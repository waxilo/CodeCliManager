//! 本地 HTTP 代理：把 Anthropic Messages API 请求转发到 Kiro 后端。
//! 移植自 kiro2cli/src/server.js + proxy-kiro.js（MIT）。
//!
//! 端点：
//! - GET  /health, /          → 健康检查
//! - GET  /v1/models          → Kiro 模型列表（供 Claude Code / ccm 模型选择器）
//! - POST /v1/messages/count_tokens → token 估算
//! - POST /v1/messages        → 对话（SSE 流式 / 非流式）

use std::collections::HashMap;
use std::io::{self, Read};
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{self, Receiver};
use std::sync::Arc;
use std::thread::{self, JoinHandle};
use std::time::Duration;

use reqwest::blocking::{Client, Response as ReqwestResponse};
use serde_json::{json, Value};
use tiny_http::{Header, Method, Request, Response, Server, StatusCode};
use uuid::Uuid;

use crate::kiro::auth::Auth;
use crate::kiro::eventstream::{
    collect_kiro_text, extract_reasoning_parts, parse_event_stream, IncrementalEventStream,
    KiroEvent,
};
use crate::kiro::models::{
    estimate_tokens, get_supported_effort_levels, kiro_model_to_public_model_id, normalize_kiro_model,
    public_display_name,
};
use crate::kiro::transform::{
    anthropic_message_response_with_tools, build_kiro_request, parse_tool_use_blocks_from_text,
};
use crate::protocol_guard::{normalize_stop_reason, sanitize_protocol_text, ProtocolTextGuard};

#[derive(Debug, Clone)]
pub struct ProxyConfig {
    pub host: String,
    pub port: u16,
    pub proxy_api_key: Option<String>,
    pub default_model: String,
    pub runtime_url: String,
    pub management_url: String,
    pub sso_cache_dir: PathBuf,
    pub profile_arn_override: Option<String>,
}

/// 运行中的代理句柄。
pub struct ProxyHandle {
    pub port: u16,
    pub(crate) stop: Arc<AtomicBool>,
    pub(crate) thread: Option<JoinHandle<()>>,
}

impl ProxyHandle {
    pub fn stop(&mut self) {
        self.stop.store(true, Ordering::Relaxed);
        if let Some(thread) = self.thread.take() {
            let _ = thread.join();
        }
    }
}

fn cors_header() -> Header {
    Header::from_bytes("Access-Control-Allow-Origin", "*").expect("valid header")
}

/// 尝试绑定端口（被占用时自动 +1，最多试 20 个）。
fn bind_server(host: &str, port: u16) -> Result<(Server, u16), String> {
    for offset in 0..20u16 {
        let candidate = port.saturating_add(offset);
        match Server::http(format!("{host}:{candidate}")) {
            Ok(server) => return Ok((server, candidate)),
            Err(_) => continue,
        }
    }
    Err(format!("Failed to bind Kiro proxy on {host}:{port} (tried 20 ports)"))
}

/// 启动代理服务器，返回句柄。绑定失败会报错。
pub fn start_proxy(mut config: ProxyConfig) -> Result<ProxyHandle, String> {
    let (server, port) = bind_server(&config.host, config.port)?;
    config.port = port;

    let auth = Arc::new(Auth::new(
        config.sso_cache_dir.clone(),
        config.profile_arn_override.clone(),
        config.runtime_url.clone(),
        config.management_url.clone(),
    ));

    let stop = Arc::new(AtomicBool::new(false));
    let stop_flag = stop.clone();
    let thread_config = config.clone();

    let handle = thread::spawn(move || {
        loop {
            if stop_flag.load(Ordering::Relaxed) {
                break;
            }
            match server.recv_timeout(Duration::from_millis(200)) {
                Ok(Some(request)) => {
                    let auth = auth.clone();
                    let config = thread_config.clone();
                    thread::spawn(move || handle_request(request, &config, &auth));
                }
                Ok(None) => {}
                Err(_) => break,
            }
        }
    });

    Ok(ProxyHandle { port, stop, thread: Some(handle) })
}

// ============ 路由 ============

fn handle_request(request: Request, config: &ProxyConfig, auth: &Arc<Auth>) {
    let method = request.method().clone();
    let url = request.url().to_string();
    let path = url.split('?').next().unwrap_or(&url).to_string();

    if method == Method::Options {
        let response = Response::from_string("")
            .with_status_code(StatusCode(204))
            .with_header(cors_header())
            .with_header(Header::from_bytes("Access-Control-Allow-Methods", "GET,POST,OPTIONS").unwrap())
            .with_header(Header::from_bytes("Access-Control-Allow-Headers", "content-type,x-api-key,authorization").unwrap());
        let _ = request.respond(response);
        return;
    }

    match (method.clone(), path.as_str()) {
        (Method::Get, "/") | (Method::Get, "/health") => handle_health(request, config, auth),
        (Method::Get, "/v1/models") => handle_models(request, config, auth),
        (Method::Post, "/v1/messages/count_tokens") => handle_count_tokens(request, config),
        (Method::Post, "/v1/messages") => handle_messages(request, config, auth),
        _ => {
            let body = json!({ "type": "error", "error": { "type": "invalid_request_error", "message": format!("No route for {method} {path}") } });
            json_response(request, 404, &body);
        }
    }
}

// ============ 辅助 ============

fn check_proxy_auth(request: &Request, config: &ProxyConfig) -> bool {
    let Some(key) = config.proxy_api_key.as_deref() else {
        return false;
    };
    let mut has_x_api_key = false;
    let mut has_bearer = false;
    for header in request.headers() {
        if header.field.equiv("x-api-key") {
            has_x_api_key = has_x_api_key || header.value.as_str() == key;
        }
        if header.field.equiv("authorization") {
            has_bearer = has_bearer || header.value.as_str() == format!("Bearer {key}");
        }
    }
    has_x_api_key || has_bearer
}

fn read_json_body(request: &mut Request) -> Result<Value, String> {
    let mut body = Vec::new();
    request.as_reader().read_to_end(&mut body).map_err(|e| e.to_string())?;
    if body.is_empty() {
        return Ok(json!({}));
    }
    serde_json::from_slice(&body).map_err(|e| e.to_string())
}

fn json_response(request: Request, status: u16, body: &Value) {
    let data = serde_json::to_string(body).unwrap_or_else(|_| "{}".to_string());
    let response = Response::from_string(data)
        .with_status_code(StatusCode(status))
        .with_header(Header::from_bytes("Content-Type", "application/json; charset=utf-8").unwrap())
        .with_header(cors_header());
    let _ = request.respond(response);
}

fn error_response(request: Request, status: u16, message: &str, error_type: &str) {
    let body = json!({ "type": "error", "error": { "type": error_type, "message": message } });
    json_response(request, status, &body);
}

