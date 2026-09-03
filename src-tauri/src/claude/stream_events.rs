use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use std::time::Instant;
use tauri::{AppHandle, Emitter};

use crate::history::{Conversation, Message};
use crate::protocol_guard::ProtocolTextGuard;
use crate::usage::{accumulate_session_usage, add_session_cost, SessionUsage};

#[derive(Debug, Serialize, Deserialize, Clone)]
pub(crate) struct SessionEventPayload {
    pub(crate) conversation_id: String,
    pub(crate) title: String,
    pub(crate) messages: Vec<Message>,
    pub(crate) project_dir: Option<String>,
    pub(crate) source_path: Option<String>,
    pub(crate) updated_at: i64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) context_tokens: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) last_model: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) usage: Option<SessionUsage>,
}

/// 流式消息块，参考 claudecodeui 的 NormalizedMessage.kind
#[derive(Debug, Serialize, Deserialize, Clone)]
pub(crate) struct MessageChunkPayload {
    pub(crate) conversation_id: String,
    pub(crate) kind: String,
    pub(crate) content: String,
    #[serde(rename = "runId", skip_serializing_if = "Option::is_none")]
    pub(crate) run_id: Option<String>,
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
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) code: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) recoverable: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) technical: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) detail: Option<String>,
}

pub(crate) enum StreamOutcome {
    Success(Option<String>),
    Cancelled(Option<String>),
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
        source_path: conv.source_path.clone(),
        updated_at: conv.updated_at,
        context_tokens: conv.context_tokens,
        last_model: conv.last_model.clone(),
        usage: conv.usage.clone(),
    }
}

pub(crate) fn emit_message_chunk(app: &AppHandle, conversation_id: &str, kind: &str, content: &str) {
    emit_message_chunk_for_run(app, conversation_id, kind, content, None);
}

fn emit_message_chunk_for_run(
    app: &AppHandle,
    conversation_id: &str,
    kind: &str,
    content: &str,
    run_id: Option<&str>,
) {
    let payload = MessageChunkPayload {
        conversation_id: conversation_id.to_string(),
        kind: kind.to_string(),
        content: content.to_string(),
        run_id: run_id.map(str::to_string),
    };
    let _ = app.emit("message-chunk", &payload);
}

/// 流式 tool_use 块累积（所有工具都会 emit 到前端，供实时工具卡展示）
#[derive(Debug, Clone, Default)]
pub(crate) struct ToolUseBlockState {
    pub(crate) id: String,
    pub(crate) name: String,
    pub(crate) input_json: String,
}

fn tool_result_content_to_string(content: &serde_json::Value) -> String {
    match content {
        serde_json::Value::String(s) => s.clone(),
        serde_json::Value::Array(items) => items
            .iter()
            .filter_map(|item| {
                if let Some(text) = item.get("text").and_then(|t| t.as_str()) {
                    Some(text.to_string())
                } else if let Some(s) = item.as_str() {
                    Some(s.to_string())
                } else {
                    Some(item.to_string())
                }
            })
            .collect::<Vec<_>>()
            .join("\n"),
        other => other.to_string(),
    }
}

/// 子代理「启动成功」元数据结果（新版 Claude Code 的 Task/Agent 异步启动时，
/// 主链立即收到 "Async agent launched successfully" 这类 tool_result）。
/// 它不是子代理的完成结果：不能作为前端「完成」信号，也不能把子代理从未决集合移除。
pub(crate) fn is_subagent_launch_metadata(result_text: &str) -> bool {
    let t = result_text.trim();
    t.contains("Async agent launched successfully")
        || t.contains("launched successfully")
        || t.contains("internal metadata")
        || t.contains("agentId:")
}

