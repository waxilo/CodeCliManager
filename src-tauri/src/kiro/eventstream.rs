//! Kiro 私有协议使用的 AWS Event Stream 二进制帧解析。
//!
//! 帧格式：
//!   total_length (u32 BE) | headers_length (u32 BE) | prelude_crc (u32 BE) |
//!   headers | payload | trailing_crc (u32 BE)
//! header 值类型与 AWS Event Stream 规范一致（0..=9）。
//! 移植自 kiro2cli/src/eventstream.js（MIT）。

use std::collections::HashMap;

use serde_json::{json, Value};

/// 解析后的一条 Kiro 事件。
#[derive(Debug, Clone)]
pub struct KiroEvent {
    pub event_type: String,
    pub payload: Value,
}

/// 从事件流中累积出的文本回复。
#[derive(Debug, Default, Clone)]
pub struct CollectedText {
    pub text: String,
    /// 可见思考过程（Claude adaptive thinking / 其它模型的 reasoning 事件）。
    pub thinking: String,
    /// Anthropic thinking 块所需的签名（有则原样回传）。
    pub thinking_signature: Option<String>,
    /// 已拼装完成的原生 tool_use 块（Anthropic 格式）。
    pub tool_uses: Vec<Value>,
    pub stop_reason: String,
    pub meter: Option<Value>,
    pub context_usage: Option<Value>,
}

#[derive(Debug, Clone)]
enum HeaderValue {
    Bool,
    Byte,
    Int16,
    Int32,
    Int64,
    ByteArray,
    String(String),
    Uuid,
}

fn read_u16_be(b: &[u8], off: usize) -> usize {
    u16::from_be_bytes([b[off], b[off + 1]]) as usize
}

fn read_u32_be(b: &[u8], off: usize) -> usize {
    u32::from_be_bytes([b[off], b[off + 1], b[off + 2], b[off + 3]]) as usize
}

/// 读取一个 header 条目，返回 (name, value, 下一个 offset)。
fn read_header_value(buffer: &[u8], offset: usize) -> Option<(String, HeaderValue, usize)> {
    let name_length = *buffer.get(offset)? as usize;
    let mut o = offset + 1;
    let name = String::from_utf8(buffer.get(o..o + name_length)?.to_vec()).ok()?;
    o += name_length;
    let value_type = *buffer.get(o)?;
    o += 1;

    let get_u8 = |o: usize| buffer.get(o).copied();

    let value = match value_type {
        0 => HeaderValue::Bool,
        1 => HeaderValue::Bool,
        2 => {
            get_u8(o)?;
            o += 1;
            HeaderValue::Byte
        }
        3 => {
            get_u8(o)?;
            get_u8(o + 1)?;
            o += 2;
            HeaderValue::Int16
        }
        4 => {
            get_u8(o)?;
            get_u8(o + 1)?;
            get_u8(o + 2)?;
            get_u8(o + 3)?;
            o += 4;
            HeaderValue::Int32
        }
        5 | 8 => {
            for index in 0..8 {
                get_u8(o + index)?;
            }
            o += 8;
            HeaderValue::Int64
        }
        6 => {
            let length = read_u16_be(buffer, o);
            o += 2;
            buffer.get(o..o + length)?;
            o += length;
            HeaderValue::ByteArray
        }
        7 => {
            let length = read_u16_be(buffer, o);
            o += 2;
            let v = String::from_utf8(buffer.get(o..o + length)?.to_vec()).ok()?;
            o += length;
            HeaderValue::String(v)
        }
        9 => {
            buffer.get(o..o + 16)?;
            o += 16;
            HeaderValue::Uuid
        }
        _ => return None,
    };

    Some((name, value, o))
}

/// 增量解析 AWS Event Stream：边读 HTTP body 边吐出完整帧。
#[derive(Debug, Default)]
pub struct IncrementalEventStream {
    pub(crate) buffer: Vec<u8>,
}

impl IncrementalEventStream {
    pub fn new() -> Self {
        Self::default()
    }

    /// 喂入一段原始字节，返回本轮新解析出的完整事件。
    pub fn push(&mut self, data: &[u8]) -> Vec<KiroEvent> {
        if !data.is_empty() {
            self.buffer.extend_from_slice(data);
        }
        self.drain_complete_frames()
    }

