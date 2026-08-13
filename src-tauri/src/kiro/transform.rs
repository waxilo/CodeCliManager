//! Anthropic/OpenAI ↔ Kiro 请求/响应转换。
//! 移植自 kiro2cli/src/transform.js（MIT）。

use serde_json::{json, Map, Value};
use uuid::Uuid;

use crate::kiro::models::{
    estimate_tokens, get_requested_effort, normalize_effort_for_kiro_model,
};

/// Anthropic content 块 → Kiro 的 {text, images}。
pub struct KiroContent {
    pub text: String,
    pub images: Vec<Value>,
    pub tool_results: Vec<Value>,
}

// ============ 工具调用解析（JSON + XML） ============

fn strip_json_code_fence(text: &str) -> String {
    let trimmed = text.trim();
    if let Some(rest) = trimmed.strip_prefix("```") {
        let body = rest.strip_prefix("json").unwrap_or(rest);
        let body = body.trim_start();
        if let Some(stripped) = body.strip_suffix("```") {
            return stripped.trim().to_string();
        }
    }
    trimmed.to_string()
}

fn parse_json_lenient(text: &str) -> Option<Value> {
    let candidate = strip_json_code_fence(text);
    if candidate.is_empty() {
        return None;
    }
    for variant in [candidate.clone(), unescape_json(&candidate)] {
        if let Ok(value) = serde_json::from_str::<Value>(&variant) {
            return Some(value);
        }
    }
    None
}

/// 去掉 JSON 字符串中多余的转义（JS 的 replace(/\\(?!["\\/bfnrtu])/g, "")）。
fn unescape_json(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut chars = text.chars().peekable();
    while let Some(ch) = chars.next() {
        if ch == '\\' {
            match chars.peek() {
                Some(&next) if matches!(next, '"' | '\\' | '/' | 'b' | 'f' | 'n' | 'r' | 't' | 'u') => {
                    out.push(ch);
                    out.push(next);
                    chars.next();
                }
                _ => {
                    // drop the backslash
                }
            }
        } else {
            out.push(ch);
        }
    }
    out
}

/// 扫描文本中所有配平的 JSON 对象片段。
fn extract_json_object_candidates(text: &str) -> Vec<String> {
    let source = strip_json_code_fence(text);
    let bytes: Vec<char> = source.chars().collect();
    let mut candidates = Vec::new();
    let mut start: Option<usize> = None;
    let mut depth: i32 = 0;
    let mut in_string = false;
    let mut escaping = false;

    for (i, &ch) in bytes.iter().enumerate() {
        if in_string {
            if escaping {
                escaping = false;
            } else if ch == '\\' {
                escaping = true;
            } else if ch == '"' {
                in_string = false;
            }
            continue;
        }
        match ch {
            '"' => in_string = true,
            '{' => {
                if depth == 0 {
                    start = Some(i);
                }
                depth += 1;
            }
            '}' if depth > 0 => {
                depth -= 1;
                if depth == 0 {
                    if let Some(start_idx) = start {
                        let slice: String = bytes[start_idx..=i].iter().collect();
                        candidates.push(slice);
                        start = None;
                    }
                }
            }
            _ => {}
        }
    }
    candidates
}

fn generated_tool_use_id() -> String {
    let id = Uuid::new_v4().to_string().replace('-', "");
    format!("call_{}", &id[..24])
}

fn normalize_tool_use_block(value: &Value) -> Option<Value> {
    if !value.is_object() || value.as_array().is_some() {
        return None;
    }
    let name = value.get("name").and_then(|v| v.as_str())?;
    if value.get("type").and_then(|v| v.as_str()) != Some("tool_use") || name.is_empty() {
        return None;
    }
    let id = value
        .get("id")
        .and_then(|v| v.as_str())
        .filter(|s| !s.is_empty())
        .map(|s| s.to_string())
        .unwrap_or_else(generated_tool_use_id);
    let input = value
        .get("input")
        .filter(|v| v.is_object())
        .cloned()
        .unwrap_or_else(|| json!({}));
    Some(json!({ "type": "tool_use", "id": id, "name": name, "input": input }))
}

fn parse_tool_use_block_fallback(text: &str) -> Option<Value> {
    if !text.contains("\"type\"") || !text.contains("tool_use") {
        return None;
    }
    let id = find_quoted_after(text, "\"id\"", "\"")
        .map(|s| s.to_string())
        .unwrap_or_else(generated_tool_use_id);
    let name = find_quoted_after(text, "\"name\"", "\"")?;
    if name.is_empty() {
        return None;
    }
    let mut input = json!({});
    if let Some(input_str) = find_braced_after(text, "\"input\"") {
        if let Some(parsed) = parse_json_lenient(&input_str) {
            if parsed.is_object() {
                input = parsed;
            }
        }
    }
    if input.as_object().map(|o| o.is_empty()).unwrap_or(false) {
        if let Some(command) = find_quoted_after(text, "\"command\"", "\"") {
            input
                .as_object_mut()
                .unwrap()
                .insert("command".to_string(), Value::String(command.to_string()));
        }
        if let Some(description) = find_quoted_after(text, "\"description\"", "\"") {
            input
                .as_object_mut()
                .unwrap()
                .insert("description".to_string(), Value::String(description.to_string()));
        }
    }
    Some(json!({ "type": "tool_use", "id": id, "name": name, "input": input }))
}

