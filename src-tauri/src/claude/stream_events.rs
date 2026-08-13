use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use tauri::{AppHandle, Emitter};

use crate::history::{Conversation, Message};
use crate::protocol_guard::ProtocolTextGuard;

#[derive(Debug, Serialize, Deserialize, Clone)]
pub(crate) struct SessionEventPayload {
    pub(crate) conversation_id: String,
    pub(crate) title: String,
    pub(crate) messages: Vec<Message>,
    pub(crate) project_dir: Option<String>,
    pub(crate) updated_at: i64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) context_tokens: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) last_model: Option<String>,
}

/// 流式消息块，参考 claudecodeui 的 NormalizedMessage.kind
#[derive(Debug, Serialize, Deserialize, Clone)]
pub(crate) struct MessageChunkPayload {
    pub(crate) conversation_id: String,
    pub(crate) kind: String,
    pub(crate) content: String,
}

/// 对 Claude stream-json 再做一层保护，避免异常协议文本直接灌入 WebView。
#[derive(Default)]
pub(crate) struct ProtocolLeakGuard {
    text: ProtocolTextGuard,
    recovery_needed: bool,
}

impl ProtocolLeakGuard {
    fn filter_text_delta(&mut self, text: &str) -> String {
        let visible = self.text.push(text);
        if self.text.detected() {
            self.recovery_needed = true;
        }
        visible
    }

    fn finish_text_block(&mut self) -> String {
        self.text.finish()
    }

    fn mark_stop_reason(&mut self, stop_reason: &str) {
        if stop_reason == "max_tokens" {
            self.recovery_needed = true;
        }
    }

    pub(crate) fn recovery_needed(&self) -> bool {
        self.recovery_needed
    }