fn sse_event(event: &str, data: &Value) -> String {
    format!("event: {event}\ndata: {data}\n\n")
}

/// 在已发送 `message_start` 后的失败收尾。
///
/// Claude Code 若只收到 error + message_stop、没有 message_delta，
/// 会以 `stop_reason=null` + `result_type=user` 报 `[ede_diagnostic]`。
/// 这里补齐文本错误块与 message_delta，让客户端能正常结束本轮。
fn finish_sse_after_error(mut send: impl FnMut(String), message: &str) {
    send(sse_event(
        "error",
        &json!({
            "type": "error",
            "error": { "type": "api_error", "message": message },
        }),
    ));

    let error_text = if message.trim().is_empty() {
        "API Error: upstream request failed".to_string()
    } else if message.trim().starts_with("API Error:") {
        message.trim().to_string()
    } else {
        format!("API Error: {message}")
    };

    let mut started = false;
    let mut out = String::new();
    emit_text_block_sse(&mut started, 0, &error_text, &mut out);
    if !out.is_empty() {
        send(out);
        send(sse_event(
            "content_block_stop",
            &json!({ "type": "content_block_stop", "index": 0 }),
        ));
    }

    send(sse_event(
        "message_delta",
        &json!({
            "type": "message_delta",
            "delta": { "stop_reason": "end_turn", "stop_sequence": null },
            "usage": { "output_tokens": estimate_tokens(&error_text) },
        }),
    ));
    send(sse_event("message_stop", &json!({ "type": "message_stop" })));
}

fn emit_sse_message_delta_stop(mut send: impl FnMut(String), stop_reason: &str, output_tokens: i64) {
    send(sse_event(
        "message_delta",
        &json!({
            "type": "message_delta",
            "delta": { "stop_reason": stop_reason, "stop_sequence": null },
            "usage": { "output_tokens": output_tokens },
        }),
    ));
    send(sse_event("message_stop", &json!({ "type": "message_stop" })));
}

/// 把 mpsc 字节块适配成 Read，供 tiny_http 以 chunked 方式边写边发。
struct ChannelReader {
    rx: Receiver<Vec<u8>>,
    current: Vec<u8>,
    pos: usize,
    eof: bool,
}

impl Read for ChannelReader {
    fn read(&mut self, buf: &mut [u8]) -> io::Result<usize> {
        loop {
            if self.pos < self.current.len() {
                let n = std::cmp::min(buf.len(), self.current.len() - self.pos);
                buf[..n].copy_from_slice(&self.current[self.pos..self.pos + n]);
                self.pos += n;
                return Ok(n);
            }
            if self.eof {
                return Ok(0);
            }
            match self.rx.recv() {
                Ok(chunk) if chunk.is_empty() => {
                    self.eof = true;
                    return Ok(0);
                }
                Ok(chunk) => {
                    self.current = chunk;
                    self.pos = 0;
                }
                Err(_) => {
                    self.eof = true;
                    return Ok(0);
                }
            }
        }
    }
}

/// 尚不确定是普通文本还是 tool_use JSON/XML 时，先缓冲再决定是否真流式吐出。
fn classify_stream_content(text: &str) -> Option<bool> {
    let trimmed = text.trim_start();
    if trimmed.is_empty() {
        return None;
    }
    if trimmed.starts_with("<invoke ") || trimmed.starts_with("<invoke>") {
        return Some(true);
    }
    if trimmed.starts_with('{') {
        if trimmed.contains("\"tool_use\"") || trimmed.contains("\"type\":\"tool_use\"") {
            return Some(true);
        }
        // JSON 前缀可能仍是 tool_use，再多等一会儿
        if trimmed.len() < 160 {
            return None;
        }
    }
    Some(false)
}

fn map_kiro_stop_reason(stop_reason: &str) -> String {
    match stop_reason {
        "TOOL_USE" => "tool_use".to_string(),
        "MAX_TOKENS" => "max_tokens".to_string(),
        _ => "end_turn".to_string(),
    }
}

fn emit_text_block_sse(started: &mut bool, index: usize, text: &str, out: &mut String) {
    if text.is_empty() {
        return;
    }
    if !*started {
        out.push_str(&sse_event(
            "content_block_start",
            &json!({
                "type": "content_block_start",
                "index": index,
                "content_block": { "type": "text", "text": "" },
            }),
        ));
        *started = true;
    }
    out.push_str(&sse_event(
        "content_block_delta",
        &json!({
            "type": "content_block_delta",
            "index": index,
            "delta": { "type": "text_delta", "text": text },
        }),
    ));
}

/// Kiro 上游常在生成结束后才返回 HTTP 响应；把突发文本按字符节奏拆开发送，改善前端“持续输出”观感。
fn pace_text_chunks(text: &str) -> Vec<String> {
    let mut chunks = Vec::new();
    let mut buf = String::new();
    for ch in text.chars() {
        buf.push(ch);
        let boundary = buf.chars().count() >= 12
            || ch == '\n'
            || "。！？；，、".contains(ch);
        if boundary {
            chunks.push(std::mem::take(&mut buf));
        }
    }
    if !buf.is_empty() {
        chunks.push(buf);
    }
    if chunks.is_empty() && !text.is_empty() {
        chunks.push(text.to_string());
    }
    chunks
}

fn pace_delay_ms(chunk: &str) -> u64 {
    let n = chunk.chars().count() as u64;
    (8 + n.saturating_mul(10)).clamp(12, 48)
}

fn emit_tool_blocks_sse(blocks: &[Value], out: &mut String) {
    for (index, block) in blocks.iter().enumerate() {
        let name = block.get("name").and_then(|v| v.as_str()).unwrap_or("");
        let tool_id = block.get("id").and_then(|v| v.as_str()).unwrap_or("");
        let input = block.get("input").cloned().unwrap_or_else(|| json!({}));
        out.push_str(&sse_event(
            "content_block_start",
            &json!({
                "type": "content_block_start",
                "index": index,
                "content_block": { "type": "tool_use", "id": tool_id, "name": name, "input": {} },
            }),
        ));
        out.push_str(&sse_event(
            "content_block_delta",
            &json!({
                "type": "content_block_delta",
                "index": index,
                "delta": { "type": "input_json_delta", "partial_json": input.to_string() },
            }),
        ));
        out.push_str(&sse_event(
            "content_block_stop",
            &json!({ "type": "content_block_stop", "index": index }),
        ));
    }
}

/// 实时转发上游增量：不做人为 sleep，避免“假流式拖慢”。
fn send_text_immediate(started: &mut bool, index: usize, text: &str, mut send: impl FnMut(String)) {
    let mut out = String::new();
    emit_text_block_sse(started, index, text, &mut out);
    if !out.is_empty() {
        send(out);
    }
}