/// 在 `needle` 之后查找下一个 `quote` 包围的字符串值，支持 `\"` 转义。
fn find_quoted_after<'a>(text: &'a str, needle: &str, quote: &str) -> Option<&'a str> {
    let start = text.find(needle)? + needle.len();
    let rest = &text[start..];
    let open = rest.find(quote)? + 1;
    let mut chars = rest[open..].char_indices().peekable();
    let mut end = 0;
    while let Some((idx, ch)) = chars.next() {
        if ch == '\\' {
            chars.next();
            end = idx + 1;
            continue;
        }
        if ch == '"' {
            end = idx;
            break;
        }
        end = idx + ch.len_utf8();
    }
    Some(&rest[open..open + end])
}

/// 在 `needle` 之后查找第一个 `{...}` 平衡片段。
fn find_braced_after(text: &str, needle: &str) -> Option<String> {
    let start = text.find(needle)? + needle.len();
    let rest = &text[start..];
    let open = rest.find('{')?;
    let mut depth = 0;
    let mut in_string = false;
    let mut escaping = false;
    for (i, ch) in rest[open..].char_indices() {
        if in_string {
            if escaping {
                escaping = false;
            } else if ch == '\\' {
                escaping = true;
            } else if ch == '"' {
                in_string = false;
            }
            continue;
        }
        match ch {
            '"' => in_string = true,
            '{' => depth += 1,
            '}' => {
                depth -= 1;
                if depth == 0 {
                    return Some(rest[open..open + i + ch.len_utf8()].to_string());
                }
            }
            _ => {}
        }
    }
    None
}

fn parse_xml_tool_calls(text: &str) -> Option<Vec<Value>> {
    let mut blocks = Vec::new();
    let mut search_from = 0;
    while let Some(start) = text[search_from..].find("<invoke ") {
        let invoke_start = search_from + start;
        let rest = &text[invoke_start..];
        let Some(name_attr) = rest.find("name=\"") else { break };
        let name_start = invoke_start + name_attr + "name=\"".len();
        let Some(name_end) = text[name_start..].find('"') else { break };
        let name = &text[name_start..name_start + name_end];
        let Some(body_start) = text[name_start + name_end..].find('>') else { break };
        let body_begin = name_start + name_end + body_start + 1;
        let Some(close_tag) = text[body_begin..].find("</invoke>") else { break };
        let body = &text[body_begin..body_begin + close_tag];

        let mut input = Map::new();
        let mut p = 0;
        while let Some(param_start) = body[p..].find("<parameter ") {
            let param_begin = p + param_start;
            let p_rest = &body[param_begin..];
            let Some(param_name_attr) = p_rest.find("name=\"") else { break };
            let p_name_start = param_begin + param_name_attr + "name=\"".len();
            let Some(p_name_end) = body[p_name_start..].find('"') else { break };
            let param_name = body[p_name_start..p_name_start + p_name_end].to_string();
            let Some(p_body_start) = body[p_name_start + p_name_end..].find('>') else { break };
            let p_body_begin = p_name_start + p_name_end + p_body_start + 1;
            let Some(p_close) = body[p_body_begin..].find("</parameter>") else { break };
            let param_value = body[p_body_begin..p_body_begin + p_close].to_string();
            input.insert(param_name, Value::String(param_value));
            p = p_body_begin + p_close + "</parameter>".len();
        }

        blocks.push(json!({ "type": "tool_use", "id": generated_tool_use_id(), "name": name, "input": Value::Object(input) }));
        search_from = body_begin + close_tag + "</invoke>".len();
    }
    if blocks.is_empty() {
        None
    } else {
        Some(blocks)
    }
}

pub fn parse_tool_use_blocks_from_text(text: &str) -> Option<Vec<Value>> {
    let mut blocks: Vec<Value> = Vec::new();
    let mut seen_ids = std::collections::HashSet::new();

    // 先尝试直接解析 / 提取 JSON 片段
    let mut parsed_values: Vec<Value> = Vec::new();
    if let Some(value) = parse_json_lenient(text) {
        parsed_values.push(value);
    }
    let candidates = extract_json_object_candidates(text);
    if let Some(first) = candidates.first() {
        if let Some(value) = parse_json_lenient(first) {
            parsed_values.push(value);
        }
    }
    for candidate in candidates.iter() {
        if let Some(value) = parse_json_lenient(candidate) {
            parsed_values.push(value);
        }
    }

    for parsed in parsed_values {
        let parsed_blocks: Vec<Value> = if let Some(arr) = parsed.as_array() {
            arr.iter().filter_map(normalize_tool_use_block).collect()
        } else {
            normalize_tool_use_block(&parsed).into_iter().collect()
        };
        for block in parsed_blocks {
            let id = block.get("id").and_then(|v| v.as_str()).unwrap_or_default().to_string();
            if seen_ids.contains(&id) {
                continue;
            }
            seen_ids.insert(id);
            blocks.push(block);
        }
    }

    // 正则兜底解析
    for candidate in candidates.iter() {
        if let Some(block) = parse_tool_use_block_fallback(candidate) {
            let id = block.get("id").and_then(|v| v.as_str()).unwrap_or_default().to_string();
            if seen_ids.contains(&id) {
                continue;
            }
            seen_ids.insert(id);
            blocks.push(block);
        }
    }

    // XML 格式
    if let Some(xml_blocks) = parse_xml_tool_calls(text) {
        for block in xml_blocks {
            let id = block.get("id").and_then(|v| v.as_str()).unwrap_or_default().to_string();
            if !seen_ids.contains(&id) {
                seen_ids.insert(id);
                blocks.push(block);
            }
        }
    }

    if blocks.is_empty() {
        None
    } else {
        Some(blocks)
    }
}

