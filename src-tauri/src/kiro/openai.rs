//! OpenAI Chat Completions 兼容层。
//!
//! 目标：让 OpenAI SDK / 各类只认 `/v1/chat/completions` 的客户端也能复用本机 Kiro 额度。
//!
//! 与 Anthropic 路径的关系不是「另起一套代理」，而是**同一管线的第二个入口**：
//!
//! ```text
//! OpenAI 请求 ──(openai_request_to_anthropic)──► Anthropic body
//!                                                 │
//!                        build_kiro_request / call_kiro_generate / 去重 / 限流 / 健康自愈
//!                                                 │
//! OpenAI 响应 ◄──(OpenAI 出参构造)──────────────── CollectedText / KiroEvent
//! ```
//!
//! 之所以先把入参归一化成 Anthropic 结构，是因为下游所有环节（工具 schema 校验、
//! antml 泄漏恢复、思维链提取、协议清洗、停因归一）都建立在该结构上，
//! 归一化后即可**原样复用**，无需为 OpenAI 协议再写一遍。
//!
//! 出参方向则必须真正翻译：OpenAI 的 `content` + `tool_calls` 与 Anthropic 的
//! `content[]` 块模型不同，`finish_reason` 取值不同，工具调用入参是 JSON **字符串**
//! 而非对象，流式增量是 `delta` 而非 `content_block_delta`。

use serde_json::{json, Map, Value};

// ============ 入参：OpenAI → Anthropic ============