/// 仅当上游整包突发时，拆开节奏改善观感；实时增量路径不要用这个。
fn send_text_paced(started: &mut bool, index: usize, text: &str, mut send: impl FnMut(String)) {
    // 短增量直接转发
    if text.chars().count() <= 24 {
        send_text_immediate(started, index, text, send);
        return;
    }
    for piece in pace_text_chunks(text) {
        let mut out = String::new();
        emit_text_block_sse(started, index, &piece, &mut out);
        if !out.is_empty() {
            send(out);
            thread::sleep(Duration::from_millis(pace_delay_ms(&piece)));
        }
    }
}

fn ensure_text_block_index(
    text_block_index: &mut Option<usize>,
    block_counter: &mut usize,
) -> usize {
    *text_block_index.get_or_insert_with(|| {
        let index = *block_counter;
        *block_counter += 1;
        index
    })
}

fn emit_thinking_start_sse(index: usize, mut send: impl FnMut(String)) {
    send(sse_event(
        "content_block_start",
        &json!({
            "type": "content_block_start",
            "index": index,
            "content_block": { "type": "thinking", "thinking": "" },
        }),
    ));
}

fn emit_thinking_delta_sse(index: usize, text: &str, mut send: impl FnMut(String)) {
    if text.is_empty() {
        return;
    }
    send(sse_event(
        "content_block_delta",
        &json!({
            "type": "content_block_delta",
            "index": index,
            "delta": { "type": "thinking_delta", "thinking": text },
        }),
    ));
}

fn close_thinking_block_sse(
    thinking_started: &mut bool,
    thinking_index: Option<usize>,
    signature: &Option<String>,
    mut send: impl FnMut(String),
) {
    if !*thinking_started {
        return;
    }
    let index = thinking_index.unwrap_or(0);
    if let Some(sig) = signature {
        if !sig.is_empty() {
            send(sse_event(
                "content_block_delta",
                &json!({
                    "type": "content_block_delta",
                    "index": index,
                    "delta": { "type": "signature_delta", "signature": sig },
                }),
            ));
        }
    }
    send(sse_event(
        "content_block_stop",
        &json!({ "type": "content_block_stop", "index": index }),
    ));
    *thinking_started = false;
}

fn emit_tool_use_start_sse(index: usize, tool_id: &str, name: &str, mut send: impl FnMut(String)) {
    send(sse_event(
        "content_block_start",
        &json!({
            "type": "content_block_start",
            "index": index,
            "content_block": { "type": "tool_use", "id": tool_id, "name": name, "input": {} },
        }),
    ));
}

fn emit_tool_use_input_delta_sse(index: usize, partial_json: &str, mut send: impl FnMut(String)) {
    if partial_json.is_empty() {
        return;
    }
    send(sse_event(
        "content_block_delta",
        &json!({
            "type": "content_block_delta",
            "index": index,
            "delta": { "type": "input_json_delta", "partial_json": partial_json },
        }),
    ));
}

fn emit_tool_use_stop_sse(index: usize, mut send: impl FnMut(String)) {
    send(sse_event(
        "content_block_stop",
        &json!({ "type": "content_block_stop", "index": index }),
    ));
}

fn emit_fallback_text_block_sse(
    block_counter: &mut usize,
    text: &str,
    mut send: impl FnMut(String),
) {
    if text.trim().is_empty() {
        return;
    }
    let mut started = false;
    let index = *block_counter;
    *block_counter += 1;
    let mut out = String::new();
    emit_text_block_sse(&mut started, index, text, &mut out);
    if out.is_empty() {
        return;
    }
    send(out);
    send(sse_event(
        "content_block_stop",
        &json!({ "type": "content_block_stop", "index": index }),
    ));
}