/// 流式 tool_result 下发：所有工具结果都实时发给前端（实时工具卡展示完成态/错误态）。
/// Task/Agent 的子代理结果额外从未决集合移除，允许主链 result 触发 turn-complete；
/// 子代理「启动成功」的元数据结果除外——它不表示子代理完成。
fn emit_tool_result_if_any(
    app: &AppHandle,
    sid: &str,
    value: &serde_json::Value,
    known_task_ids: &HashSet<String>,
    outstanding_task_ids: &mut HashSet<String>,
) {
    let message = match value.get("message") {
        Some(m) => m,
        None => return,
    };
    let content = match message.get("content").and_then(|c| c.as_array()) {
        Some(arr) => arr,
        None => return,
    };
    for item in content {
        if item.get("type").and_then(|t| t.as_str()) != Some("tool_result") {
            continue;
        }
        let tool_use_id = item
            .get("tool_use_id")
            .and_then(|v| v.as_str())
            .unwrap_or("");
        if tool_use_id.is_empty() {
            continue;
        }
        let is_error = item
            .get("is_error")
            .and_then(|v| v.as_bool())
            .unwrap_or(false);
        let result_text = item
            .get("content")
            .map(tool_result_content_to_string)
            .unwrap_or_default();
        // 子代理启动元数据（"Async agent launched successfully"）：不表示完成，
        // 不下发前端（避免实时卡误显"完成"）、不移除未决集合（子代理仍在运行）。
        if !is_error && is_subagent_launch_metadata(&result_text) {
            continue;
        }
        // 子代理结果已回：从未决集合中移除，允许主链 result 触发 turn-complete
        if known_task_ids.contains(tool_use_id) {
            outstanding_task_ids.remove(tool_use_id);
        }
        let payload = serde_json::json!({
            "tool_use_id": tool_use_id,
            "content": result_text,
            "is_error": is_error,
        });
        emit_message_chunk(app, sid, "tool_result", &payload.to_string());
    }
}

pub(crate) fn emit_session_error(app: &AppHandle, conversation_id: Option<&str>, error: &str) {
    emit_structured_session_error(app, conversation_id, error, None, None, None, None);
}

pub(crate) fn emit_structured_session_error(
    app: &AppHandle,
    conversation_id: Option<&str>,
    error: &str,
    code: Option<&str>,
    recoverable: Option<bool>,
    technical: Option<bool>,
    detail: Option<&str>,
) {
    let trimmed = error.trim();
    if trimmed.is_empty() {
        return;
    }
    let payload = SessionErrorPayload {
        conversation_id: conversation_id.map(str::to_string),
        error: trimmed.to_string(),
        code: code.map(str::to_string),
        recoverable,
        technical,
        detail: detail
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(str::to_string),
    };
    let _ = app.emit("session-error", &payload);
}

const EDE_DIAGNOSTIC_MARKER: &str = "[ede_diagnostic]";
const CLAUDE_DERIVED_DIAGNOSTIC_CODE: &str = "claude_derived_diagnostic";
const KIRO_INVALID_TOOL_STREAM_CODE: &str = "kiro_invalid_tool_stream";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum StreamErrorClassification {
    Ordinary,
    ClaudeDerivedDiagnostic,
    KiroInvalidToolStream,
}

pub(crate) fn classify_stream_error(
    error: &str,
    has_primary_error: bool,
) -> Option<StreamErrorClassification> {
    let trimmed = error.trim();
    if trimmed.is_empty() {
        return None;
    }
    if trimmed.contains(EDE_DIAGNOSTIC_MARKER) {
        return Some(if has_primary_error {
            StreamErrorClassification::ClaudeDerivedDiagnostic
        } else {
            StreamErrorClassification::KiroInvalidToolStream
        });
    }
    Some(StreamErrorClassification::Ordinary)
}

#[derive(Debug, Clone)]
struct RecordedStreamError {
    error: String,
    classification: StreamErrorClassification,
}

/// Collects all error-shaped records for one stream turn and exposes one primary failure.
/// Claude Code can append `[ede_diagnostic]` to an upstream error in its final `result`;
/// that record is retained as technical context but never replaces or re-emits the primary.
#[derive(Debug, Default)]
pub(crate) struct StreamErrorState {
    primary: Option<RecordedStreamError>,
    technical_diagnostics: Vec<String>,
}