/// 把 OpenAI Chat Completions 请求体翻译成 Anthropic Messages 请求体。
///
/// 覆盖的字段：
/// - `messages[].role`: system / developer → 顶层 `system`；user / assistant 原样；tool → user 的 `tool_result`
/// - `messages[].content`: 字符串或 content part 数组（`text` / `image_url` / `input_audio` 忽略）
/// - `messages[].tool_calls[]` → assistant 的 `tool_use` 块
/// - `tools[]`（`{type:"function",function:{...}}`）→ Anthropic `tools[]`
/// - `tool_choice` → Anthropic `tool_choice`
/// - `max_completion_tokens` / `max_tokens` → `max_tokens`
/// - `reasoning_effort` → `output_config.effort`（归一化交给下游 models.rs 的同名逻辑）
/// - `response_format.type == "json_object"` → 追加一条 system 指示（Kiro 无原生 JSON 模式）
///
/// `stream` 由调用方另行处理，不在此处消费。
pub fn openai_request_to_anthropic(body: &Value) -> Result<Value, String> {
    let messages = body
        .get("messages")
        .and_then(Value::as_array)
        .ok_or_else(|| "messages must be a non-empty array.".to_string())?;
    if messages.is_empty() {
        return Err("messages must be a non-empty array.".to_string());
    }

    let mut system_parts: Vec<String> = Vec::new();
    let mut out_messages: Vec<Value> = Vec::new();

    for message in messages {
        let role = message.get("role").and_then(Value::as_str).unwrap_or("");
        match role {
            "system" | "developer" => {
                let text = openai_content_to_text(message.get("content").unwrap_or(&Value::Null));
                if !text.is_empty() {
                    system_parts.push(text);
                }
            }
            "tool" => {
                // OpenAI 的 tool 消息是独立轮次；Anthropic 要求 tool_result 作为 user 内容块，
                // 并携带 tool_use_id 以配对。这里保持一一对应。
                let tool_call_id = message
                    .get("tool_call_id")
                    .and_then(Value::as_str)
                    .unwrap_or("unknown")
                    .to_string();
                let text = openai_content_to_text(message.get("content").unwrap_or(&Value::Null));
                out_messages.push(json!({
                    "role": "user",
                    "content": [{
                        "type": "tool_result",
                        "tool_use_id": tool_call_id,
                        "content": text,
                    }]
                }));
            }
            "assistant" => {
                let mut blocks: Vec<Value> = Vec::new();
                let text = openai_content_to_text(message.get("content").unwrap_or(&Value::Null));
                if !text.is_empty() {
                    blocks.push(json!({ "type": "text", "text": text }));
                }
                if let Some(tool_calls) = message.get("tool_calls").and_then(Value::as_array) {
                    for call in tool_calls {
                        let id = call.get("id").and_then(Value::as_str).unwrap_or("");
                        let function = call.get("function").unwrap_or(&Value::Null);
                        let name = function.get("name").and_then(Value::as_str).unwrap_or("");
                        if name.is_empty() {
                            continue;
                        }
                        blocks.push(json!({
                            "type": "tool_use",
                            "id": if id.is_empty() { format!("call_{}", blocks.len()) } else { id.to_string() },
                            "name": name,
                            "input": parse_tool_arguments(function.get("arguments")),
                        }));
                    }
                }
                if blocks.is_empty() {
                    // Anthropic 不允许空 content；下游 build_kiro_request 也有同样的兜底语义。
                    blocks.push(json!({ "type": "text", "text": "." }));
                }
                out_messages.push(json!({ "role": "assistant", "content": blocks }));
            }
            _ => {
                // user 及未知角色一律按 user 处理
                let blocks = openai_content_to_blocks(message.get("content").unwrap_or(&Value::Null));
                if !blocks.is_empty() {
                    out_messages.push(json!({ "role": "user", "content": blocks }));
                }
            }
        }
    }

    if !out_messages
        .iter()
        .any(|m| m.get("role").and_then(Value::as_str) == Some("user"))
    {
        return Err("messages must contain at least one user message.".to_string());
    }

    let mut out = Map::new();
    out.insert("messages".to_string(), Value::Array(out_messages));

    if let Some(response_format) = body.get("response_format") {
        if response_format.get("type").and_then(Value::as_str) == Some("json_object") {
            system_parts.push(
                "Respond with a single valid JSON object and no prose."
                    .to_string(),
            );
        }
    }
    if !system_parts.is_empty() {
        out.insert(
            "system".to_string(),
            Value::String(system_parts.join("\n\n")),
        );
    }

    if let Some(tools) = body.get("tools").and_then(Value::as_array) {
        let converted = tools
            .iter()
            .filter_map(openai_tool_to_anthropic)
            .collect::<Vec<_>>();
        if !converted.is_empty() {
            out.insert("tools".to_string(), Value::Array(converted));
        }
    }

    if let Some(tool_choice) = body.get("tool_choice") {
        if let Some(converted) = openai_tool_choice_to_anthropic(tool_choice) {
            out.insert("tool_choice".to_string(), converted);
        }
    }

    let max_tokens = body
        .get("max_completion_tokens")
        .or_else(|| body.get("max_tokens"))
        .and_then(Value::as_i64);
    if let Some(max_tokens) = max_tokens {
        out.insert("max_tokens".to_string(), json!(max_tokens));
    }

    // reasoning_effort 是 OpenAI 侧的字段名；Anthropic 路径读 output_config.effort。
    // 归一化（合法取值、按模型能力裁剪）由 models.rs 的既有逻辑完成，这里只做字段搬运。
    if let Some(effort) = body.get("reasoning_effort").and_then(Value::as_str) {
        if !effort.trim().is_empty() {
            out.insert(
                "output_config".to_string(),
                json!({ "effort": effort.trim().to_lowercase() }),
            );
        }
    }

    // 透传其它 Anthropic 侧可选字段，便于用户手工注入高级能力
    for key in ["thinking", "additionalModelRequestFields", "additional_model_request_fields"] {
        if let Some(value) = body.get(key) {
            out.insert(key.to_string(), value.clone());
        }
    }
    if let Some(metadata) = body.get("metadata") {
        out.insert("metadata".to_string(), metadata.clone());
    }

    Ok(Value::Object(out))
}

/// OpenAI `content`（字符串 / part 数组）→ 纯文本。
pub fn openai_content_to_text(content: &Value) -> String {
    if let Some(text) = content.as_str() {
        return text.to_string();
    }
    let Some(parts) = content.as_array() else {
        return String::new();
    };
    parts
        .iter()
        .filter_map(|part| {
            let part_type = part.get("type").and_then(Value::as_str).unwrap_or("");
            match part_type {
                "text" | "input_text" | "output_text" => {
                    part.get("text").and_then(Value::as_str).map(str::to_string)
                }
                // 少数客户端把裸对象塞进数组，按文本兜底
                _ => None,
            }
        })
        .filter(|text| !text.is_empty())
        .collect::<Vec<_>>()
        .join("\n")
}