    pub(crate) fn take_recovery_needed(&mut self) -> bool {
        let needed = self.recovery_needed;
        self.text.reset();
        self.recovery_needed = false;
        needed
    }
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SessionErrorPayload {
    pub(crate) conversation_id: Option<String>,
    pub(crate) error: String,
}

pub(crate) enum StreamOutcome {
    Success(Option<String>),
    Failed {
        session_id: Option<String>,
        error: String,
    },
}

pub(crate) fn conversation_to_payload(conv: &Conversation) -> SessionEventPayload {
    SessionEventPayload {
        conversation_id: conv.id.clone(),
        title: conv.title.clone(),
        messages: conv.messages.clone(),
        project_dir: conv.project_dir.clone(),
        updated_at: conv.updated_at,
        context_tokens: conv.context_tokens,
        last_model: conv.last_model.clone(),
    }
}

pub(crate) fn emit_message_chunk(app: &AppHandle, conversation_id: &str, kind: &str, content: &str) {
    let payload = MessageChunkPayload {
        conversation_id: conversation_id.to_string(),
        kind: kind.to_string(),
        content: content.to_string(),
    };
    let _ = app.emit("message-chunk", &payload);
}

pub(crate) fn emit_session_error(app: &AppHandle, conversation_id: Option<&str>, error: &str) {
    let trimmed = error.trim();
    if trimmed.is_empty() {
        return;
    }
    let payload = SessionErrorPayload {
        conversation_id: conversation_id.map(|id| id.to_string()),
        error: trimmed.to_string(),
    };
    let _ = app.emit("session-error", &payload);
}

pub(crate) fn is_api_error_text(text: &str) -> bool {
    let trimmed = text.trim();
    trimmed.starts_with("API Error:")
        || trimmed.starts_with("Error:")
        || trimmed.contains("authentication_error")
        || trimmed.contains("rate_limit_error")
        || trimmed.contains("overloaded_error")
}

pub(crate) fn extract_result_error(value: &serde_json::Value) -> String {
    if let Some(result) = value.get("result").and_then(|v| v.as_str()) {
        if !result.trim().is_empty() {
            return result.trim().to_string();
        }
    }
    if let Some(errors) = value.get("errors").and_then(|v| v.as_array()) {
        let joined = errors
            .iter()
            .filter_map(|item| item.as_str())
            .collect::<Vec<_>>()
            .join("\n");
        if !joined.is_empty() {
            return joined;
        }
    }
    value
        .get("error")
        .and_then(|v| v.as_str())
        .map(|s| s.to_string())
        .unwrap_or_else(|| "模型调用失败".to_string())
}

pub(crate) fn extract_top_level_error(value: &serde_json::Value) -> Option<String> {
    let error_value = value.get("error")?;
    if let Some(message) = error_value.as_str() {
        return Some(message.trim().to_string());
    }
    if let Some(message) = error_value
        .get("message")
        .and_then(|v| v.as_str())
    {
        return Some(message.trim().to_string());
    }
    None
}

pub(crate) fn extract_assistant_text(value: &serde_json::Value) -> Option<String> {
    value
        .get("message")
        .and_then(|message| message.get("content"))
        .and_then(|content| content.as_array())
        .and_then(|blocks| {
            blocks.iter().find_map(|block| {
                if block.get("type").and_then(|t| t.as_str()) == Some("text") {
                    block.get("text").and_then(|t| t.as_str()).map(str::trim).filter(|t| !t.is_empty())
                } else {
                    None
                }
            })
        })
        .map(|text| text.to_string())
}

pub(crate) fn record_stream_error(
    stream_error: &mut Option<String>,
    app: &AppHandle,
    session_id: Option<&str>,
    error: String,
) {
    if error.trim().is_empty() {
        return;
    }
    if let Some(sid) = session_id.filter(|id| !id.is_empty()) {
        emit_message_chunk(app, sid, "error", &error);
    }
    emit_session_error(app, session_id, &error);
    *stream_error = Some(error);
}

pub(crate) fn resolve_stream_session_id(
    captured: &Option<String>,
    value: &serde_json::Value,
) -> Option<String> {
    captured.clone().or_else(|| {
        value
            .get("session_id")
            .and_then(|s| s.as_str())
            .map(|s| s.to_string())
    })
}

pub(crate) struct ParsedPermissionRequest {
    pub(crate) request_id: String,
    pub(crate) tool_name: String,
    pub(crate) input: serde_json::Value,
    pub(crate) description: Option<String>,
}

/// 解析 stream-json 中的工具权限请求（control_request / sdk_control_request）
pub(crate) fn try_parse_permission_request(line: &str) -> Option<ParsedPermissionRequest> {
    let value: serde_json::Value = serde_json::from_str(line).ok()?;
    let typ = value.get("type").and_then(|t| t.as_str()).unwrap_or("");
    if typ != "control_request" && typ != "sdk_control_request" {
        return None;
    }

    let request = value.get("request")?;
    let subtype = request.get("subtype").and_then(|s| s.as_str()).unwrap_or("");
    // 兼容 can_use_tool / permission 两种 subtype
    if subtype != "can_use_tool" && subtype != "permission" {
        return None;
    }

    let request_id = value
        .get("request_id")
        .and_then(|v| v.as_str())
        .or_else(|| request.get("request_id").and_then(|v| v.as_str()))?
        .to_string();
    let tool_name = request
        .get("tool_name")
        .and_then(|v| v.as_str())
        .unwrap_or("Tool")
        .to_string();
    let input = request
        .get("input")
        .cloned()
        .or_else(|| request.get("tool_input").cloned())
        .unwrap_or_else(|| serde_json::json!({}));
    let description = request
        .get("description")
        .and_then(|v| v.as_str())
        .map(|s| s.to_string());

    Some(ParsedPermissionRequest {
        request_id,
        tool_name,
        input,
        description,
    })
}

/// 本轮对话是否已结束（stream-json 在 stdin 常开时不会自动退出进程）
pub(crate) fn is_stream_turn_complete(line: &str) -> bool {
    serde_json::from_str::<serde_json::Value>(line)
        .ok()
        .and_then(|v| v.get("type").and_then(|t| t.as_str()).map(|t| t == "result"))
        .unwrap_or(false)
}

/// 解析 claude --output-format stream-json 的 NDJSON 行
pub(crate) fn process_claude_stream_line(
    line: &str,
    app: &AppHandle,
    captured_session_id: &mut Option<String>,
    block_types: &mut HashMap<usize, String>,
    protocol_guard: &mut ProtocolLeakGuard,
    stream_error: &mut Option<String>,
) {
    let value: serde_json::Value = match serde_json::from_str(line) {
        Ok(v) => v,
        Err(_) => return,
    };

    let typ = value.get("type").and_then(|t| t.as_str()).unwrap_or("");

    match typ {
        "error" => {
            if let Some(error) = extract_top_level_error(&value) {
                let sid = resolve_stream_session_id(captured_session_id, &value);
                record_stream_error(stream_error, app, sid.as_deref(), error);
            }
        }
        "system" => {
            match value.get("subtype").and_then(|s| s.as_str()) {
                Some("init") => {
                    if let Some(sid) = value.get("session_id").and_then(|s| s.as_str()) {
                        *captured_session_id = Some(sid.to_string());
                        let cwd = value
                            .get("cwd")
                            .and_then(|c| c.as_str())
                            .unwrap_or("");
                        emit_message_chunk(app, sid, "session_created", cwd);
                    }
                }
                Some("api_retry") => {
                    let sid = resolve_stream_session_id(captured_session_id, &value);
                    let error_status = value.get("error_status").and_then(|v| v.as_u64());
                    let error_code = value
                        .get("error")
                        .and_then(|v| v.as_str())
                        .unwrap_or("unknown_error");
                    let attempt = value.get("attempt").and_then(|v| v.as_u64()).unwrap_or(0);
                    let max_retries = value.get("max_retries").and_then(|v| v.as_u64()).unwrap_or(10);

                    let retry_msg = format!(
                        "API 请求失败（HTTP {} / {}），正在重试 {}/{}...",
                        error_status
                            .map(|status| status.to_string())
                            .unwrap_or_else(|| "?".to_string()),
                        error_code,
                        attempt,
                        max_retries
                    );
                    if let Some(sid) = sid.as_ref() {
                        emit_message_chunk(app, sid, "api_retry", &retry_msg);
                    }

                    if matches!(error_status, Some(401 | 403))
                        || error_code == "authentication_failed"
                    {
                        let error_msg = format!(
                            "API 认证失败（HTTP {}）：{}，请检查 API Key 和 Base URL 是否正确",
                            error_status.unwrap_or(401),
                            error_code
                        );
                        record_stream_error(stream_error, app, sid.as_deref(), error_msg);
                    }
                }
                _ => {}
            }
        }
        "stream_event" => {
            let sid = match resolve_stream_session_id(captured_session_id, &value) {
                Some(s) => s,
                None => return,
            };

            let event = match value.get("event") {
                Some(e) => e,
                None => return,
            };
            let event_type = event.get("type").and_then(|t| t.as_str()).unwrap_or("");

            match event_type {
                "content_block_start" => {
                    if let Some(block_type) = event
                        .get("content_block")
                        .and_then(|b| b.get("type"))
                        .and_then(|t| t.as_str())
                    {
                        let index = event.get("index").and_then(|i| i.as_u64()).unwrap_or(0) as usize;
                        block_types.insert(index, block_type.to_string());
                        let kind = if block_type == "thinking" {
                            "thinking_start"
                        } else if block_type == "text" {
                            "text_start"
                        } else {
                            return;
                        };
                        emit_message_chunk(app, &sid, kind, "");
                    }
                }
                "content_block_delta" => {
                    let delta = match event.get("delta") {
                        Some(d) => d,
                        None => return,
                    };
                    match delta.get("type").and_then(|t| t.as_str()) {
                        Some("thinking_delta") => {
                            if let Some(text) = delta.get("thinking").and_then(|t| t.as_str()) {
                                if !text.is_empty() {
                                    emit_message_chunk(app, &sid, "thinking_delta", text);
                                }
                            }
                        }
                        Some("text_delta") => {
                            if let Some(text) = delta.get("text").and_then(|t| t.as_str()) {
                                if !text.is_empty() {
                                    if is_api_error_text(text) {
                                        let sid = resolve_stream_session_id(captured_session_id, &value);
                                        record_stream_error(
                                            stream_error,
                                            app,
                                            sid.as_deref(),
                                            text.trim().to_string(),
                                        );
                                    } else {
                                        let visible = protocol_guard.filter_text_delta(text);
                                        if !visible.is_empty() {
                                            emit_message_chunk(app, &sid, "text_delta", &visible);
                                        }
                                    }
                                }
                            }
                        }
                        _ => {}
                    }
                }
                "content_block_stop" => {
                    let index = event.get("index").and_then(|i| i.as_u64()).unwrap_or(0) as usize;
                    let kind = match block_types.get(&index).map(|s| s.as_str()) {
                        Some("thinking") => "thinking_end",
                        Some("text") => {
                            let trailing = protocol_guard.finish_text_block();
                            if !trailing.is_empty() {
                                emit_message_chunk(app, &sid, "text_delta", &trailing);
                            }
                            "text_end"
                        }
                        _ => return,
                    };
                    emit_message_chunk(app, &sid, kind, "");
                    block_types.remove(&index);
                }
                "message_stop" => {
                    emit_message_chunk(app, &sid, "stream_end", "");
                }
                "message_delta" => {
                    if let Some(stop_reason) = event
                        .get("delta")
                        .and_then(|delta| delta.get("stop_reason"))
                        .and_then(|reason| reason.as_str())
                    {
                        protocol_guard.mark_stop_reason(stop_reason);
                    }
                }
                _ => {}
            }
        }
        "assistant" => {
            if let Some(text) = extract_assistant_text(&value) {
                if is_api_error_text(&text) {
                    let sid = resolve_stream_session_id(captured_session_id, &value);
                    record_stream_error(stream_error, app, sid.as_deref(), text);
                }
            }
        }
        "result" => {
            if value.get("is_error").and_then(|v| v.as_bool()) == Some(true) {
                let sid = resolve_stream_session_id(captured_session_id, &value);
                let error = extract_result_error(&value);
                record_stream_error(stream_error, app, sid.as_deref(), error);
                return;
            }
            // complete 由 spawn 在确认不会自动续跑后再发，避免 recovery 路径先收尾再续写
        }
        _ => {}
    }
}

#[cfg(test)]
mod tests {
    use super::ProtocolLeakGuard;

    #[test]
    fn protocol_guard_filters_split_internal_route() {
        let mut guard = ProtocolLeakGuard::default();
        let mut visible = guard.filter_text_delta("有效正文\nassistant to=func");
        visible.push_str(&guard.filter_text_delta("tions.Bash (commentary)\nNo."));
        visible.push_str(&guard.finish_text_block());

        assert_eq!(visible, "有效正文\n");
        assert!(guard.take_recovery_needed());
    }

    #[test]
    fn max_tokens_requests_one_controlled_recovery() {
        let mut guard = ProtocolLeakGuard::default();
        guard.mark_stop_reason("max_tokens");

        assert!(guard.take_recovery_needed());
        assert!(!guard.take_recovery_needed());
    }
}
