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
    pub stop_reason: String,
    pub meter: Option<Value>,
    pub context_usage: Option<Value>,
}

#[derive(Debug, Clone)]
enum HeaderValue {
    Bool(bool),
    Byte(u8),
    Int16(i16),
    Int32(i32),
    Int64(i64),
    ByteArray(Vec<u8>),
    String(String),
    Uuid(String),
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
        0 => HeaderValue::Bool(true),
        1 => HeaderValue::Bool(false),
        2 => {
            let v = get_u8(o)?;
            o += 1;
            HeaderValue::Byte(v)
        }
        3 => {
            let v = i16::from_be_bytes([get_u8(o)?, get_u8(o + 1)?]);
            o += 2;
            HeaderValue::Int16(v)
        }
        4 => {
            let v = i32::from_be_bytes([get_u8(o)?, get_u8(o + 1)?, get_u8(o + 2)?, get_u8(o + 3)?]);
            o += 4;
            HeaderValue::Int32(v)
        }
        5 | 8 => {
            let v = i64::from_be_bytes([
                get_u8(o)?, get_u8(o + 1)?, get_u8(o + 2)?, get_u8(o + 3)?,
                get_u8(o + 4)?, get_u8(o + 5)?, get_u8(o + 6)?, get_u8(o + 7)?,
            ]);
            o += 8;
            HeaderValue::Int64(v)
        }
        6 => {
            let length = read_u16_be(buffer, o);
            o += 2;
            let v = buffer.get(o..o + length)?.to_vec();
            o += length;
            HeaderValue::ByteArray(v)
        }
        7 => {
            let length = read_u16_be(buffer, o);
            o += 2;
            let v = String::from_utf8(buffer.get(o..o + length)?.to_vec()).ok()?;
            o += length;
            HeaderValue::String(v)
        }
        9 => {
            let v = buffer.get(o..o + 16)?.iter().map(|byte| format!("{byte:02x}")).collect::<String>();
            o += 16;
            HeaderValue::Uuid(v)
        }
        _ => return None,
    };

    Some((name, value, o))
}

/// 解析完整的事件流 body（不含 HTTP 分块编码，reqwest 已自动解码）。
pub fn parse_event_stream(input: &[u8]) -> Vec<KiroEvent> {
    let mut events = Vec::new();
    let mut offset = 0;
    let len = input.len();

    while offset + 12 <= len {
        let total_length = read_u32_be(input, offset);
        let headers_length = read_u32_be(input, offset + 4);
        if total_length == 0 || offset + total_length > len {
            break;
        }

        let mut headers: HashMap<String, HeaderValue> = HashMap::new();
        let header_end = offset + 12 + headers_length;
        let mut header_offset = offset + 12;
        while header_offset + 2 <= header_end {
            match read_header_value(input, header_offset) {
                Some((name, value, next)) => {
                    headers.insert(name, value);
                    header_offset = next;
                }
                None => break,
            }
        }

        let payload_start = header_end;
        let payload_end = offset + total_length - 4;
        let payload_bytes = if payload_start < payload_end {
            &input[payload_start..payload_end]
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

        events.push(KiroEvent { event_type, payload });
        offset += total_length;
    }

    events
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
}

fn map_stop_reason(stop_reason: &str) -> String {
    match stop_reason {
        "TOOL_USE" => "tool_use".to_string(),
        "MAX_TOKENS" => "max_tokens".to_string(),
        _ => "end_turn".to_string(),
    }
}

/// 遍历事件，累积文本回复、停止原因与用量信息。
pub fn collect_kiro_text(events: &[KiroEvent]) -> CollectedText {
    let mut collected = CollectedText {
        stop_reason: "end_turn".to_string(),
        ..Default::default()
    };

    for event in events {
        match event.event_type.as_str() {
            "assistantResponseEvent" => {
                if let Some(content) = event.payload.get("content").and_then(|v| v.as_str()) {
                    collected.text.push_str(content);
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

    collected
}