/// OpenAI `content` → Anthropic content 块数组（支持 `image_url`）。
fn openai_content_to_blocks(content: &Value) -> Vec<Value> {
    if let Some(text) = content.as_str() {
        return if text.is_empty() {
            Vec::new()
        } else {
            vec![json!({ "type": "text", "text": text })]
        };
    }
    let Some(parts) = content.as_array() else {
        return Vec::new();
    };
    let mut blocks = Vec::new();
    for part in parts {
        match part.get("type").and_then(Value::as_str).unwrap_or("") {
            "text" | "input_text" | "output_text" => {
                if let Some(text) = part.get("text").and_then(Value::as_str) {
                    if !text.is_empty() {
                        blocks.push(json!({ "type": "text", "text": text }));
                    }
                }
            }
            "image_url" => {
                let url = part
                    .get("image_url")
                    .and_then(|image| image.get("url"))
                    .or_else(|| part.get("image_url"))
                    .and_then(Value::as_str)
                    .unwrap_or("");
                if let Some(source) = openai_image_source(url) {
                    blocks.push(json!({ "type": "image", "source": source }));
                }
            }
            _ => {}
        }
    }
    blocks
}

/// OpenAI 的图片既可能是 `data:` URL（内联 base64），也可能是公网 URL。
/// Anthropic 的 image 块只认 base64 / 已下载内容，而 Kiro 上游同样只接受 bytes，
/// 因此这里只透传 data: URL；公网 URL 会被忽略（下游也无法拉取）。
fn openai_image_source(url: &str) -> Option<Value> {
    let rest = url.strip_prefix("data:")?;
    let (meta, data) = rest.split_once(';')?;
    let data = data.strip_prefix("base64,")?;
    Some(json!({
        "type": "base64",
        "media_type": if meta.is_empty() { "image/png" } else { meta },
        "data": data,
    }))
}

/// OpenAI 的 `arguments` 是 JSON **字符串**；Anthropic 的 `input` 是对象。
/// 解析失败时保留原文，交给下游 `ToolRecoverySpec` 判定并走泄漏恢复路径。
fn parse_tool_arguments(arguments: Option<&Value>) -> Value {
    match arguments {
        Some(Value::String(raw)) => {
            let trimmed = raw.trim();
            if trimmed.is_empty() {
                json!({})
            } else {
                serde_json::from_str::<Value>(trimmed).unwrap_or_else(|_| json!({}))
            }
        }
        Some(value) if value.is_object() => value.clone(),
        _ => json!({}),
    }
}

/// `tools[]` 的 OpenAI 形态 → Anthropic `tool`。
/// 同时兼容已经是 Anthropic 形态（`{name, input_schema}`）的输入。
fn openai_tool_to_anthropic(tool: &Value) -> Option<Value> {
    let function = tool.get("function").unwrap_or(tool);
    let name = function.get("name")?.as_str()?.trim();
    if name.is_empty() {
        return None;
    }
    let description = function
        .get("description")
        .and_then(Value::as_str)
        .unwrap_or("");
    let schema = function
        .get("parameters")
        .or_else(|| function.get("input_schema"))
        .cloned()
        .unwrap_or_else(|| json!({ "type": "object", "properties": {} }));
    let mut out = Map::new();
    out.insert("name".to_string(), Value::String(name.to_string()));
    if !description.is_empty() {
        out.insert("description".to_string(), Value::String(description.to_string()));
    }
    out.insert("input_schema".to_string(), schema);
    if let Some(strict) = tool.get("strict").or_else(|| function.get("strict")) {
        out.insert("strict".to_string(), strict.clone());
    }
    Some(Value::Object(out))
}

fn openai_tool_choice_to_anthropic(choice: &Value) -> Option<Value> {
    if let Some(text) = choice.as_str() {
        return match text {
            "none" | "auto" | "required" | "any" => Some(json!({ "type": text })),
            _ => None,
        };
    }
    let choice_type = choice.get("type").and_then(Value::as_str).unwrap_or("");
    if choice_type == "function" {
        let name = choice
            .get("function")
            .and_then(|f| f.get("name"))
            .and_then(Value::as_str)
            .unwrap_or("");
        if name.is_empty() {
            return None;
        }
        return Some(json!({ "type": "tool", "name": name }));
    }
    None
}

// ============ 出参：Anthropic 结果 → OpenAI ============

/// Anthropic 的 `stop_reason` → OpenAI 的 `finish_reason`。
pub fn anthropic_stop_reason_to_openai(stop_reason: &str) -> &'static str {
    match stop_reason {
        "tool_use" => "tool_calls",
        "max_tokens" => "length",
        // end_turn / stop_sequence 都表示自然结束
        _ => "stop",
    }
}