    fn drain_complete_frames(&mut self) -> Vec<KiroEvent> {
        let mut events = Vec::new();
        loop {
            if self.buffer.len() < 12 {
                break;
            }
            let total_length = read_u32_be(&self.buffer, 0);
            // 非法长度：停止消费，避免死循环（留给上层当截断处理）
            if total_length < 16 || total_length > 64 * 1024 * 1024 {
                break;
            }
            if self.buffer.len() < total_length {
                break;
            }
            let frame: Vec<u8> = self.buffer.drain(..total_length).collect();
            if let Some(event) = parse_single_frame(&frame) {
                events.push(event);
            }
        }
        events
    }
}

fn parse_single_frame(frame: &[u8]) -> Option<KiroEvent> {
    if frame.len() < 16 {
        return None;
    }
    let total_length = read_u32_be(frame, 0);
    let headers_length = read_u32_be(frame, 4);
    if total_length == 0 || total_length > frame.len() {
        return None;
    }

    let mut headers: HashMap<String, HeaderValue> = HashMap::new();
    let header_end = 12 + headers_length;
    if header_end > frame.len().saturating_sub(4) {
        return None;
    }
    let mut header_offset = 12;
    while header_offset + 2 <= header_end {
        match read_header_value(frame, header_offset) {
            Some((name, value, next)) => {
                headers.insert(name, value);
                header_offset = next;
            }
            None => break,
        }
    }

    let payload_start = header_end;
    let payload_end = total_length - 4;
    let payload_bytes = if payload_start < payload_end && payload_end <= frame.len() {
        &frame[payload_start..payload_end]
    } else {
        &[]
    };

    let payload = if payload_bytes.is_empty() {
        Value::Null
    } else {
        serde_json::from_slice(payload_bytes).unwrap_or_else(|_| {
            json!({ "raw": String::from_utf8_lossy(payload_bytes).to_string() })
        })
    };

    let event_type = match headers.get(":event-type") {
        Some(HeaderValue::String(s)) => s.clone(),
        _ => String::new(),
    };

    Some(KiroEvent { event_type, payload })
}