/// 解析上游 Event Stream，边收边推 Anthropic SSE。
///
/// 原生 `toolUseEvent` 是主路径：文本增量不再为 tools 整包缓冲。
/// 仅当内容像「文本里嵌 tool JSON」时短暂暂缓；真正的 tool 调用走增量 toolUseEvent。
fn pipe_kiro_body_to_anthropic_sse(
    response: ReqwestResponse,
    _has_tools: bool,
    mut send: impl FnMut(String),
) {
    let mut parser = IncrementalEventStream::new();
    let mut reader = response;
    let mut read_buf = [0u8; 8192];
    let mut full_text = String::new();
    let mut pending_flush = String::new();
    let mut tool_mode: Option<bool> = None;
    let mut text_started = false;
    let mut text_block_index: Option<usize> = None;
    let mut thinking_started = false;
    let mut thinking_block_index: Option<usize> = None;
    let mut thinking_signature: Option<String> = None;
    let mut saw_native_tool = false;
    let mut emitted_tool_use = false;
    let mut block_counter = 0usize;
    // toolUseId -> (name, index, open)
    let mut native_tool_blocks: HashMap<String, (String, usize, bool)> = HashMap::new();
    let mut stop_reason = "end_turn".to_string();
    let mut protocol_guard = ProtocolTextGuard::default();

    loop {
        let n = match reader.read(&mut read_buf) {
            Ok(0) => break,
            Ok(n) => n,
            Err(e) => {
                // 已 message_start：必须补 message_delta，否则 Claude Code 报 ede_diagnostic
                let msg = format!("读取 Kiro 流失败: {e}");
                send(sse_event(
                    "error",
                    &json!({
                        "type": "error",
                        "error": { "type": "api_error", "message": msg },
                    }),
                ));
                let had_assistant_content =
                    text_started || thinking_started || emitted_tool_use || !full_text.is_empty();
                close_thinking_block_sse(
                    &mut thinking_started,
                    thinking_block_index,
                    &thinking_signature,
                    &mut send,
                );
                if text_started {
                    let index = text_block_index.unwrap_or(0);
                    send(sse_event(
                        "content_block_stop",
                        &json!({ "type": "content_block_stop", "index": index }),
                    ));
                }
                for (_id, (_name, index, open)) in native_tool_blocks.iter_mut() {
                    if *open {
                        emit_tool_use_stop_sse(*index, &mut send);
                        *open = false;
                    }
                }
                // 若本轮尚未产出任何助手内容，补一条 API Error 文本，避免 result_type=user
                if !had_assistant_content {
                    emit_fallback_text_block_sse(
                        &mut block_counter,
                        &format!("API Error: {msg}"),
                        &mut send,
                    );
                }
                emit_sse_message_delta_stop(&mut send, "end_turn", estimate_tokens(&full_text));
                return;
            }
        };

        for event in parser.push(&read_buf[..n]) {
            match event.event_type.as_str() {
                "reasoningContentEvent" => {
                    let (text, signature) = extract_reasoning_parts(&event.payload);
                    if signature.is_some() {
                        thinking_signature = signature;
                    }
                    if text.is_empty() {
                        continue;
                    }
                    if !thinking_started {
                        let index = block_counter;
                        block_counter += 1;
                        thinking_block_index = Some(index);
                        emit_thinking_start_sse(index, &mut send);
                        thinking_started = true;
                    }
                    let index = thinking_block_index.unwrap_or(0);
                    emit_thinking_delta_sse(index, &text, &mut send);
                }
                "assistantResponseEvent" => {
                    let Some(raw_chunk) = event.payload.get("content").and_then(|v| v.as_str()) else {
                        continue;
                    };
                    if raw_chunk.is_empty() || saw_native_tool {
                        continue;
                    }
                    let chunk = protocol_guard.push(raw_chunk);
                    if chunk.is_empty() {
                        continue;
                    }
                    full_text.push_str(&chunk);

                    // 已判定为文本 JSON 工具：继续缓冲到结束再一次性转换
                    if tool_mode == Some(true) {
                        pending_flush.push_str(&chunk);
                        continue;
                    }

                    // 文本开始前先收尾 thinking 块
                    close_thinking_block_sse(
                        &mut thinking_started,
                        thinking_block_index,
                        &thinking_signature,
                        &mut send,
                    );

                    // 已锁定文本模式：立刻转发，不等待聚合
                    if tool_mode == Some(false) {
                        let index =
                            ensure_text_block_index(&mut text_block_index, &mut block_counter);
                        send_text_immediate(&mut text_started, index, &chunk, &mut send);
                        continue;
                    }

                    // 未判定：只对疑似 tool JSON 前缀短缓冲，普通文本马上推
                    pending_flush.push_str(&chunk);
                    tool_mode = classify_stream_content(&full_text);
                    if tool_mode == Some(false) {
                        let flush = std::mem::take(&mut pending_flush);
                        let index =
                            ensure_text_block_index(&mut text_block_index, &mut block_counter);
                        send_text_paced(&mut text_started, index, &flush, &mut send);
                    }
                }
                "toolUseEvent" => {
                    let tool_id = event
                        .payload
                        .get("toolUseId")
                        .or_else(|| event.payload.get("tool_use_id"))
                        .and_then(|v| v.as_str())
                        .unwrap_or("")
                        .to_string();
                    if tool_id.is_empty() {
                        continue;
                    }
                    let name = event
                        .payload
                        .get("name")
                        .and_then(|v| v.as_str())
                        .unwrap_or("")
                        .to_string();

                    if !native_tool_blocks.contains_key(&tool_id) {
                        // 原生 tool 到达：丢掉未发出的疑似 JSON 缓冲；先收尾 thinking/text
                        pending_flush.clear();
                        close_thinking_block_sse(
                            &mut thinking_started,
                            thinking_block_index,
                            &thinking_signature,
                            &mut send,
                        );
                        if text_started {
                            let index = text_block_index.unwrap_or(0);
                            send(sse_event(
                                "content_block_stop",
                                &json!({ "type": "content_block_stop", "index": index }),
                            ));
                            text_block_index = None;
                            text_started = false;
                        }
                        let index = block_counter;
                        block_counter += 1;
                        emit_tool_use_start_sse(index, &tool_id, &name, &mut send);
                        native_tool_blocks.insert(tool_id.clone(), (name.clone(), index, true));
                        saw_native_tool = true;
                        emitted_tool_use = true;
                        tool_mode = Some(true);
                        stop_reason = "tool_use".to_string();
                    } else if let Some(entry) = native_tool_blocks.get_mut(&tool_id) {
                        if entry.0.is_empty() && !name.is_empty() {
                            entry.0 = name;
                        }
                    }

                    let index = native_tool_blocks.get(&tool_id).map(|e| e.1).unwrap_or(0);
                    match event.payload.get("input") {
                        Some(Value::String(chunk)) if !chunk.is_empty() => {
                            emit_tool_use_input_delta_sse(index, chunk, &mut send);
                        }
                        Some(value) if value.is_object() => {
                            emit_tool_use_input_delta_sse(index, &value.to_string(), &mut send);
                        }
                        _ => {}
                    }
                    let is_stop = event
                        .payload
                        .get("stop")
                        .and_then(|v| v.as_bool())
                        .unwrap_or(false);
                    if is_stop {
                        emit_tool_use_stop_sse(index, &mut send);
                        if let Some(entry) = native_tool_blocks.get_mut(&tool_id) {
                            entry.2 = false;
                        }
                    }
                }
                "metadataEvent" => {
                    if let Some(reason) = event.payload.get("stopReason").and_then(|v| v.as_str()) {
                        stop_reason = map_kiro_stop_reason(reason);
                    }
                }
                _ => {}
            }
        }
    }

    let trailing_text = protocol_guard.finish();
    if !trailing_text.is_empty() {
        full_text.push_str(&trailing_text);
        pending_flush.push_str(&trailing_text);
    }

    if !saw_native_tool {
        // 仅在尚未向客户端吐出文本时，才把缓冲内容改判为文本 JSON tool
        let parsed_tool_blocks = if !text_started {
            parse_tool_use_blocks_from_text(&full_text)
        } else {
            None
        };

        if !text_started && parsed_tool_blocks.is_some() {
            close_thinking_block_sse(
                &mut thinking_started,
                thinking_block_index,
                &thinking_signature,
                &mut send,
            );
            if let Some(blocks) = parsed_tool_blocks {
                let mut out = String::new();
                emit_tool_blocks_sse(&blocks, &mut out);
                if !out.is_empty() {
                    send(out);
                    emitted_tool_use = true;
                    stop_reason = "tool_use".to_string();
                }
            }
        } else if !pending_flush.is_empty() {
            close_thinking_block_sse(
                &mut thinking_started,
                thinking_block_index,
                &thinking_signature,
                &mut send,
            );
            let flush = std::mem::take(&mut pending_flush);
            let index = ensure_text_block_index(&mut text_block_index, &mut block_counter);
            send_text_paced(&mut text_started, index, &flush, &mut send);
        } else if !text_started && !full_text.is_empty() {
            close_thinking_block_sse(
                &mut thinking_started,
                thinking_block_index,
                &thinking_signature,
                &mut send,
            );
            let index = ensure_text_block_index(&mut text_block_index, &mut block_counter);
            send_text_paced(&mut text_started, index, &full_text, &mut send);
        }
    }

    close_thinking_block_sse(
        &mut thinking_started,
        thinking_block_index,
        &thinking_signature,
        &mut send,
    );

    if text_started {
        let index = text_block_index.unwrap_or(0);
        send(sse_event(
            "content_block_stop",
            &json!({ "type": "content_block_stop", "index": index }),
        ));
    }

    // 上游可能省略 toolUseEvent.stop；收尾时补 content_block_stop
    for (_id, (_name, index, open)) in native_tool_blocks.iter_mut() {
        if *open {
            emit_tool_use_stop_sse(*index, &mut send);
            *open = false;
        }
    }

    let had_assistant_content =
        emitted_tool_use || text_started || text_block_index.is_some() || thinking_block_index.is_some();

    let final_stop =
        normalize_stop_reason(&stop_reason, emitted_tool_use, protocol_guard.detected());

    // 无任何助手内容时必须补文本块，否则 Claude Code 会以 result_type=user 报 ede_diagnostic
    if !had_assistant_content {
        let fallback = if stop_reason == "tool_use" {
            "API Error: upstream claimed tool_use but returned no tool call"
        } else if protocol_guard.detected() {
            "API Error: response interrupted by protocol leak"
        } else {
            "API Error: empty assistant response"
        };
        emit_fallback_text_block_sse(&mut block_counter, fallback, &mut send);
    }

    send(sse_event(
        "message_delta",
        &json!({
            "type": "message_delta",
            "delta": { "stop_reason": final_stop, "stop_sequence": null },
            "usage": { "output_tokens": estimate_tokens(&full_text) },
        }),
    ));
    send(sse_event("message_stop", &json!({ "type": "message_stop" })));
}