/// 把一个 Anthropic `tool_use` 块转成 OpenAI 的 `tool_calls[]` 元素。
/// `index` 为在该响应内的序号，OpenAI 要求流式与非流式都带。
pub fn anthropic_tool_use_to_openai(block: &Value, index: usize) -> Option<Value> {
    let name = block.get("name").and_then(Value::as_str)?;
    let id = block.get("id").and_then(Value::as_str).unwrap_or("");
    let input = block.get("input").cloned().unwrap_or_else(|| json!({}));
    Some(json!({
        "index": index,
        "id": id,
        "type": "function",
        "function": {
            "name": name,
            "arguments": serde_json::to_string(&input).unwrap_or_else(|_| "{}".to_string()),
        }
    }))
}

/// 从 Anthropic content 块数组里抽出文本与 tool_calls，用于非流式响应构造。
pub fn anthropic_content_to_openai_parts(content: &[Value]) -> (String, Vec<Value>) {
    let mut text = String::new();
    let mut tool_calls = Vec::new();
    for block in content {
        match block.get("type").and_then(Value::as_str) {
            // thinking 块不进正文：OpenAI 侧的思维链由 reasoning_content 承载，单独处理
            Some("text") => {
                if let Some(part) = block.get("text").and_then(Value::as_str) {
                    text.push_str(part);
                }
            }
            Some("tool_use") => {
                if let Some(call) = anthropic_tool_use_to_openai(block, tool_calls.len()) {
                    tool_calls.push(call);
                }
            }
            _ => {}
        }
    }
    (text, tool_calls)
}

/// 构造非流式 `chat.completion` 响应。
///
/// `reasoning_content` 使用 DeepSeek / vLLM 等主流 OpenAI 兼容实现的约定字段名，
/// 只有存在思维链时才出现，避免污染普通响应。
pub fn openai_chat_completion(
    id: &str,
    model: &str,
    content: &[Value],
    thinking: &str,
    stop_reason: &str,
    output_tokens: i64,
) -> Value {
    let (text, tool_calls) = anthropic_content_to_openai_parts(content);
    let mut message = Map::new();
    message.insert("role".to_string(), Value::String("assistant".to_string()));
    // OpenAI 规范：有 tool_calls 时 content 允许为 null
    message.insert(
        "content".to_string(),
        if text.is_empty() {
            Value::Null
        } else {
            Value::String(text.clone())
        },
    );
    if !thinking.is_empty() {
        message.insert(
            "reasoning_content".to_string(),
            Value::String(thinking.to_string()),
        );
    }
    if !tool_calls.is_empty() {
        message.insert("tool_calls".to_string(), Value::Array(tool_calls));
    }

    let finish_reason = anthropic_stop_reason_to_openai(stop_reason);
    json!({
        "id": id,
        "object": "chat.completion",
        "created": now_unix(),
        "model": model,
        "choices": [{
            "index": 0,
            "message": Value::Object(message),
            "logprobs": null,
            "finish_reason": finish_reason,
        }],
        "usage": {
            "prompt_tokens": 0,
            "completion_tokens": output_tokens,
            "total_tokens": output_tokens,
        },
    })
}

/// 构造流式 chunk。
///
/// `delta` 为 OpenAI 的增量对象（如 `{"content":"…"}` 或 `{"tool_calls":[…]}`）；
/// `finish_reason` 仅在最后一个 chunk 给出。
pub fn openai_chunk(
    id: &str,
    model: &str,
    delta: Value,
    finish_reason: Option<&str>,
) -> Value {
    json!({
        "id": id,
        "object": "chat.completion.chunk",
        "created": now_unix(),
        "model": model,
        "choices": [{
            "index": 0,
            "delta": delta,
            "logprobs": null,
            "finish_reason": finish_reason,
        }],
    })
}

/// 首个 chunk 的 role 声明，OpenAI 客户端据此确定流的起始。
pub fn openai_role_chunk(id: &str, model: &str) -> Value {
    openai_chunk(id, model, json!({ "role": "assistant", "content": "" }), None)
}

/// 尾包的 usage chunk（`stream_options.include_usage` 为 true 时 OpenAI 才发，
/// 但多发一个不影响客户端解析，这里始终附带以便统计）。
pub fn openai_usage_chunk(id: &str, model: &str, output_tokens: i64) -> Value {
    json!({
        "id": id,
        "object": "chat.completion.chunk",
        "created": now_unix(),
        "model": model,
        "choices": [],
        "usage": {
            "prompt_tokens": 0,
            "completion_tokens": output_tokens,
            "total_tokens": output_tokens,
        },
    })
}

