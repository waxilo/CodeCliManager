//! 本地 HTTP 代理：把 Anthropic Messages API 请求转发到 Kiro 后端。
//! 移植自 kiro2cli/src/server.js + proxy-kiro.js（MIT）。
//!
//! 端点：
//! - GET  /health, /          → 健康检查
//! - GET  /v1/models          → Kiro 模型列表（供 Claude Code / ccm 模型选择器）
//! - POST /v1/messages/count_tokens → token 估算
//! - POST /v1/messages        → 对话（SSE 流式 / 非流式）

use std::collections::hash_map::DefaultHasher;
use std::collections::HashMap;
use std::hash::{Hash, Hasher};
use std::io::{self, Cursor, Read};
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::mpsc::{self, Receiver};
use std::sync::{Arc, Condvar, Mutex};
use std::thread::{self, JoinHandle};
use std::time::{Duration, Instant};

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
    anthropic_message_response_with_tools, build_kiro_request, build_kiro_request_with_schema,
    MixedTextToolGuard,
};
use crate::protocol_guard::{normalize_stop_reason, sanitize_protocol_text, ProtocolTextGuard};

const MAX_REQUEST_BODY_BYTES: usize = 8 * 1024 * 1024;
const MAX_CONCURRENT_REQUESTS: usize = 16;

/// 诊断日志：追加到 App 数据目录下的 kiro-debug.log，便于定位 502 /
/// 「property 'X' is not defined in the schema」类问题（记录发给 Kiro 的请求体 + 上游原始报错）。
/// 写失败不影响代理；排查完可删除该文件。
fn diag_log(line: &str) {
    use std::io::Write;
    let path = crate::paths::get_data_path().join("kiro-debug.log");
    if let Ok(mut f) = std::fs::OpenOptions::new().create(true).append(true).open(&path) {
        let _ = writeln!(
            f,
            "{} {line}",
            chrono::Local::now().format("%Y-%m-%d %H:%M:%S")
        );
    }
}

/// 诊断日志里截断超长串（主要是请求体），避免 kiro-debug.log 被 1MB+ 的 body 撑爆。
/// 保留开头，便于定位是哪个字段/哪条消息过大。
fn truncate_for_log(s: &str, max: usize) -> String {
    let count = s.chars().count();
    if count <= max {
        return s.to_string();
    }
    let head: String = s.chars().take(max).collect();
    format!("{head}\u{2026}[truncated {count} chars]\u{2026}")
}
/// 连续失败达到该阈值时，判定进入了「Claude Code 重试」状态，重试请求前先自检/恢复代理。
/// 阈值 = 1 表示首次失败后、下一次请求（往往就是第一次重试）前就恢复，最多浪费一次尝试。
const RETRY_HEALTH_THRESHOLD: usize = 1;
/// 自检恢复的最小间隔，避免高频失败时反复打 OIDC。
const RETRY_RECOVERY_MIN_INTERVAL: Duration = Duration::from_secs(5);
/// 连续失败的有效时间窗：窗口外的失败不视为「正在重试」。
const RETRY_HEALTH_WINDOW: Duration = Duration::from_secs(30);
/// 等待 Kiro 首字节 / 事件间隙期间的心跳间隔。SSE 注释行，客户端必须忽略；
/// 防止连接长时间空转被 CC / 系统 idle timeout 掐断（「用着用着就超时」的根因之一）。
const SSE_HEARTBEAT_INTERVAL: Duration = Duration::from_secs(20);
/// 完成响应可被同 body 请求重放的有效期。
const DEDUP_TTL: Duration = Duration::from_secs(300);
/// follower 等待同 body leader 的上限，与 Auth runtime 客户端的 1500s 总超时保持一致。
/// 测试通过 `acquire_with_limits` 注入更短时长，不缩短生产环境的正常生成窗口。
const DEDUP_FOLLOWER_WAIT: Duration = Duration::from_secs(1500);
/// 重放缓冲上限，超过则放弃缓冲（该请求不再可重放），避免内存膨胀。
const DEDUP_BUFFER_CAP: usize = 16 * 1024 * 1024;

/// 代理自愈状态：跟踪连续失败（重试风暴），在重试请求前自检并恢复 token / ARN / 模型缓存。
///
/// 只做认证/控制面恢复，**不重放生成请求**，因此不会额外消耗 Kiro Credits——
/// 重试请求本身由 Claude Code 发出（必然生成一次），这里保证它带着有效凭据去打。
struct ProxyHealth {
    consecutive_failures: AtomicUsize,
    last_failure: Mutex<Option<Instant>>,
    recovery_lock: Mutex<()>,
    last_recovery: Mutex<Option<Instant>>,
}

impl ProxyHealth {
    fn new() -> Self {
        Self {
            consecutive_failures: AtomicUsize::new(0),
            last_failure: Mutex::new(None),
            recovery_lock: Mutex::new(()),
            last_recovery: Mutex::new(None),
        }
    }

    fn record_success(&self) {
        self.consecutive_failures.store(0, Ordering::SeqCst);
    }

    fn record_failure(&self) {
        self.consecutive_failures.fetch_add(1, Ordering::SeqCst);
        if let Ok(mut guard) = self.last_failure.lock() {
            *guard = Some(Instant::now());
        }
    }

    /// 是否需要请求前自检：窗口内连续失败达到阈值（即很可能正被 Claude Code 重试）。
    fn needs_preflight(&self) -> bool {
        let count = self.consecutive_failures.load(Ordering::SeqCst);
        if count == 0 {
            return false;
        }
        let recent = self
            .last_failure
            .lock()
            .map(|g| {
                g.map(|t| t.elapsed() < RETRY_HEALTH_WINDOW)
                    .unwrap_or(false)
            })
            .unwrap_or(false);
        if !recent {
            self.consecutive_failures.store(0, Ordering::SeqCst);
            return false;
        }
        count >= RETRY_HEALTH_THRESHOLD
    }

    /// 请求前自检 + 恢复：强制刷新凭据、重拉 ARN / 模型缓存。
    /// 带互斥与冷却期，避免并发请求同时触发恢复；全部尽力而为，失败不阻断请求。
    fn run_preflight_recovery(&self, auth: &Auth) {
        let Ok(_guard) = self.recovery_lock.try_lock() else {
            return; // 已有请求正在恢复，跳过本次
        };
        let now = Instant::now();
        let within_cooldown = self
            .last_recovery
            .lock()
            .map(|g| {
                g.map(|t| now.duration_since(t) < RETRY_RECOVERY_MIN_INTERVAL)
                    .unwrap_or(false)
            })
            .unwrap_or(false);
        if within_cooldown {
            return;
        }
        if let Ok(mut guard) = self.last_recovery.lock() {
            *guard = Some(now);
        }

        match auth.force_refresh() {
            Ok((true, _)) => eprintln!("[kiro] preflight recovery: credentials refreshed"),
            Ok((false, _)) => eprintln!("[kiro] preflight recovery: no refreshToken (env auth?)"),
            Err(e) => eprintln!("[kiro] preflight recovery: credential refresh failed: {e}"),
        }
        match auth.discover_profile_arn() {
            Ok(_) => {}
            Err(e) => eprintln!("[kiro] preflight recovery: discover_profile_arn failed: {e}"),
        }
        match auth.list_available_models() {
            Ok(_) => {}
            Err(e) => eprintln!("[kiro] preflight recovery: list_available_models failed: {e}"),
        }
    }
}