pub fn normalize_assistant_content(text: &str, stop_reason: &str) -> (Vec<Value>, String) {
    if let Some(tool_use_blocks) = parse_tool_use_blocks_from_text(text) {
        return (tool_use_blocks, "tool_use".to_string());
    }
    (
        vec![json!({ "type": "text", "text": text })],
        stop_reason.to_string(),
    )
}

// ============ Anthropic ↔ Kiro ============

fn system_to_text(system: &Value) -> String {
    if system.is_null() {
        return String::new();
    }
    if let Some(s) = system.as_str() {
        return s.to_string();
    }
    if let Some(blocks) = system.as_array() {
        return blocks
            .iter()
            .filter_map(|block| {
                if let Some(s) = block.as_str() {
                    return Some(s.to_string());
                }
                block.get("type").and_then(|v| v.as_str()).and_then(|t| {
                    if t == "text" {
                        block.get("text").and_then(|v| v.as_str()).map(|s| s.to_string())
                    } else {
                        None
                    }
                })
            })
            .filter(|s| !s.is_empty())
            .collect::<Vec<_>>()
            .join("\n\n");
    }
    system.to_string()
}

fn media_type_to_format(media_type: &str) -> String {
    media_type
        .split('/')
        .nth(1)
        .unwrap_or("png")
        .to_lowercase()
}

fn parse_data_url(url: &str) -> Option<(String, String)> {
    let rest = url.strip_prefix("data:")?;
    let (meta, data) = rest.split_once(';')?;
    let data = data.strip_prefix("base64,")?;
    Some((meta.to_string(), data.to_string()))
}

/// Kiro 侧要求 toolUseId 使用 `tooluse_` 前缀；Claude Code 常见 `call_` / `toolu_`。
fn normalize_tool_use_id(id: &str) -> String {
    let id = id.trim();
    if id.is_empty() {
        return format!("tooluse_{}", Uuid::new_v4().simple());
    }
    if id.starts_with("tooluse_") {
        return id.to_string();
    }
    let stripped = id
        .strip_prefix("toolu_")
        .or_else(|| id.strip_prefix("call_"))
        .or_else(|| id.strip_prefix("tool_"))
        .unwrap_or(id);
    format!("tooluse_{stripped}")
}

fn try_parse_json_or_wrap(raw: &str) -> Value {
    serde_json::from_str(raw).unwrap_or_else(|_| json!({ "result": raw }))
}

fn tool_result_content_to_kiro(content: &Value) -> Vec<Value> {
    let raw = match content {
        Value::String(text) => text.clone(),
        Value::Array(parts) => parts
            .iter()
            .map(|part| {
                if let Some(text) = part.get("text").and_then(|v| v.as_str()) {
                    text.to_string()
                } else if let Some(value) = part.get("json") {
                    value.to_string()
                } else {
                    part.to_string()
                }
            })
            .collect::<Vec<_>>()
            .join("\n"),
        Value::Null => String::new(),
        other => other.to_string(),
    };
    // 与 kiro-proxy-anthropic 一致：toolResults.content 使用 [{ json: ... }]
    vec![json!({ "json": try_parse_json_or_wrap(&raw) })]
}

fn anthropic_content_to_kiro(content: &Value) -> Result<KiroContent, String> {
    if let Some(s) = content.as_str() {
        return Ok(KiroContent {
            text: s.to_string(),
            images: Vec::new(),
            tool_results: Vec::new(),
        });
    }
    let Some(blocks) = content.as_array() else {
        return Ok(KiroContent {
            text: content.as_str().unwrap_or("").to_string(),
            images: Vec::new(),
            tool_results: Vec::new(),
        });
    };

    let mut text_parts = Vec::new();
    let mut images = Vec::new();
    let mut tool_results = Vec::new();

    for block in blocks {
        if block.is_null() {
            continue;
        }
        if let Some(text) = block.get("type").and_then(|v| v.as_str()) {
            match text {
                "text" => {
                    if let Some(text) = block.get("text").and_then(|v| v.as_str()) {
                        text_parts.push(text.to_string());
                    }
                }
                "image" => {
                    let source = block.get("source").unwrap_or(&Value::Null);
                    let source_type = source.get("type").and_then(|v| v.as_str());
                    match source_type {
                        Some("base64") => {
                            let media_type = source.get("media_type").and_then(|v| v.as_str()).unwrap_or("image/png");
                            let data = source.get("data").and_then(|v| v.as_str()).unwrap_or("");
                            images.push(json!({
                                "format": media_type_to_format(media_type),
                                "source": { "bytes": data },
                            }));
                        }
                        Some("url") => {
                            let url = source.get("url").and_then(|v| v.as_str()).unwrap_or("");
                            let (media_type, data) = parse_data_url(url)
                                .ok_or_else(|| "Only base64 image sources and data: URLs are supported.".to_string())?;
                            images.push(json!({
                                "format": media_type_to_format(&media_type),
                                "source": { "bytes": data },
                            }));
                        }
                        _ => {}
                    }
                }
                "tool_result" => {
                    let tool_use_id = block
                        .get("tool_use_id")
                        .and_then(|v| v.as_str())
                        .unwrap_or("")
                        .trim();
                    if tool_use_id.is_empty() {
                        continue;
                    }
                    let normalized_id = normalize_tool_use_id(tool_use_id);
                    if tool_results
                        .iter()
                        .any(|result: &Value| result["toolUseId"] == normalized_id)
                    {
                        continue;
                    }
                    tool_results.push(json!({
                        "toolUseId": normalized_id,
                        "content": tool_result_content_to_kiro(
                            block.get("content").unwrap_or(&Value::Null)
                        ),
                        "status": if block.get("is_error").and_then(|v| v.as_bool()).unwrap_or(false) {
                            "error"
                        } else {
                            "success"
                        },
                    }));
                }
                _ => {}
            }
        }
    }

    Ok(KiroContent {
        text: text_parts.join("\n"),
        images,
        tool_results,
    })
}