/// OpenAI 流式终止标记。所有兼容实现都以 `data: [DONE]` 收尾，客户端据此停止读取。
pub const OPENAI_SSE_DONE: &str = "data: [DONE]\n\n";

/// OpenAI 的 SSE 帧格式：**只有 `data:`，没有 `event:` 行**。
/// 复用 Anthropic 的 `sse_event`（会多写 event 行）会导致部分严格客户端解析失败。
pub fn openai_sse_data(data: &Value) -> String {
    format!("data: {data}\n\n")
}

/// 构造 OpenAI 形状的 `models` 列表。
pub fn openai_models_list(entries: &[Value]) -> Value {
    json!({
        "object": "list",
        "data": entries,
    })
}

/// 单个模型的 OpenAI 形状。
pub fn openai_model_entry(id: &str, display_name: &str, created: i64) -> Value {
    let mut entry = Map::new();
    entry.insert("id".to_string(), Value::String(id.to_string()));
    entry.insert("object".to_string(), Value::String("model".to_string()));
    entry.insert("created".to_string(), json!(created));
    entry.insert("owned_by".to_string(), Value::String("kiro".to_string()));
    if !display_name.is_empty() && display_name != id {
        // OpenAI 无此字段，但多数客户端会忽略未知键，保留便于人工排查
        entry.insert(
            "display_name".to_string(),
            Value::String(display_name.to_string()),
        );
    }
    Value::Object(entry)
}

/// OpenAI 形状的错误信封：`{"error":{"message":…,"type":…,"code":…}}`。
///
/// 与 Anthropic 的 `{"type":"error","error":{…}}` 不同 —— 顶层没有 `type` 键，
/// 且 `error` 内用 `code` 而非 `type` 表达细分原因。混用会让 OpenAI SDK 无法解析。
pub fn openai_error_body(message: &str, error_type: &str) -> Value {
    json!({
        "error": {
            "message": message,
            "type": error_type,
            "code": Value::Null,
            "param": Value::Null,
        }
    })
}

/// Anthropic 侧的 error_type → OpenAI 侧的 type。
pub fn anthropic_error_type_to_openai(error_type: &str) -> &'static str {
    match error_type {
        "authentication_error" => "invalid_request_error",
        "rate_limit_error" => "rate_limit_error",
        "api_error" => "server_error",
        "overloaded_error" => "server_error",
        _ => "invalid_request_error",
    }
}