impl StreamErrorState {
    pub(crate) fn is_some(&self) -> bool {
        self.primary.is_some()
    }

    pub(crate) fn error(&self) -> Option<&str> {
        self.primary.as_ref().map(|primary| primary.error.as_str())
    }

    pub(crate) fn record(&mut self, error: impl Into<String>) {
        let error = error.into();
        let trimmed = error.trim();
        if trimmed.is_empty() {
            return;
        }

        // Some result implementations concatenate the upstream failure and the final Claude
        // diagnostic. Treat the prefix as the primary and retain the marker section as technical.
        if let Some(marker_index) = trimmed.find(EDE_DIAGNOSTIC_MARKER) {
            let primary_prefix = trimmed[..marker_index]
                .trim()
                .trim_end_matches(['\n', '\r', ':', '-', '—'])
                .trim();
            if !primary_prefix.is_empty() {
                self.record_classified(
                    primary_prefix,
                    StreamErrorClassification::Ordinary,
                );
            }
            let diagnostic = trimmed[marker_index..].trim();
            let classification = classify_stream_error(diagnostic, self.primary.is_some())
                .expect("non-empty ede diagnostic");
            self.record_classified(diagnostic, classification);
            return;
        }

        self.record_classified(trimmed, StreamErrorClassification::Ordinary);
    }

    fn record_classified(&mut self, error: &str, classification: StreamErrorClassification) {
        match classification {
            StreamErrorClassification::ClaudeDerivedDiagnostic => {
                eprintln!("[claude] {CLAUDE_DERIVED_DIAGNOSTIC_CODE}: {error}");
                if !self
                    .technical_diagnostics
                    .iter()
                    .any(|diagnostic| diagnostic == error)
                {
                    self.technical_diagnostics.push(error.to_string());
                }
            }
            StreamErrorClassification::KiroInvalidToolStream => {
                eprintln!("[claude] {KIRO_INVALID_TOOL_STREAM_CODE}: {error}");
                self.primary = Some(RecordedStreamError {
                    error: error.to_string(),
                    classification,
                });
            }
            StreamErrorClassification::Ordinary => match self.primary.as_ref() {
                None => {
                    self.primary = Some(RecordedStreamError {
                        error: error.to_string(),
                        classification,
                    });
                }
                Some(primary)
                    if primary.classification
                        == StreamErrorClassification::KiroInvalidToolStream =>
                {
                    // A diagnostic received before its actual upstream error is not standalone.
                    let diagnostic = primary.error.clone();
                    self.primary = Some(RecordedStreamError {
                        error: error.to_string(),
                        classification,
                    });
                    if !self.technical_diagnostics.contains(&diagnostic) {
                        self.technical_diagnostics.push(diagnostic);
                    }
                }
                Some(_) => {
                    // Preserve the first real stream error as the StreamOutcome failure.
                    // Repeated result/assistant forms of the same failure do not emit again.
                }
            },
        }
    }

    fn detail(&self) -> Option<String> {
        if self.technical_diagnostics.is_empty() {
            return self
                .primary
                .as_ref()
                .filter(|primary| {
                    primary.classification == StreamErrorClassification::KiroInvalidToolStream
                })
                .map(|primary| primary.error.clone());
        }
        Some(
            self.technical_diagnostics
                .iter()
                .map(|diagnostic| {
                    format!("{CLAUDE_DERIVED_DIAGNOSTIC_CODE}: {diagnostic}")
                })
                .collect::<Vec<_>>()
                .join("\n"),
        )
    }

    fn payload(&self, conversation_id: Option<&str>) -> Option<SessionErrorPayload> {
        let primary = self.primary.as_ref()?;
        let code = match primary.classification {
            StreamErrorClassification::KiroInvalidToolStream => {
                Some(KIRO_INVALID_TOOL_STREAM_CODE.to_string())
            }
            _ => None,
        };
        Some(SessionErrorPayload {
            conversation_id: conversation_id.map(str::to_string),
            error: primary.error.clone(),
            code,
            recoverable: None,
            technical: None,
            detail: self.detail(),
        })
    }