fn anthropic_assistant_to_kiro(content: &Value) -> Value {
    if let Some(s) = content.as_str() {
        return json!({ "content": s });
    }
    let Some(blocks) = content.as_array() else {
        return json!({ "content": content.as_str().unwrap_or("") });
    };

    let mut text_parts = Vec::new();
    let mut tool_uses = Vec::new();
    for block in blocks {
        match block.get("type").and_then(|v| v.as_str()) {
            Some("text") => {
                if let Some(text) = block.get("text").and_then(|v| v.as_str()) {
                    text_parts.push(text.to_string());
                }
            }
            Some("tool_use") => {
                let id = block.get("id").and_then(|v| v.as_str()).unwrap_or("").trim();
                let name = block
                    .get("name")
                    .and_then(|v| v.as_str())
                    .unwrap_or("")
                    .trim();
                if !id.is_empty() && !name.is_empty() {
                    tool_uses.push(json!({
                        "toolUseId": normalize_tool_use_id(id),
                        "name": name,
                        "input": block.get("input").cloned().unwrap_or_else(|| json!({})),
                    }));
                }
            }
            _ => {}
        }
    }

    let mut message = json!({ "content": text_parts.join("\n") });
    if !tool_uses.is_empty() {
        let object = message.as_object_mut().unwrap();
        object.insert(
            "messageId".to_string(),
            Value::String(Uuid::new_v4().to_string()),
        );
        object.insert("toolUses".to_string(), Value::Array(tool_uses));
    } else if message
        .get("content")
        .and_then(|v| v.as_str())
        .map(|s| s.is_empty())
        .unwrap_or(true)
    {
        // Kiro 不允许空 assistant 消息
        message
            .as_object_mut()
            .unwrap()
            .insert("content".to_string(), Value::String(".".to_string()));
    }
    message
}

fn last_assistant_tool_ids(history: &[Value]) -> std::collections::HashSet<String> {
    for item in history.iter().rev() {
        if let Some(assistant) = item.get("assistantResponseMessage") {
            let mut ids = std::collections::HashSet::new();
            if let Some(tool_uses) = assistant.get("toolUses").and_then(|v| v.as_array()) {
                for tool_use in tool_uses {
                    if let Some(id) = tool_use.get("toolUseId").and_then(|v| v.as_str()) {
                        ids.insert(id.to_string());
                    }
                }
            }
            return ids;
        }
    }
    std::collections::HashSet::new()
}

fn filter_orphan_tool_results(results: &[Value], valid_ids: &std::collections::HashSet<String>) -> Vec<Value> {
    if valid_ids.is_empty() {
        return results.to_vec();
    }
    results
        .iter()
        .filter(|result| {
            result
                .get("toolUseId")
                .and_then(|v| v.as_str())
                .is_some_and(|id| valid_ids.contains(id))
        })
        .cloned()
        .collect()
}

fn anthropic_tools_to_kiro(tools: &Value) -> Vec<Value> {
    let Some(tools) = tools.as_array() else {
        return Vec::new();
    };
    tools
        .iter()
        .filter_map(|tool| {
            let name = tool
                .get("name")
                .or_else(|| tool.get("function").and_then(|f| f.get("name")))
                .and_then(|v| v.as_str())
                .unwrap_or("");
            if name.is_empty() {
                return None;
            }
            let description = tool
                .get("description")
                .or_else(|| tool.get("function").and_then(|f| f.get("description")))
                .and_then(|v| v.as_str())
                .unwrap_or("");
            let schema = tool
                .get("input_schema")
                .or_else(|| tool.get("function").and_then(|f| f.get("parameters")))
                .cloned()
                .unwrap_or_else(|| json!({ "type": "object", "properties": {} }));
            Some(json!({
                "toolSpecification": {
                    "name": name,
                    "description": description,
                    "inputSchema": { "json": schema },
                }
            }))
        })
        .collect()
}

fn attach_user_context(message: &mut Value, tools: &[Value], tool_results: &[Value]) {
    if tools.is_empty() && tool_results.is_empty() {
        return;
    }
    let mut context = Map::new();
    if !tools.is_empty() {
        context.insert("tools".to_string(), Value::Array(tools.to_vec()));
    }
    if !tool_results.is_empty() {
        context.insert(
            "toolResults".to_string(),
            Value::Array(tool_results.to_vec()),
        );
    }
    message.as_object_mut().unwrap().insert(
        "userInputMessageContext".to_string(),
        Value::Object(context),
    );
}