fn now_unix() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.as_secs() as i64)
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn converts_basic_openai_request() {
        let body = json!({
            "model": "claude-sonnet-4-5",
            "messages": [
                { "role": "system", "content": "be terse" },
                { "role": "user", "content": "hi" }
            ],
            "max_completion_tokens": 2048,
            "reasoning_effort": "HIGH",
        });
        let out = openai_request_to_anthropic(&body).unwrap();
        assert_eq!(out["system"], "be terse");
        assert_eq!(out["messages"][0]["role"], "user");
        assert_eq!(out["messages"][0]["content"][0]["text"], "hi");
        assert_eq!(out["max_tokens"], 2048);
        // reasoning_effort 小写化后落进 output_config.effort
        assert_eq!(out["output_config"]["effort"], "high");
    }

    #[test]
    fn converts_tool_round_trip() {
        let body = json!({
            "messages": [
                { "role": "user", "content": "list files" },
                { "role": "assistant", "content": null, "tool_calls": [{
                    "id": "call_1",
                    "type": "function",
                    "function": { "name": "Bash", "arguments": "{\"command\":\"ls\"}" }
                }]},
                { "role": "tool", "tool_call_id": "call_1", "content": "-rw a.txt" }
            ],
            "tools": [{
                "type": "function",
                "function": {
                    "name": "Bash",
                    "description": "run a command",
                    "parameters": {
                        "type": "object",
                        "required": ["command"],
                        "properties": { "command": { "type": "string" } }
                    }
                }
            }]
        });
        let out = openai_request_to_anthropic(&body).unwrap();
        // assistant 的 tool_calls → tool_use 块，arguments 字符串解析成对象
        assert_eq!(out["messages"][1]["content"][0]["type"], "tool_use");
        assert_eq!(out["messages"][1]["content"][0]["name"], "Bash");
        assert_eq!(out["messages"][1]["content"][0]["input"]["command"], "ls");
        // tool 消息 → user 的 tool_result，并保留 id 配对
        assert_eq!(out["messages"][2]["content"][0]["type"], "tool_result");
        assert_eq!(out["messages"][2]["content"][0]["tool_use_id"], "call_1");
        // tools 展开成 Anthropic input_schema
        assert_eq!(out["tools"][0]["name"], "Bash");
        assert_eq!(out["tools"][0]["input_schema"]["properties"]["command"]["type"], "string");
    }

    #[test]
    fn rejects_request_without_user_message() {
        let body = json!({ "messages": [{ "role": "system", "content": "x" }] });
        assert!(openai_request_to_anthropic(&body).is_err());
        assert!(openai_request_to_anthropic(&json!({})).is_err());
    }

    #[test]
    fn converts_data_url_image() {
        let body = json!({
            "messages": [{
                "role": "user",
                "content": [
                    { "type": "text", "text": "what is this" },
                    { "type": "image_url", "image_url": { "url": "data:image/png;base64,AAAA" } }
                ]
            }]
        });
        let out = openai_request_to_anthropic(&body).unwrap();
        assert_eq!(out["messages"][0]["content"][0]["type"], "text");
        assert_eq!(out["messages"][0]["content"][1]["type"], "image");
        assert_eq!(out["messages"][0]["content"][1]["source"]["media_type"], "image/png");
        assert_eq!(out["messages"][0]["content"][1]["source"]["data"], "AAAA");
    }

    #[test]
    fn maps_stop_reason_to_finish_reason() {
        assert_eq!(anthropic_stop_reason_to_openai("tool_use"), "tool_calls");
        assert_eq!(anthropic_stop_reason_to_openai("max_tokens"), "length");
        assert_eq!(anthropic_stop_reason_to_openai("end_turn"), "stop");
        assert_eq!(anthropic_stop_reason_to_openai("stop_sequence"), "stop");
    }

    #[test]
    fn builds_non_stream_completion_with_tool_calls() {
        let content = vec![
            json!({ "type": "thinking", "thinking": "hmm", "signature": "s" }),
            json!({ "type": "text", "text": "let me check" }),
            json!({ "type": "tool_use", "id": "call_9", "name": "Read", "input": { "path": "a.txt" } }),
        ];
        let response = openai_chat_completion("chatcmpl-1", "claude-opus-5", &content, "hmm", "tool_use", 42);
        assert_eq!(response["object"], "chat.completion");
        assert_eq!(response["choices"][0]["message"]["content"], "let me check");
        assert_eq!(response["choices"][0]["message"]["reasoning_content"], "hmm");
        assert_eq!(response["choices"][0]["finish_reason"], "tool_calls");
        // 入参必须是 JSON 字符串，而不是对象
        let args = response["choices"][0]["message"]["tool_calls"][0]["function"]["arguments"]
            .as_str()
            .unwrap();
        assert_eq!(serde_json::from_str::<Value>(args).unwrap()["path"], "a.txt");
        assert_eq!(response["usage"]["completion_tokens"], 42);
    }

    #[test]
    fn non_stream_content_is_null_when_only_tool_calls() {
        let content = vec![json!({
            "type": "tool_use", "id": "c1", "name": "Bash", "input": { "command": "ls" }
        })];
        let response = openai_chat_completion("id", "m", &content, "", "tool_use", 7);
        assert!(response["choices"][0]["message"]["content"].is_null());
        assert!(response["choices"][0]["message"].get("reasoning_content").is_none());
    }

    #[test]
    fn sse_frames_have_no_event_line() {
        let frame = openai_sse_data(&json!({ "object": "chat.completion.chunk" }));
        assert!(frame.starts_with("data: "));
        assert!(frame.ends_with("\n\n"));
        assert!(!frame.contains("event:"));
        assert_eq!(OPENAI_SSE_DONE, "data: [DONE]\n\n");
    }

    #[test]
    fn error_envelope_matches_openai_shape() {
        let body = openai_error_body("bad key", "invalid_request_error");
        assert!(body.get("type").is_none());
        assert_eq!(body["error"]["message"], "bad key");
        assert!(body["error"].get("code").is_some());
        assert_eq!(anthropic_error_type_to_openai("api_error"), "server_error");
        assert_eq!(anthropic_error_type_to_openai("rate_limit_error"), "rate_limit_error");
    }
}