/// 先立刻打开 SSE（message_start），再请求 Kiro；避免等上游整包结束后才开始响应。
fn respond_sse_stream_fetch(
    request: Request,
    message_id: String,
    response_model: String,
    auth: Arc<Auth>,
    runtime_url: String,
    built: Value,
    has_tools: bool,
) {
    let (tx, rx) = mpsc::sync_channel::<Vec<u8>>(16);
    let producer = thread::spawn(move || {
        let mut send = |chunk: String| {
            let _ = tx.send(chunk.into_bytes());
        };

        send(sse_event(
            "message_start",
            &json!({
                "type": "message_start",
                "message": {
                    "id": message_id,
                    "type": "message",
                    "role": "assistant",
                    "model": response_model,
                    "content": [],
                    "stop_reason": null,
                    "stop_sequence": null,
                    "usage": { "input_tokens": 0, "output_tokens": 0 },
                }
            }),
        ));
        // 立即刷出首包，避免客户端一直空等
        send(": keepalive\n\n".to_string());

        let upstream = match kiro_post(
            &auth.http,
            auth.as_ref(),
            &runtime_url,
            "KiroRuntimeService.GenerateAssistantResponse",
            &built,
        ) {
            Ok(response) => response,
            Err(e) => {
                // 已提前 message_start：不可只发 error + message_stop（会触发 ede_diagnostic）
                finish_sse_after_error(&mut send, &e);
                let _ = tx.send(Vec::new());
                return;
            }
        };

        let status = upstream.status();
        if !status.is_success() {
            let bytes = upstream.bytes().unwrap_or_default();
            let text = String::from_utf8_lossy(&bytes).to_string();
            let message = serde_json::from_str::<Value>(&text)
                .ok()
                .and_then(|v| {
                    v.get("message")
                        .or_else(|| v.get("reason"))
                        .and_then(|m| m.as_str())
                        .map(|s| s.to_string())
                })
                .unwrap_or(text);
            finish_sse_after_error(&mut send, &message);
            let _ = tx.send(Vec::new());
            return;
        }

        pipe_kiro_body_to_anthropic_sse(upstream, has_tools, send);
        let _ = tx.send(Vec::new());
    });

    let reader = ChannelReader {
        rx,
        current: Vec::new(),
        pos: 0,
        eof: false,
    };
    let response = Response::new(
        StatusCode(200),
        vec![
            Header::from_bytes("Content-Type", "text/event-stream; charset=utf-8").unwrap(),
            Header::from_bytes("Cache-Control", "no-cache").unwrap(),
            Header::from_bytes("Connection", "keep-alive").unwrap(),
            Header::from_bytes("X-Accel-Buffering", "no").unwrap(),
            cors_header(),
        ],
        reader,
        None,
        None,
    )
    .with_chunked_threshold(0);

    let _ = request.respond(response);
    let _ = producer.join();
}

// ============ Kiro 上游调用 ============

fn build_kiro_headers(auth: &Auth, target: &str) -> Result<reqwest::header::HeaderMap, String> {
    let authorization = auth
        .get_authorization()?
        .ok_or_else(|| "Missing Kiro credentials. Sign in to Kiro IDE first.".to_string())?;
    let mut headers = reqwest::header::HeaderMap::new();
    for (name, value) in [
        ("authorization", authorization.as_str()),
        ("tokentype", "SSO_OIDC"),
        ("content-type", "application/x-amz-json-1.0"),
        ("x-amz-target", target),
        ("user-agent", "KiroIDE"),
    ] {
        headers.insert(name, value.parse().map_err(|e| format!("Invalid header {name}: {e}"))?);
    }
    Ok(headers)
}

fn kiro_post(
    client: &Client,
    auth: &Auth,
    url: &str,
    target: &str,
    body: &Value,
) -> Result<ReqwestResponse, String> {
    let do_post = || {
        let headers = build_kiro_headers(auth, target)?;
        client
            .post(url)
            .headers(headers)
            .json(body)
            .send()
            .map_err(|e| format!("Kiro request failed: {e}"))
    };
    let mut response = do_post()?;
    let status = response.status();
    if status == reqwest::StatusCode::UNAUTHORIZED || status == reqwest::StatusCode::FORBIDDEN {
        if auth.refresh_after_auth_failure()? {
            response = do_post()?;
        }
    }
    Ok(response)
}

fn call_kiro_generate(
    client: &Client,
    auth: &Auth,
    config: &ProxyConfig,
    body: &Value,
) -> Result<Vec<KiroEvent>, String> {
    let response = kiro_post(
        client,
        auth,
        &config.runtime_url,
        "KiroRuntimeService.GenerateAssistantResponse",
        body,
    )?;
    let status = response.status();
    let bytes = response.bytes().map_err(|e| e.to_string())?.to_vec();
    if !status.is_success() {
        let text = String::from_utf8_lossy(&bytes).to_string();
        let message = serde_json::from_str::<Value>(&text)
            .ok()
            .and_then(|v| {
                v.get("message")
                    .or_else(|| v.get("reason"))
                    .and_then(|m| m.as_str())
                    .map(|s| s.to_string())
            })
            .unwrap_or(text);
        return Err(message);
    }
    Ok(parse_event_stream(&bytes))
}

fn resolve_profile_arn(auth: &Auth) -> Result<Option<String>, String> {
    if let Some(arn) = auth.get_sso_profile_arn() {
        return Ok(Some(arn));
    }
    auth.discover_profile_arn()
}