/// 同 body 请求的去重存储：同一 key 的 acquire 在 entries 锁内选出唯一 leader，
/// follower 等待 leader 的终态并重放完整 SSE，绝不再次穿透到 Kiro。
struct DedupStore {
    entries: Mutex<HashMap<u64, Arc<DedupEntry>>>,
}

#[derive(Clone, Debug)]
enum DedupStatus {
    InFlight,
    Completed { completed_at: Instant },
    Failed,
}

#[derive(Debug)]
struct DedupEntryState {
    buffer: Vec<u8>,
    status: DedupStatus,
    overflow: bool,
}

#[derive(Debug)]
struct DedupEntry {
    key: u64,
    state: Mutex<DedupEntryState>,
    changed: Condvar,
}

#[derive(Debug)]
enum DedupAcquire {
    Leader(Arc<DedupEntry>),
    Replay(Vec<u8>),
    Failed,
    TimedOut,
}

impl DedupStore {
    fn new() -> Self {
        Self {
            entries: Mutex::new(HashMap::new()),
        }
    }

    /// 同 body 请求的稳定指纹：以原始 Anthropic body 的紧凑 JSON 为准。
    /// 客户端重试/重发同一条消息时字节级一致，天然稳定。
    fn fingerprint(body: &Value) -> u64 {
        let mut hasher = DefaultHasher::new();
        body.to_string().hash(&mut hasher);
        hasher.finish()
    }

    fn new_entry(key: u64) -> Arc<DedupEntry> {
        Arc::new(DedupEntry {
            key,
            state: Mutex::new(DedupEntryState {
                buffer: Vec::new(),
                status: DedupStatus::InFlight,
                overflow: false,
            }),
            changed: Condvar::new(),
        })
    }

    fn acquire(&self, key: u64) -> DedupAcquire {
        self.acquire_with_limits(key, DEDUP_FOLLOWER_WAIT, DEDUP_TTL)
    }

    /// 原子 acquire：entries 锁内只允许一个调用插入 InFlight；其他调用在该条目的
    /// Condvar 上等待。Failed、过期 Completed 和 overflow Completed 都先原子移除再竞选新 leader。
    fn acquire_with_limits(&self, key: u64, wait: Duration, ttl: Duration) -> DedupAcquire {
        let deadline = Instant::now() + wait;
        loop {
            let entry = {
                let mut entries = self.entries.lock().unwrap_or_else(|e| e.into_inner());
                if entries.len() >= 64 {
                    entries.retain(|_, entry| {
                        let state = entry.state.lock().unwrap_or_else(|e| e.into_inner());
                        match &state.status {
                            DedupStatus::InFlight => true,
                            DedupStatus::Completed { completed_at } => completed_at.elapsed() < ttl,
                            DedupStatus::Failed => false,
                        }
                    });
                }
                if let Some(entry) = entries.get(&key) {
                    Arc::clone(entry)
                } else {
                    let entry = Self::new_entry(key);
                    entries.insert(key, Arc::clone(&entry));
                    return DedupAcquire::Leader(entry);
                }
            };

            let mut state = entry.state.lock().unwrap_or_else(|e| e.into_inner());
            let mut waited_on_entry = false;
            loop {
                match &state.status {
                    DedupStatus::Completed { completed_at }
                        if completed_at.elapsed() < ttl
                            && !state.overflow
                            && !state.buffer.is_empty() =>
                    {
                        return DedupAcquire::Replay(state.buffer.clone());
                    }
                    DedupStatus::Completed { .. } | DedupStatus::Failed => {
                        drop(state);
                        self.remove_if_same(key, &entry);
                        if waited_on_entry {
                            // 已等待该 leader 的 follower 只观察终态，不会在本次请求中晋升并穿透上游。
                            return DedupAcquire::Failed;
                        }
                        // 新到请求遇到过期/不可重放终态时，可以在下一轮原子竞选 leader。
                        break;
                    }
                    DedupStatus::InFlight => {
                        waited_on_entry = true;
                        let now = Instant::now();
                        if now >= deadline {
                            return DedupAcquire::TimedOut;
                        }
                        let remaining = deadline.saturating_duration_since(now);
                        let waited = entry.changed.wait_timeout(state, remaining);
                        let (next, timeout) = match waited {
                            Ok(result) => result,
                            Err(poisoned) => poisoned.into_inner(),
                        };
                        state = next;
                        if timeout.timed_out()
                            && matches!(&state.status, DedupStatus::InFlight)
                        {
                            return DedupAcquire::TimedOut;
                        }
                    }
                }
            }
        }
    }

    fn append(&self, entry: &DedupEntry, bytes: &[u8]) {
        if bytes.is_empty() {
            return;
        }
        let mut state = entry.state.lock().unwrap_or_else(|e| e.into_inner());
        if !matches!(&state.status, DedupStatus::InFlight) || state.overflow {
            return;
        }
        let Some(next_len) = state.buffer.len().checked_add(bytes.len()) else {
            state.buffer.clear();
            state.overflow = true;
            return;
        };
        if next_len > DEDUP_BUFFER_CAP {
            // 丢弃 partial buffer，但保持 InFlight：follower 仍必须等 leader 结束，不能穿透。
            state.buffer.clear();
            state.overflow = true;
            return;
        }
        state.buffer.extend_from_slice(bytes);
    }

    /// 只有持有 leader entry 的 producer 可以完成该转换；终态不会被 Drop 或迟到写入覆盖。
    fn mark_completed(&self, entry: &DedupEntry) -> bool {
        let mut state = entry.state.lock().unwrap_or_else(|e| e.into_inner());
        if !matches!(&state.status, DedupStatus::InFlight) {
            return false;
        }
        let overflow = state.overflow;
        state.status = DedupStatus::Completed {
            completed_at: Instant::now(),
        };
        entry.changed.notify_all();
        drop(state);
        // overflow 没有可重放结果；仅在 producer 已发布终态后移除，in-flight 期间绝不穿透。
        if overflow {
            self.remove_if_same(entry.key, entry);
        }
        true
    }

    /// Failed 会清空 partial buffer，避免之后任何路径把不完整响应复活为 Completed。
    fn mark_failed(&self, entry: &DedupEntry) -> bool {
        let mut state = entry.state.lock().unwrap_or_else(|e| e.into_inner());
        if !matches!(&state.status, DedupStatus::InFlight) {
            return false;
        }
        state.buffer.clear();
        state.status = DedupStatus::Failed;
        entry.changed.notify_all();
        drop(state);
        // 已持有 Arc 的 follower 仍能观察 Failed；新请求可以原子竞选新的 leader。
        self.remove_if_same(entry.key, entry);
        true
    }

    fn remove_if_same(&self, key: u64, expected: &DedupEntry) {
        let mut entries = self.entries.lock().unwrap_or_else(|e| e.into_inner());
        if entries
            .get(&key)
            .is_some_and(|current| std::ptr::eq(current.as_ref(), expected))
        {
            entries.remove(&key);
        }
    }
}
#[derive(Debug)]
enum BodyReadError {
    TooLarge,
    Invalid(String),
}

struct RequestPermit {
    active: Arc<AtomicUsize>,
}

impl Drop for RequestPermit {
    fn drop(&mut self) {
        self.active.fetch_sub(1, Ordering::AcqRel);
    }
}