    pub(crate) fn emit(&self, app: &AppHandle, conversation_id: Option<&str>) {
        let Some(payload) = self.payload(conversation_id) else {
            return;
        };
        // 最终错误只走结构化 session-error。避免 message-chunk(error) 先清理一次、
        // session-error 再落卡一次，造成重复刷新与衍生诊断竞态。
        let _ = app.emit("session-error", &payload);
    }
}

pub(crate) fn is_api_error_text(text: &str) -> bool {
    let trimmed = text.trim();
    trimmed.starts_with("API Error:")
        || trimmed.starts_with("Error:")
        || trimmed.contains("authentication_error")
        || trimmed.contains("rate_limit_error")
        || trimmed.contains("overloaded_error")
        || trimmed.contains(EDE_DIAGNOSTIC_MARKER)
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

/// 取 assistant 事件的全部文本块（`\n\n` 拼接）。
/// 与 `extract_assistant_text`（只取首块）不同：多文本块消息的最终报告需整块覆盖判断。
pub(crate) fn extract_full_assistant_text(value: &serde_json::Value) -> Option<String> {
    let blocks = value
        .get("message")
        .and_then(|message| message.get("content"))
        .and_then(|content| content.as_array())?;
    let texts: Vec<&str> = blocks
        .iter()
        .filter_map(|block| {
            if block.get("type").and_then(|t| t.as_str()) == Some("text") {
                block
                    .get("text")
                    .and_then(|t| t.as_str())
                    .map(str::trim)
                    .filter(|t| !t.is_empty())
            } else {
                None
            }
        })
        .collect();
    if texts.is_empty() {
        return None;
    }
    Some(texts.join("\n\n"))
}

/// 是否为子代理（sidechain）事件。启用 --include-partial-messages 后子代理的
/// assistant / result 也会进入父流，但带非空 parent_tool_use_id 或 isSidechain 标记；
/// 这些文本不会落入本会话 JSONL 的主链，不能用于「最终回复已落盘」的判断。
fn is_sidechain_event(value: &serde_json::Value) -> bool {
    for key in ["parent_tool_use_id", "parentToolUseId", "is_sidechain", "isSidechain"] {
        match value.get(key) {
            Some(v) if v.is_string() && v.as_str().is_some_and(|s| !s.is_empty()) => return true,
            Some(v) if v.as_bool() == Some(true) => return true,
            _ => {}
        }
    }
    false
}

pub(crate) fn record_stream_error(stream_error: &mut StreamErrorState, error: String) {
    stream_error.record(error);
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

/// result 事件是否属于主链（parent_tool_use_id 为空 / 不存在）。
/// 启用 --include-partial-messages 后，子代理的 result 也会进入父流，
/// 但其消息带非空 parent_tool_use_id；只有主链 result 才能作为「本轮结束」信号。
pub(crate) fn is_main_stream_result(line: &str) -> bool {
    let Ok(value) = serde_json::from_str::<serde_json::Value>(line) else {
        return false;
    };
    if value.get("type").and_then(|t| t.as_str()) != Some("result") {
        return false;
    }
    match value.get("parent_tool_use_id") {
        None => true,
        Some(serde_json::Value::Null) => true,
        Some(_) => false,
    }
}

/// 所有工具的 tool_use 块都流式累积 input（实时工具卡需要展示输入快照）。

/// system 事件的字段可能挂在顶层，防御性取值。
fn system_event_field<'a>(value: &'a serde_json::Value, field: &str) -> Option<&'a serde_json::Value> {
    value.get(field)
}