fn apply_system_prompt(text: &str, system_text: &str) -> String {
    if system_text.is_empty() {
        return text.to_string();
    }
    format!("<system>\n{system_text}\n</system>\n\n{text}")
}

fn merge_object(target: &mut Map<String, Value>, source: &Value) {
    let Some(source_obj) = source.as_object() else {
        return;
    };
    for (key, value) in source_obj {
        if value.is_object() {
            let entry = target
                .entry(key.clone())
                .or_insert_with(|| json!({}));
            if let Some(target_obj) = entry.as_object_mut() {
                merge_object(target_obj, value);
            }
        } else if !value.is_null() {
            target.insert(key.clone(), value.clone());
        }
    }
}

fn apply_thinking_fields(extra: &mut Map<String, Value>, thinking: &Value) {
    if !thinking.is_object() {
        return;
    }
    match thinking.get("type").and_then(|v| v.as_str()) {
        Some("disabled") => {
            extra.insert("thinking".to_string(), json!({ "type": "disabled" }));
        }
        Some("enabled") | Some("adaptive") => {
            let display = if thinking.get("display").and_then(|v| v.as_str()) == Some("omitted") {
                "omitted"
            } else {
                "summarized"
            };
            extra.insert("thinking".to_string(), json!({ "type": "adaptive", "display": display }));
        }
        _ => {}
    }
}

fn build_additional_model_request_fields(body: &Value, kiro_model: &str) -> Option<Value> {
    let mut extra = Map::new();
    if let Some(fields) = body
        .get("additionalModelRequestFields")
        .or_else(|| body.get("additional_model_request_fields"))
    {
        if let Some(obj) = fields.as_object() {
            merge_object(&mut extra, &Value::Object(obj.clone()));
        }
    }

    let effort = get_requested_effort(body)
        .and_then(|effort| normalize_effort_for_kiro_model(Some(&effort), kiro_model));

    if let Some(output_config) = body.get("output_config") {
        let existing = extra
            .entry("output_config".to_string())
            .or_insert_with(|| json!({}));
        if let Some(existing_obj) = existing.as_object_mut() {
            merge_object(existing_obj, output_config);
        }
    }

    // Claude Code 几乎总会带 max_tokens（通常 ≥ 1024）。
    // Kiro 的 GenerateAssistantResponse schema 里，max_tokens 仅对部分 Claude 模型合法；
    // 转给 gpt-5.6 / 其它模型会直接 502：
    // "property 'max_tokens' is not defined in the schema"。
    let is_claude = kiro_model.starts_with("claude-");
    let is_gpt = kiro_model.starts_with("gpt-5.6");

    if !is_claude {
        extra.remove("max_tokens");
    }

    if is_claude {
        // 即使 effort 列表为空，也要转发 thinking（Claude adaptive thinking）
        apply_thinking_fields(&mut extra, body.get("thinking").unwrap_or(&Value::Null));
        // Claude Code 默认开启思考时，若请求未显式带 thinking，也启用 adaptive+summarized
        if !extra.contains_key("thinking")
            && body
                .get("thinking")
                .and_then(|v| v.get("type"))
                .and_then(|v| v.as_str())
                .is_none()
        {
            // 不强制默认开启，避免意外加费；仅在请求明确要求时启用
        }

        let requested_max_tokens = body
            .get("max_tokens")
            .or_else(|| body.get("max_completion_tokens"))
            .and_then(|v| v.as_i64());
        if let Some(max_tokens) = requested_max_tokens {
            if max_tokens >= 1024 {
                extra.insert("max_tokens".to_string(), json!(max_tokens));
            }
        }

        if let Some(effort) = effort {
            if effort != "none" {
                let existing = extra
                    .entry("output_config".to_string())
                    .or_insert_with(|| json!({}));
                if let Some(existing_obj) = existing.as_object_mut() {
                    existing_obj.insert("effort".to_string(), json!(effort));
                }
            }
        }
    } else if is_gpt {
        // GPT 系不接受 Anthropic 的 thinking / output_config / max_tokens
        extra.remove("thinking");
        extra.remove("output_config");
        if let Some(reasoning) = body.get("reasoning") {
            let existing = extra
                .entry("reasoning".to_string())
                .or_insert_with(|| json!({}));
            if let Some(existing_obj) = existing.as_object_mut() {
                merge_object(existing_obj, reasoning);
            }
        }
        if let Some(effort) = effort {
            let existing = extra
                .entry("reasoning".to_string())
                .or_insert_with(|| json!({}));
            if let Some(existing_obj) = existing.as_object_mut() {
                existing_obj.insert("effort".to_string(), json!(effort));
            }
        }
    } else if let Some(effort) = effort {
        // 其它已知 effort 模型：尽量走 output_config.effort
        if effort != "none" {
            let existing = extra
                .entry("output_config".to_string())
                .or_insert_with(|| json!({}));
            if let Some(existing_obj) = existing.as_object_mut() {
                existing_obj.insert("effort".to_string(), json!(effort));
            }
        }
    }

    if extra.is_empty() {
        None
    } else {
        Some(Value::Object(extra))
    }
}