fn try_acquire_request(active: &Arc<AtomicUsize>, limit: usize) -> Option<RequestPermit> {
    active
        .fetch_update(Ordering::AcqRel, Ordering::Acquire, |current| {
            (current < limit).then_some(current + 1)
        })
        .ok()
        .map(|_| RequestPermit { active: Arc::clone(active) })
}

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

fn is_loopback_host(host: &str) -> bool {
    let host = host.trim();
    let bare = if let Some(rest) = host.strip_prefix('[') {
        rest.split(']').next().unwrap_or(rest).to_string()
    } else {
        host.split(':').next().unwrap_or(host).to_string()
    };
    matches!(
        bare.as_str(),
        "127.0.0.1" | "localhost" | "::1" | "0:0:0:0:0:0:0:1"
    )
}

fn request_origin(request: &Request) -> Option<&str> {
    request
        .headers()
        .iter()
        .find(|header| header.field.equiv("origin"))
        .map(|header| header.value.as_str())
}

fn is_loopback_origin(origin: &str) -> bool {
    origin == "tauri://localhost"
        || origin == "http://tauri.localhost"
        || origin == "https://tauri.localhost"
        || origin.starts_with("http://localhost:")
        || origin.starts_with("https://localhost:")
        || origin.starts_with("http://127.0.0.1:")
        || origin.starts_with("https://127.0.0.1:")
        || origin.starts_with("http://[::1]:")
        || origin.starts_with("https://[::1]:")
}

/// 仅对本机来源回显 CORS 头；其余（原生客户端无 Origin / 恶意跨源）一律不发。
/// 任意网页便无法读取本地代理的响应（DNS rebinding 已由 Host 校验拦截）。
fn cors_headers_for(request: &Request) -> Vec<Header> {
    let Some(origin) = request_origin(request) else {
        return Vec::new();
    };
    if !is_loopback_origin(origin) {
        return Vec::new();
    }
    vec![
        Header::from_bytes("Access-Control-Allow-Origin", origin).expect("valid header"),
        Header::from_bytes("Vary", "Origin").expect("valid header"),
    ]
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
    let active_requests = Arc::new(AtomicUsize::new(0));
    let warmup_auth = Arc::clone(&auth);
    let health = Arc::new(ProxyHealth::new());
    let dedup = Arc::new(DedupStore::new());

    let handle = thread::spawn(move || {
        loop {
            if stop_flag.load(Ordering::Relaxed) {
                break;
            }
            match server.recv_timeout(Duration::from_millis(200)) {
                Ok(Some(request)) => {
                    let auth = auth.clone();
                    let config = thread_config.clone();
                    let health = Arc::clone(&health);
                    let dedup = Arc::clone(&dedup);
                    let active_requests = Arc::clone(&active_requests);
                    thread::spawn(move || {
                        handle_request(
                            request,
                            &config,
                            &auth,
                            health,
                            dedup,
                            active_requests,
                        );
                    });
                }
                Ok(None) => {}
                Err(_) => break,
            }
        }
    });

    // 后台预热 profile ARN 与可用模型列表，避免冷缓存时首条请求在热路径上等管理面网络调用。
    // 无凭据时这些调用立即返回，不产生网络开销。
    {
        thread::spawn(move || {
            match warmup_auth.discover_profile_arn() {
                Ok(_) => {}
                Err(e) => eprintln!("[kiro] warmup discover_profile_arn failed: {e}"),
            }
            match warmup_auth.list_available_models() {
                Ok(_) => {}
                Err(e) => eprintln!("[kiro] warmup list_available_models failed: {e}"),
            }
        });
    }

    Ok(ProxyHandle { port, stop, thread: Some(handle) })
}

// ============ 路由 ============