/// 解析 claude --output-format stream-json 的 NDJSON 行
pub(crate) fn process_claude_stream_line(
    line: &str,
    app: &AppHandle,
    run_id: &str,
    captured_session_id: &mut Option<String>,
    block_types: &mut HashMap<usize, String>,
    tool_use_blocks: &mut HashMap<usize, ToolUseBlockState>,
    known_task_ids: &mut HashSet<String>,
    outstanding_task_ids: &mut HashSet<String>,
    protocol_guard: &mut ProtocolLeakGuard,
    stream_error: &mut StreamErrorState,
    last_assistant_text: &mut Option<String>,
    thinking_started_at: &mut Option<Instant>,
) {
    let value: serde_json::Value = match serde_json::from_str(line) {
        Ok(v) => v,
        Err(_) => return,
    };

    let typ = value.get("type").and_then(|t| t.as_str()).unwrap_or("");

    match typ {
        "error" => {
            if let Some(error) = extract_top_level_error(&value) {
                record_stream_error(stream_error, error);
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
                        emit_message_chunk_for_run(app, sid, "session_created", cwd, Some(run_id));
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
                        record_stream_error(stream_error, error_msg);
                    }
                }
                Some("task_started") => {
                    let sid = resolve_stream_session_id(captured_session_id, &value);
                    if let Some(sid) = sid {
                        let tool_use_id = system_event_field(&value, "tool_use_id")
                            .and_then(|v| v.as_str())
                            .unwrap_or("")
                            .to_string();
                        let task_id = system_event_field(&value, "task_id")
                            .and_then(|v| v.as_str())
                            .unwrap_or("")
                            .to_string();
                        let description = system_event_field(&value, "description")
                            .and_then(|v| v.as_str())
                            .unwrap_or("")
                            .to_string();
                        let prompt = system_event_field(&value, "prompt")
                            .and_then(|v| v.as_str())
                            .unwrap_or("")
                            .to_string();
                        let payload = serde_json::json!({
                            "tool_use_id": tool_use_id,
                            "task_id": task_id,
                            "description": description,
                            "prompt": prompt,
                        });
                        emit_message_chunk(app, &sid, "task_started", &payload.to_string());
                    }
                }
                Some("task_notification") => {
                    let sid = resolve_stream_session_id(captured_session_id, &value);
                    if let Some(sid) = sid {
                        let tool_use_id = system_event_field(&value, "tool_use_id")
                            .and_then(|v| v.as_str())
                            .unwrap_or("")
                            .to_string();
                        let task_id = system_event_field(&value, "task_id")
                            .and_then(|v| v.as_str())
                            .unwrap_or("")
                            .to_string();
                        let status = system_event_field(&value, "status")
                            .and_then(|v| v.as_str())
                            .unwrap_or("")
                            .to_string();
                        // CLI 可能下发 completed/failed/stopped，旧版也可能是 success/error
                        let is_terminal = matches!(
                            status.as_str(),
                            "completed" | "success" | "failed" | "error" | "stopped"
                        );
                        // 兜底：子代理终态通知即视为完成，避免 tool_result 偶发未匹配时卡死
                        if is_terminal {
                            if !tool_use_id.is_empty() {
                                outstanding_task_ids.remove(&tool_use_id);
                            }
                        }
                        // usage 可能嵌套在 usage 对象内，也可能平铺在顶层
                        let usage = system_event_field(&value, "usage");
                        let total_tokens = usage
                            .and_then(|u| u.get("total_tokens"))
                            .and_then(|v| v.as_u64())
                            .or_else(|| {
                                system_event_field(&value, "total_tokens").and_then(|v| v.as_u64())
                            })
                            .unwrap_or(0);
                        let tool_uses = usage
                            .and_then(|u| u.get("tool_uses"))
                            .and_then(|v| v.as_u64())
                            .or_else(|| {
                                system_event_field(&value, "tool_uses").and_then(|v| v.as_u64())
                            })
                            .unwrap_or(0);
                        let duration_ms = usage
                            .and_then(|u| u.get("duration_ms"))
                            .and_then(|v| v.as_u64())
                            .or_else(|| {
                                system_event_field(&value, "duration_ms").and_then(|v| v.as_u64())
                            })
                            .unwrap_or(0);
                        let payload = serde_json::json!({
                            "tool_use_id": tool_use_id,
                            "task_id": task_id,
                            "status": status,
                            "total_tokens": total_tokens,
                            "tool_uses": tool_uses,
                            "duration_ms": duration_ms,
                        });
                        emit_message_chunk(app, &sid, "task_progress", &payload.to_string());
                    }
                }
                _ => {}
            }
        }
        "user" => {
            if let Some(sid) = resolve_stream_session_id(captured_session_id, &value) {
                emit_tool_result_if_any(app, &sid, &value, known_task_ids, outstanding_task_ids);
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
                "message_start" => {
                    // 输入 / 缓存 token 在 message_start 一次性给出；output 由最终 message_delta 累计
                    if let Some(usage) = event.get("message").and_then(|m| m.get("usage")) {
                        let input_tokens =
                            usage.get("input_tokens").and_then(|v| v.as_u64()).unwrap_or(0);
                        let cache_read = usage
                            .get("cache_read_input_tokens")
                            .and_then(|v| v.as_u64())
                            .unwrap_or(0);
                        let cache_creation = usage
                            .get("cache_creation_input_tokens")
                            .and_then(|v| v.as_u64())
                            .unwrap_or(0);
                        accumulate_session_usage(&sid, input_tokens, 0, cache_read, cache_creation);
                    }
                }
                "content_block_start" => {
                    if let Some(block) = event.get("content_block") {
                        let block_type = block.get("type").and_then(|t| t.as_str()).unwrap_or("");
                        let index = event.get("index").and_then(|i| i.as_u64()).unwrap_or(0) as usize;
                        block_types.insert(index, block_type.to_string());
                        if block_type == "thinking" {
                            *thinking_started_at = Some(Instant::now());
                            emit_message_chunk(app, &sid, "thinking_start", "");
                        } else if block_type == "text" {
                            emit_message_chunk(app, &sid, "text_start", "");
                        } else if block_type == "tool_use" {
                            let id = block
                                .get("id")
                                .and_then(|v| v.as_str())
                                .unwrap_or("")
                                .to_string();
                            let name = block
                                .get("name")
                                .and_then(|v| v.as_str())
                                .unwrap_or("")
                                .to_string();
                            tool_use_blocks.insert(
                                index,
                                ToolUseBlockState {
                                    id: id.clone(),
                                    name: name.clone(),
                                    input_json: String::new(),
                                },
                            );
                            // 所有工具都下发 tool_use_start：前端据此实时创建工具卡。
                            // 无 id 的（罕见）跳过实时卡，落盘后仍由历史渲染展示。
                            if !id.is_empty() {
                                // Task/Agent 都是子代理：纳入 known 集合，
                                // 其运行期间主链 result 不得触发 turn-complete。
                                if name == "Task" || name == "Agent" {
                                    known_task_ids.insert(id.clone());
                                }
                                let payload = serde_json::json!({
                                    "id": id,
                                    "name": name,
                                    "index": index,
                                });
                                emit_message_chunk(
                                    app,
                                    &sid,
                                    "tool_use_start",
                                    &payload.to_string(),
                                );
                            }
                        }
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
                                        record_stream_error(
                                            stream_error,
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
                        Some("input_json_delta") => {
                            let index =
                                event.get("index").and_then(|i| i.as_u64()).unwrap_or(0) as usize;
                            if let Some(partial) =
                                delta.get("partial_json").and_then(|v| v.as_str())
                            {
                                // 所有工具的 input 都累积：实时工具卡需要展示命令/路径/内容等输入
                                if let Some(block) = tool_use_blocks.get_mut(&index) {
                                    block.input_json.push_str(partial);
                                }
                            }
                        }
                        _ => {}
                    }
                }
                "content_block_stop" => {
                    let index = event.get("index").and_then(|i| i.as_u64()).unwrap_or(0) as usize;
                    match block_types.get(&index).map(|s| s.as_str()) {
                        Some("thinking") => {
                            // 思考块结束：附带本次思考时长（ms），前端在思考块标题展示
                            let duration_ms = thinking_started_at
                                .take()
                                .map(|t| t.elapsed().as_millis() as u64)
                                .unwrap_or(0);
                            let payload = serde_json::json!({ "duration_ms": duration_ms });
                            emit_message_chunk(
                                app,
                                &sid,
                                "thinking_end",
                                &payload.to_string(),
                            );
                            block_types.remove(&index);
                        }
                        Some("text") => {
                            let trailing = protocol_guard.finish_text_block();
                            if !trailing.is_empty() {
                                emit_message_chunk(app, &sid, "text_delta", &trailing);
                            }
                            emit_message_chunk(app, &sid, "text_end", "");
                            block_types.remove(&index);
                        }
                        Some("tool_use") => {
                            if let Some(block) = tool_use_blocks.remove(&index) {
                                let input: serde_json::Value =
                                    serde_json::from_str(&block.input_json)
                                        .unwrap_or_else(|_| serde_json::json!({}));
                                if block.name == "Task" || block.name == "Agent" {
                                    // 主链 Task/Agent 已发出：其子代理结果未回前，
                                    // 主链 result 不视为本轮结束（异步子代理仍在运行）
                                    outstanding_task_ids.insert(block.id.clone());
                                } else if block.name == "TodoWrite" {
                                    // TodoWrite 协议为「整表替换」，直接透传完整 todos 给前端
                                    let todos = input
                                        .get("todos")
                                        .cloned()
                                        .unwrap_or_else(|| serde_json::json!([]));
                                    let todos_payload = serde_json::json!({
                                        "conversation_id": sid,
                                        "todos": todos,
                                    });
                                    emit_message_chunk(
                                        app,
                                        &sid,
                                        "todos_updated",
                                        &todos_payload.to_string(),
                                    );
                                }
                                // 所有工具都下发 tool_use_end：前端结束实时工具卡并展示完整输入
                                let payload = serde_json::json!({
                                    "id": block.id,
                                    "name": block.name,
                                    "input": input,
                                    "index": index,
                                });
                                emit_message_chunk(
                                    app,
                                    &sid,
                                    "tool_use_end",
                                    &payload.to_string(),
                                );
                            }
                            block_types.remove(&index);
                        }
                        _ => {
                            block_types.remove(&index);
                            tool_use_blocks.remove(&index);
                        }
                    }
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
                        // 仅带 stop_reason 的最终 message_delta 携带累计 output，且只出现一次，
                        // 避免中间 delta 的累计 output 被重复累加
                        if let Some(usage) = event.get("usage") {
                            let output_tokens =
                                usage.get("output_tokens").and_then(|v| v.as_u64()).unwrap_or(0);
                            if output_tokens > 0 {
                                accumulate_session_usage(&sid, 0, output_tokens, 0, 0);
                            }
                        }
                    }
                }
                _ => {}
            }
        }
        "assistant" => {
            if let Some(text) = extract_assistant_text(&value) {
                if is_api_error_text(&text) {
                    record_stream_error(stream_error, text);
                }
            }
            // 仅主链 assistant 事件更新“最终助手文本”；子代理文本不会落入本会话 JSONL 主链
            if !is_sidechain_event(&value) {
                if let Some(full) = extract_full_assistant_text(&value) {
                    *last_assistant_text = Some(full);
                }
            }
        }
        "result" => {
            // 主链 / 子代理 result 均携带 total_cost_usd，逐次累加（含子代理调用）
            if let Some(cost) = value.get("total_cost_usd").and_then(|v| v.as_f64()) {
                let sid = resolve_stream_session_id(captured_session_id, &value);
                if let Some(sid) = sid.as_deref() {
                    add_session_cost(sid, cost);
                }
            }
            if value.get("is_error").and_then(|v| v.as_bool()) == Some(true) {
                let error = extract_result_error(&value);
                record_stream_error(stream_error, error);
                return;
            }
            // complete 由 spawn 在确认不会自动续跑后再发，避免 recovery 路径先收尾再续写
        }
        _ => {}
    }
}

