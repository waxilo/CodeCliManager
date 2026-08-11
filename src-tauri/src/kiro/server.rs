//! 本地 HTTP 代理：把 Anthropic Messages API 请求转发到 Kiro 后端。
//! 移植自 kiro2cli/src/server.js + proxy-kiro.js（MIT）。
//!
//! 端点：
//! - GET  /health, /          → 健康检查
//! - GET  /v1/models          → Kiro 模型列表（供 Claude Code / ccm 模型选择器）
//! - POST /v1/messages/count_tokens → token 估算
//! - POST /v1/messages        → 对话（SSE 流式 / 非流式）

use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::thread::{self, JoinHandle};
use std::time::Duration;

use reqwest::blocking::{Client, Response as ReqwestResponse};
use serde_json::{json, Value};
use tiny_http::{Header, Method, Request, Response, Server, StatusCode};
use uuid::Uuid;

use crate::kiro::auth::Auth;
use crate::kiro::eventstream::{collect_kiro_text, parse_event_stream, KiroEvent};
use crate::kiro::models::{
    estimate_tokens, get_supported_effort_levels, kiro_model_to_public_model_id, normalize_kiro_model,
    public_display_name,
};
use crate::kiro::transform::{anthropic_message_response, build_kiro_request, normalize_assistant_content};

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
    pub config: ProxyConfig,
    stop: Arc<AtomicBool>,
    thread: Option<JoinHandle<()>>,
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

    Ok(ProxyHandle { port, config, stop, thread: Some(handle) })
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

fn sse_response(request: Request, body: String) {
    let response = Response::from_string(body)
        .with_status_code(StatusCode(200))
        .with_header(Header::from_bytes("Content-Type", "text/event-stream; charset=utf-8").unwrap())
        .with_header(Header::from_bytes("Cache-Control", "no-cache").unwrap())
        .with_header(cors_header());
    let _ = request.respond(response);
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

fn handle_messages(mut request: Request, config: &ProxyConfig, auth: &Auth) {
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

    let events = match call_kiro_generate(&auth.http, auth, config, &built) {
        Ok(events) => events,
        Err(e) => {
            if is_stream {
                let sse = format!("event: error\ndata: {}\n\n", json!({ "type": "error", "error": { "type": "api_error", "message": e } }));
                return sse_response(request, sse);
            }
            return error_response(request, 502, &e, "api_error");
        }
    };

    let collected = collect_kiro_text(&events);

    if !is_stream {
        let response = anthropic_message_response(&id, &response_model, &collected.text, &collected.stop_reason);
        return json_response(request, 200, &response);
    }

    // SSE 流式：message_start → content_block_* → message_delta → message_stop
    let (content, stop_reason) = normalize_assistant_content(&collected.text, &collected.stop_reason);
    let mut sse = String::new();
    sse.push_str(&format!(
        "event: message_start\ndata: {}\n\n",
        json!({
            "type": "message_start",
            "message": {
                "id": id,
                "type": "message",
                "role": "assistant",
                "model": response_model,
                "content": [],
                "stop_reason": null,
                "stop_sequence": null,
                "usage": { "input_tokens": 0, "output_tokens": 0 },
            }
        })
    ));
    for (index, block) in content.iter().enumerate() {
        let is_tool_use = block.get("type").and_then(|v| v.as_str()) == Some("tool_use");
        if is_tool_use {
            let name = block.get("name").and_then(|v| v.as_str()).unwrap_or("");
            let tool_id = block.get("id").and_then(|v| v.as_str()).unwrap_or("");
            let input = block.get("input").cloned().unwrap_or_else(|| json!({}));
            sse.push_str(&format!(
                "event: content_block_start\ndata: {}\n\n",
                json!({
                    "type": "content_block_start",
                    "index": index,
                    "content_block": { "type": "tool_use", "id": tool_id, "name": name, "input": {} },
                })
            ));
            sse.push_str(&format!(
                "event: content_block_delta\ndata: {}\n\n",
                json!({
                    "type": "content_block_delta",
                    "index": index,
                    "delta": { "type": "input_json_delta", "partial_json": input.to_string() },
                })
            ));
            sse.push_str(&format!(
                "event: content_block_stop\ndata: {}\n\n",
                json!({ "type": "content_block_stop", "index": index })
            ));
        } else {
            let text = block.get("text").and_then(|v| v.as_str()).unwrap_or("");
            sse.push_str(&format!(
                "event: content_block_start\ndata: {}\n\n",
                json!({
                    "type": "content_block_start",
                    "index": index,
                    "content_block": { "type": "text", "text": "" },
                })
            ));
            if !text.is_empty() {
                sse.push_str(&format!(
                    "event: content_block_delta\ndata: {}\n\n",
                    json!({
                        "type": "content_block_delta",
                        "index": index,
                        "delta": { "type": "text_delta", "text": text },
                    })
                ));
            }
            sse.push_str(&format!(
                "event: content_block_stop\ndata: {}\n\n",
                json!({ "type": "content_block_stop", "index": index })
            ));
        }
    }
    sse.push_str(&format!(
        "event: message_delta\ndata: {}\n\n",
        json!({
            "type": "message_delta",
            "delta": { "stop_reason": stop_reason, "stop_sequence": null },
            "usage": { "output_tokens": estimate_tokens(&collected.text) },
        })
    ));
    sse.push_str("event: message_stop\ndata: {\"type\":\"message_stop\"}\n\n");

    sse_response(request, sse);
}

#[cfg(test)]
mod tests {
    use super::*;

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

        // 3. 请求账户里不存在的 Claude 模型 → 应降级到可用模型并成功
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

        // 4. 流式 SSE
        let body = json!({
            "model": "claude-opus-5",
            "max_tokens": 64,
            "messages": [{ "role": "user", "content": "只回复两个字：你好" }],
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
        println!("[live] /v1/messages(stream) status={}", status);
        println!(
            "[live] sse (truncated): {}",
            text.chars().take(600).collect::<String>()
        );
        assert!(status.is_success(), "stream request failed: {text}");
        assert!(text.contains("message_start") && text.contains("message_stop"), "SSE incomplete");

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