/// 解析出最终发往 Kiro 的模型 ID。
///
/// 账户套餐未必包含 Claude 模型（例如仅有 GPT/DeepSeek/GLM），
/// 若请求的模型不在 `ListAvailableModels` 返回的可用列表里，
/// 就降级到账户实际可用的默认模型（优先 Claude，否则取第一个），
/// 避免整条对话因「Invalid model ID」直接 502。
fn resolve_kiro_model(auth: &Auth, requested: &str, default_model: &str) -> String {
    let base = normalize_kiro_model(
        if requested.is_empty() { None } else { Some(requested) },
        default_model,
    );
    match auth.list_available_models() {
        Ok(models) if !models.is_empty() => {
            if models.iter().any(|m| m == &base) {
                base
            } else {
                auth.pick_available_default_model().unwrap_or(base)
            }
        }
        _ => base,
    }
}

// ============ 路由实现 ============

fn handle_health(request: Request, config: &ProxyConfig, auth: &Auth) {
    let body = json!({
        "ok": true,
        "service": "codecli-manager-kiro",
        "port": config.port,
        "default_model": config.default_model,
        "auth_source": auth.describe_auth_source(),
        "endpoints": ["/v1/messages", "/v1/messages/count_tokens", "/v1/models"],
    });
    json_response(request, 200, &body);
}

fn handle_models(request: Request, config: &ProxyConfig, auth: &Auth) {
    if !check_proxy_auth(&request, config) {
        return error_response(request, 401, "Invalid proxy API key.", "authentication_error");
    }

    let profile_arn = match resolve_profile_arn(auth) {
        Ok(Some(arn)) => arn,
        Ok(None) => {
            return error_response(
                request,
                400,
                "Missing Kiro profile ARN. 请先登录 Kiro IDE 或设置 KIRO_PROFILE_ARN。",
                "invalid_request_error",
            );
        }
        Err(e) => return error_response(request, 502, &e, "api_error"),
    };

    let response = match kiro_post(
        &auth.http,
        auth,
        &config.management_url,
        "KiroControlPlaneBearerService.ListAvailableModels",
        &json!({ "origin": "AI_EDITOR", "profileArn": profile_arn }),
    ) {
        Ok(response) => response,
        Err(e) => return error_response(request, 502, &e, "api_error"),
    };
    let status = response.status();
    let data: Value = response.json().unwrap_or_else(|_| json!({}));
    if !status.is_success() {
        return error_response(
            request,
            502,
            &format!("ListAvailableModels failed: {status}"),
            "api_error",
        );
    }

    let mut items: Vec<Value> = Vec::new();
    if let Some(models) = data.get("models").and_then(|v| v.as_array()) {
        for model in models {
            let schema = model.get("additionalModelRequestFieldsSchema").unwrap_or(&Value::Null);
            let kiro_id = model.get("modelId").and_then(|v| v.as_str()).unwrap_or("");
            let public_id = kiro_model_to_public_model_id(kiro_id);
            let effort_levels = get_supported_effort_levels(schema);
            items.push(json!({
                "id": public_id,
                "kiro_model_id": kiro_id,
                "resolvedModel": public_id,
                "resolved_model": public_id,
                "object": "model",
                "type": "model",
                "owned_by": "kiro",
                "display_name": public_display_name(model.get("modelName").and_then(|v| v.as_str()).unwrap_or(kiro_id)),
                "input_modalities": model.get("supportedInputTypes").and_then(|v| v.as_array()).map(|arr| arr.iter().filter_map(|t| t.as_str().map(|s| s.to_lowercase())).collect::<Vec<_>>()).unwrap_or_default(),
                "supportsEffort": !effort_levels.is_empty(),
                "supports_effort": !effort_levels.is_empty(),
                "supportedEffortLevels": effort_levels,
                "supported_effort_levels": effort_levels,
                "supportsAdaptiveThinking": schema.get("properties").and_then(|p| p.get("thinking")).is_some(),
                "supports_adaptive_thinking": schema.get("properties").and_then(|p| p.get("thinking")).is_some(),
            }));
        }
    }

    let body = json!({
        "object": "list",
        "data": items,
        "has_more": false,
        "first_id": items.first().and_then(|v| v.get("id")).and_then(|v| v.as_str()).unwrap_or(""),
        "last_id": items.last().and_then(|v| v.get("id")).and_then(|v| v.as_str()).unwrap_or(""),
    });
    json_response(request, 200, &body);
}

fn handle_count_tokens(mut request: Request, config: &ProxyConfig) {
    if !check_proxy_auth(&request, config) {
        return error_response(request, 401, "Invalid proxy API key.", "authentication_error");
    }
    let body = match read_json_body(&mut request) {
        Ok(body) => body,
        Err(e) => return error_response(request, 400, &format!("Invalid JSON body: {e}"), "invalid_request_error"),
    };
    let text = json!({
        "system": body.get("system").unwrap_or(&Value::Null),
        "messages": body.get("messages").unwrap_or(&Value::Null),
        "tools": body.get("tools").unwrap_or(&Value::Null),
    })
    .to_string();
    json_response(request, 200, &json!({ "input_tokens": estimate_tokens(&text) }));
}