#[cfg(test)]
mod tests {
    use super::{
        classify_stream_error, is_subagent_launch_metadata, ProtocolLeakGuard,
        StreamErrorClassification, StreamErrorState, CLAUDE_DERIVED_DIAGNOSTIC_CODE,
        KIRO_INVALID_TOOL_STREAM_CODE,
    };

    const DIAGNOSTIC: &str =
        "[ede_diagnostic] result_type=user last_content_type=n/a stop_reason=null";

    #[test]
    fn primary_and_derived_diagnostic_keep_one_primary_payload() {
        let mut errors = StreamErrorState::default();
        errors.record("API Error: 502 Improperly formed request");
        errors.record(DIAGNOSTIC);

        let payload = errors.payload(Some("session-1")).expect("primary error");
        assert_eq!(payload.conversation_id.as_deref(), Some("session-1"));
        assert_eq!(payload.error, "API Error: 502 Improperly formed request");
        assert_eq!(payload.code, None);
        assert_eq!(payload.recoverable, None);
        assert_eq!(payload.technical, None);
        let detail = payload.detail.expect("derived technical diagnostic detail");
        assert!(detail.contains(CLAUDE_DERIVED_DIAGNOSTIC_CODE));
        assert!(detail.contains(DIAGNOSTIC));
    }