/// 解析完整的事件流 body（不含 HTTP 分块编码，reqwest 已自动解码）。
pub fn parse_event_stream(input: &[u8]) -> Vec<KiroEvent> {
    let mut parser = IncrementalEventStream::new();
    parser.push(input)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn build_frame(event_type: &str, payload: &Value) -> Vec<u8> {
        let name = b":event-type";
        let value = event_type.as_bytes();
        let mut headers = Vec::new();
        headers.push(name.len() as u8);
        headers.extend_from_slice(name);
        headers.push(7u8); // string 类型
        headers.extend_from_slice(&(value.len() as u16).to_be_bytes());
        headers.extend_from_slice(value);

        let payload_bytes = serde_json::to_vec(payload).unwrap();
        let total_len = 12 + headers.len() + payload_bytes.len() + 4;

        let mut frame = Vec::new();
        frame.extend_from_slice(&(total_len as u32).to_be_bytes());
        frame.extend_from_slice(&(headers.len() as u32).to_be_bytes());
        frame.extend_from_slice(&0u32.to_be_bytes()); // prelude crc
        frame.extend_from_slice(&headers);
        frame.extend_from_slice(&payload_bytes);
        frame.extend_from_slice(&0u32.to_be_bytes()); // trailing crc
        frame
    }

    #[test]
    fn parses_assistant_response() {
        let frame = build_frame("assistantResponseEvent", &json!({ "content": "hello" }));
        let events = parse_event_stream(&frame);
        assert_eq!(events.len(), 1);
        assert_eq!(events[0].event_type, "assistantResponseEvent");
        assert_eq!(events[0].payload["content"], "hello");
    }

    #[test]
    fn collects_text_and_stop_reason() {
        let mut data = Vec::new();
        data.extend_from_slice(&build_frame("assistantResponseEvent", &json!({ "content": "abc" })));
        data.extend_from_slice(&build_frame("metadataEvent", &json!({ "stopReason": "TOOL_USE" })));
        let events = parse_event_stream(&data);
        let collected = collect_kiro_text(&events);
        assert_eq!(collected.text, "abc");
        assert_eq!(collected.stop_reason, "tool_use");
    }

    #[test]
    fn tolerates_truncated_stream() {
        let frame = build_frame("assistantResponseEvent", &json!({ "content": "x" }));
        let events = parse_event_stream(&frame[..frame.len() - 3]);
        // 截断的帧应被跳过而不是 panic
        assert!(events.is_empty());
    }

    #[test]
    fn incremental_parser_emits_across_chunks() {
        let frame = build_frame("assistantResponseEvent", &json!({ "content": "ab" }));
        let split = frame.len() / 2;
        let mut parser = IncrementalEventStream::new();
        assert!(parser.push(&frame[..split]).is_empty());
        let events = parser.push(&frame[split..]);
        assert_eq!(events.len(), 1);
        assert_eq!(events[0].payload["content"], "ab");
    }

    #[test]
    fn collects_native_tool_use_event() {
        let frame = build_frame(
            "toolUseEvent",
            &json!({
                "name": "Bash",
                "toolUseId": "call_abc",
                "input": "{\"command\":\"echo hi\"}",
                "stop": true
            }),
        );
        let events = parse_event_stream(&frame);
        let collected = collect_kiro_text(&events);
        assert_eq!(collected.stop_reason, "tool_use");
        assert_eq!(collected.tool_uses.len(), 1);
        assert_eq!(collected.tool_uses[0]["name"], "Bash");
        assert_eq!(collected.tool_uses[0]["id"], "call_abc");
        assert_eq!(collected.tool_uses[0]["input"]["command"], "echo hi");
    }

    #[test]
    fn collects_chunked_native_tool_use_event() {
        let mut data = Vec::new();
        data.extend_from_slice(&build_frame(
            "toolUseEvent",
            &json!({
                "name": "Bash",
                "toolUseId": "call_chunked"
            }),
        ));
        data.extend_from_slice(&build_frame(
            "toolUseEvent",
            &json!({
                "name": "Bash",
                "toolUseId": "call_chunked",
                "input": "{\"command\":"
            }),
        ));
        data.extend_from_slice(&build_frame(
            "toolUseEvent",
            &json!({
                "name": "Bash",
                "toolUseId": "call_chunked",
                "input": "\"echo hi\"}"
            }),
        ));
        data.extend_from_slice(&build_frame(
            "toolUseEvent",
            &json!({
                "name": "Bash",
                "toolUseId": "call_chunked",
                "stop": true
            }),
        ));
        let events = parse_event_stream(&data);
        let collected = collect_kiro_text(&events);
        assert_eq!(collected.tool_uses.len(), 1);
        assert_eq!(collected.tool_uses[0]["id"], "call_chunked");
        assert_eq!(collected.tool_uses[0]["input"]["command"], "echo hi");
        assert_eq!(collected.stop_reason, "tool_use");
    }

    #[test]
    fn collects_reasoning_content_event() {
        let mut data = Vec::new();
        data.extend_from_slice(&build_frame(
            "reasoningContentEvent",
            &json!({
                "text": "先分析问题。",
                "signature": "sig_abc"
            }),
        ));
        data.extend_from_slice(&build_frame(
            "reasoningContentEvent",
            &json!({ "reasoningText": { "text": "再给出答案。" } }),
        ));
        data.extend_from_slice(&build_frame(
            "assistantResponseEvent",
            &json!({ "content": "结论" }),
        ));
        let collected = collect_kiro_text(&parse_event_stream(&data));
        assert_eq!(collected.thinking, "先分析问题。再给出答案。");
        assert_eq!(collected.thinking_signature.as_deref(), Some("sig_abc"));
        assert_eq!(collected.text, "结论");
    }
}

fn map_stop_reason(stop_reason: &str) -> String {
    match stop_reason {
        "TOOL_USE" => "tool_use".to_string(),
        "MAX_TOKENS" => "max_tokens".to_string(),
        _ => "end_turn".to_string(),
    }
}

/// 从 Kiro reasoning 相关 payload 提取可见思考文本与签名。
pub fn extract_reasoning_parts(payload: &Value) -> (String, Option<String>) {
    let signature = payload
        .get("signature")
        .and_then(|v| v.as_str())
        .filter(|s| !s.is_empty())
        .map(|s| s.to_string());

    let text = if let Some(rt) = payload.get("reasoningText") {
        match rt {
            Value::String(s) => s.clone(),
            Value::Object(obj) => obj
                .get("text")
                .or_else(|| obj.get("Text"))
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string(),
            _ => String::new(),
        }
    } else if let Some(s) = payload.get("text").and_then(|v| v.as_str()) {
        s.to_string()
    } else if let Some(s) = payload.get("content").and_then(|v| v.as_str()) {
        s.to_string()
    } else {
        String::new()
    };

    (text, signature)
}