/// 构造发送给 Kiro GenerateAssistantResponse 的请求体。
pub fn build_kiro_request(
    body: &Value,
    kiro_model: &str,
    profile_arn: Option<&str>,
) -> Result<Value, String> {
    let messages = body.get("messages").and_then(|v| v.as_array()).cloned().unwrap_or_default();
    let last_user_index = messages
        .iter()
        .rposition(|m| m.get("role").and_then(|v| v.as_str()) == Some("user"))
        .ok_or_else(|| "messages must contain at least one user message.".to_string())?;

    let system_text = system_to_text(body.get("system").unwrap_or(&Value::Null));
    let kiro_tools = anthropic_tools_to_kiro(body.get("tools").unwrap_or(&Value::Null));

    let mut history: Vec<Value> = Vec::new();
    let mut system_applied = false;

    for message in &messages[..last_user_index] {
        let role = message.get("role").and_then(|v| v.as_str()).unwrap_or("");
        if role == "user" {
            let parsed = anthropic_content_to_kiro(message.get("content").unwrap_or(&Value::Null))?;
            let mut content = parsed.text;
            if !system_applied && !system_text.is_empty() {
                content = apply_system_prompt(&content, &system_text);
                system_applied = true;
            }
            let kept_results =
                filter_orphan_tool_results(&parsed.tool_results, &last_assistant_tool_ids(&history));
            // 历史里空 content 会被 Kiro 拒；工具结果轮次用 continue
            if content.trim().is_empty() {
                content = if kept_results.is_empty() {
                    String::new()
                } else {
                    "continue".to_string()
                };
            }
            let mut msg = json!({
                "content": content,
                "origin": "KIRO_CLI",
                "modelId": kiro_model,
            });
            if !parsed.images.is_empty() {
                msg.as_object_mut().unwrap().insert("images".to_string(), Value::Array(parsed.images));
            }
            attach_user_context(&mut msg, &[], &kept_results);
            history.push(json!({ "userInputMessage": msg }));
        } else if role == "assistant" {
            history.push(json!({
                "assistantResponseMessage": anthropic_assistant_to_kiro(
                    message.get("content").unwrap_or(&Value::Null)
                )
            }));
        }
    }

    let current_parsed = anthropic_content_to_kiro(messages[last_user_index].get("content").unwrap_or(&Value::Null))?;
    let mut current_content = if !system_applied {
        apply_system_prompt(&current_parsed.text, &system_text)
    } else {
        current_parsed.text
    };
    let kept_current_results = filter_orphan_tool_results(
        &current_parsed.tool_results,
        &last_assistant_tool_ids(&history),
    );
    if current_content.trim().is_empty() {
        current_content = if kept_current_results.is_empty() {
            ".".to_string()
        } else {
            "continue".to_string()
        };
    }
    let mut current_message = json!({
        "content": current_content,
        "modelId": kiro_model,
        "origin": "KIRO_CLI",
    });
    if !current_parsed.images.is_empty() {
        current_message
            .as_object_mut()
            .unwrap()
            .insert("images".to_string(), Value::Array(current_parsed.images));
    }
    attach_user_context(
        &mut current_message,
        &kiro_tools,
        &kept_current_results,
    );

    let mut body_out = json!({
        "conversationState": {
            "currentMessage": { "userInputMessage": current_message },
            "chatTriggerType": "MANUAL",
            "conversationId": format!("sess_proxy_{}", Uuid::new_v4().to_string().replace('-', "")),
            "history": Value::Array(history),
            "agentContinuationId": Uuid::new_v4().to_string(),
            "agentTaskType": "vibe",
        },
        "profileArn": profile_arn.unwrap_or(""),
        "agentMode": "vibe",
    });

    if let Some(additional) = build_additional_model_request_fields(body, kiro_model) {
        body_out
            .as_object_mut()
            .unwrap()
            .insert("additionalModelRequestFields".to_string(), additional);
    }
    if let Some(conversation_id) = body
        .get("metadata")
        .and_then(|m| m.get("conversation_id"))
        .and_then(|v| v.as_str())
    {
        body_out
            .get_mut("conversationState")
            .unwrap()
            .as_object_mut()
            .unwrap()
            .insert("conversationId".to_string(), Value::String(conversation_id.to_string()));
    }

    Ok(body_out)
}

// ============ 响应构造 ============