    #[test]
    fn standalone_diagnostic_is_kiro_invalid_tool_stream() {
        let mut errors = StreamErrorState::default();
        errors.record(DIAGNOSTIC);

        let payload = errors.payload(None).expect("diagnostic error");
        assert_eq!(payload.error, DIAGNOSTIC);
        assert_eq!(payload.code.as_deref(), Some(KIRO_INVALID_TOOL_STREAM_CODE));
        assert_eq!(payload.recoverable, None);
        assert_eq!(payload.technical, None);
        assert_eq!(payload.detail.as_deref(), Some(DIAGNOSTIC));
        assert_eq!(
            classify_stream_error(DIAGNOSTIC, false),
            Some(StreamErrorClassification::KiroInvalidToolStream)
        );
        assert_eq!(
            classify_stream_error(DIAGNOSTIC, true),
            Some(StreamErrorClassification::ClaudeDerivedDiagnostic)
        );
    }

    #[test]
    fn ordinary_stream_error_is_unchanged() {
        let mut errors = StreamErrorState::default();
        errors.record("Error: ordinary failure");
        errors.record("Error: ordinary failure");

        let payload = errors.payload(Some("session-2")).expect("ordinary error");
        assert_eq!(payload.error, "Error: ordinary failure");
        assert_eq!(payload.code, None);
        assert_eq!(payload.recoverable, None);
        assert_eq!(payload.technical, None);
        assert_eq!(payload.detail, None);
    }

    #[test]
    fn combined_primary_and_diagnostic_are_split() {
        let mut errors = StreamErrorState::default();
        errors.record(format!("API Error: 502 gateway failure\n{DIAGNOSTIC}"));

        let payload = errors.payload(None).expect("combined error");
        assert_eq!(payload.error, "API Error: 502 gateway failure");
        assert_eq!(payload.technical, None);
        assert!(payload
            .detail
            .as_deref()
            .is_some_and(|detail| detail.contains(DIAGNOSTIC)));
    }

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

    #[test]
    fn subagent_launch_metadata_is_recognized() {
        // 新版 Claude Code 的 Task/Agent 异步启动结果：是元数据，不是完成信号
        assert!(is_subagent_launch_metadata(
            "Async agent launched successfully. (This tool result is internal metadata — never quote or paste any part of it, including the agentId below, into a user-facing reply.)\nagentId: abc123 (internal ID)"
        ));
        assert!(is_subagent_launch_metadata("launched successfully"));
        // 普通工具结果 / 子代理真报告不是启动元数据
        assert!(!is_subagent_launch_metadata("file.txt"));
        assert!(!is_subagent_launch_metadata("## 报告\n\n正文"));
        assert!(!is_subagent_launch_metadata(""));
    }
}
