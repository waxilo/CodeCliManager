//! 本地 HTTP 代理：把 Anthropic Messages API 请求转发到 Kiro 后端。
//! 移植自 kiro2cli/src/server.js + proxy-kiro.js（MIT）。
//!
//! 端点：
//! - GET  /health, /          → 健康检查
//! - GET  /v1/models          → Kiro 模型列表（Anthropic 形状，供 Claude Code / ccm 模型选择器）
//! - POST /v1/messages/count_tokens → token 估算
//! - POST /v1/messages        → 对话（SSE 流式 / 非流式）
//!
//! OpenAI 兼容入口（同一监听端口，按路径分流；前缀 /openai/v1）：
//! - GET  /openai/v1/models              → 模型列表（OpenAI 形状）
//! - POST /openai/v1/chat/completions    → 对话（OpenAI 形状，SSE 流式 / 非流式）
//!
//! 两套入口共用同一中间层（Host/Origin 校验、密钥鉴权、并发许可、同请求去重、
//! 健康自愈）与同一上游转换，差异只体现在入参归一化与出参构造（见 `crate::kiro::openai`）。
//! 注意 `GET /v1/models` 保持 Anthropic 形状不变 —— Claude Code 与前端模型选择器都依赖
//! 它的 `data[].id` 与 `has_more`/`first_id` 字段，OpenAI 形状另行开路径，避免破坏既有契约。

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
    collect_kiro_text, extract_reasoning_parts, parse_event_stream_checked, IncrementalEventStream,
    KiroEvent,
};
use crate::kiro::models::{
    estimate_tokens, get_supported_effort_levels, kiro_model_to_public_model_id, normalize_kiro_model,
    public_display_name,
};
use crate::kiro::openai::{
    anthropic_error_type_to_openai, anthropic_stop_reason_to_openai, anthropic_tool_use_to_openai,
    openai_chat_completion, openai_chunk, openai_error_body, openai_model_entry,
    openai_models_list, openai_request_to_anthropic, openai_role_chunk, openai_sse_data,
    openai_usage_chunk, OPENAI_SSE_DONE,
};
use crate::kiro::transform::{
    anthropic_message_response_with_tools, build_kiro_request, build_kiro_request_with_schema,
    ensure_tool_id_unique, recover_tool_calls_from_text, RecoveredContent, TextToolRecoveryGuard,
    ToolRecoverySpec,
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
    ///
    /// `protocol` 参与哈希是**必需**的：OpenAI 请求会先归一化成 Anthropic 结构再计算指纹，
    /// 因此「同一个语义请求经两种协议送达」会得到相同的 body。但两套入口写入 dedup buffer
    /// 的字节形状不同（Anthropic SSE 事件 vs OpenAI `chat.completion.chunk`），
    /// 若不加区分，follower 会把另一种协议格式的缓冲原样回放给客户端，导致解析失败。
    fn fingerprint(body: &Value, protocol: &str) -> u64 {
        let mut hasher = DefaultHasher::new();
        protocol.hash(&mut hasher);
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

/// Host 白名单校验：只有本机回环地址才算通过，否则返回**拒绝原因**。
///
/// 返回原因而不是 bool，是因为这里统一回 400 的写法曾经掩盖过真实原因：
/// reqwest 默认发送的 `Host: 127.0.0.1:<port>` 本来就合法，一旦判据或端口拆分
/// 出错，线上只会看到一个 400，完全看不出是哪个取值被拒。把实际取值带上，
/// 测试与日志里能直接定位，不必再加临时打印。
fn loopback_host_violation(host: &str) -> Option<String> {
    let host = host.trim();
    let bare = if let Some(rest) = host.strip_prefix('[') {
        rest.split(']').next().unwrap_or(rest).to_string()
    } else {
        host.split(':').next().unwrap_or(host).to_string()
    };
    if bare.is_empty() {
        return Some("Host header is empty".to_string());
    }
    if matches!(
        bare.as_str(),
        "127.0.0.1" | "localhost" | "::1" | "0:0:0:0:0:0:0:1"
    ) {
        None
    } else {
        Some(format!("host `{host}` is not a loopback address"))
    }
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

/// 请求目标可能是 origin-form（`/v1/messages`）或 absolute-form
/// （`http://127.0.0.1:39871/v1/messages`）。
///
/// 客户端配置了 HTTP 代理（`HTTP_PROXY`）时，reqwest 等库会按 RFC 9112 §3.2.2 发送
/// absolute-form；同一规范要求服务端必须接受该形态。这里统一还原为 origin-form 再做路由匹配，
/// 否则会因路径带 scheme/authority 而落到 404。
fn normalize_request_target(url: &str) -> &str {
    let bytes = url.as_bytes();
    let scheme_len = [b"http://" as &[u8], b"https://"]
        .into_iter()
        .find(|scheme| bytes.len() > scheme.len() && bytes[..scheme.len()].eq_ignore_ascii_case(scheme))
        .map(<[u8]>::len);
    let Some(scheme_len) = scheme_len else {
        return url;
    };
    match url[scheme_len..].find('/') {
        Some(index) => &url[scheme_len + index..],
        // 只有 authority、没有路径（如 "http://127.0.0.1:39871"）等价于根路径
        None => "/",
    }
}

fn handle_request(
    request: Request,
    config: &ProxyConfig,
    auth: &Arc<Auth>,
    health: Arc<ProxyHealth>,
    dedup: Arc<DedupStore>,
    active_requests: Arc<AtomicUsize>,
) {
    // Host 校验：仅接受本机回环地址，阻断 DNS rebinding（浏览器把恶意域名解析到 127.0.0.1）
    let host_value = request
        .headers()
        .iter()
        .find(|header| header.field.equiv("host"))
        .map(|header| header.value.as_str().to_string());
    if let Some(violation) = host_value
        .as_deref()
        .map(loopback_host_violation)
        .unwrap_or_else(|| Some("Host header is missing".to_string()))
    {
        return error_response(
            request,
            400,
            &format!("Invalid Host header: {violation}"),
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
    let target = normalize_request_target(&url);
    let path = target.split('?').next().unwrap_or(target).to_string();

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
        // OpenAI 兼容入口：与 Anthropic 路径共用中间层，仅入参/出参形状不同
        (Method::Get, "/openai/v1/models") => handle_openai_models(request, config, auth),
        (Method::Post, "/openai/v1/chat/completions") => handle_openai_chat_completions(
            request,
            config,
            auth,
            health,
            dedup,
            active_requests,
        ),
        _ => {
            // 404 的信封形状按路径前缀区分，避免 OpenAI SDK 收到 Anthropic 形状后解析失败
            if path.starts_with("/openai/") {
                openai_error_response(
                    request,
                    404,
                    &format!("No route for {method} {path}"),
                    "invalid_request_error",
                );
            } else {
                let body = json!({ "type": "error", "error": { "type": "invalid_request_error", "message": format!("No route for {method} {path}") } });
                json_response(request, 404, &body);
            }
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

/// OpenAI 形状的错误响应。
///
/// `error_type` 传 Anthropic 侧取值（如 `api_error`），这里统一映射成 OpenAI 的 type，
/// 调用点因此可以复用同一套语义标签，不必在两处维护映射表。
fn openai_error_response(request: Request, status: u16, message: &str, error_type: &str) {
    let body = openai_error_body(message, anthropic_error_type_to_openai(error_type));
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

/// 原生工具入参归一化：直接合法就用原值；被 antml 残片污染时尝试重建后再校验。
///
/// **不会因为「入参不合规」丢掉整轮**。本校验器对 schema 的理解永远可能落后于客户端
/// （新关键字、新工具），而客户端自己会做权威校验：单条工具报错是可恢复的（模型能读到错误并
/// 重试），整轮被替换成 "model returned an incomplete tool call" 则不可恢复。
/// 因此这里只做「能修就修、修不了就原样放行」，结构性残缺（JSON 解析不出对象、上游没给 stop、
/// 工具名未声明）仍在调用方按不完整工具处理。
fn normalize_native_tool_input(spec: &ToolRecoverySpec, tool: &mut Value) {
    let name = tool.get("name").and_then(Value::as_str).unwrap_or("").to_string();
    let input = tool.get("input").cloned().unwrap_or(Value::Null);
    if spec.validates_input(&name, &input) {
        return;
    }
    if !spec.analyzes_schema(&name) {
        // 声明里的 schema 用了本校验器不认识的写法（未知关键字等）：无法断言入参非法。
        diag_log(&format!("[tool-schema-unsupported] name={name}"));
        return;
    }
    if let Some(repaired) = spec.repair_polluted_input(&name, &input) {
        if let Some(object) = tool.as_object_mut() {
            object.insert("input".to_string(), repaired);
        }
        return;
    }
    diag_log(&format!(
        "[tool-input-unverified] name={name} input={}",
        truncate_for_log(&input.to_string(), 600)
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

enum BufferedKiroPart {
    Text(String),
    NativeTool(String),
}

fn push_buffered_text(parts: &mut Vec<BufferedKiroPart>, text: &str) {
    if text.is_empty() {
        return;
    }
    if let Some(BufferedKiroPart::Text(previous)) = parts.last_mut() {
        previous.push_str(text);
    } else {
        parts.push(BufferedKiroPart::Text(text.to_string()));
    }
}

fn emit_buffered_kiro_events_to_anthropic_sse(
    events: Vec<KiroEvent>,
    recovery_spec: ToolRecoverySpec,
    mut send: impl FnMut(String),
) -> bool {
    let mut parts = Vec::new();
    let mut native_tools: HashMap<String, NativeToolBlock> = HashMap::new();
    let mut completed_tools: HashMap<String, Value> = HashMap::new();
    let mut thinking = String::new();
    let mut thinking_signature = None;
    let mut stop_reason = "end_turn".to_string();
    let mut invalid_tool = false;

    for event in events {
        match event.event_type.as_str() {
            "assistantResponseEvent" => {
                if let Some(text) = event.payload.get("content").and_then(Value::as_str) {
                    push_buffered_text(&mut parts, text);
                }
            }
            "reasoningContentEvent" => {
                let (text, signature) = extract_reasoning_parts(&event.payload);
                thinking.push_str(&text);
                if signature.is_some() {
                    thinking_signature = signature;
                }
            }
            "toolUseEvent" => {
                let id = event
                    .payload
                    .get("toolUseId")
                    .or_else(|| event.payload.get("tool_use_id"))
                    .and_then(Value::as_str)
                    .unwrap_or("")
                    .trim();
                let name = event.payload.get("name").and_then(Value::as_str).unwrap_or("").trim();
                if id.is_empty() || !recovery_spec.declares(name) {
                    invalid_tool = true;
                    continue;
                }
                if !native_tools.contains_key(id) {
                    let Some(block) = new_native_tool_block(id, name) else {
                        invalid_tool = true;
                        continue;
                    };
                    native_tools.insert(id.to_string(), block);
                    parts.push(BufferedKiroPart::NativeTool(id.to_string()));
                }
                let Some(block) = native_tools.get_mut(id) else {
                    invalid_tool = true;
                    continue;
                };
                if block.name != name {
                    invalid_tool = true;
                    block.open = false;
                    continue;
                }
                let is_stop = event.payload.get("stop").and_then(Value::as_bool).unwrap_or(false);
                match update_native_tool(block, event.payload.get("input"), is_stop) {
                    NativeToolUpdate::Pending => {}
                    NativeToolUpdate::Complete(mut tool) => {
                        normalize_native_tool_input(&recovery_spec, &mut tool);
                        completed_tools.insert(id.to_string(), tool);
                    }
                    NativeToolUpdate::Invalid => invalid_tool = true,
                }
            }
            "metadataEvent" => {
                if let Some(reason) = event.payload.get("stopReason").and_then(Value::as_str) {
                    stop_reason = map_kiro_stop_reason(reason);
                }
            }
            _ => {}
        }
    }

    if native_tools.values().any(|tool| tool.open)
        || completed_tools.len() != native_tools.len()
    {
        invalid_tool = true;
    }
    if invalid_tool {
        let mut block_counter = 0;
        emit_fallback_text_block_sse(
            &mut block_counter,
            "API Error: model returned an incomplete tool call",
            &mut send,
        );
        emit_sse_message_delta_stop(&mut send, "end_turn", 0);
        return true;
    }

    let mut ordered = Vec::new();
    let mut incomplete_tool = false;
    let mut protocol_leak = false;
    let mut output_tokens_text = String::new();
    for part in parts {
        match part {
            BufferedKiroPart::Text(raw) => {
                output_tokens_text.push_str(&raw);
                let (text, detected) = sanitize_protocol_text(&raw);
                protocol_leak |= detected;
                let recovered = recover_tool_calls_from_text(&text, &recovery_spec);
                incomplete_tool |= recovered.incomplete_tool;
                for recovered_part in recovered.parts {
                    match &recovered_part {
                        RecoveredContent::Tool(tool)
                            if completed_tools
                                .values()
                                .any(|native| recovery_spec.is_native_mirror(tool, native)) => {}
                        _ => ordered.push(recovered_part),
                    }
                }
            }
            BufferedKiroPart::NativeTool(id) => {
                if let Some(tool) = completed_tools.get(&id) {
                    ordered.push(RecoveredContent::Tool(tool.clone()));
                }
            }
        }
    }

    let native_tool_ids = completed_tools.keys().cloned().collect::<std::collections::HashSet<_>>();
    let mut seen_tool_ids = native_tool_ids.clone();
    for (index, part) in ordered.iter_mut().enumerate() {
        if let RecoveredContent::Tool(tool) = part {
            let id = tool.get("id").and_then(Value::as_str).unwrap_or("");
            if !native_tool_ids.contains(id) {
                ensure_tool_id_unique(tool, &mut seen_tool_ids, index);
            }
        }
    }

    let mut block_counter = 0;
    let mut thinking_started = false;
    let mut thinking_index = None;
    if !thinking.is_empty() || thinking_signature.is_some() {
        thinking_index = Some(block_counter);
        block_counter += 1;
        emit_thinking_start_sse(thinking_index.unwrap(), &mut send);
        thinking_started = true;
        if !thinking.is_empty() {
            emit_thinking_delta_sse(thinking_index.unwrap(), &thinking, &mut send);
        }
    }
    close_thinking_block_sse(
        &mut thinking_started,
        thinking_index,
        &thinking_signature,
        &mut send,
    );

    let mut text_started = false;
    let mut text_index = None;
    let mut emitted_tools = false;
    for part in ordered {
        match part {
            RecoveredContent::Text(text) if !text.is_empty() => {
                let index = ensure_text_block_index(&mut text_index, &mut block_counter);
                send_text_immediate(&mut text_started, index, &text, &mut send);
            }
            RecoveredContent::Tool(tool) => {
                if text_started {
                    send(sse_event(
                        "content_block_stop",
                        &json!({ "type": "content_block_stop", "index": text_index.unwrap_or(0) }),
                    ));
                    text_started = false;
                    text_index = None;
                }
                let mut out = String::new();
                emit_tool_blocks_sse(&[tool], &mut block_counter, &mut out);
                send(out);
                emitted_tools = true;
            }
            RecoveredContent::Text(_) => {}
        }
    }
    if text_started {
        send(sse_event(
            "content_block_stop",
            &json!({ "type": "content_block_stop", "index": text_index.unwrap_or(0) }),
        ));
    }
    if block_counter == 0 {
        emit_fallback_text_block_sse(
            &mut block_counter,
            "API Error: empty assistant response",
            &mut send,
        );
    }
    let final_stop = normalize_stop_reason(
        &stop_reason,
        emitted_tools,
        incomplete_tool || protocol_leak,
    );
    emit_sse_message_delta_stop(
        &mut send,
        final_stop,
        estimate_tokens(&output_tokens_text),
    );
    true
}

fn pipe_buffered_kiro_tools_to_anthropic_sse(
    response: ReqwestResponse,
    recovery_spec: ToolRecoverySpec,
    mut send: impl FnMut(String),
) -> bool {
    let bytes = match response.bytes() {
        Ok(bytes) => bytes,
        Err(error) => {
            let mut block_counter = 0;
            emit_fallback_text_block_sse(
                &mut block_counter,
                &format!("API Error: 读取 Kiro 流失败: {error}"),
                &mut send,
            );
            emit_sse_message_delta_stop(&mut send, "end_turn", 0);
            return false;
        }
    };
    let events = match parse_event_stream_checked(&bytes) {
        Ok(events) => events,
        Err(error) => {
            let mut block_counter = 0;
            emit_fallback_text_block_sse(
                &mut block_counter,
                &format!("API Error: {error}"),
                &mut send,
            );
            emit_sse_message_delta_stop(&mut send, "max_tokens", 0);
            return false;
        }
    };
    emit_buffered_kiro_events_to_anthropic_sse(events, recovery_spec, send)
}

/// 解析上游 Event Stream，边收边推 Anthropic SSE。返回是否干净结束（流是否被完整读完）。
fn pipe_kiro_body_to_anthropic_sse(
    response: ReqwestResponse,
    recovery_spec: ToolRecoverySpec,
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
    // 仅恢复请求声明过的工具；普通前缀即时发送，首个 JSON 候选起缓冲以保持片段顺序。
    let mut text_tool_guard = TextToolRecoveryGuard::new(recovery_spec.clone());

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
                    if raw_chunk.is_empty() {
                        continue;
                    }
                    let chunk = protocol_guard.push(raw_chunk);
                    if chunk.is_empty() {
                        continue;
                    }
                    full_text.push_str(&chunk);

                    let visible = text_tool_guard.push(&chunk);
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
                        if !recovery_spec.declares(&name) {
                            continue;
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
                    if !name.is_empty() && block.name != name {
                        invalid_native_tool = true;
                        block.open = false;
                        continue;
                    }
                    match update_native_tool(block, event.payload.get("input"), is_stop) {
                        NativeToolUpdate::Pending => {}
                        NativeToolUpdate::Complete(mut tool) => {
                            normalize_native_tool_input(&recovery_spec, &mut tool);
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

    let event_stream_clean = parser.finish();
    if !event_stream_clean {
        stop_reason = "max_tokens".to_string();
    }

    let trailing_text = protocol_guard.finish();
    if !trailing_text.is_empty() {
        full_text.push_str(&trailing_text);
        let visible = text_tool_guard.push(&trailing_text);
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

    let recovered_finish = text_tool_guard.finish();
    if recovered_finish.incomplete_tool {
        stop_reason = "max_tokens".to_string();
    }

    close_thinking_block_sse(
        &mut thinking_started,
        thinking_block_index,
        &thinking_signature,
        &mut send,
    );

    // 上游可能省略 toolUseEvent.stop；EOF 时仍验证完整 JSON 和请求 schema。
    for tool_id in &native_tool_order {
        let Some(block) = native_tool_blocks.get_mut(tool_id) else {
            invalid_native_tool = true;
            continue;
        };
        if block.open {
            match block.finish() {
                Some(mut tool) => {
                    normalize_native_tool_input(&recovery_spec, &mut tool);
                    completed_native_tools.insert(tool_id.clone(), tool);
                }
                None => invalid_native_tool = true,
            }
        }
    }

    let ordered_native_tools = native_tool_order
        .iter()
        .filter_map(|tool_id| completed_native_tools.get(tool_id).cloned())
        .collect::<Vec<_>>();

    // 保留恢复片段的原始次序：工具前后的正文分别占用单调递增的 text block。
    for part in recovered_finish.parts {
        match part {
            RecoveredContent::Text(text) if !text.is_empty() => {
                let index = ensure_text_block_index(&mut text_block_index, &mut block_counter);
                send_text_immediate(&mut text_started, index, &text, &mut send);
            }
            RecoveredContent::Tool(tool) => {
                if ordered_native_tools
                    .iter()
                    .any(|native| recovery_spec.is_native_mirror(&tool, native))
                {
                    continue;
                }
                if text_started {
                    let index = text_block_index.unwrap_or(0);
                    send(sse_event(
                        "content_block_stop",
                        &json!({ "type": "content_block_stop", "index": index }),
                    ));
                    text_started = false;
                    text_block_index = None;
                }
                let mut out = String::new();
                emit_tool_blocks_sse(&[tool], &mut block_counter, &mut out);
                if !out.is_empty() {
                    send(out);
                    emitted_tool_use = true;
                    stop_reason = "tool_use".to_string();
                }
            }
            RecoveredContent::Text(_) => {}
        }
    }
    if text_started {
        let index = text_block_index.unwrap_or(0);
        send(sse_event(
            "content_block_stop",
            &json!({ "type": "content_block_stop", "index": index }),
        ));
        text_block_index = None;
    }

    // 原生工具整轮均合法后才按首次出现顺序发出；不同 ID 的相同参数调用仍各自保留。
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
        emitted_tool_use || text_block_index.is_some() || thinking_block_index.is_some() || !full_text.is_empty();

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
    event_stream_clean
}

/// 解析上游 Event Stream，边收边推 OpenAI SSE（`chat.completion.chunk`）。
/// 返回是否干净结束（流是否被完整读完）。
///
/// 与 `pipe_kiro_body_to_anthropic_sse` 的差异，集中在 OpenAI 协议的三个特点上：
///
/// 1. **没有独立的事件类型**。Anthropic 用 `content_block_start/delta/stop` 显式管理块，
///    OpenAI 只有 `delta` 字段，靠它里面出现什么键来判断当前在推送什么。
///    因此这里把 Anthropic 的「块」折叠成 delta：正文 → `{"content": …}`，
///    思维链 → `{"reasoning_content": …}`，工具调用 → `{"tool_calls":[{…}]}`。
/// 2. **工具入参必须是字符串**。`arguments` 要逐字符累加地发（`function.arguments` 是
///    JSON 文本流），因此不能等工具组装完成再发 —— 但上游「参数可能不完整/被污染」
///    的判定又必须等整轮结束。这里采用业界通行做法：**先按增量发，若整轮结束时判定
///    工具非法，则回退成一条错误正文**（`invalid_native_tool` 分支）。
/// 3. **结束只有 finish_reason + `[DONE]`**，没有 message_delta/message_stop。
///
/// 文本侧的协议泄漏清洗、antml 工具恢复全部沿用与 Anthropic 路径相同的构件，
/// 保证两种协议下模型输出的处置结果一致。
fn pipe_kiro_body_to_openai_sse(
    response: ReqwestResponse,
    recovery_spec: ToolRecoverySpec,
    chat_id: &str,
    response_model: &str,
    mut send: impl FnMut(String),
) -> bool {
    let mut parser = IncrementalEventStream::new();
    let mut reader = response;
    let mut read_buf = [0u8; 8192];
    let mut full_text = String::new();
    let mut thinking_started = false;
    let mut stop_reason = "end_turn".to_string();
    let mut protocol_guard = ProtocolTextGuard::default();
    let mut text_tool_guard = TextToolRecoveryGuard::new(recovery_spec.clone());

    // 原生工具：按 id 聚合，逐块累加 arguments 文本并即时外发。
    // `emitted_any_tool_call` 用于最终把 finish_reason 定为 tool_calls。
    let mut tool_blocks: HashMap<String, OpenAiToolBlock> = HashMap::new();
    let mut tool_order: Vec<String> = Vec::new();
    let mut emitted_any_tool_call = false;

    loop {
        let n = match reader.read(&mut read_buf) {
            Ok(0) => break,
            Ok(n) => n,
            Err(e) => {
                let msg = format!("读取 Kiro 流失败: {e}");
                let had_content = !full_text.is_empty() || emitted_any_tool_call;
                if !had_content {
                    send(openai_sse_data(&openai_chunk(
                        chat_id,
                        response_model,
                        json!({ "content": format!("API Error: {msg}") }),
                        None,
                    )));
                }
                for block in tool_blocks.values_mut() {
                    block.invalid = true;
                }
                send(openai_sse_data(&openai_chunk(
                    chat_id,
                    response_model,
                    json!({}),
                    Some(anthropic_stop_reason_to_openai("end_turn")),
                )));
                send(openai_sse_data(&openai_usage_chunk(
                    chat_id,
                    response_model,
                    estimate_tokens(&full_text),
                )));
                send(OPENAI_SSE_DONE.to_string());
                return false;
            }
        };

        for event in parser.push(&read_buf[..n]) {
            match event.event_type.as_str() {
                "reasoningContentEvent" => {
                    let (text, _signature) = extract_reasoning_parts(&event.payload);
                    if text.is_empty() {
                        continue;
                    }
                    // OpenAI 侧思维链用 reasoning_content；仅在首个增量时带 role 之外无需额外信封
                    thinking_started = true;
                    send(openai_sse_data(&openai_chunk(
                        chat_id,
                        response_model,
                        json!({ "reasoning_content": text }),
                        None,
                    )));
                }
                "assistantResponseEvent" => {
                    let Some(raw_chunk) = event.payload.get("content").and_then(|v| v.as_str()) else {
                        continue;
                    };
                    if raw_chunk.is_empty() {
                        continue;
                    }
                    let chunk = protocol_guard.push(raw_chunk);
                    if chunk.is_empty() {
                        continue;
                    }
                    full_text.push_str(&chunk);

                    let visible = text_tool_guard.push(&chunk);
                    if visible.is_empty() {
                        continue;
                    }
                    send(openai_sse_data(&openai_chunk(
                        chat_id,
                        response_model,
                        json!({ "content": visible }),
                        None,
                    )));
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

                    if !tool_blocks.contains_key(&tool_id) {
                        if !recovery_spec.declares(&name) {
                            continue;
                        }
                        tool_order.push(tool_id.clone());
                        tool_blocks.insert(tool_id.clone(), OpenAiToolBlock::new(&name));
                        // 第一个工具的出现位置就是它在 tool_calls 里的 index，必须稳定
                        let index = tool_order.len() - 1;
                        send(openai_sse_data(&openai_chunk(
                            chat_id,
                            response_model,
                            json!({
                                "tool_calls": [{
                                    "index": index,
                                    "id": tool_id,
                                    "type": "function",
                                    "function": { "name": name, "arguments": "" },
                                }]
                            }),
                            None,
                        )));
                        emitted_any_tool_call = true;
                    }

                    let index = tool_order
                        .iter()
                        .position(|id| id == &tool_id)
                        .unwrap_or(0);
                    let Some(block) = tool_blocks.get_mut(&tool_id) else {
                        continue;
                    };
                    // 名字中途变化视为上游不稳定：只标记，不中断已发出的增量
                    if !name.is_empty() && block.name != name {
                        block.invalid = true;
                        continue;
                    }
                    // 入参增量照原样外发即可；「本轮是否完整」只有整轮结束才判得出来，
                    // 不在这里用 `stop` 标记（OpenAI 侧无法撤回已发出的 arguments）。
                    match event.payload.get("input") {
                        Some(Value::String(fragment)) if !fragment.is_empty() => {
                            block.arguments.push_str(fragment);
                            send(openai_sse_data(&openai_chunk(
                                chat_id,
                                response_model,
                                json!({
                                    "tool_calls": [{
                                        "index": index,
                                        "function": { "arguments": fragment },
                                    }]
                                }),
                                None,
                            )));
                        }
                        Some(value) if value.is_object() => {
                            // 上游偶发直接给完整对象：转成 JSON 文本一次性发出
                            let text =
                                serde_json::to_string(value).unwrap_or_else(|_| "{}".to_string());
                            if block.arguments.is_empty() {
                                block.arguments.push_str(&text);
                                send(openai_sse_data(&openai_chunk(
                                    chat_id,
                                    response_model,
                                    json!({
                                        "tool_calls": [{
                                            "index": index,
                                            "function": { "arguments": text },
                                        }]
                                    }),
                                    None,
                                )));
                            }
                        }
                        _ => {}
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

    let event_stream_clean = parser.finish();
    if !event_stream_clean {
        stop_reason = "max_tokens".to_string();
    }

    // 尾包正文：与 Anthropic 路径一致，先放行协议守护的滞留内容，再结算文本工具恢复
    let trailing_text = protocol_guard.finish();
    if !trailing_text.is_empty() {
        full_text.push_str(&trailing_text);
        let visible = text_tool_guard.push(&trailing_text);
        if !visible.is_empty() {
            send(openai_sse_data(&openai_chunk(
                chat_id,
                response_model,
                json!({ "content": visible }),
                None,
            )));
        }
    }

    let recovered_finish = text_tool_guard.finish();
    if recovered_finish.incomplete_tool {
        stop_reason = "max_tokens".to_string();
    }

    // 整轮结束后才能判定原生工具是否合法：入参必须是完整 JSON 且通过请求声明的 schema。
    //
    // 空入参视为 `{}`（与 Anthropic 路径 `NativeToolBlock::finish` 一致）：模型对无参工具
    // 常常一个 `input` 分片都不发，只有 name —— 若把「没收到入参」判成残缺，会让这类调用
    // 每次都被回退成错误正文。
    let mut invalid_native_tool = false;
    for tool_id in &tool_order {
        let Some(block) = tool_blocks.get(tool_id) else {
            invalid_native_tool = true;
            continue;
        };
        if block.invalid {
            invalid_native_tool = true;
            continue;
        }
        let trimmed = block.arguments.trim();
        let parsed = if trimmed.is_empty() {
            Some(json!({}))
        } else {
            serde_json::from_str::<Value>(trimmed).ok()
        };
        let valid = parsed
            .as_ref()
            .is_some_and(|input| recovery_spec.validates_input(&block.name, input));
        if !valid {
            invalid_native_tool = true;
        }
    }

    // 文本恢复出的工具调用：只有在整轮没有原生工具时才作为 tool_calls 补发，
    // 避免与已发出的增量重复（`is_native_mirror` 判定同一调用）。
    let mut recovered_tool_index = tool_order.len();
    if !invalid_native_tool {
        for part in recovered_finish.parts {
            let RecoveredContent::Tool(tool) = part else {
                continue;
            };
            if tool_blocks.values().any(|native| {
                native.name == tool.get("name").and_then(Value::as_str).unwrap_or("")
                    && serde_json::from_str::<Value>(native.arguments.trim())
                        .ok()
                        .is_some_and(|input| recovery_spec.is_native_mirror(&tool, &json!({ "input": input })))
            }) {
                continue;
            }
            let Some(call) = anthropic_tool_use_to_openai(&tool, recovered_tool_index) else {
                continue;
            };
            recovered_tool_index += 1;
            emitted_any_tool_call = true;
            send(openai_sse_data(&openai_chunk(
                chat_id,
                response_model,
                json!({ "tool_calls": [call] }),
                None,
            )));
        }
    }

    // 非法工具：整轮回退成一条错误正文，避免客户端拿着残缺的 arguments 去执行工具。
    //
    // 但**只在还没有外发过任何 tool_calls 分片时**才回退 finish_reason。原因：
    // OpenAI 客户端是按「收到 tool_calls 分片」来认定这轮是工具调用的，一旦分片
    // 已经发出去，再把 finish_reason 从 `tool_calls` 改成 `stop` 只会自相矛盾 ——
    // 有的 SDK 仍会尝试解析残缺 arguments 并执行，有的则会直接报协议不一致。
    // 已经外发时保留 `tool_calls`，让客户端自己做权威校验（它能看到 schema 与实际入参），
    // 并额外补一条错误正文供上层展示。
    let final_stop = if invalid_native_tool && !emitted_any_tool_call {
        send(openai_sse_data(&openai_chunk(
            chat_id,
            response_model,
            json!({ "content": "API Error: model returned an incomplete tool call" }),
            None,
        )));
        "end_turn"
    } else if invalid_native_tool {
        send(openai_sse_data(&openai_chunk(
            chat_id,
            response_model,
            json!({ "content": "API Error: model returned an incomplete tool call" }),
            None,
        )));
        stop_reason = "tool_use".to_string();
        &stop_reason
    } else if emitted_any_tool_call {
        stop_reason = "tool_use".to_string();
        &stop_reason
    } else if full_text.is_empty() && !thinking_started {
        let fallback = if stop_reason == "tool_use" {
            "API Error: upstream claimed tool_use but returned no tool call"
        } else if protocol_guard.detected() {
            "API Error: response interrupted by protocol leak"
        } else {
            "API Error: empty assistant response"
        };
        send(openai_sse_data(&openai_chunk(
            chat_id,
            response_model,
            json!({ "content": fallback }),
            None,
        )));
        &stop_reason
    } else {
        &stop_reason
    };

    let normalized = normalize_stop_reason(final_stop, emitted_any_tool_call, protocol_guard.detected());
    send(openai_sse_data(&openai_chunk(
        chat_id,
        response_model,
        json!({}),
        Some(anthropic_stop_reason_to_openai(normalized)),
    )));
    send(openai_sse_data(&openai_usage_chunk(
        chat_id,
        response_model,
        estimate_tokens(&full_text),
    )));
    send(OPENAI_SSE_DONE.to_string());
    event_stream_clean
}

/// 流式聚合中的单个 OpenAI 工具调用。
struct OpenAiToolBlock {
    name: String,
    /// 累加的 `arguments` JSON 文本（OpenAI 规范是字符串流）
    arguments: String,
    /// 上游中途改过工具名或入参无法解析 —— 整轮结束时据此回退
    invalid: bool,
}

impl OpenAiToolBlock {
    fn new(name: &str) -> Self {
        Self {
            name: name.to_string(),
            arguments: String::new(),
            invalid: false,
        }
    }
}

/// 先立刻打开 SSE，再请求 Kiro；避免等上游整包结束后才开始响应。
fn respond_sse_stream_fetch(
    request: Request,
    message_id: String,
    response_model: String,
    auth: Arc<Auth>,
    runtime_url: String,
    built: Value,
    recovery_spec: ToolRecoverySpec,
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

        let clean = if recovery_spec.is_empty() {
            pipe_kiro_body_to_anthropic_sse(upstream, recovery_spec, send)
        } else {
            pipe_buffered_kiro_tools_to_anthropic_sse(upstream, recovery_spec, send)
        };
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

/// OpenAI 兼容的流式响应：先开 SSE 头，再请求 Kiro，逐块推 `chat.completion.chunk`。
///
/// 与 Anthropic 版本的骨架完全一致（并发许可 → 心跳 → producer/reader → 有界 join），
/// 只有三处不同：
/// - 首包是 `role` chunk 而非 `message_start`，且帧格式为纯 `data:`（无 `event:` 行）；
/// - 正文解析走 `pipe_kiro_body_to_openai_sse`，产出 OpenAI delta；
/// - 以 `data: [DONE]` 收尾，而非 `message_stop` 事件。
///
/// 缓冲区语义与 Anthropic 路径共享：producer 即使在下游断开后也继续填满 dedup buffer，
/// 因此 follower 能重放到完整流。**但要注意 dedup buffer 里存的是 OpenAI 形状的字节**，
/// 而 OpenAI 与 Anthropic 请求归一化后指纹相同 —— 若两者混用同一 body，
/// follower 会拿到形状不匹配的缓冲。为此 `DedupStore::fingerprint` 的输入已包含协议标识
/// （见该函数实现），保证两套协议互不串流。
#[allow(clippy::too_many_arguments)]
fn respond_openai_sse_stream_fetch(
    request: Request,
    chat_id: String,
    response_model: String,
    auth: Arc<Auth>,
    runtime_url: String,
    built: Value,
    recovery_spec: ToolRecoverySpec,
    health: Arc<ProxyHealth>,
    entry: Option<Arc<DedupEntry>>,
    dedup: Arc<DedupStore>,
    active_requests: Arc<AtomicUsize>,
) {
    let Some(permit) = try_acquire_request(&active_requests, MAX_CONCURRENT_REQUESTS) else {
        if let Some(entry) = &entry {
            dedup.mark_failed(entry);
        }
        return openai_error_response(
            request,
            429,
            "Too many concurrent requests.",
            "rate_limit_error",
        );
    };

    let (tx, rx) = mpsc::sync_channel::<Vec<u8>>(16);
    let client_gone = Arc::new(AtomicBool::new(false));
    let hb_tx = tx.clone();
    let hb_gone = Arc::clone(&client_gone);
    thread::spawn(move || {
        while !hb_gone.load(Ordering::Relaxed) {
            thread::sleep(SSE_HEARTBEAT_INTERVAL);
            if hb_gone.load(Ordering::Relaxed) {
                break;
            }
            // SSE 注释行；OpenAI 客户端同样必须忽略，可安全复用同一心跳机制
            let _ = hb_tx.try_send(b": keepalive\n\n".to_vec());
        }
    });

    let eof_tx = tx.clone();
    let producer_gone = Arc::clone(&client_gone);
    let producer = thread::spawn(move || {
        let _permit = permit;
        let mut send = |chunk: String| {
            if let Some(entry) = &entry {
                dedup.append(entry, chunk.as_bytes());
            }
            if !producer_gone.load(Ordering::Acquire) && tx.send(chunk.into_bytes()).is_err() {
                producer_gone.store(true, Ordering::Release);
            }
        };

        send(openai_sse_data(&openai_role_chunk(&chat_id, &response_model)));
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
                    "[openai-stream] network_error={e} body={}",
                    truncate_for_log(&serde_json::to_string(&built).unwrap_or_default(), 2048)
                ));
                finish_openai_sse_after_error(&mut send, &chat_id, &response_model, &e);
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
                "[openai-stream] status={status} body={} resp={text}",
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
            finish_openai_sse_after_error(&mut send, &chat_id, &response_model, &message);
            if let Some(entry) = &entry {
                dedup.mark_failed(entry);
            }
            let _ = eof_tx.send(Vec::new());
            return;
        }

        let clean = pipe_kiro_body_to_openai_sse(
            upstream,
            recovery_spec,
            &chat_id,
            &response_model,
            send,
        );
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
    let join_deadline = Instant::now() + Duration::from_millis(500);
    while !producer.is_finished() && Instant::now() < join_deadline {
        thread::sleep(Duration::from_millis(10));
    }
}

/// 流式路径的失败收尾：把错误表示成一段 assistant 正文再正常结束。
///
/// 不直接发 error chunk —— 很多 OpenAI SDK 在收到 HTTP 200 之后遇到 error 对象会抛
/// 「unexpected response object」，反而丢掉已收到的正文。与 Anthropic 侧
/// `finish_sse_after_error` 的设计取舍一致。
fn finish_openai_sse_after_error(
    mut send: impl FnMut(String),
    chat_id: &str,
    response_model: &str,
    message: &str,
) {
    let text = if message.trim().is_empty() {
        "API Error: upstream request failed".to_string()
    } else if message.trim().starts_with("API Error:") {
        message.trim().to_string()
    } else {
        format!("API Error: {message}")
    };
    send(openai_sse_data(&openai_chunk(
        chat_id,
        response_model,
        json!({ "content": text }),
        None,
    )));
    send(openai_sse_data(&openai_chunk(
        chat_id,
        response_model,
        json!({}),
        Some("stop"),
    )));
    send(
        openai_sse_data(&openai_usage_chunk(
            chat_id,
            response_model,
            estimate_tokens(&text),
        )),
    );
    send(OPENAI_SSE_DONE.to_string());
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
    parse_event_stream_checked(&bytes)
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
        let key = DedupStore::fingerprint(&body, "anthropic");
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

    let recovery_spec = ToolRecoverySpec::from_body(&body);

    // 先发 SSE 头/message_start，再请求 Kiro；文本按节奏拆开，改善“整包突发”观感
    if is_stream {
        return respond_sse_stream_fetch(
            request,
            id,
            response_model,
            Arc::clone(auth),
            config.runtime_url.clone(),
            built,
            recovery_spec,
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
    collected.tool_uses.retain(|tool| {
        let name = tool.get("name").and_then(Value::as_str).unwrap_or("");
        let input = tool.get("input").unwrap_or(&Value::Null);
        recovery_spec.validates_input(name, input)
    });
    let (visible_text, mut protocol_leak_detected) = sanitize_protocol_text(&collected.text);
    collected.text = visible_text;
    for part in &mut collected.ordered_content {
        if part.get("type").and_then(Value::as_str) != Some("text") {
            continue;
        }
        let raw = part.get("text").and_then(Value::as_str).unwrap_or("");
        let (visible, detected) = sanitize_protocol_text(raw);
        protocol_leak_detected |= detected;
        if let Some(text) = part.get_mut("text") {
            *text = Value::String(visible);
        }
    }
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
        &collected.ordered_content,
        &collected.tool_uses,
        &collected.stop_reason,
        &recovery_spec,
    );
    health.record_success();
    json_response(request, 200, &response);
}

// ============ OpenAI 兼容入口 ============

/// `GET /openai/v1/models` —— OpenAI 形状的模型列表。
///
/// 与 `handle_models` 走同一个上游控制面调用，但只回 `{object,data[]}`，
/// 且每项仅保留 OpenAI 规范字段（`id` / `object` / `created` / `owned_by`）。
/// 额外字段（effort 能力、模态）不外泄 —— OpenAI SDK 会严格反序列化列表项。
fn handle_openai_models(request: Request, config: &ProxyConfig, auth: &Auth) {
    if !check_proxy_auth(&request, config) {
        return openai_error_response(request, 401, "Invalid proxy API key.", "authentication_error");
    }

    let profile_arn = match resolve_profile_arn(auth) {
        Ok(Some(arn)) => arn,
        Ok(None) => {
            return openai_error_response(
                request,
                400,
                "Missing Kiro profile ARN. 请先登录 Kiro IDE 或设置 KIRO_PROFILE_ARN。",
                "invalid_request_error",
            );
        }
        Err(e) => return openai_error_response(request, 502, &e, "api_error"),
    };

    let response = match kiro_post(
        &auth.http,
        auth,
        &config.management_url,
        "KiroControlPlaneBearerService.ListAvailableModels",
        &json!({ "origin": "AI_EDITOR", "profileArn": profile_arn }),
    ) {
        Ok(response) => response,
        Err(e) => return openai_error_response(request, 502, &e, "api_error"),
    };
    let status = response.status();
    let data: Value = response.json().unwrap_or_else(|_| json!({}));
    if !status.is_success() {
        return openai_error_response(
            request,
            502,
            &format!("ListAvailableModels failed: {status}"),
            "api_error",
        );
    }

    let created = now_unix_secs();
    let mut items: Vec<Value> = Vec::new();
    if let Some(models) = data.get("models").and_then(|v| v.as_array()) {
        for model in models {
            let kiro_id = model.get("modelId").and_then(|v| v.as_str()).unwrap_or("");
            if kiro_id.is_empty() {
                continue;
            }
            let public_id = kiro_model_to_public_model_id(kiro_id);
            let display_name = public_display_name(
                model.get("modelName").and_then(|v| v.as_str()).unwrap_or(kiro_id),
            );
            items.push(openai_model_entry(&public_id, &display_name, created));
        }
    }

    json_response(request, 200, &openai_models_list(&items));
}

/// `POST /openai/v1/chat/completions` —— OpenAI 兼容对话。
///
/// 流程与 `handle_messages` 对齐：鉴权 → 读体 → 去重 → 健康自检 → 解析模型/ARN →
/// 构造上游请求体。差异只在两端：
/// - 入参先用 `openai_request_to_anthropic` 归一化成 Anthropic 结构；
/// - 出参按 OpenAI 形状构造（非流式直接组装，流式见 `respond_openai_sse_stream_fetch`）。
///
/// 归一化后的 body 会作为去重指纹、工具恢复 schema（`ToolRecoverySpec`）、
/// 模型解析的共同输入，因此这些环节无需感知 OpenAI 协议。
fn handle_openai_chat_completions(
    mut request: Request,
    config: &ProxyConfig,
    auth: &Arc<Auth>,
    health: Arc<ProxyHealth>,
    dedup: Arc<DedupStore>,
    active_requests: Arc<AtomicUsize>,
) {
    if !check_proxy_auth(&request, config) {
        return openai_error_response(request, 401, "Invalid proxy API key.", "authentication_error");
    }

    let raw_body = match read_json_body(&mut request) {
        Ok(body) => body,
        Err(error) => return respond_openai_body_error(request, error),
    };

    let body = match openai_request_to_anthropic(&raw_body) {
        Ok(body) => body,
        Err(e) => return openai_error_response(request, 400, &e, "invalid_request_error"),
    };

    let is_stream = raw_body
        .get("stream")
        .and_then(Value::as_bool)
        .unwrap_or(false);

    // 去重键用归一化后的 body：同一语义的 OpenAI / Anthropic 请求因此天然共享同一个 key，
    // 混合使用两种协议的客户端也能命中彼此的缓存。
    let dedup_entry = if is_stream {
        let key = DedupStore::fingerprint(&body, "openai");
        match dedup.acquire(key) {
            DedupAcquire::Leader(entry) => Some(entry),
            DedupAcquire::Replay(bytes) => return respond_replayed_sse(request, bytes),
            DedupAcquire::Failed => {
                return openai_error_response(
                    request,
                    502,
                    "The in-progress request with the same body failed.",
                    "api_error",
                );
            }
            DedupAcquire::TimedOut => {
                return openai_error_response(
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

    if health.needs_preflight() {
        health.run_preflight_recovery(auth);
    }

    let requested_model = raw_body
        .get("model")
        .and_then(|v| v.as_str())
        .unwrap_or("");
    let kiro_model = resolve_kiro_model(auth, requested_model, &config.default_model);
    let profile_arn = match resolve_profile_arn(auth) {
        Ok(arn) => arn,
        Err(e) => {
            health.record_failure();
            if let Some(entry) = &dedup_entry {
                dedup.mark_failed(entry);
            }
            return openai_error_response(request, 502, &e, "api_error");
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
            return openai_error_response(request, 400, &e, "invalid_request_error");
        }
    };

    // OpenAI 的 id 惯例是 `chatcmpl-…`，用与 Anthropic 路径不同的前缀便于日志区分来源
    let id = format!("chatcmpl-{}", Uuid::new_v4().to_string().replace('-', ""));
    let response_model = if requested_model.is_empty() {
        kiro_model.clone()
    } else {
        requested_model.to_string()
    };

    let recovery_spec = ToolRecoverySpec::from_body(&body);

    if is_stream {
        return respond_openai_sse_stream_fetch(
            request,
            id,
            response_model,
            Arc::clone(auth),
            config.runtime_url.clone(),
            built,
            recovery_spec,
            health,
            dedup_entry,
            dedup,
            active_requests,
        );
    }

    let Some(_permit) = try_acquire_request(&active_requests, MAX_CONCURRENT_REQUESTS) else {
        return openai_error_response(
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
                "[openai] generate_error={e} status=502 body={}",
                truncate_for_log(&serde_json::to_string(&built).unwrap_or_default(), 2048)
            ));
            return openai_error_response(request, 502, &e, "api_error");
        }
    };

    let mut collected = collect_kiro_text(&events);
    collected.tool_uses.retain(|tool| {
        let name = tool.get("name").and_then(Value::as_str).unwrap_or("");
        let input = tool.get("input").unwrap_or(&Value::Null);
        recovery_spec.validates_input(name, input)
    });
    let (visible_text, mut protocol_leak_detected) = sanitize_protocol_text(&collected.text);
    collected.text = visible_text;
    for part in &mut collected.ordered_content {
        if part.get("type").and_then(Value::as_str) != Some("text") {
            continue;
        }
        let raw = part.get("text").and_then(Value::as_str).unwrap_or("");
        let (visible, detected) = sanitize_protocol_text(raw);
        protocol_leak_detected |= detected;
        if let Some(text) = part.get_mut("text") {
            *text = Value::String(visible);
        }
    }
    collected.stop_reason = normalize_stop_reason(
        &collected.stop_reason,
        !collected.tool_uses.is_empty(),
        protocol_leak_detected,
    )
    .to_string();

    // 复用 Anthropic 的响应装配：它负责工具恢复（antml 泄漏、schema 校验）、
    // thinking 块与 stop_reason 终裁。拿到规范 content[] 后再翻译成 OpenAI 形状，
    // 避免在两条路径上各维护一份恢复逻辑。
    let anthropic_response = anthropic_message_response_with_tools(
        &id,
        &response_model,
        &collected.text,
        &collected.thinking,
        collected.thinking_signature.as_deref(),
        &collected.ordered_content,
        &collected.tool_uses,
        &collected.stop_reason,
        &recovery_spec,
    );
    let content = anthropic_response
        .get("content")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let stop_reason = anthropic_response
        .get("stop_reason")
        .and_then(Value::as_str)
        .unwrap_or("end_turn");

    let response = openai_chat_completion(
        &id,
        &response_model,
        &content,
        &collected.thinking,
        stop_reason,
        estimate_tokens(&collected.text),
    );
    health.record_success();
    json_response(request, 200, &response);
}

fn respond_openai_body_error(request: Request, error: BodyReadError) {
    match error {
        BodyReadError::TooLarge => openai_error_response(
            request,
            413,
            "Request body too large.",
            "invalid_request_error",
        ),
        BodyReadError::Invalid(message) => openai_error_response(
            request,
            400,
            &format!("Invalid JSON body: {message}"),
            "invalid_request_error",
        ),
    }
}

/// `now()` 的秒级 Unix 时间戳（OpenAI 的 `created` 字段单位为秒）。
fn now_unix_secs() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.as_secs() as i64)
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normalize_request_target_accepts_origin_and_absolute_forms() {
        // origin-form 原样返回
        assert_eq!(normalize_request_target("/v1/messages"), "/v1/messages");
        assert_eq!(normalize_request_target("/health?x=1"), "/health?x=1");
        // absolute-form：客户端经 HTTP 代理发送时出现（RFC 9112 要求服务端接受）
        assert_eq!(
            normalize_request_target("http://127.0.0.1:39871/v1/messages"),
            "/v1/messages"
        );
        assert_eq!(
            normalize_request_target("https://example.com/health?x=1"),
            "/health?x=1"
        );
        // scheme 大小写不敏感；只有 authority 时等价于根路径
        assert_eq!(normalize_request_target("HTTP://127.0.0.1:1/"), "/");
        assert_eq!(normalize_request_target("http://127.0.0.1:39871"), "/");
        // 普通相对路径（非 absolute-form）不受影响
        assert_eq!(normalize_request_target("v1/messages"), "v1/messages");
        assert_eq!(normalize_request_target("httpnot://x/y"), "httpnot://x/y");
    }

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
        assert_eq!(
            DedupStore::fingerprint(&a, "anthropic"),
            DedupStore::fingerprint(&b, "anthropic")
        );
        assert_ne!(
            DedupStore::fingerprint(&a, "anthropic"),
            DedupStore::fingerprint(&c, "anthropic")
        );
    }

    #[test]
    fn dedup_fingerprint_separates_protocols() {
        // OpenAI 请求会先归一化成 Anthropic 结构，两者可能得到同一个 body；
        // 但 dedup buffer 里存的字节形状不同（OpenAI chunk vs Anthropic SSE 事件），
        // 因此协议必须参与指纹，否则 follower 会拿到另一种格式的缓冲。
        let body = json!({ "model": "claude", "messages": [{ "role": "user", "content": "hi" }] });
        assert_ne!(
            DedupStore::fingerprint(&body, "anthropic"),
            DedupStore::fingerprint(&body, "openai")
        );
        // 同协议内仍然稳定
        assert_eq!(
            DedupStore::fingerprint(&body, "openai"),
            DedupStore::fingerprint(&body, "openai")
        );
    }

    #[test]
    fn nameless_tool_use_event_is_not_emitted_as_block() {
        assert!(new_native_tool_block("call_1", "").is_none());
        assert!(new_native_tool_block("", "Bash").is_none());
    }

    /// OpenAI 侧：模型只发工具名、不发任何入参分片时，必须判成合法空入参 `{}`。
    ///
    /// 实测（live）：请求 `get_current_time`（无参数 schema）时，toolUseEvent 只带 name，
    /// 不带 input —— 若把「没收到入参」当作残缺，这条调用每次都会被回退成错误正文。
    /// 这里直接断言判定口径：空/纯空白 arguments 归一为 `{}` 后能否通过 schema 校验。
    #[test]
    fn empty_openai_tool_arguments_are_valid_empty_object() {
        let spec = ToolRecoverySpec::from_body(&json!({
            "tools": [{
                "name": "get_current_time",
                "description": "Get the current local time",
                "input_schema": { "type": "object", "properties": {} }
            }]
        }));

        for raw in ["", "   ", "\n"] {
            let trimmed = raw.trim();
            let parsed = if trimmed.is_empty() {
                Some(json!({}))
            } else {
                serde_json::from_str::<Value>(trimmed).ok()
            };
            assert!(
                parsed
                    .as_ref()
                    .is_some_and(|input| spec.validates_input("get_current_time", input)),
                "empty arguments must normalize to {{}} and pass schema, raw={raw:?}"
            );
        }
    }

    /// OpenAI 侧：残缺 arguments 会解析失败 —— 这是「整轮结束后回退」判据的输入。
    #[test]
    fn truncated_openai_tool_arguments_fail_validation() {
        let spec = ToolRecoverySpec::from_body(&json!({
            "tools": [{
                "name": "Bash",
                "description": "Run a command",
                "input_schema": {
                    "type": "object",
                    "properties": { "command": { "type": "string" } },
                    "required": ["command"]
                }
            }]
        }));

        // 半截 JSON：即便 trim 后非空也解析不出来
        let parsed = serde_json::from_str::<Value>("{\"command\":").ok();
        assert!(parsed.is_none(), "truncated JSON must not parse");
        assert!(
            !parsed
                .as_ref()
                .is_some_and(|input| spec.validates_input("Bash", input)),
            "truncated arguments must fail validation"
        );

        // 能解析但违反 schema（缺 required）也算不合法
        let parsed = serde_json::from_str::<Value>("{}").ok();
        assert!(
            !parsed
                .as_ref()
                .is_some_and(|input| spec.validates_input("Bash", input)),
            "missing required field must fail validation"
        );
    }

    /// Host 校验必须带上被拒的具体取值，否则线上 400 无法定位。
    #[test]
    fn loopback_host_violation_reports_offending_value() {
        // 合法：回环 + 端口 / 不带端口 / IPv6 括号形式
        for ok in ["127.0.0.1:5050", "127.0.0.1", "localhost:8080", "[::1]:5050"] {
            assert!(
                loopback_host_violation(ok).is_none(),
                "{ok} should be accepted as loopback"
            );
        }
        // 非法：DNS rebinding 场景，原因里必须能看到原始取值
        let reason = loopback_host_violation("evil.example.com")
            .expect("foreign host must be rejected");
        assert!(
            reason.contains("evil.example.com"),
            "reason should quote the offending host: {reason}"
        );
        let reason = loopback_host_violation("").expect("empty host must be rejected");
        assert!(!reason.is_empty());
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
    fn buffered_tool_events_preserve_text_tool_text_order() {
        let spec = ToolRecoverySpec::from_body(&json!({
            "tools": [{
                "name": "Bash",
                "input_schema": {
                    "type": "object",
                    "required": ["command"],
                    "properties": { "command": { "type": "string" } },
                    "additionalProperties": false
                }
            }]
        }));
        let events = vec![
            KiroEvent {
                event_type: "assistantResponseEvent".to_string(),
                payload: json!({ "content": "before" }),
            },
            KiroEvent {
                event_type: "toolUseEvent".to_string(),
                payload: json!({
                    "toolUseId": "call_order",
                    "name": "Bash",
                    "input": { "command": "ls" },
                    "stop": true
                }),
            },
            KiroEvent {
                event_type: "assistantResponseEvent".to_string(),
                payload: json!({ "content": "after" }),
            },
        ];
        let mut out = String::new();
        assert!(emit_buffered_kiro_events_to_anthropic_sse(
            events,
            spec,
            |chunk| out.push_str(&chunk),
        ));
        let before = out.find("before").unwrap();
        let tool = out.find("call_order").unwrap();
        let after = out.find("after").unwrap();
        assert!(before < tool && tool < after);
        assert!(out.contains("\"stop_reason\":\"tool_use\""));
    }

    #[test]
    fn buffered_tool_events_reject_missing_stop() {
        let spec = ToolRecoverySpec::from_body(&json!({
            "tools": [{ "name": "Bash", "input_schema": { "type": "object" } }]
        }));
        let events = vec![KiroEvent {
            event_type: "toolUseEvent".to_string(),
            payload: json!({
                "toolUseId": "call_open",
                "name": "Bash",
                "input": { "command": "side-effect" }
            }),
        }];
        let mut out = String::new();
        assert!(emit_buffered_kiro_events_to_anthropic_sse(
            events,
            spec,
            |chunk| out.push_str(&chunk),
        ));
        assert!(!out.contains("\"type\":\"tool_use\""));
        assert!(!out.contains("call_open"));
        assert!(out.contains("incomplete tool call"));
        assert!(out.contains("\"stop_reason\":\"end_turn\""));
    }

    /// 从 SSE 输出里取出首个 input_json_delta 的 partial_json 并解码成 JSON。
    fn first_tool_input(out: &str) -> Value {
        let mark = "\"partial_json\":\"";
        let start = out.find(mark).expect("应存在 input_json_delta") + mark.len();
        let bytes = out.as_bytes();
        let mut end = start;
        while end < bytes.len() {
            match bytes[end] {
                b'\\' => end += 2,
                b'"' => break,
                _ => end += 1,
            }
        }
        let unescaped: String =
            serde_json::from_str(&format!("\"{}\"", &out[start..end])).expect("partial_json 应可解码");
        serde_json::from_str(&unescaped).expect("入参应是合法 JSON")
    }

    #[test]
    fn buffered_tool_events_repair_antml_polluted_input() {
        // 真实样本（会话 791513c9 第 374 行）：上游把 antml 参数序列半解析成
        // `{"-B":"3\">\n<parameter name=\"-n\">true", ...}`，`-B` 该是 number 却成了 string。
        // 旧行为整轮报 "incomplete tool call"；现在应按 schema 重建出干净入参。
        let spec = ToolRecoverySpec::from_body(&json!({
            "tools": [{
                "name": "Grep",
                "input_schema": {
                    "type": "object",
                    "required": ["pattern"],
                    "properties": {
                        "pattern": { "type": "string" },
                        "output_mode": { "type": "string" },
                        "-B": { "type": "number" },
                        "-n": { "type": "boolean" }
                    }
                }
            }]
        }));
        let events = vec![KiroEvent {
            event_type: "toolUseEvent".to_string(),
            payload: json!({
                "toolUseId": "toolu_bdrk_polluted",
                "name": "Grep",
                "input": {
                    "-B": "3\">\n<parameter name=\"-n\">true",
                    "output_mode": "content",
                    "pattern": "RequiredArgsConstructor\""
                },
                "stop": true
            }),
        }];
        let mut out = String::new();
        assert!(emit_buffered_kiro_events_to_anthropic_sse(
            events,
            spec,
            |chunk| out.push_str(&chunk),
        ));
        assert!(!out.contains("incomplete tool call"), "不应再整轮失败: {out}");
        assert!(out.contains("toolu_bdrk_polluted"));
        assert!(out.contains("\"stop_reason\":\"tool_use\""));
        assert_eq!(
            first_tool_input(&out),
            json!({
                "-B": 3,
                "-n": true,
                "output_mode": "content",
                "pattern": "RequiredArgsConstructor"
            })
        );
    }

    #[test]
    fn buffered_tool_events_accept_tuple_schema_and_tolerate_opaque_schema() {
        // 真实样本（2026-09-10 16:07，会话 75fd38f7）：AskUserQuestion 的 schema 是元组形态
        // （draft-7 序列化成数组形式的 `items`），旧校验器读不懂 → 任何入参都被判非法 →
        // 整轮被替换成 "model returned an incomplete tool call"。
        let questions = json!({
            "questions": [{
                "header": "实现方式",
                "multiSelect": false,
                "question": "采用哪种实现方式？",
                "options": [
                    { "description": "只用来发现子账户列表", "label": "复用现有 fundAccount→userId 查询（推荐）" },
                    { "description": "内部直接初始化全部数据", "label": "新增 initAllDataBatchByFundAccountOnly" }
                ]
            }]
        });
        let spec = ToolRecoverySpec::from_body(&json!({
            "tools": [{
                "name": "AskUserQuestion",
                "input_schema": {
                    "type": "object",
                    "required": ["questions"],
                    "properties": {
                        "questions": {
                            "type": "array",
                            "items": [{
                                "type": "object",
                                "required": ["question", "header", "options", "multiSelect"],
                                "properties": {
                                    "question": { "type": "string" },
                                    "header": { "type": "string" },
                                    "multiSelect": { "type": "boolean" },
                                    "options": {
                                        "type": "array",
                                        "items": [
                                            {
                                                "type": "object",
                                                "required": ["label", "description"],
                                                "properties": {
                                                    "label": { "type": "string" },
                                                    "description": { "type": "string" }
                                                }
                                            },
                                            {
                                                "type": "object",
                                                "required": ["label", "description"],
                                                "properties": {
                                                    "label": { "type": "string" },
                                                    "description": { "type": "string" }
                                                }
                                            }
                                        ]
                                    }
                                }
                            }]
                        }
                    }
                }
            }]
        }));
        let events = vec![KiroEvent {
            event_type: "toolUseEvent".to_string(),
            payload: json!({
                "toolUseId": "toolu_bdrk_ask",
                "name": "AskUserQuestion",
                "input": questions.clone(),
                "stop": true
            }),
        }];
        let mut out = String::new();
        assert!(emit_buffered_kiro_events_to_anthropic_sse(
            events,
            spec,
            |chunk| out.push_str(&chunk),
        ));
        assert!(!out.contains("incomplete tool call"), "不应整轮失败: {out}");
        assert!(out.contains("toolu_bdrk_ask"));
        assert!(out.contains("\"stop_reason\":\"tool_use\""));
        assert_eq!(first_tool_input(&out), questions);

        // 兜底：schema 带本校验器不认识的写法时，也不能把整轮打成错误（放行给客户端校验）
        let opaque = ToolRecoverySpec::from_body(&json!({
            "tools": [{
                "name": "Opaque",
                "input_schema": { "type": "object", "x-vendor-extension": true }
            }]
        }));
        let events = vec![KiroEvent {
            event_type: "toolUseEvent".to_string(),
            payload: json!({
                "toolUseId": "toolu_bdrk_opaque",
                "name": "Opaque",
                "input": { "anything": 1 },
                "stop": true
            }),
        }];
        let mut out = String::new();
        assert!(emit_buffered_kiro_events_to_anthropic_sse(
            events,
            opaque,
            |chunk| out.push_str(&chunk),
        ));
        assert!(!out.contains("incomplete tool call"), "schema 读不懂时应放行: {out}");
        assert!(out.contains("toolu_bdrk_opaque"));
        assert_eq!(first_tool_input(&out), json!({ "anything": 1 }));
    }

    #[test]
    fn buffered_tool_events_pass_through_schema_violating_input() {
        // 真实 case（2026-09-10 17:16，会话 75fd38f7）：入参对不上 schema 时，旧行为会把整轮
        // 替换成 "model returned an incomplete tool call"。客户端自己会做权威校验 ——
        // 单条工具报错可恢复（模型能读到错误并重试），整轮报废不可恢复，所以必须放行。
        let spec = ToolRecoverySpec::from_body(&json!({
            "tools": [{
                "name": "Bash",
                "input_schema": {
                    "type": "object",
                    "required": ["command"],
                    "properties": { "command": { "type": "string" } },
                    "additionalProperties": false
                }
            }]
        }));
        let wrong_key = json!({ "cmd": "ls" });
        let events = vec![KiroEvent {
            event_type: "toolUseEvent".to_string(),
            payload: json!({
                "toolUseId": "call_schema_bad",
                "name": "Bash",
                "input": wrong_key.clone(),
                "stop": true
            }),
        }];
        let mut out = String::new();
        assert!(emit_buffered_kiro_events_to_anthropic_sse(
            events,
            spec,
            |chunk| out.push_str(&chunk),
        ));
        assert!(!out.contains("incomplete tool call"), "不应整轮失败: {out}");
        assert!(out.contains("call_schema_bad"));
        assert!(out.contains("\"stop_reason\":\"tool_use\""));
        assert_eq!(first_tool_input(&out), wrong_key);
    }

    #[test]
    fn buffered_tool_events_accept_real_ask_user_question_schema() {
        // 端到端复刻 16:07 / 17:16 的 AskUserQuestion 故障：用从本地 CLI 抓到的**真实** schema，
        // 正常的入参必须原样透出成 tool_use，而不是整轮错误文本。
        let tool: Value =
            serde_json::from_str(include_str!("../../tests/fixtures/ask_user_question_tool.json"))
                .unwrap();
        let questions = json!({
            "questions": [{
                "header": "重构范围",
                "multiSelect": false,
                "options": [
                    {
                        "description": "只给 AssetAdminReqVO 补上 fundAccount 字段，让 queryStockAssetProfitForAdminV1 优先用传入的 fundAccount，不用 userId 反查；其余接口保持用 userId，不动。",
                        "label": "仅这一个接口 query-stockAssetInfo/v1"
                    },
                    {
                        "description": "把 accountCacheService.getAccountList(userId)/holdCacheService.getHoldList(userId) 这两个查询入口，从按 userId 改造成按 fundAccount 查询，所有调用方统一收敛到 fundAccount 语义。",
                        "label": "整个 SecAssetFirstServiceV1 计算内核都改成主用 fundAccount"
                    }
                ],
                "question": "这次重构的范围选哪个？"
            }]
        });
        let spec = ToolRecoverySpec::from_body(&json!({ "tools": [tool] }));
        let events = vec![KiroEvent {
            event_type: "toolUseEvent".to_string(),
            payload: json!({
                "toolUseId": "toolu_bdrk_ask_real",
                "name": "AskUserQuestion",
                "input": questions.clone(),
                "stop": true
            }),
        }];
        let mut out = String::new();
        assert!(emit_buffered_kiro_events_to_anthropic_sse(
            events,
            spec,
            |chunk| out.push_str(&chunk),
        ));
        assert!(!out.contains("incomplete tool call"), "不应整轮失败: {out}");
        assert!(out.contains("toolu_bdrk_ask_real"));
        assert!(out.contains("\"stop_reason\":\"tool_use\""));
        assert_eq!(first_tool_input(&out), questions);
    }

    #[test]
    fn metadata_tool_use_without_complete_tool_downgrades_to_end_turn() {        let metadata_reason = map_kiro_stop_reason("TOOL_USE");
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

    /// 临时手工验证（非 CI）：OpenAI 兼容入口走真实 Kiro 凭据的完整链路。
    ///
    /// 覆盖四件事：
    /// - `/openai/v1/models` 的列表形状（`object: "list"`，条目字段改用 OpenAI 命名）
    /// - 非流式 `chat.completion`（含 `finish_reason`、`prompt_tokens`/`completion_tokens`）
    /// - 流式 `chat.completion.chunk`（无 `event:` 行、以 `data: [DONE]` 终止）
    /// - OpenAI 工具调用往返（`tool_calls[].function.arguments` 是 **JSON 字符串**，
    ///   且 `role:"tool"` 的结果能喂回去触发第二轮）
    ///
    /// 运行：cargo test -p codecli-manager --lib kiro::server::tests::live_openai_proxy_roundtrip -- --ignored --nocapture
    #[test]
    #[ignore = "requires real Kiro SSO credentials"]
    fn live_openai_proxy_roundtrip() {
        let home = std::env::var("HOME").unwrap();
        let sso_dir = std::path::PathBuf::from(&home).join(".aws/sso/cache");
        let config = ProxyConfig {
            host: "127.0.0.1".to_string(),
            port: 5051,
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

        // 1. /openai/v1/models：OpenAI 列表形状
        let resp = client
            .get(format!("http://127.0.0.1:{port}/openai/v1/models"))
            .header("authorization", "Bearer live-test-key")
            .send()
            .unwrap();
        let status = resp.status();
        let text = resp.text().unwrap();
        println!("[live] /openai/v1/models status={status}");
        println!(
            "[live] models body (truncated): {}",
            text.chars().take(800).collect::<String>()
        );
        assert!(status.is_success(), "/openai/v1/models failed: {text}");
        let models: Value = serde_json::from_str(&text).unwrap();
        assert_eq!(models["object"], "list");
        let entries = models["data"].as_array().expect("data array");
        assert!(!entries.is_empty(), "models list must not be empty");
        let first = &entries[0];
        assert_eq!(first["object"], "model");
        assert!(first["id"].is_string());
        assert!(first["owned_by"].is_string());
        assert!(first["created"].is_u64(), "model.created must be unix secs");
        // OpenAI 形状不应带 Anthropic 专有字段
        assert!(
            first.get("kiro_model_id").is_none() && models.get("has_more").is_none(),
            "OpenAI models response must not leak Anthropic fields: {models}"
        );
        let model = first["id"].as_str().unwrap().to_string();
        println!("[live] picked model={model}");

        // 2. 非流式 chat.completion
        let resp = client
            .post(format!("http://127.0.0.1:{port}/openai/v1/chat/completions"))
            .header("x-api-key", "live-test-key")
            .json(&json!({
                "model": model,
                "messages": [{ "role": "user", "content": "只回复两个字：你好" }],
                "stream": false,
            }))
            .send()
            .unwrap();
        let status = resp.status();
        let text = resp.text().unwrap();
        println!("[live] /openai/v1/chat/completions status={status}");
        println!(
            "[live] body (truncated): {}",
            text.chars().take(800).collect::<String>()
        );
        assert!(status.is_success(), "non-stream completion failed: {text}");
        let completion: Value = serde_json::from_str(&text).unwrap();
        assert_eq!(completion["object"], "chat.completion");
        assert!(
            completion["id"]
                .as_str()
                .unwrap_or("")
                .starts_with("chatcmpl-"),
            "id should carry chatcmpl- prefix: {completion}"
        );
        assert_eq!(completion["choices"][0]["index"], 0);
        assert_eq!(completion["choices"][0]["message"]["role"], "assistant");
        // 顶层不应有 Anthropic 字段
        assert!(
            completion.get("stop_reason").is_none() && completion.get("content").is_none(),
            "OpenAI completion must not leak Anthropic fields: {completion}"
        );
        let finish = completion["choices"][0]["finish_reason"].as_str().unwrap();
        assert!(
            ["stop", "length", "tool_calls"].contains(&finish),
            "unexpected finish_reason={finish}"
        );
        assert!(completion["usage"]["prompt_tokens"].is_u64());
        assert!(completion["usage"]["completion_tokens"].is_u64());
        assert!(completion["usage"]["total_tokens"].is_u64());
        let usage = &completion["usage"];
        assert_eq!(
            usage["prompt_tokens"].as_u64().unwrap() + usage["completion_tokens"].as_u64().unwrap(),
            usage["total_tokens"].as_u64().unwrap(),
            "total_tokens must equal prompt+completion: {usage}"
        );

        // 3. 非流式工具调用 → tool_calls 必须是 OpenAI 形状
        let tools = json!([{
            "type": "function",
            "function": {
                "name": "get_current_time",
                "description": "Get the current local time",
                "parameters": { "type": "object", "properties": {} }
            }
        }]);
        let resp = client
            .post(format!("http://127.0.0.1:{port}/openai/v1/chat/completions"))
            .header("x-api-key", "live-test-key")
            .json(&json!({
                "model": model,
                "messages": [{
                    "role": "user",
                    "content": "必须调用 get_current_time 工具，不要直接回答。"
                }],
                "tools": tools,
                "stream": false,
            }))
            .send()
            .unwrap();
        let status = resp.status();
        let text = resp.text().unwrap();
        println!("[live] /openai/v1/chat/completions(tool) status={status}");
        println!(
            "[live] tool body (truncated): {}",
            text.chars().take(800).collect::<String>()
        );
        assert!(status.is_success(), "tool request failed: {text}");
        let tool_resp: Value = serde_json::from_str(&text).unwrap();
        assert_eq!(tool_resp["choices"][0]["finish_reason"], "tool_calls");
        let message = &tool_resp["choices"][0]["message"];
        let call = message["tool_calls"]
            .as_array()
            .and_then(|c| c.first())
            .expect("tool_calls array");
        assert_eq!(call["type"], "function");
        assert_eq!(call["function"]["name"], "get_current_time");
        // 关键契约：arguments 是 JSON **字符串**，不是对象
        let raw_args = call["function"]["arguments"]
            .as_str()
            .expect("arguments must be a JSON string, not an object");
        let _parsed: Value = serde_json::from_str(raw_args).expect("arguments must be valid JSON");
        // 只有工具调用时 content 应为 null
        assert!(
            message["content"].is_null(),
            "content should be null when only tool_calls are returned: {message}"
        );
        let call_id = call["id"].as_str().unwrap().to_string();
        println!("[live] tool_call id={call_id} args={raw_args}");

        // 4. 工具结果回传第二轮：role:"tool" + tool_call_id
        let resp = client
            .post(format!("http://127.0.0.1:{port}/openai/v1/chat/completions"))
            .header("x-api-key", "live-test-key")
            .json(&json!({
                "model": model,
                "messages": [
                    {
                        "role": "user",
                        "content": "必须调用 get_current_time 工具，不要直接回答。"
                    },
                    {
                        "role": "assistant",
                        "content": Value::Null,
                        "tool_calls": [{
                            "id": call_id.clone(),
                            "type": "function",
                            "function": { "name": "get_current_time", "arguments": raw_args }
                        }]
                    },
                    {
                        "role": "tool",
                        "tool_call_id": call_id,
                        "content": "2026-08-11T23:59:00+08:00"
                    }
                ],
                "tools": tools,
                "stream": false,
            }))
            .send()
            .unwrap();
        let status = resp.status();
        let text = resp.text().unwrap();
        println!("[live] /openai/v1/chat/completions(tool roundtrip) status={status}");
        println!(
            "[live] tool-result body (truncated): {}",
            text.chars().take(800).collect::<String>()
        );
        assert!(status.is_success(), "tool roundtrip failed: {text}");
        let followup: Value = serde_json::from_str(&text).unwrap();
        assert_ne!(
            followup["choices"][0]["finish_reason"], "tool_calls",
            "second turn should consume the tool result, not request another tool: {text}"
        );
        let followup_text = followup["choices"][0]["message"]["content"]
            .as_str()
            .unwrap_or("");
        assert!(
            !followup_text.trim().is_empty(),
            "second turn should return assistant text: {text}"
        );

        // 5. 流式：chunk 形状 + [DONE] 终止 + 无 event: 行
        let resp = client
            .post(format!("http://127.0.0.1:{port}/openai/v1/chat/completions"))
            .header("x-api-key", "live-test-key")
            .json(&json!({
                "model": model,
                "messages": [{ "role": "user", "content": "从 1 数到 3，只输出数字。" }],
                "stream": true,
            }))
            .send()
            .unwrap();
        let status = resp.status();
        assert_eq!(status, 200, "stream should return 200");
        assert!(resp
            .headers()
            .get("content-type")
            .and_then(|v| v.to_str().ok())
            .unwrap_or("")
            .starts_with("text/event-stream"));
        let sse = resp.text().unwrap();
        println!("[live] sse (truncated): {}", sse.chars().take(800).collect::<String>());
        assert!(!sse.contains("event:"), "OpenAI SSE must not carry event: lines");
        assert!(
            sse.contains("chat.completion.chunk"),
            "stream must emit chunk objects: {sse}"
        );
        assert!(
            sse.trim_end().ends_with("data: [DONE]"),
            "stream must terminate with data: [DONE]: {sse}"
        );
        // 首帧应带 role，让客户端建立上下文
        let first_data = sse
            .lines()
            .find(|l| l.starts_with("data: ") && !l.contains("[DONE]"))
            .and_then(|l| serde_json::from_str::<Value>(l.trim_start_matches("data: ")).ok())
            .expect("first SSE data frame parses");
        assert_eq!(first_data["object"], "chat.completion.chunk");
        assert_eq!(first_data["choices"][0]["delta"]["role"], "assistant");
        // 每帧都必须是合法 JSON（不能有半截帧）
        let mut frames = 0usize;
        let mut saw_content = false;
        for line in sse.lines().filter(|l| l.starts_with("data: ")) {
            let payload = line.trim_start_matches("data: ").trim();
            if payload == "[DONE]" {
                continue;
            }
            let frame: Value = serde_json::from_str(payload)
                .unwrap_or_else(|e| panic!("non-JSON SSE frame ({e}): {payload}"));
            frames += 1;
            if frame["choices"][0]["delta"]["content"].is_string() {
                saw_content = true;
            }
        }
        assert!(frames > 0, "no SSE frames parsed");
        assert!(saw_content, "stream should deliver at least one content delta: {sse}");

        // 6. 流式 + 工具：arguments 以字符串分片增量下发
        let resp = client
            .post(format!("http://127.0.0.1:{port}/openai/v1/chat/completions"))
            .header("x-api-key", "live-test-key")
            .json(&json!({
                "model": model,
                "messages": [{
                    "role": "user",
                    "content": "必须调用 get_current_time 工具，不要直接回答。"
                }],
                "tools": tools,
                "stream": true,
            }))
            .send()
            .unwrap();
        assert_eq!(resp.status(), 200);
        let sse = resp.text().unwrap();
        println!(
            "[live] stream tool sse (truncated): {}",
            sse.chars().take(800).collect::<String>()
        );
        assert!(sse.trim_end().ends_with("data: [DONE]"), "{sse}");
        let mut saw_tool_delta = false;
        let mut saw_tool_finish = false;
        for line in sse.lines().filter(|l| l.starts_with("data: ")) {
            let payload = line.trim_start_matches("data: ").trim();
            if payload == "[DONE]" {
                continue;
            }
            let frame: Value = serde_json::from_str(payload).expect("stream tool frame parses");
            let delta = &frame["choices"][0]["delta"];
            if let Some(calls) = delta["tool_calls"].as_array() {
                for c in calls {
                    if c["function"]["arguments"].is_string() {
                        saw_tool_delta = true;
                    }
                }
            }
            if frame["choices"][0]["finish_reason"] == "tool_calls" {
                saw_tool_finish = true;
            }
        }
        assert!(saw_tool_delta, "stream must emit tool_call deltas: {sse}");
        assert!(saw_tool_finish, "stream must finish with tool_calls: {sse}");

        handle.stop();
        println!("[live] OPENAI DONE");
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

    /// OpenAI 入口的路由、鉴权与错误信封形状。
    ///
    /// 只验证「路由通了 + 鉴权生效 + 错误形状是 OpenAI 而非 Anthropic」这三件
    /// 不依赖上游 Kiro 凭据的事 —— 真正的生成链路无法在本机无凭据环境下打通。
    #[test]
    fn openai_routes_are_gated_and_use_openai_error_envelope() {
        let mut handle = start_proxy(test_config(39879)).expect("proxy starts");
        let port = handle.port;
        let client = reqwest::blocking::Client::new();

        // 1) 无 key → 401，且信封为 OpenAI 形状（顶层无 "type"，error 内含 code）
        let resp = client
            .post(format!("http://127.0.0.1:{port}/openai/v1/chat/completions"))
            .json(&json!({
                "model": "claude-opus-5",
                "messages": [{ "role": "user", "content": "hi" }],
            }))
            .send()
            .unwrap();
        assert_eq!(resp.status(), 401);
        let body: Value = resp.json().unwrap();
        assert!(
            body.get("type").is_none(),
            "OpenAI 响应的顶层不应有 Anthropic 的 type 字段: {body}"
        );
        assert!(body["error"]["message"].is_string());
        assert!(
            body["error"].get("code").is_some(),
            "OpenAI 错误必须包含 code 字段: {body}"
        );

        // 2) 带 key 且 messages 为空 → 400 由入参校验拦下（证明已通过鉴权、进入 handler）
        let resp = client
            .post(format!("http://127.0.0.1:{port}/openai/v1/chat/completions"))
            .header("authorization", "Bearer test-key")
            .json(&json!({ "model": "claude-opus-5", "messages": [] }))
            .send()
            .unwrap();
        assert_eq!(resp.status(), 400);
        let body: Value = resp.json().unwrap();
        assert!(body["error"]["message"]
            .as_str()
            .unwrap_or("")
            .contains("messages"));

        // 3) OpenAI 侧未知路由 → 404，且同样是 OpenAI 信封（不能被 Anthropic 形状污染）
        let resp = client
            .get(format!("http://127.0.0.1:{port}/openai/v1/nope"))
            .header("x-api-key", "test-key")
            .send()
            .unwrap();
        assert_eq!(resp.status(), 404);
        let body: Value = resp.json().unwrap();
        assert!(body.get("type").is_none());
        assert!(body["error"]["message"].is_string());

        // 4) Anthropic 侧未知路由仍保持 Anthropic 信封（回归保护：不能被新逻辑改掉）
        let resp = client
            .get(format!("http://127.0.0.1:{port}/v1/nope"))
            .send()
            .unwrap();
        assert_eq!(resp.status(), 404);
        let body: Value = resp.json().unwrap();
        assert_eq!(body["type"], "error");

        // 5) /v1/models 未被 OpenAI 分支影响：带 key 时因缺 Kiro 凭据报错，
        //    但不能是 404（路由仍在），且错误信封仍是 Anthropic 形状
        let resp = client
            .get(format!("http://127.0.0.1:{port}/v1/models"))
            .header("x-api-key", "test-key")
            .send()
            .unwrap();
        assert_ne!(resp.status(), 404);
        let body: Value = resp.json().unwrap();
        assert_eq!(body["type"], "error");

        handle.stop();
    }

    /// OpenAI 流式入口在缺少上游凭据时，必须走「正常 SSE 收尾」而不是 HTTP 错误。
    ///
    /// 客户端已经收到 200，若这里返回错误 JSON，OpenAI SDK 会抛
    /// 「unexpected response object」并丢掉整轮内容。
    #[test]
    fn openai_stream_failure_finishes_as_sse() {
        let mut handle = start_proxy(test_config(39881)).expect("proxy starts");
        let port = handle.port;
        let client = reqwest::blocking::Client::new();

        let resp = client
            .post(format!("http://127.0.0.1:{port}/openai/v1/chat/completions"))
            .header("authorization", "Bearer test-key")
            .json(&json!({
                "model": "claude-opus-5",
                "messages": [{ "role": "user", "content": "hi" }],
                "stream": true,
            }))
            .send()
            .unwrap();
        assert_eq!(resp.status(), 200);
        let content_type = resp
            .headers()
            .get("content-type")
            .and_then(|v| v.to_str().ok())
            .unwrap_or("")
            .to_string();
        assert!(content_type.starts_with("text/event-stream"), "{content_type}");

        let text = resp.text().unwrap();
        // 必须先给出 role chunk，让客户端建立流上下文
        assert!(text.contains("chat.completion.chunk"), "{text}");
        assert!(text.contains("\"role\":\"assistant\""), "{text}");
        // 无论成功失败都要以 [DONE] 终止，否则客户端会一直等
        assert!(text.trim_end().ends_with("data: [DONE]"), "{text}");
        // OpenAI 帧不应带 event: 行
        assert!(!text.contains("event:"), "{text}");

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