pub fn anthropic_message_response_with_tools(
    id: &str,
    model: &str,
    text: &str,
    thinking: &str,
    thinking_signature: Option<&str>,
    native_tool_uses: &[Value],
    stop_reason: &str,
) -> Value {
    let mut content = Vec::new();
    if !thinking.is_empty() || thinking_signature.is_some_and(|s| !s.is_empty()) {
        content.push(json!({
            "type": "thinking",
            "thinking": thinking,
            "signature": thinking_signature.unwrap_or(""),
        }));
    }
    if !text.is_empty() {
        // 原生 tool 已到位时，不再把文本当 tool JSON 再解析一遍
        if native_tool_uses.is_empty() {
            let (parsed, parsed_stop) = normalize_assistant_content(text, stop_reason);
            if parsed_stop == "tool_use" {
                let mut blocks = Vec::new();
                if !thinking.is_empty() || thinking_signature.is_some_and(|s| !s.is_empty()) {
                    blocks.push(json!({
                        "type": "thinking",
                        "thinking": thinking,
                        "signature": thinking_signature.unwrap_or(""),
                    }));
                }
                blocks.extend(parsed);
                return json!({
                    "id": id,
                    "type": "message",
                    "role": "assistant",
                    "model": model,
                    "content": blocks,
                    "stop_reason": parsed_stop,
                    "stop_sequence": null,
                    "usage": { "input_tokens": 0, "output_tokens": estimate_tokens(text) },
                });
            }
            content.extend(parsed);
        } else {
            content.push(json!({ "type": "text", "text": text }));
        }
    }
    content.extend(native_tool_uses.iter().cloned());
    let stop_reason = if !native_tool_uses.is_empty() {
        "tool_use".to_string()
    } else {
        stop_reason.to_string()
    };
    if content.is_empty() {
        content.push(json!({ "type": "text", "text": "" }));
    }
    json!({
        "id": id,
        "type": "message",
        "role": "assistant",
        "model": model,
        "content": content,
        "stop_reason": stop_reason,
        "stop_sequence": null,
        "usage": { "input_tokens": 0, "output_tokens": estimate_tokens(text) },
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn builds_kiro_request_basic() {
        let body = json!({
            "model": "claude-sonnet-4-5",
            "messages": [
                { "role": "user", "content": "hi there" }
            ],
            "stream": true
        });
        let built = build_kiro_request(
            &body,
            "claude-sonnet-4.5",
            Some("arn:aws:codewhisperer:us-east-1:123456789012:profile/abc"),
        )
        .unwrap();
        assert_eq!(built["profileArn"], "arn:aws:codewhisperer:us-east-1:123456789012:profile/abc");
        assert_eq!(built["agentMode"], "vibe");
        assert_eq!(built["conversationState"]["chatTriggerType"], "MANUAL");
        let cur = &built["conversationState"]["currentMessage"]["userInputMessage"];
        assert_eq!(cur["modelId"], "claude-sonnet-4.5");
        assert!(cur["content"].as_str().unwrap().contains("hi there"));
    }

    #[test]
    fn history_contains_assistant_message() {
        let body = json!({
            "messages": [
                { "role": "user", "content": "ping" },
                { "role": "assistant", "content": "pong" },
                { "role": "user", "content": "again" }
            ]
        });
        let built = build_kiro_request(&body, "claude-opus-5", Some("arn")).unwrap();
        let history = built["conversationState"]["history"].as_array().unwrap();
        assert_eq!(history.len(), 2);
        assert_eq!(history[1]["assistantResponseMessage"]["content"], "pong");
        assert_eq!(built["conversationState"]["currentMessage"]["userInputMessage"]["content"], "again");
    }

    #[test]
    fn parses_tool_use_from_text() {
        let text = "{\"type\":\"tool_use\",\"id\":\"call_123\",\"name\":\"Bash\",\"input\":{\"command\":\"ls\"}}";
        let blocks = parse_tool_use_blocks_from_text(text).unwrap();
        assert_eq!(blocks.len(), 1);
        assert_eq!(blocks[0]["name"], "Bash");
        assert_eq!(blocks[0]["id"], "call_123");
        assert_eq!(blocks[0]["input"]["command"], "ls");
    }

    #[test]
    fn parses_tool_use_after_prose_and_code_fence() {
        let text = concat!(
            "让我先看看项目的整体结构：\n\n```json\n",
            "{\"type\":\"tool_use\",\"id\":\"call_001\",\"name\":\"Bash\",",
            "\"input\":{\"command\":\"find . -type f -name \\\"*.rs\\\" | head -20\"}}",
            "\n```"
        );
        let blocks = parse_tool_use_blocks_from_text(text).unwrap();
        assert_eq!(blocks.len(), 1);
        assert_eq!(blocks[0]["name"], "Bash");
        assert_eq!(
            blocks[0]["input"]["command"],
            "find . -type f -name \"*.rs\" | head -20"
        );
    }

    #[test]
    fn tools_use_native_kiro_context() {
        let body = json!({
            "system": "You are helpful",
            "messages": [{ "role": "user", "content": "hi" }],
            "tools": [{
                "name": "Bash",
                "description": "run a command",
                "input_schema": {
                    "type": "object",
                    "required": ["command"],
                    "properties": { "command": { "type": "string" } }
                }
            }]
        });
        let built = build_kiro_request(&body, "claude-opus-5", Some("arn")).unwrap();
        let current = &built["conversationState"]["currentMessage"]["userInputMessage"];
        let content = current["content"].as_str().unwrap();
        assert!(content.contains("You are helpful"));
        assert!(!content.contains("Available tools:"));
        let specification = &current["userInputMessageContext"]["tools"][0]["toolSpecification"];
        assert_eq!(specification["name"], "Bash");
        assert_eq!(
            specification["inputSchema"]["json"]["required"][0],
            "command"
        );
    }

    #[test]
    fn converts_native_tool_round_trip() {
        let body = json!({
            "messages": [
                { "role": "user", "content": "list files" },
                {
                    "role": "assistant",
                    "content": [{
                        "type": "tool_use",
                        "id": "call_abc",
                        "name": "Bash",
                        "input": { "command": "ls" }
                    }]
                },
                {
                    "role": "user",
                    "content": [{
                        "type": "tool_result",
                        "tool_use_id": "call_abc",
                        "content": "a.txt\nb.txt"
                    }]
                }
            ],
            "tools": [{
                "name": "Bash",
                "description": "run a command",
                "input_schema": { "type": "object" }
            }]
        });
        let built = build_kiro_request(&body, "gpt-5.6-sol", Some("arn")).unwrap();
        let history = built["conversationState"]["history"].as_array().unwrap();
        let assistant = &history[1]["assistantResponseMessage"];
        assert_eq!(assistant["content"], "");
        assert_eq!(assistant["toolUses"][0]["toolUseId"], "tooluse_abc");
        assert_eq!(assistant["toolUses"][0]["name"], "Bash");
        assert_eq!(assistant["toolUses"][0]["input"]["command"], "ls");

        let current = &built["conversationState"]["currentMessage"]["userInputMessage"];
        assert_eq!(current["content"], "continue");
        assert_eq!(current["origin"], "KIRO_CLI");
        let result = &current["userInputMessageContext"]["toolResults"][0];
        assert_eq!(result["toolUseId"], "tooluse_abc");
        assert_eq!(result["content"][0]["json"]["result"], "a.txt\nb.txt");
        assert_eq!(result["status"], "success");
        assert_eq!(
            current["userInputMessageContext"]["tools"][0]["toolSpecification"]["name"],
            "Bash"
        );
    }

    #[test]
    fn preserves_historical_tool_results_and_error_status() {
        let body = json!({
            "messages": [
                { "role": "user", "content": "run it" },
                {
                    "role": "assistant",
                    "content": [{
                        "type": "tool_use",
                        "id": "call_bad",
                        "name": "Bash",
                        "input": { "command": "false" }
                    }]
                },
                {
                    "role": "user",
                    "content": [{
                        "type": "tool_result",
                        "tool_use_id": "call_bad",
                        "is_error": true,
                        "content": [{ "type": "text", "text": "exit 1" }]
                    }]
                },
                { "role": "assistant", "content": "retrying" },
                { "role": "user", "content": "continue" }
            ]
        });
        let built = build_kiro_request(&body, "deepseek-3.2", Some("arn")).unwrap();
        let history = built["conversationState"]["history"].as_array().unwrap();
        let result = &history[2]["userInputMessage"]["userInputMessageContext"]["toolResults"][0];
        assert_eq!(result["toolUseId"], "tooluse_bad");
        assert_eq!(result["content"][0]["json"]["result"], "exit 1");
        assert_eq!(result["status"], "error");
    }

    #[test]
    fn drops_orphan_tool_results() {
        let body = json!({
            "messages": [
                { "role": "user", "content": "hi" },
                {
                    "role": "assistant",
                    "content": [{
                        "type": "tool_use",
                        "id": "call_keep",
                        "name": "Bash",
                        "input": { "command": "ls" }
                    }]
                },
                {
                    "role": "user",
                    "content": [
                        {
                            "type": "tool_result",
                            "tool_use_id": "call_keep",
                            "content": "ok"
                        },
                        {
                            "type": "tool_result",
                            "tool_use_id": "call_orphan",
                            "content": "nope"
                        }
                    ]
                }
            ],
            "tools": [{ "name": "Bash", "input_schema": { "type": "object" } }]
        });
        let built = build_kiro_request(&body, "gpt-5.6-sol", Some("arn")).unwrap();
        let results = built["conversationState"]["currentMessage"]["userInputMessage"]
            ["userInputMessageContext"]["toolResults"]
            .as_array()
            .unwrap();
        assert_eq!(results.len(), 1);
        assert_eq!(results[0]["toolUseId"], "tooluse_keep");
    }

    #[test]
    fn gpt_models_do_not_forward_anthropic_max_tokens() {
        let body = json!({
            "model": "claude-sonnet-5",
            "max_tokens": 32000,
            "messages": [{ "role": "user", "content": "hi" }],
            "thinking": { "type": "enabled" },
        });
        let built = build_kiro_request(&body, "gpt-5.6-sol", Some("arn")).unwrap();
        let additional = &built["additionalModelRequestFields"];
        assert!(additional.get("max_tokens").is_none(), "gpt must not receive max_tokens");
        assert!(additional.get("thinking").is_none(), "gpt must not receive thinking");
        assert!(additional.get("output_config").is_none(), "gpt must not receive output_config");
    }

    #[test]
    fn claude_models_forward_max_tokens_when_large_enough() {
        let body = json!({
            "max_tokens": 32000,
            "messages": [{ "role": "user", "content": "hi" }],
        });
        let built = build_kiro_request(&body, "claude-sonnet-5", Some("arn")).unwrap();
        assert_eq!(built["additionalModelRequestFields"]["max_tokens"], 32000);
    }

    #[test]
    fn claude_models_forward_thinking_enabled() {
        let body = json!({
            "max_tokens": 4096,
            "messages": [{ "role": "user", "content": "hi" }],
            "thinking": { "type": "enabled" },
        });
        let built = build_kiro_request(&body, "claude-opus-4.8", Some("arn")).unwrap();
        let thinking = &built["additionalModelRequestFields"]["thinking"];
        assert_eq!(thinking["type"], "adaptive");
        assert_eq!(thinking["display"], "summarized");
    }

    #[test]
    fn response_includes_thinking_block_before_text() {
        let response = anthropic_message_response_with_tools(
            "msg_1",
            "claude-opus-4.8",
            "最终答案",
            "先想一步。",
            Some("sig_xyz"),
            &[],
            "end_turn",
        );
        let content = response["content"].as_array().unwrap();
        assert_eq!(content.len(), 2);
        assert_eq!(content[0]["type"], "thinking");
        assert_eq!(content[0]["thinking"], "先想一步。");
        assert_eq!(content[0]["signature"], "sig_xyz");
        assert_eq!(content[1]["type"], "text");
        assert_eq!(content[1]["text"], "最终答案");
    }
}