fn tool_use_event_to_block(payload: &Value) -> Option<Value> {
    let name = payload.get("name").and_then(|v| v.as_str()).unwrap_or("").trim();
    if name.is_empty() {
        return None;
    }
    let id = payload
        .get("toolUseId")
        .or_else(|| payload.get("tool_use_id"))
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .trim();
    let id = if id.is_empty() {
        let raw = format!("{:x}", chrono::Utc::now().timestamp_nanos_opt().unwrap_or(0));
        format!("tooluse_{raw}")
    } else {
        id.to_string()
    };
    let input_value = match payload.get("input") {
        Some(Value::String(s)) => {
            serde_json::from_str::<Value>(s).unwrap_or_else(|_| json!({ "raw": s }))
        }
        Some(v) if v.is_object() => v.clone(),
        _ => json!({}),
    };
    Some(json!({
        "type": "tool_use",
        "id": id,
        "name": name,
        "input": input_value,
    }))
}

/// 遍历事件，累积文本回复、停止原因与用量信息。
pub fn collect_kiro_text(events: &[KiroEvent]) -> CollectedText {
    let mut collected = CollectedText {
        stop_reason: "end_turn".to_string(),
        ..Default::default()
    };
    let mut tool_order: Vec<String> = Vec::new();
    let mut tool_parts: HashMap<String, (String, String, Option<Value>, bool)> = HashMap::new();

    for event in events {
        match event.event_type.as_str() {
            "assistantResponseEvent" => {
                if let Some(content) = event.payload.get("content").and_then(|v| v.as_str()) {
                    collected.text.push_str(content);
                }
            }
            "reasoningContentEvent" => {
                let (text, signature) = extract_reasoning_parts(&event.payload);
                if !text.is_empty() {
                    collected.thinking.push_str(&text);
                }
                if signature.is_some() {
                    collected.thinking_signature = signature;
                }
            }
            "toolUseEvent" => {
                let id = event
                    .payload
                    .get("toolUseId")
                    .or_else(|| event.payload.get("tool_use_id"))
                    .and_then(|v| v.as_str())
                    .unwrap_or("")
                    .to_string();
                if id.is_empty() {
                    continue;
                }
                let name = event
                    .payload
                    .get("name")
                    .and_then(|v| v.as_str())
                    .unwrap_or("")
                    .to_string();
                if !tool_parts.contains_key(&id) {
                    tool_order.push(id.clone());
                }
                let entry = tool_parts
                    .entry(id.clone())
                    .or_insert_with(|| (name.clone(), String::new(), None, false));
                if entry.0.is_empty() && !name.is_empty() {
                    entry.0 = name;
                }
                match event.payload.get("input") {
                    Some(Value::String(chunk)) => entry.1.push_str(chunk),
                    Some(value) if value.is_object() => entry.2 = Some(value.clone()),
                    _ => {}
                }
                let is_stop = event
                    .payload
                    .get("stop")
                    .and_then(|v| v.as_bool())
                    .unwrap_or(false);
                if is_stop {
                    entry.3 = true;
                }
            }
            "metadataEvent" => {
                if let Some(reason) = event.payload.get("stopReason").and_then(|v| v.as_str()) {
                    collected.stop_reason = map_stop_reason(reason);
                }
            }
            "meteringEvent" => collected.meter = Some(event.payload.clone()),
            "contextUsageEvent" => collected.context_usage = Some(event.payload.clone()),
            _ => {}
        }
    }

    for id in tool_order {
        let Some((name, input_parts, object_input, is_complete)) = tool_parts.get(&id) else {
            continue;
        };
        if !is_complete {
            continue;
        }
        let input = object_input
            .clone()
            .unwrap_or_else(|| Value::String(input_parts.clone()));
        if let Some(block) = tool_use_event_to_block(&json!({
            "toolUseId": id,
            "name": name,
            "input": input,
        })) {
            collected.tool_uses.push(block);
        }
    }
    if !collected.tool_uses.is_empty() {
        collected.stop_reason = "tool_use".to_string();
    }

    collected
}