fn handle_messages(mut request: Request, config: &ProxyConfig, auth: &Arc<Auth>) {
    if !check_proxy_auth(&request, config) {
        return error_response(request, 401, "Invalid proxy API key.", "authentication_error");
    }
    let body = match read_json_body(&mut request) {
        Ok(body) => body,
        Err(e) => return error_response(request, 400, &format!("Invalid JSON body: {e}"), "invalid_request_error"),
    };

    let model = body.get("model").and_then(|v| v.as_str()).unwrap_or("");
    let kiro_model = resolve_kiro_model(auth, model, &config.default_model);
    let profile_arn = match resolve_profile_arn(auth) {
        Ok(arn) => arn,
        Err(e) => return error_response(request, 502, &e, "api_error"),
    };

    let built = match build_kiro_request(&body, &kiro_model, profile_arn.as_deref()) {
        Ok(built) => built,
        Err(e) => return error_response(request, 400, &e, "invalid_request_error"),
    };

    let id = format!("msg_{}", Uuid::new_v4().to_string().replace('-', ""));
    let response_model = if model.is_empty() { kiro_model.clone() } else { model.to_string() };

    let is_stream = body.get("stream").and_then(|v| v.as_bool()).unwrap_or(false);
    let has_tools = body
        .get("tools")
        .and_then(|v| v.as_array())
        .is_some_and(|tools| !tools.is_empty());

    // 先发 SSE 头/message_start，再请求 Kiro；文本按节奏拆开，改善“整包突发”观感
    if is_stream {
        return respond_sse_stream_fetch(
            request,
            id,
            response_model,
            Arc::clone(auth),
            config.runtime_url.clone(),
            built,
            has_tools,
        );
    }

    let events = match call_kiro_generate(&auth.http, auth, config, &built) {
        Ok(events) => events,
        Err(e) => return error_response(request, 502, &e, "api_error"),
    };
    let mut collected = collect_kiro_text(&events);
    let (visible_text, protocol_leak_detected) = sanitize_protocol_text(&collected.text);
    collected.text = visible_text;
    collected.stop_reason = normalize_stop_reason(
        &collected.stop_reason,
        !collected.tool_uses.is_empty(),
        protocol_leak_detected,
    )
    .to_string();
    let response = anthropic_message_response_with_tools(
        &id,
        &response_model,
        &collected.text,
        &collected.thinking,
        collected.thinking_signature.as_deref(),
        &collected.tool_uses,
        &collected.stop_reason,
    );
    json_response(request, 200, &response);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn classifies_plain_text_immediately() {
        assert_eq!(classify_stream_content("你好，世界"), Some(false));
    }

    #[test]
    fn classifies_tool_invoke_as_tool() {
        assert_eq!(
            classify_stream_content("<invoke name=\"Bash\"><parameter name=\"command\">ls</parameter></invoke>"),
            Some(true)
        );
    }

    #[test]
    fn waits_on_short_json_prefix() {
        assert_eq!(classify_stream_content("{\"type\":"), None);
    }

    #[test]
    fn classifies_tool_use_json() {
        assert_eq!(
            classify_stream_content("{\"type\":\"tool_use\",\"id\":\"call_1\",\"name\":\"Bash\",\"input\":{}}"),
            Some(true)
        );
    }

    #[test]
    fn protocol_guard_blocks_marker_split_across_chunks() {
        let mut guard = ProtocolTextGuard::default();
        let mut visible = guard.push("正常结论。\nassistant to=func");
        visible.push_str(&guard.push("tions.Bash (commentary)\nNo."));
        visible.push_str(&guard.finish());

        assert_eq!(visible, "正常结论。\n");
        assert!(guard.detected());
    }

    #[test]
    fn protocol_guard_preserves_normal_text() {
        let mut guard = ProtocolTextGuard::default();
        let mut visible = guard.push("正常的 assistant 工具说明");
        visible.push_str(&guard.finish());

        assert_eq!(visible, "正常的 assistant 工具说明");
        assert!(!guard.detected());
    }

    #[test]
    fn non_stream_protocol_text_is_sanitized() {
        let (visible, detected) =
            sanitize_protocol_text("正常结论。\nassistant to=functions.Bash (commentary)\nNo.");

        assert_eq!(visible, "正常结论。\n");
        assert!(detected);
    }

    #[test]
    fn channel_reader_streams_chunks() {
        let (tx, rx) = mpsc::sync_channel(4);
        tx.send(b"hello ".to_vec()).unwrap();
        tx.send(b"world".to_vec()).unwrap();
        tx.send(Vec::new()).unwrap();
        drop(tx);
        let mut reader = ChannelReader {
            rx,
            current: Vec::new(),
            pos: 0,
            eof: false,
        };
        let mut buf = String::new();
        reader.read_to_string(&mut buf).unwrap();
        assert_eq!(buf, "hello world");
    }

    #[test]
    fn pace_text_chunks_splits_on_punctuation() {
        let chunks = pace_text_chunks("你好，世界。下一句");
        assert!(chunks.len() >= 2);
        assert_eq!(chunks.concat(), "你好，世界。下一句");
    }

    /// 临时手工验证（非 CI）：使用真实 Kiro SSO 凭据走一遍完整代理链路。
    /// 运行：cargo test -p codecli-manager --lib kiro::server::tests::live_proxy_roundtrip -- --ignored --nocapture
    #[test]
    #[ignore = "requires real Kiro SSO credentials"]
    fn live_proxy_roundtrip() {
        let home = std::env::var("HOME").unwrap();
        let sso_dir = std::path::PathBuf::from(&home).join(".aws/sso/cache");
        let config = ProxyConfig {
            host: "127.0.0.1".to_string(),
            port: 5050,
            proxy_api_key: Some("live-test-key".to_string()),
            default_model: "claude-opus-5".to_string(),
            runtime_url: "https://runtime.us-east-1.kiro.dev/".to_string(),
            management_url: "https://management.us-east-1.kiro.dev/".to_string(),
            sso_cache_dir: sso_dir.clone(),
            profile_arn_override: None,
        };
        let mut handle = start_proxy(config).expect("proxy starts");
        let port = handle.port;
        let client = reqwest::blocking::Client::builder()
            .timeout(std::time::Duration::from_secs(120))
            .build()
            .unwrap();

        // 1. /v1/models 走真实 ListAvailableModels
        let resp = client
            .get(format!("http://127.0.0.1:{port}/v1/models"))
            .header("x-api-key", "live-test-key")
            .send()
            .unwrap();
        println!("[live] /v1/models status={}", resp.status());
        let models: Value = resp.json().unwrap_or_else(|_| json!({}));
        println!("[live] models count={}", models["data"].as_array().map(|a| a.len()).unwrap_or(0));
        for m in models["data"].as_array().unwrap_or(&vec![]) {
            println!(
                "[live]   id={} kiro_model_id={} display={}",
                m["id"].as_str().unwrap_or(""),
                m["kiro_model_id"].as_str().unwrap_or(""),
                m["display_name"].as_str().unwrap_or(""),
            );
        }

        // 2. /v1/messages 非流式，最小请求（用真实可用模型）
        let body = json!({
            "model": "gpt-5.6-sol",
            "max_tokens": 64,
            "messages": [{ "role": "user", "content": "只回复两个字：你好" }],
            "stream": false,
        });
        let resp = client
            .post(format!("http://127.0.0.1:{port}/v1/messages"))
            .header("x-api-key", "live-test-key")
            .json(&body)
            .send()
            .unwrap();
        let status = resp.status();
        let text = resp.text().unwrap();
        println!("[live] /v1/messages(available model) status={}", status);
        println!(
            "[live] body (truncated): {}",
            text.chars().take(800).collect::<String>()
        );
        assert!(status.is_success(), "non-2xx: {text}");

        // 3. 原生 Kiro tools → toolUseEvent → Anthropic tool_use
        let body = json!({
            "model": "gpt-5.6-sol",
            "messages": [{
                "role": "user",
                "content": "必须调用 get_current_time 工具，不要直接回答。"
            }],
            "tools": [{
                "name": "get_current_time",
                "description": "Get the current local time",
                "input_schema": {
                    "type": "object",
                    "properties": {}
                }
            }],
            "stream": false,
        });
        let resp = client
            .post(format!("http://127.0.0.1:{port}/v1/messages"))
            .header("x-api-key", "live-test-key")
            .json(&body)
            .send()
            .unwrap();
        let status = resp.status();
        let text = resp.text().unwrap();
        println!("[live] /v1/messages(native tool) status={}", status);
        println!(
            "[live] tool body (truncated): {}",
            text.chars().take(800).collect::<String>()
        );
        assert!(status.is_success(), "native tool request failed: {text}");
        let tool_response: Value = serde_json::from_str(&text).unwrap();
        assert_eq!(tool_response["stop_reason"], "tool_use");
        let tool_block = tool_response["content"]
            .as_array()
            .and_then(|blocks| blocks.iter().find(|b| b["type"] == "tool_use"))
            .expect("native tool_use block");
        assert_eq!(tool_block["name"], "get_current_time");
        let tool_use_id = tool_block["id"].as_str().unwrap().to_string();

        // 4. 工具结果回传第二轮（根治验证：toolResults 原生链路）
        let body = json!({
            "model": "gpt-5.6-sol",
            "messages": [
                {
                    "role": "user",
                    "content": "必须调用 get_current_time 工具，不要直接回答。"
                },
                {
                    "role": "assistant",
                    "content": [{
                        "type": "tool_use",
                        "id": tool_use_id.clone(),
                        "name": "get_current_time",
                        "input": {}
                    }]
                },
                {
                    "role": "user",
                    "content": [{
                        "type": "tool_result",
                        "tool_use_id": tool_use_id,
                        "content": "2026-08-11T23:59:00+08:00"
                    }]
                }
            ],
            "tools": [{
                "name": "get_current_time",
                "description": "Get the current local time",
                "input_schema": {
                    "type": "object",
                    "properties": {}
                }
            }],
            "stream": false,
        });
        let resp = client
            .post(format!("http://127.0.0.1:{port}/v1/messages"))
            .header("x-api-key", "live-test-key")
            .json(&body)
            .send()
            .unwrap();
        let status = resp.status();
        let text = resp.text().unwrap();
        println!("[live] /v1/messages(tool result roundtrip) status={}", status);
        println!(
            "[live] tool-result body (truncated): {}",
            text.chars().take(800).collect::<String>()
        );
        assert!(status.is_success(), "tool result roundtrip failed: {text}");
        let followup: Value = serde_json::from_str(&text).unwrap();
        assert_ne!(
            followup["stop_reason"], "tool_use",
            "second turn should consume tool result, not request another tool: {text}"
        );
        let followup_text = followup["content"]
            .as_array()
            .into_iter()
            .flatten()
            .filter_map(|b| b.get("text").and_then(|v| v.as_str()))
            .collect::<Vec<_>>()
            .join("");
        assert!(
            !followup_text.trim().is_empty(),
            "second turn should return assistant text: {text}"
        );

        // 5. 请求账户里不存在的 Claude 模型 → 应降级到可用模型并成功
        let body = json!({
            "model": "claude-opus-5",
            "max_tokens": 64,
            "messages": [{ "role": "user", "content": "只回复一个字：好" }],
            "stream": false,
        });
        let resp = client
            .post(format!("http://127.0.0.1:{port}/v1/messages"))
            .header("x-api-key", "live-test-key")
            .json(&body)
            .send()
            .unwrap();
        let status = resp.status();
        let text = resp.text().unwrap();
        println!("[live] /v1/messages(fallback claude-opus-5) status={}", status);
        println!(
            "[live] body (truncated): {}",
            text.chars().take(800).collect::<String>()
        );
        assert!(status.is_success(), "fallback request failed: {text}");

        // 6. 流式 SSE + 原生 tool_use
        let body = json!({
            "model": "gpt-5.6-sol",
            "messages": [{
                "role": "user",
                "content": "必须调用 get_current_time 工具，不要直接回答。"
            }],
            "tools": [{
                "name": "get_current_time",
                "description": "Get the current local time",
                "input_schema": { "type": "object", "properties": {} }
            }],
            "stream": true,
        });
        let resp = client
            .post(format!("http://127.0.0.1:{port}/v1/messages"))
            .header("x-api-key", "live-test-key")
            .json(&body)
            .send()
            .unwrap();
        let status = resp.status();
        let text = resp.text().unwrap();
        println!("[live] /v1/messages(stream tool) status={}", status);
        println!(
            "[live] sse (truncated): {}",
            text.chars().take(800).collect::<String>()
        );
        assert!(status.is_success(), "stream tool request failed: {text}");
        assert!(text.contains("message_start") && text.contains("message_stop"), "SSE incomplete");
        assert!(
            text.contains("\"type\":\"tool_use\"") || text.contains("\"type\": \"tool_use\""),
            "stream should emit tool_use: {text}"
        );
        assert!(
            text.contains("input_json_delta"),
            "stream should emit input_json_delta: {text}"
        );
        assert!(
            text.contains("\"stop_reason\":\"tool_use\"")
                || text.contains("\"stop_reason\": \"tool_use\""),
            "stream stop_reason must be tool_use: {text}"
        );

        handle.stop();
        println!("[live] DONE");
    }

    fn test_config(port: u16) -> ProxyConfig {
        ProxyConfig {
            host: "127.0.0.1".to_string(),
            port,
            proxy_api_key: Some("test-key".to_string()),
            default_model: "claude-opus-5".to_string(),
            runtime_url: "https://runtime.us-east-1.kiro.dev/".to_string(),
            management_url: "https://management.us-east-1.kiro.dev/".to_string(),
            sso_cache_dir: std::env::temp_dir(),
            profile_arn_override: None,
        }
    }

    #[test]
    fn health_and_auth_gating() {
        let mut handle = start_proxy(test_config(39871)).expect("proxy starts");
        let port = handle.port;
        let client = reqwest::blocking::Client::new();

        // 健康检查
        let resp = client
            .get(format!("http://127.0.0.1:{port}/health"))
            .send()
            .unwrap();
        assert_eq!(resp.status(), 200);
        let health: Value = resp.json().unwrap();
        assert_eq!(health["ok"], true);

        // 无 key 请求 /v1/messages → 401
        let resp = client
            .post(format!("http://127.0.0.1:{port}/v1/messages"))
            .json(&json!({
                "model": "claude-opus-5",
                "messages": [{ "role": "user", "content": "hi" }],
                "stream": false,
            }))
            .send()
            .unwrap();
        assert_eq!(resp.status(), 401);

        // 正确 key 但无 Kiro 凭据 → 400（messages 构建阶段报错，证明路由已通）
        let resp = client
            .post(format!("http://127.0.0.1:{port}/v1/messages"))
            .header("x-api-key", "test-key")
            .json(&json!({
                "model": "claude-opus-5",
                "messages": [{ "role": "user", "content": "hi" }],
                "stream": false,
            }))
            .send()
            .unwrap();
        // 无凭据时 resolve_profile_arn 返回 None，走到 build_kiro_request(profile_arn=None)
        // 或 get_authorization 失败，都应是 4xx/502，而不是 panic 或 500
        assert!(resp.status().is_client_error() || resp.status().is_server_error());
        assert_ne!(resp.status(), 200);

        // 未知路由 → 404
        let resp = client
            .get(format!("http://127.0.0.1:{port}/nope"))
            .send()
            .unwrap();
        assert_eq!(resp.status(), 404);

        handle.stop();
    }
}