fn handle_request(
    request: Request,
    config: &ProxyConfig,
    auth: &Arc<Auth>,
    health: Arc<ProxyHealth>,
    dedup: Arc<DedupStore>,
    active_requests: Arc<AtomicUsize>,
) {
    // Host 校验：仅接受本机回环地址，阻断 DNS rebinding（浏览器把恶意域名解析到 127.0.0.1）
    let host_ok = request
        .headers()
        .iter()
        .find(|header| header.field.equiv("host"))
        .map(|header| is_loopback_host(header.value.as_str()))
        .unwrap_or(false);
    if !host_ok {
        return error_response(
            request,
            400,
            "Invalid Host header.",
            "invalid_request_error",
        );
    }
    // Origin 校验：非本机来源直接拒绝
    if let Some(origin) = request_origin(&request) {
        if !is_loopback_origin(origin) {
            return error_response(
                request,
                403,
                "Cross-origin requests are not allowed.",
                "invalid_request_error",
            );
        }
    }

    let method = request.method().clone();
    let url = request.url().to_string();
    let path = url.split('?').next().unwrap_or(&url).to_string();

    if method == Method::Options {
        let mut response = Response::from_string("")
            .with_status_code(StatusCode(204))
            .with_header(Header::from_bytes("Access-Control-Allow-Methods", "GET,POST,OPTIONS").unwrap())
            .with_header(Header::from_bytes("Access-Control-Allow-Headers", "content-type,x-api-key,authorization").unwrap());
        for header in cors_headers_for(&request) {
            response = response.with_header(header);
        }
        let _ = request.respond(response);
        return;
    }

    match (method.clone(), path.as_str()) {
        (Method::Get, "/") | (Method::Get, "/health") => handle_health(request, config, auth),
        (Method::Get, "/v1/models") => handle_models(request, config, auth),
        (Method::Post, "/v1/messages/count_tokens") => handle_count_tokens(request, config),
        (Method::Post, "/v1/messages") => handle_messages(
            request,
            config,
            auth,
            health,
            dedup,
            active_requests,
        ),
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

fn read_json_body(request: &mut Request) -> Result<Value, BodyReadError> {
    if request.body_length().is_some_and(|length| length > MAX_REQUEST_BODY_BYTES) {
        return Err(BodyReadError::TooLarge);
    }
    let mut body = Vec::new();
    request
        .as_reader()
        .take((MAX_REQUEST_BODY_BYTES + 1) as u64)
        .read_to_end(&mut body)
        .map_err(|e| BodyReadError::Invalid(e.to_string()))?;
    if body.len() > MAX_REQUEST_BODY_BYTES {
        return Err(BodyReadError::TooLarge);
    }
    if body.is_empty() {
        return Ok(json!({}));
    }
    serde_json::from_slice(&body).map_err(|e| BodyReadError::Invalid(e.to_string()))
}

fn respond_body_error(request: Request, error: BodyReadError) {
    match error {
        BodyReadError::TooLarge => error_response(
            request,
            413,
            "Request body exceeds the configured limit.",
            "request_too_large",
        ),
        BodyReadError::Invalid(message) => error_response(
            request,
            400,
            &format!("Invalid JSON body: {message}"),
            "invalid_request_error",
        ),
    }
}

fn json_response(request: Request, status: u16, body: &Value) {
    let data = serde_json::to_string(body).unwrap_or_else(|_| "{}".to_string());
    let mut response = Response::from_string(data)
        .with_status_code(StatusCode(status))
        .with_header(Header::from_bytes("Content-Type", "application/json; charset=utf-8").unwrap());
    for header in cors_headers_for(&request) {
        response = response.with_header(header);
    }
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
/// 这里把错误表示成普通文本块后正常 message_delta/message_stop 收尾。
/// `error` SSE 是终端事件，不能先发送它再继续补文本或 message_stop。
fn finish_sse_after_error(mut send: impl FnMut(String), message: &str) {
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
    /// 只表示下游连接不可再写；不得参与 dedup 的 producer 终态转换。
    client_gone: Option<Arc<AtomicBool>>,
}

impl Drop for ChannelReader {
    fn drop(&mut self) {
        // 正常 EOF 和客户端断开都会 Drop reader。这里只停止向下游 tx 写入；producer 继续读完
        // 上游并缓冲，随后独占 InFlight -> Completed/Failed。
        if let Some(gone) = &self.client_gone {
            gone.store(true, Ordering::Release);
        }
    }
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

fn emit_tool_blocks_sse(blocks: &[Value], block_counter: &mut usize, out: &mut String) {
    for block in blocks {
        let index = *block_counter;
        *block_counter += 1;
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

#[derive(Debug)]
struct NativeToolBlock {
    id: String,
    name: String,
    input_json: String,
    object_input: Option<Value>,
    open: bool,
}

impl NativeToolBlock {
    fn finish(&mut self) -> Option<Value> {
        self.open = false;
        let input = if let Some(value) = self.object_input.clone() {
            value
        } else if self.input_json.trim().is_empty() {
            json!({})
        } else {
            serde_json::from_str::<Value>(&self.input_json).ok()?
        };
        if !input.is_object() {
            return None;
        }
        Some(json!({
            "type": "tool_use",
            "id": self.id,
            "name": self.name,
            "input": input,
        }))
    }
}

#[derive(Debug)]
enum NativeToolUpdate {
    Pending,
    Complete(Value),
    Invalid,
}

fn new_native_tool_block(tool_id: &str, name: &str) -> Option<NativeToolBlock> {
    let id = tool_id.trim();
    let name = name.trim();
    if id.is_empty() || name.is_empty() {
        return None;
    }
    Some(NativeToolBlock {
        id: id.to_string(),
        name: name.to_string(),
        input_json: String::new(),
        object_input: None,
        open: true,
    })
}

/// 在代理内累计完整工具输入；只有最终 JSON 是对象时才返回完整 tool_use 块。
/// 这样残缺 JSON、迟到 delta 和重复 stop 永远不会泄漏给 Claude Code。
fn update_native_tool(
    block: &mut NativeToolBlock,
    input: Option<&Value>,
    is_stop: bool,
) -> NativeToolUpdate {
    if !block.open {
        return NativeToolUpdate::Pending;
    }
    match input {
        Some(Value::String(chunk)) if !chunk.is_empty() => block.input_json.push_str(chunk),
        Some(value) if value.is_object() => block.object_input = Some(value.clone()),
        _ => {}
    }
    if !is_stop {
        return NativeToolUpdate::Pending;
    }

    match block.finish() {
        Some(value) => NativeToolUpdate::Complete(value),
        None => NativeToolUpdate::Invalid,
    }
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

/// 解析上游 Event Stream，边收边推 Anthropic SSE。返回是否干净结束（流是否被完整读完）。
///
/// 原生 `toolUseEvent` 是主路径：文本增量不再为 tools 整包缓冲。
/// 仅当内容像「文本里嵌 tool JSON」时短暂暂缓；真正的 tool 调用走增量 toolUseEvent。
fn pipe_kiro_body_to_anthropic_sse(
    response: ReqwestResponse,
    has_tools: bool,
    mut send: impl FnMut(String),
) -> bool {
    let mut parser = IncrementalEventStream::new();
    let mut reader = response;
    let mut read_buf = [0u8; 8192];
    let mut full_text = String::new();
    let mut text_started = false;
    let mut text_block_index: Option<usize> = None;
    let mut thinking_started = false;
    let mut thinking_block_index: Option<usize> = None;
    let mut thinking_signature: Option<String> = None;
    let mut saw_native_tool = false;
    let mut emitted_tool_use = false;
    let mut invalid_native_tool = false;
    let mut block_counter = 0usize;
    let mut native_tool_blocks: HashMap<String, NativeToolBlock> = HashMap::new();
    let mut native_tool_order: Vec<String> = Vec::new();
    let mut completed_native_tools: HashMap<String, Value> = HashMap::new();
    let mut stop_reason = "end_turn".to_string();
    let mut protocol_guard = ProtocolTextGuard::default();
    // 请求声明了 tools 时才恢复文本中泄漏的 SDK tool_use，避免普通对话里的 JSON 示例被执行。
    let mut mixed_tool_guard = MixedTextToolGuard::new(has_tools);

    loop {
        let n = match reader.read(&mut read_buf) {
            Ok(0) => break,
            Ok(n) => n,
            Err(e) => {
                // 已 message_start：用文本/message_delta 正常收尾；不能先发终端 error 再补事件。
                let msg = format!("读取 Kiro 流失败: {e}");
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
                for block in native_tool_blocks.values_mut() {
                    block.open = false;
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
                return false;
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

                    // 整个响应期间持续扫描，而不是在首段普通正文后永久锁定文本模式。
                    // 普通文字立即可见；任意后续行首的 SDK tool_use JSON 暂缓并在收尾恢复。
                    let visible = mixed_tool_guard.push(&chunk);
                    if visible.is_empty() {
                        continue;
                    }

                    close_thinking_block_sse(
                        &mut thinking_started,
                        thinking_block_index,
                        &thinking_signature,
                        &mut send,
                    );
                    let index = ensure_text_block_index(&mut text_block_index, &mut block_counter);
                    send_text_immediate(&mut text_started, index, &visible, &mut send);
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
                        // 原生 toolUseEvent 始终优先：丢掉文本路径中尚未确认的工具候选，
                        // 再收尾 thinking/text，避免同一调用被文本恢复与原生事件重复发射。
                        mixed_tool_guard = MixedTextToolGuard::new(has_tools);
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
                        let Some(block) = new_native_tool_block(&tool_id, &name) else {
                            continue;
                        };
                        native_tool_order.push(tool_id.clone());
                        native_tool_blocks.insert(tool_id.clone(), block);
                        saw_native_tool = true;
                    }

                    let is_stop = event
                        .payload
                        .get("stop")
                        .and_then(|v| v.as_bool())
                        .unwrap_or(false);
                    let Some(block) = native_tool_blocks.get_mut(&tool_id) else {
                        continue;
                    };
                    if block.name.is_empty() && !name.is_empty() {
                        block.name = name;
                    }
                    match update_native_tool(block, event.payload.get("input"), is_stop) {
                        NativeToolUpdate::Pending => {}
                        NativeToolUpdate::Complete(tool) => {
                            completed_native_tools.insert(tool_id.clone(), tool);
                        }
                        NativeToolUpdate::Invalid => invalid_native_tool = true,
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
        if !saw_native_tool {
            let visible = mixed_tool_guard.push(&trailing_text);
            if !visible.is_empty() {
                close_thinking_block_sse(
                    &mut thinking_started,
                    thinking_block_index,
                    &thinking_signature,
                    &mut send,
                );
                let index = ensure_text_block_index(&mut text_block_index, &mut block_counter);
                send_text_immediate(&mut text_started, index, &visible, &mut send);
            }
        }
    }

    let mixed_finish = if saw_native_tool {
        Default::default()
    } else {
        mixed_tool_guard.finish()
    };
    if !mixed_finish.visible_text.is_empty() {
        close_thinking_block_sse(
            &mut thinking_started,
            thinking_block_index,
            &thinking_signature,
            &mut send,
        );
        let index = ensure_text_block_index(&mut text_block_index, &mut block_counter);
        send_text_immediate(
            &mut text_started,
            index,
            &mixed_finish.visible_text,
            &mut send,
        );
    }
    if mixed_finish.incomplete_tool {
        // 候选在 JSON 顶层对象闭合前断流：不泄漏协议残片，以 max_tokens 触发
        // Claude 流解析器已有的一次 INTERNAL_RECOVERY_PROMPT 自动续跑。
        stop_reason = "max_tokens".to_string();
    }

    close_thinking_block_sse(
        &mut thinking_started,
        thinking_block_index,
        &thinking_signature,
        &mut send,
    );

    // 前置正文可以先占用一个 text block；恢复出的工具块必须在关闭正文后，
    // 从当前 block_counter 继续编号，不能重新使用 index 0。
    if text_started {
        let index = text_block_index.unwrap_or(0);
        send(sse_event(
            "content_block_stop",
            &json!({ "type": "content_block_stop", "index": index }),
        ));
    }
    if !mixed_finish.tool_blocks.is_empty() {
        let mut out = String::new();
        emit_tool_blocks_sse(&mixed_finish.tool_blocks, &mut block_counter, &mut out);
        if !out.is_empty() {
            send(out);
            emitted_tool_use = true;
            stop_reason = "tool_use".to_string();
        }
    }

    // 上游可能省略 toolUseEvent.stop；EOF 时仍需验证完整 JSON，不能把半截 input 当工具调用。
    for tool_id in &native_tool_order {
        let Some(block) = native_tool_blocks.get_mut(tool_id) else {
            invalid_native_tool = true;
            continue;
        };
        if block.open {
            match block.finish() {
                Some(tool) => {
                    completed_native_tools.insert(tool_id.clone(), tool);
                }
                None => invalid_native_tool = true,
            }
        }
    }

    // 原生工具整轮均合法后才按首次出现顺序向 Claude Code 发出，避免部分合法、
    // 部分残缺的混合流，也避免 HashMap/完成时序导致工具块乱序。
    let ordered_native_tools = native_tool_order
        .iter()
        .filter_map(|tool_id| completed_native_tools.get(tool_id).cloned())
        .collect::<Vec<_>>();
    if saw_native_tool
        && !invalid_native_tool
        && ordered_native_tools.len() == native_tool_order.len()
        && !ordered_native_tools.is_empty()
    {
        let mut out = String::new();
        emit_tool_blocks_sse(&ordered_native_tools, &mut block_counter, &mut out);
        if !out.is_empty() {
            send(out);
            emitted_tool_use = true;
            stop_reason = "tool_use".to_string();
        }
    }

    let had_assistant_content =
        emitted_tool_use || text_started || text_block_index.is_some() || thinking_block_index.is_some();

    // 无效工具输入即使前面有思考/正文，也追加一条合法文本错误并以 end_turn 收尾。
    if invalid_native_tool {
        emit_fallback_text_block_sse(
            &mut block_counter,
            "API Error: model returned an incomplete tool call",
            &mut send,
        );
        stop_reason = "end_turn".to_string();
    } else if !had_assistant_content {
        let fallback = if stop_reason == "tool_use" {
            "API Error: upstream claimed tool_use but returned no tool call"
        } else if protocol_guard.detected() {
            "API Error: response interrupted by protocol leak"
        } else {
            "API Error: empty assistant response"
        };
        emit_fallback_text_block_sse(&mut block_counter, fallback, &mut send);
    }

    let final_stop =
        normalize_stop_reason(&stop_reason, emitted_tool_use, protocol_guard.detected());

    send(sse_event(
        "message_delta",
        &json!({
            "type": "message_delta",
            "delta": { "stop_reason": final_stop, "stop_sequence": null },
            "usage": { "output_tokens": estimate_tokens(&full_text) },
        }),
    ));
    send(sse_event("message_stop", &json!({ "type": "message_stop" })));
    true
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
    health: Arc<ProxyHealth>,
    entry: Option<Arc<DedupEntry>>,
    dedup: Arc<DedupStore>,
    active_requests: Arc<AtomicUsize>,
) {
    // 只有真正会打 GenerateAssistantResponse 的 leader 才占用上游并发许可。
    let Some(permit) = try_acquire_request(&active_requests, MAX_CONCURRENT_REQUESTS) else {
        if let Some(entry) = &entry {
            dedup.mark_failed(entry);
        }
        return error_response(
            request,
            429,
            "Too many concurrent requests.",
            "rate_limit_error",
        );
    };

    let (tx, rx) = mpsc::sync_channel::<Vec<u8>>(16);
    // reader Drop 只停止下游写入；producer 仍完整消费上游并填满 dedup buffer。
    let client_gone = Arc::new(AtomicBool::new(false));
    // 心跳：producer 阻塞等 Kiro 首字节 / 事件间隙期间持续发 SSE 注释，防止连接空转被掐。
    let hb_tx = tx.clone();
    let hb_gone = Arc::clone(&client_gone);
    thread::spawn(move || {
        while !hb_gone.load(Ordering::Relaxed) {
            thread::sleep(SSE_HEARTBEAT_INTERVAL);
            if hb_gone.load(Ordering::Relaxed) {
                break;
            }
            // try_send：通道满（说明数据在流动）时跳过，绝不阻塞心跳
            let _ = hb_tx.try_send(b": keepalive\n\n".to_vec());
        }
    });

    let eof_tx = tx.clone();
    let producer_gone = Arc::clone(&client_gone);
    let producer = thread::spawn(move || {
        let _permit = permit;
        // 即使客户端已断开也继续 append 完整缓冲；仅跳过对已关闭 tx 的写入。
        let mut send = |chunk: String| {
            if let Some(entry) = &entry {
                dedup.append(entry, chunk.as_bytes());
            }
            if !producer_gone.load(Ordering::Acquire)
                && tx.send(chunk.into_bytes()).is_err()
            {
                producer_gone.store(true, Ordering::Release);
            }
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
            &auth.runtime,
            auth.as_ref(),
            &runtime_url,
            "KiroRuntimeService.GenerateAssistantResponse",
            &built,
        ) {
            Ok(response) => response,
            Err(e) => {
                health.record_failure();
                diag_log(&format!(
                    "[stream] network_error={e} body={}",
                    truncate_for_log(&serde_json::to_string(&built).unwrap_or_default(), 2048)
                ));
                // 已提前 message_start：以文本块正常收尾，再由 producer 发布 Failed。
                finish_sse_after_error(&mut send, &e);
                if let Some(entry) = &entry {
                    dedup.mark_failed(entry);
                }
                let _ = eof_tx.send(Vec::new());
                return;
            }
        };

        let status = upstream.status();
        if !status.is_success() {
            health.record_failure();
            let bytes = upstream.bytes().unwrap_or_default();
            let text = String::from_utf8_lossy(&bytes).to_string();
            diag_log(&format!(
                "[stream] status={status} body={} resp={text}",
                truncate_for_log(&serde_json::to_string(&built).unwrap_or_default(), 2048)
            ));
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
            if let Some(entry) = &entry {
                dedup.mark_failed(entry);
            }
            let _ = eof_tx.send(Vec::new());
            return;
        }

        let clean = pipe_kiro_body_to_anthropic_sse(upstream, has_tools, send);
        if clean {
            health.record_success();
            if let Some(e) = &entry {
                dedup.mark_completed(e);
            }
        } else {
            health.record_failure();
            if let Some(e) = &entry {
                dedup.mark_failed(e);
            }
        }
        let _ = eof_tx.send(Vec::new());
    });

    let reader = ChannelReader {
        rx,
        current: Vec::new(),
        pos: 0,
        eof: false,
        client_gone: Some(Arc::clone(&client_gone)),
    };
    let mut headers = vec![
        Header::from_bytes("Content-Type", "text/event-stream; charset=utf-8").unwrap(),
        Header::from_bytes("Cache-Control", "no-cache").unwrap(),
        Header::from_bytes("Connection", "keep-alive").unwrap(),
        Header::from_bytes("X-Accel-Buffering", "no").unwrap(),
    ];
    headers.extend(cors_headers_for(&request));
    let response = Response::new(StatusCode(200), headers, reader, None, None)
        .with_chunked_threshold(0);

    let _ = request.respond(response);
    // 有界等待 producer：客户端断开后（client_gone 已置位）最多再等一小段让线程收尾，
    // 避免 handler 线程被最长 1500s 的上游请求永久卡住（旧实现直接 join）。
    let join_deadline = Instant::now() + Duration::from_millis(500);
    while !producer.is_finished() && Instant::now() < join_deadline {
        thread::sleep(Duration::from_millis(10));
    }
}

/// 把已缓冲的完整 SSE 流原样回放给客户端（同 body 请求的复用路径，不产生新的 Kiro 生成）。
fn respond_replayed_sse(request: Request, bytes: Vec<u8>) {
    let mut headers = vec![
        Header::from_bytes("Content-Type", "text/event-stream; charset=utf-8").unwrap(),
        Header::from_bytes("Cache-Control", "no-cache").unwrap(),
        Header::from_bytes("Connection", "keep-alive").unwrap(),
        Header::from_bytes("X-Accel-Buffering", "no").unwrap(),
    ];
    headers.extend(cors_headers_for(&request));
    let response = Response::new(StatusCode(200), headers, Cursor::new(bytes), None, None);
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
        diag_log(&format!(
            "[GenerateAssistantResponse] status={status} body={} resp={text}",
            truncate_for_log(&serde_json::to_string(body).unwrap_or_default(), 2048)
        ));
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

fn handle_health(request: Request, _config: &ProxyConfig, _auth: &Auth) {
    // 健康检查只暴露最少信息：不含端口、默认模型、认证来源/令牌路径等细节
    let body = json!({ "ok": true, "service": "codecli-manager-kiro" });
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
        Err(error) => return respond_body_error(request, error),
    };
    let text = json!({
        "system": body.get("system").unwrap_or(&Value::Null),
        "messages": body.get("messages").unwrap_or(&Value::Null),
        "tools": body.get("tools").unwrap_or(&Value::Null),
    })
    .to_string();
    json_response(request, 200, &json!({ "input_tokens": estimate_tokens(&text) }));
}

fn handle_messages(
    mut request: Request,
    config: &ProxyConfig,
    auth: &Arc<Auth>,
    health: Arc<ProxyHealth>,
    dedup: Arc<DedupStore>,
    active_requests: Arc<AtomicUsize>,
) {
    if !check_proxy_auth(&request, config) {
        return error_response(request, 401, "Invalid proxy API key.", "authentication_error");
    }

    let body = match read_json_body(&mut request) {
        Ok(body) => body,
        Err(error) => return respond_body_error(request, error),
    };
    let is_stream = body.get("stream").and_then(|v| v.as_bool()).unwrap_or(false);

    // 在任何 Kiro 认证恢复、模型解析或 profile 发现前先原子去重。
    // follower 因而既不占 GenerateAssistantResponse 许可，也不触发 Kiro 控制面/运行时请求。
    let dedup_entry = if is_stream {
        let key = DedupStore::fingerprint(&body);
        match dedup.acquire(key) {
            DedupAcquire::Leader(entry) => Some(entry),
            DedupAcquire::Replay(bytes) => return respond_replayed_sse(request, bytes),
            DedupAcquire::Failed => {
                return error_response(
                    request,
                    502,
                    "The in-progress request with the same body failed.",
                    "api_error",
                );
            }
            DedupAcquire::TimedOut => {
                return error_response(
                    request,
                    504,
                    "Timed out waiting for the in-progress request with the same body.",
                    "api_error",
                );
            }
        }
    } else {
        None
    };

    // 检测到连续失败（Claude Code 重试风暴）时，leader 再自检/恢复代理状态。
    if health.needs_preflight() {
        health.run_preflight_recovery(auth);
    }

    let model = body.get("model").and_then(|v| v.as_str()).unwrap_or("");
    let kiro_model = resolve_kiro_model(auth, model, &config.default_model);
    let profile_arn = match resolve_profile_arn(auth) {
        Ok(arn) => arn,
        Err(e) => {
            health.record_failure();
            if let Some(entry) = &dedup_entry {
                dedup.mark_failed(entry);
            }
            return error_response(request, 502, &e, "api_error");
        }
    };

    let model_schema = auth.model_schema(&kiro_model);
    let build_result = match &model_schema {
        Some(schema) => {
            build_kiro_request_with_schema(&body, &kiro_model, profile_arn.as_deref(), schema)
        }
        None => build_kiro_request(&body, &kiro_model, profile_arn.as_deref()),
    };
    let built = match build_result {
        Ok(built) => built,
        Err(e) => {
            if let Some(entry) = &dedup_entry {
                dedup.mark_failed(entry);
            }
            return error_response(request, 400, &e, "invalid_request_error");
        }
    };

    let id = format!("msg_{}", Uuid::new_v4().to_string().replace('-', ""));
    let response_model = if model.is_empty() { kiro_model.clone() } else { model.to_string() };

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
            health,
            dedup_entry,
            dedup,
            active_requests,
        );
    }

    let Some(_permit) = try_acquire_request(&active_requests, MAX_CONCURRENT_REQUESTS) else {
        return error_response(
            request,
            429,
            "Too many concurrent requests.",
            "rate_limit_error",
        );
    };

    let events = match call_kiro_generate(&auth.runtime, auth, config, &built) {
        Ok(events) => events,
        Err(e) => {
            health.record_failure();
            diag_log(&format!(
                "[handle_messages] generate_error={e} status=502 body={}",
                truncate_for_log(&serde_json::to_string(&built).unwrap_or_default(), 2048)
            ));
            return error_response(request, 502, &e, "api_error");
        }
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
    health.record_success();
    json_response(request, 200, &response);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn concurrency_permit_enforces_limit_and_releases() {
        let active = Arc::new(AtomicUsize::new(0));
        let first = try_acquire_request(&active, 1).expect("first permit");
        assert!(try_acquire_request(&active, 1).is_none());
        drop(first);
        assert!(try_acquire_request(&active, 1).is_some());
    }

    #[test]
    fn oversized_body_is_rejected_with_413() {
        let mut handle = start_proxy(test_config(39872)).expect("proxy starts");
        let client = reqwest::blocking::Client::new();
        let body = vec![b'x'; MAX_REQUEST_BODY_BYTES + 1];
        let response = client
            .post(format!("http://127.0.0.1:{}/v1/messages", handle.port))
            .header("x-api-key", "test-key")
            .body(body)
            .send()
            .unwrap();
        assert_eq!(response.status(), 413);
        handle.stop();
    }

    #[test]
    fn dedup_acquire_elects_exactly_one_concurrent_leader() {
        use std::sync::Barrier;

        let store = Arc::new(DedupStore::new());
        let barrier = Arc::new(Barrier::new(16));
        let leaders = Arc::new(AtomicUsize::new(0));
        let replays = Arc::new(AtomicUsize::new(0));
        let mut threads = Vec::new();
        for _ in 0..16 {
            let store = Arc::clone(&store);
            let barrier = Arc::clone(&barrier);
            let leaders = Arc::clone(&leaders);
            let replays = Arc::clone(&replays);
            threads.push(thread::spawn(move || {
                barrier.wait();
                match store.acquire_with_limits(
                    42,
                    Duration::from_secs(1),
                    Duration::from_secs(1),
                ) {
                    DedupAcquire::Leader(entry) => {
                        leaders.fetch_add(1, Ordering::SeqCst);
                        thread::sleep(Duration::from_millis(40));
                        store.append(&entry, b"complete-sse");
                        assert!(store.mark_completed(&entry));
                    }
                    DedupAcquire::Replay(bytes) => {
                        assert_eq!(bytes, b"complete-sse");
                        replays.fetch_add(1, Ordering::SeqCst);
                    }
                    DedupAcquire::Failed => panic!("leader unexpectedly failed"),
                    DedupAcquire::TimedOut => panic!("follower unexpectedly timed out"),
                }
            }));
        }
        for thread in threads {
            thread.join().unwrap();
        }
        assert_eq!(leaders.load(Ordering::SeqCst), 1);
        assert_eq!(replays.load(Ordering::SeqCst), 15);
    }

    #[test]
    fn dedup_follower_waits_past_old_short_window_and_replays() {
        assert!(DEDUP_FOLLOWER_WAIT > Duration::from_secs(5));
        let store = Arc::new(DedupStore::new());
        let entry = match store.acquire_with_limits(
            7,
            Duration::from_millis(400),
            Duration::from_secs(1),
        ) {
            DedupAcquire::Leader(entry) => entry,
            other => panic!("expected leader, got {other:?}"),
        };
        let follower_store = Arc::clone(&store);
        let started = Instant::now();
        let follower = thread::spawn(move || {
            follower_store.acquire_with_limits(
                7,
                Duration::from_millis(400),
                Duration::from_secs(1),
            )
        });
        thread::sleep(Duration::from_millis(80));
        store.append(&entry, b"late-complete");
        assert!(store.mark_completed(&entry));
        match follower.join().unwrap() {
            DedupAcquire::Replay(bytes) => assert_eq!(bytes, b"late-complete"),
            other => panic!("expected replay, got {other:?}"),
        }
        assert!(started.elapsed() >= Duration::from_millis(60));
    }

    #[test]
    fn dedup_ttl_starts_when_producer_completes() {
        let store = DedupStore::new();
        let entry = match store.acquire_with_limits(
            8,
            Duration::from_millis(100),
            Duration::from_millis(30),
        ) {
            DedupAcquire::Leader(entry) => entry,
            other => panic!("expected leader, got {other:?}"),
        };
        thread::sleep(Duration::from_millis(45));
        store.append(&entry, b"finished");
        assert!(store.mark_completed(&entry));
        assert!(matches!(
            store.acquire_with_limits(
                8,
                Duration::from_millis(100),
                Duration::from_millis(30)
            ),
            DedupAcquire::Replay(_)
        ));
        thread::sleep(Duration::from_millis(40));
        let replacement = match store.acquire_with_limits(
            8,
            Duration::from_millis(100),
            Duration::from_millis(30),
        ) {
            DedupAcquire::Leader(entry) => entry,
            other => panic!("expected new leader after TTL, got {other:?}"),
        };
        assert!(store.mark_failed(&replacement));
    }

    #[test]
    fn normal_reader_eof_cannot_overwrite_completed_entry() {
        let store = DedupStore::new();
        let entry = match store.acquire(9) {
            DedupAcquire::Leader(entry) => entry,
            other => panic!("expected leader, got {other:?}"),
        };
        store.append(&entry, b"event: message_stop\n\n");
        assert!(store.mark_completed(&entry));

        let (tx, rx) = mpsc::channel();
        tx.send(Vec::new()).unwrap();
        let gone = Arc::new(AtomicBool::new(false));
        let mut reader = ChannelReader {
            rx,
            current: Vec::new(),
            pos: 0,
            eof: false,
            client_gone: Some(Arc::clone(&gone)),
        };
        let mut byte = [0u8; 1];
        assert_eq!(reader.read(&mut byte).unwrap(), 0);
        drop(reader);
        assert!(gone.load(Ordering::Acquire));
        assert!(matches!(store.acquire(9), DedupAcquire::Replay(_)));
    }

    #[test]
    fn disconnected_client_still_gets_one_complete_replay_buffer() {
        let store = DedupStore::new();
        let entry = match store.acquire(10) {
            DedupAcquire::Leader(entry) => entry,
            other => panic!("expected leader, got {other:?}"),
        };
        store.append(&entry, b"start|");
        let (_tx, rx) = mpsc::channel();
        let gone = Arc::new(AtomicBool::new(false));
        drop(ChannelReader {
            rx,
            current: Vec::new(),
            pos: 0,
            eof: false,
            client_gone: Some(Arc::clone(&gone)),
        });
        assert!(gone.load(Ordering::Acquire));
        store.append(&entry, b"delta|");
        store.append(&entry, b"stop");
        assert!(store.mark_completed(&entry));
        assert!(!store.mark_failed(&entry));
        match store.acquire(10) {
            DedupAcquire::Replay(bytes) => assert_eq!(bytes, b"start|delta|stop"),
            other => panic!("expected complete replay, got {other:?}"),
        }
    }

    #[test]
    fn dedup_overflow_blocks_followers_until_leader_finishes() {
        let store = Arc::new(DedupStore::new());
        let entry = match store.acquire(11) {
            DedupAcquire::Leader(entry) => entry,
            other => panic!("expected leader, got {other:?}"),
        };
        store.append(&entry, vec![b'x'; DEDUP_BUFFER_CAP].as_ref());
        store.append(&entry, b"overflow");

        let follower_store = Arc::clone(&store);
        let (result_tx, result_rx) = mpsc::channel();
        let follower = thread::spawn(move || {
            let result = follower_store.acquire_with_limits(
                11,
                Duration::from_millis(500),
                Duration::from_secs(1),
            );
            result_tx.send(result).unwrap();
        });
        assert!(result_rx.recv_timeout(Duration::from_millis(50)).is_err());
        assert!(store.mark_completed(&entry));
        assert!(matches!(
            result_rx.recv_timeout(Duration::from_millis(500)).unwrap(),
            DedupAcquire::Failed
        ));
        follower.join().unwrap();
        let replacement = match store.acquire(11) {
            DedupAcquire::Leader(entry) => entry,
            other => panic!("a later request should become leader, got {other:?}"),
        };
        assert!(store.mark_failed(&replacement));
    }

    #[test]
    fn dedup_fingerprint_is_stable_and_distinct() {
        let a = json!({ "model": "claude", "messages": [{ "role": "user", "content": "hi" }], "stream": true });
        let b = json!({ "model": "claude", "messages": [{ "role": "user", "content": "hi" }], "stream": true });
        let c = json!({ "model": "claude", "messages": [{ "role": "user", "content": "hi!" }], "stream": true });
        assert_eq!(DedupStore::fingerprint(&a), DedupStore::fingerprint(&b));
        assert_ne!(DedupStore::fingerprint(&a), DedupStore::fingerprint(&c));
    }

    #[test]
    fn nameless_tool_use_event_is_not_emitted_as_block() {
        assert!(new_native_tool_block("call_1", "").is_none());
        assert!(new_native_tool_block("", "Bash").is_none());
    }

    #[test]
    fn complete_native_tool_buffers_until_valid_json_stop() {
        let mut block = new_native_tool_block("call_1", "Bash").expect("valid tool");
        assert!(matches!(
            update_native_tool(&mut block, Some(&json!("{\"command\":")), false),
            NativeToolUpdate::Pending
        ));
        match update_native_tool(&mut block, Some(&json!("\"ls\"}")), true) {
            NativeToolUpdate::Complete(tool) => {
                assert_eq!(tool["id"], "call_1");
                assert_eq!(tool["name"], "Bash");
                assert_eq!(tool["input"]["command"], "ls");
            }
            other => panic!("expected complete tool, got {other:?}"),
        }
    }

    #[test]
    fn closed_native_tool_ignores_late_delta_and_duplicate_stop() {
        let mut block = new_native_tool_block("call_1", "Bash").expect("valid tool");
        assert!(matches!(
            update_native_tool(&mut block, Some(&json!("{\"command\":\"ls\"}")), true),
            NativeToolUpdate::Complete(_)
        ));
        assert!(matches!(
            update_native_tool(&mut block, Some(&json!("late")), false),
            NativeToolUpdate::Pending
        ));
        assert!(matches!(
            update_native_tool(&mut block, None, true),
            NativeToolUpdate::Pending
        ));
    }

    #[test]
    fn invalid_native_tool_json_never_becomes_tool_use() {
        let mut block = new_native_tool_block("call_bad", "Bash").expect("valid tool shell");
        assert!(matches!(
            update_native_tool(&mut block, Some(&json!("{\"command\":")), true),
            NativeToolUpdate::Invalid
        ));
    }

    #[test]
    fn metadata_tool_use_without_complete_tool_downgrades_to_end_turn() {
        let metadata_reason = map_kiro_stop_reason("TOOL_USE");
        assert_eq!(
            normalize_stop_reason(&metadata_reason, false, false),
            "end_turn"
        );
    }

    #[test]
    fn streamed_error_is_text_before_normal_terminal_events() {
        let mut out = String::new();
        finish_sse_after_error(|chunk| out.push_str(&chunk), "upstream failed");
        assert!(!out.contains("event: error"));
        let text = out.find("event: content_block_start").unwrap();
        let delta = out.find("event: message_delta").unwrap();
        let stop = out.find("event: message_stop").unwrap();
        assert!(text < delta && delta < stop);
    }

    #[test]
    fn recovered_tools_continue_indexes_after_visible_text_block() {
        let blocks = vec![
            json!({"type":"tool_use","id":"call_bash","name":"Bash","input":{"command":"ls"}}),
            json!({"type":"tool_use","id":"call_read","name":"Read","input":{"file_path":"a.ts"}}),
        ];
        // index 0 已由前置正常正文占用。
        let mut counter = 1usize;
        let mut out = String::new();
        emit_tool_blocks_sse(&blocks, &mut counter, &mut out);

        assert_eq!(counter, 3);
        assert!(out.contains("\"index\":1"));
        assert!(out.contains("\"index\":2"));
        assert!(!out.contains("\"index\":0"));
        assert!(out.contains("\"name\":\"Bash\""));
        assert!(out.contains("\"name\":\"Read\""));
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
            client_gone: None,
        };
        let mut buf = String::new();
        reader.read_to_string(&mut buf).unwrap();
        assert_eq!(buf, "hello world");
    }

    #[test]
    fn channel_reader_drop_only_sets_client_gone() {
        let dedup = DedupStore::new();
        let key = 42u64;
        let entry = match dedup.acquire(key) {
            DedupAcquire::Leader(entry) => entry,
            other => panic!("expected leader, got {other:?}"),
        };

        let (_tx, rx) = mpsc::sync_channel::<Vec<u8>>(4);
        let client_gone = Arc::new(AtomicBool::new(false));
        let reader = ChannelReader {
            rx,
            current: Vec::new(),
            pos: 0,
            eof: false,
            client_gone: Some(Arc::clone(&client_gone)),
        };
        drop(reader);

        assert!(client_gone.load(Ordering::Acquire));
        let state = entry.state.lock().unwrap();
        assert!(matches!(&state.status, DedupStatus::InFlight));
        drop(state);
        dedup.append(&entry, b"complete-after-disconnect");
        assert!(dedup.mark_completed(&entry));
        assert!(matches!(dedup.acquire(key), DedupAcquire::Replay(_)));
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

    #[test]
    fn health_does_not_leak_sensitive_fields() {
        let mut handle = start_proxy(test_config(39873)).expect("proxy starts");
        let port = handle.port;
        let client = reqwest::blocking::Client::new();

        let resp = client
            .get(format!("http://127.0.0.1:{port}/health"))
            .send()
            .unwrap();
        assert_eq!(resp.status(), 200);
        let health: Value = resp.json().unwrap();
        assert_eq!(health["ok"], true);
        assert!(health.get("auth_source").is_none());
        assert!(health.get("default_model").is_none());
        assert!(health.get("port").is_none());
        assert!(health.get("endpoints").is_none());

        handle.stop();
    }

    #[test]
    fn foreign_host_header_is_rejected() {
        let mut handle = start_proxy(test_config(39875)).expect("proxy starts");
        let port = handle.port;
        let client = reqwest::blocking::Client::new();

        // 伪造 Host → DNS rebinding 场景，必须被拒绝
        let resp = client
            .get(format!("http://127.0.0.1:{port}/health"))
            .header(reqwest::header::HOST, "evil.example.com")
            .send()
            .unwrap();
        assert_eq!(resp.status(), 400);

        handle.stop();
    }

    #[test]
    fn cors_header_only_for_loopback_origins() {
        let mut handle = start_proxy(test_config(39877)).expect("proxy starts");
        let port = handle.port;
        let client = reqwest::blocking::Client::new();

        // 本机来源 → 回显对应 Origin
        let resp = client
            .get(format!("http://127.0.0.1:{port}/health"))
            .header(reqwest::header::ORIGIN, "http://localhost:1420")
            .send()
            .unwrap();
        assert_eq!(
            resp.headers().get("access-control-allow-origin").unwrap(),
            "http://localhost:1420"
        );

        // 恶意跨源 → 不返回任何 CORS 头
        let resp = client
            .get(format!("http://127.0.0.1:{port}/health"))
            .header(reqwest::header::ORIGIN, "https://evil.example.com")
            .send()
            .unwrap();
        assert!(resp.headers().get("access-control-allow-origin").is_none());

        // 原生客户端（无 Origin）→ 不返回 CORS 头
        let resp = client
            .get(format!("http://127.0.0.1:{port}/health"))
            .send()
            .unwrap();
        assert!(resp.headers().get("access-control-allow-origin").is_none());

        handle.stop();
    }
}
