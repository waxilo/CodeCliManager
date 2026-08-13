use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::Duration;
use tauri::{AppHandle, Emitter};

use crate::config::{
    apply_save_config_to_settings, env_string, load_api_profiles_store, load_kiro_proxy_prefs,
    purge_kiro_named_profiles, read_claude_settings_json, restore_api_profile_or_official,
    save_api_profiles_store, save_kiro_proxy_prefs, set_env_string, write_claude_settings_json,
    SaveClaudeCodeApiConfig,
};

// ── Kiro 反代代理：内置本地代理，把 Kiro 额度翻译成 Anthropic API ──────────

pub(crate) fn kiro_sso_cache_dir() -> PathBuf {
    dirs::home_dir()
        .unwrap_or_else(|| PathBuf::from("."))
        .join(".aws")
        .join("sso")
        .join("cache")
}

pub(crate) const KIRO_RUNTIME_URL: &str = "https://runtime.us-east-1.kiro.dev/";
pub(crate) const KIRO_MANAGEMENT_URL: &str = "https://management.us-east-1.kiro.dev/";
/// Kiro 默认模型：仅在无法查询账户可用模型时兜底（部分账户套餐不含 Claude 模型）。
pub(crate) const KIRO_DEFAULT_MODEL: &str = "claude-opus-5";

/// 定时刷新默认间隔（access token 通常约 1 小时）。
const KIRO_REFRESH_DEFAULT_SECS: u64 = 25 * 60;
/// 最短刷新间隔，避免过于频繁打 OIDC。
const KIRO_REFRESH_MIN_SECS: u64 = 5 * 60;
/// 过期前多久触发刷新。
const KIRO_REFRESH_SKEW_SECS: i64 = 5 * 60;

pub struct KiroProxyState {
    pub(crate) inner: Arc<Mutex<Option<super::server::ProxyHandle>>>,
    pub(crate) key: Arc<Mutex<Option<String>>>,
    pub(crate) port: Arc<Mutex<Option<u16>>>,
    /// 递增后旧刷新循环会退出；代理启动时再开新循环。
    pub(crate) refresh_generation: Arc<AtomicU64>,
    /// 串行化 start/stop/prepare，避免连点并发启停导致孤儿代理或卡死。
    pub(crate) op_lock: Arc<Mutex<()>>,
}

impl Clone for KiroProxyState {
    fn clone(&self) -> Self {
        Self {
            inner: Arc::clone(&self.inner),
            key: Arc::clone(&self.key),
            port: Arc::clone(&self.port),
            refresh_generation: Arc::clone(&self.refresh_generation),
            op_lock: Arc::clone(&self.op_lock),
        }
    }
}

impl Default for KiroProxyState {
    fn default() -> Self {
        Self {
            inner: Arc::new(Mutex::new(None)),
            key: Arc::new(Mutex::new(None)),
            port: Arc::new(Mutex::new(None)),
            refresh_generation: Arc::new(AtomicU64::new(0)),
            op_lock: Arc::new(Mutex::new(())),
        }
    }
}

fn is_proxy_running(state: &KiroProxyState) -> bool {
    state
        .inner
        .lock()
        .map(|inner| {
            inner
                .as_ref()
                .and_then(|handle| handle.thread.as_ref())
                .map(|thread| !thread.is_finished())
                .unwrap_or(false)
        })
        .unwrap_or(false)
}

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub(crate) struct KiroStatus {
    pub(crate) running: bool,
    /// 本地是否具备 Kiro（凭据文件 / 环境变量 / 代理已在跑），供前端决定是否展示入口
    pub(crate) available: bool,
    pub(crate) port: Option<u16>,
    pub(crate) has_key: bool,
    pub(crate) auth_source: String,
    pub(crate) expires_at: Option<String>,
    pub(crate) profile_arn: Option<String>,
}

/// 本地是否存在可用的 Kiro 凭据（文件或环境变量），不发起网络请求。
pub(crate) fn is_kiro_locally_available() -> bool {
    if has_kiro_credential_file() {
        return true;
    }
    ["KIRO_AUTHORIZATION", "KIRO_ACCESS_TOKEN"]
        .iter()
        .any(|key| {
            std::env::var(key)
                .ok()
                .map(|v| !v.trim().is_empty())
                .unwrap_or(false)
        })
}

pub(crate) fn build_kiro_status_from(state: &KiroProxyState) -> KiroStatus {
    let running = is_proxy_running(state);
    let port = state.port.lock().ok().and_then(|p| *p);
    let has_key = state.key.lock().map(|k| k.is_some()).unwrap_or(false);
    let auth = super::auth::Auth::new(
        kiro_sso_cache_dir(),
        None,
        KIRO_RUNTIME_URL.to_string(),
        KIRO_MANAGEMENT_URL.to_string(),
    );
    KiroStatus {
        running,
        available: is_kiro_locally_available() || running,
        port,
        has_key,
        auth_source: auth.describe_auth_source(),
        expires_at: auth.get_sso_token_expiry(),
        profile_arn: auth.get_sso_profile_arn(),
    }
}

pub(crate) fn build_kiro_status(state: &tauri::State<'_, KiroProxyState>) -> KiroStatus {
    build_kiro_status_from(state)
}

/// 开启 Kiro 时：记住原 API 配置、清理列表里遗留的「Kiro」项，并静默写入 Claude settings。
/// 不在 API 代理列表中新增/展示 Kiro。
pub(crate) fn activate_kiro_runtime(
    port: u16,
    api_key: &str,
    default_model: &str,
) -> Result<(), String> {
    let mut store = load_api_profiles_store();
    let _ = purge_kiro_named_profiles(&mut store);

    let mut prefs = load_kiro_proxy_prefs();
    // 仅首次进入「用户开启」时快照；已开启时（如重启自动拉起）保留原 previous
    if !prefs.enabled {
        prefs.previous_profile_id = store
            .active_profile_id
            .clone()
            .filter(|id| store.profiles.iter().any(|profile| &profile.id == id));
    }
    prefs.enabled = true;
    // 优先沿用用户上次在 Kiro 页选中的模型
    let model = {
        let preferred = prefs.default_model.trim();
        let incoming = default_model.trim();
        if !preferred.is_empty() {
            preferred.to_string()
        } else if !incoming.is_empty() {
            incoming.to_string()
        } else {
            KIRO_DEFAULT_MODEL.to_string()
        }
    };
    if prefs.default_model.trim().is_empty() {
        prefs.default_model = model.clone();
    }
    if prefs.display_models.is_empty() {
        prefs.display_models = vec![model.clone()];
    }
    save_kiro_proxy_prefs(&prefs)?;

    // 列表不展示 Kiro；运行期间也不把任何列表项标为「正在使用」
    store.active_profile_id = None;
    save_api_profiles_store(&store)?;

    let config = SaveClaudeCodeApiConfig {
        base_url: format!("http://127.0.0.1:{port}"),
        api_key: Some(api_key.to_string()),
        default_model: model.clone(),
        haiku_model: model.clone(),
        sonnet_model: model.clone(),
        opus_model: model,
        display_models: prefs.display_models.clone(),
        custom_models: Vec::new(),
    };
    apply_save_config_to_settings(&config)?;
    Ok(())
}

/// 停止 Kiro 后还原开启前的 API 配置（或官方默认），并关闭「重启自动启动」。
pub(crate) fn deactivate_kiro_runtime() -> Result<(), String> {
    let mut prefs = load_kiro_proxy_prefs();
    let previous = prefs.previous_profile_id.take();
    prefs.enabled = false;
    save_kiro_proxy_prefs(&prefs)?;
    restore_api_profile_or_official(previous)?;
    Ok(())
}

/// 本地是否已有 Kiro SSO 凭据文件（快速判断，不发起网络请求）。
pub(crate) fn has_kiro_credential_file() -> bool {
    kiro_sso_cache_dir().join("kiro-auth-token.json").is_file()
}

// `is_kiro_locally_available` 定义在上方，与 KiroStatus 相邻便于阅读。

/// 启动 Kiro 反代核心逻辑（命令与自动启动共用）。
/// 调用方须已持有 `state.op_lock`（或确认不会并发）。
pub(crate) fn start_kiro_proxy(
    app: Option<&AppHandle>,
    state: &KiroProxyState,
    port: Option<u16>,
) -> Result<KiroStatus, String> {
    // 已在运行则直接返回当前状态（并确保刷新循环活着）
    if is_proxy_running(state) {
        if let Some(app) = app {
            spawn_credential_refresh_loop(app.clone(), state.clone());
        }
        return Ok(build_kiro_status_from(state));
    }

    // 先停掉已有的代理（防御性清理）
    if let Some(mut existing) = state.inner.lock().map_err(|_| "lock failed".to_string())?.take() {
        existing.stop();
    }

    // 校验 Kiro 凭据存在（避免启动一个用不了的代理）
    let auth = super::auth::Auth::new(
        kiro_sso_cache_dir(),
        None,
        KIRO_RUNTIME_URL.to_string(),
        KIRO_MANAGEMENT_URL.to_string(),
    );
    let auth_ok = match auth.get_authorization() {
        Ok(Some(_)) => true,
        Ok(None) => false,
        Err(_) => false,
    };
    if !auth_ok {
        return Err(
            "未找到 Kiro 凭据：请先执行 `kiro-cli login`（或登录 Kiro IDE），确认 ~/.aws/sso/cache/kiro-auth-token.json 存在后再试。"
                .to_string(),
        );
    }

    // 优先使用账户实际可用的模型（部分套餐不含 Claude 模型），失败时兜底内置默认
    let default_model = auth
        .pick_available_default_model()
        .unwrap_or_else(|| KIRO_DEFAULT_MODEL.to_string());

    // 生成代理密钥并启动
    let key = format!("ccm-kiro-{}", uuid::Uuid::new_v4().to_string().replace('-', ""));
    let config = super::server::ProxyConfig {
        host: "127.0.0.1".to_string(),
        port: port.unwrap_or(5050),
        proxy_api_key: Some(key.clone()),
        default_model: default_model.clone(),
        runtime_url: KIRO_RUNTIME_URL.to_string(),
        management_url: KIRO_MANAGEMENT_URL.to_string(),
        sso_cache_dir: kiro_sso_cache_dir(),
        profile_arn_override: None,
    };
    let handle = super::server::start_proxy(config)?;
    let actual_port = handle.port;

    *state.key.lock().map_err(|_| "lock failed".to_string())? = Some(key.clone());
    *state.port.lock().map_err(|_| "lock failed".to_string())? = Some(actual_port);
    *state.inner.lock().map_err(|_| "lock failed".to_string())? = Some(handle);

    // 静默套用 Kiro 到 Claude settings（不写入 API 配置列表）
    if let Err(e) = activate_kiro_runtime(actual_port, &key, &default_model) {
        eprintln!("[kiro] apply runtime config failed: {e}");
    }

    // 启动后从反代 /v1/models 拉取可用模型，写回 Claude settings
    match sync_kiro_runtime_models(actual_port, &key) {
        Ok(ids) => {
            eprintln!("[kiro] synced {} models after start", ids.len());
        }
        Err(e) => {
            eprintln!("[kiro] sync models after start failed: {e}");
        }
    }

    if let Some(app) = app {
        spawn_credential_refresh_loop(app.clone(), state.clone());
    }

    Ok(build_kiro_status_from(state))
}

/// 停止后台凭据刷新循环（使当前 generation 失效）。
pub(crate) fn stop_credential_refresh_loop(state: &KiroProxyState) {
    state.refresh_generation.fetch_add(1, Ordering::SeqCst);
}

/// 计算下次刷新等待时长：优先在 expiresAt 前 skew 秒刷新，并夹在 [MIN, DEFAULT]。
fn next_credential_refresh_delay(expires_at: Option<&str>) -> Duration {
    let default = Duration::from_secs(KIRO_REFRESH_DEFAULT_SECS);
    let Some(raw) = expires_at else {
        return default;
    };
    let Ok(exp) = chrono::DateTime::parse_from_rfc3339(raw) else {
        // 兼容毫秒 ISO：2026-08-13T02:25:41.685Z
        let trimmed = raw.trim().trim_end_matches('Z');
        if let Ok(naive) = chrono::NaiveDateTime::parse_from_str(trimmed, "%Y-%m-%dT%H:%M:%S%.f") {
            let exp = naive.and_utc();
            return delay_until_expiry(exp.timestamp_millis());
        }
        if let Ok(naive) = chrono::NaiveDateTime::parse_from_str(trimmed, "%Y-%m-%dT%H:%M:%S") {
            let exp = naive.and_utc();
            return delay_until_expiry(exp.timestamp_millis());
        }
        return default;
    };
    delay_until_expiry(exp.timestamp_millis())
}

fn delay_until_expiry(expires_at_ms: i64) -> Duration {
    let default = Duration::from_secs(KIRO_REFRESH_DEFAULT_SECS);
    let min = Duration::from_secs(KIRO_REFRESH_MIN_SECS);
    let now = chrono::Utc::now().timestamp_millis();
    let target = expires_at_ms - KIRO_REFRESH_SKEW_SECS * 1000;
    if target <= now {
        return min;
    }
    let wait_ms = (target - now) as u64;
    Duration::from_millis(wait_ms).clamp(min, default)
}

fn sleep_interruptible(total: Duration, generation: u64, state: &KiroProxyState) -> bool {
    let step = Duration::from_secs(2);
    let mut remaining = total;
    while remaining > Duration::ZERO {
        if state.refresh_generation.load(Ordering::SeqCst) != generation {
            return false;
        }
        if !is_proxy_running(state) {
            return false;
        }
        let chunk = remaining.min(step);
        thread::sleep(chunk);
        remaining = remaining.saturating_sub(chunk);
    }
    state.refresh_generation.load(Ordering::SeqCst) == generation
}

/// 强制刷新共享 SSO 凭据（IDE / CLI 同一文件），写回 ~/.aws/sso/cache。
/// 返回 `(是否执行了刷新, 最新 expiresAt)`。
pub(crate) fn refresh_shared_sso_credentials() -> Result<(bool, Option<String>), String> {
    let auth = super::auth::Auth::new(
        kiro_sso_cache_dir(),
        None,
        KIRO_RUNTIME_URL.to_string(),
        KIRO_MANAGEMENT_URL.to_string(),
    );
    // 优先尝试 kiro-cli（若已安装）：whoami 会触发 CLI 侧会话校验，失败不阻断内置刷新
    try_kiro_cli_touch();
    auth.force_refresh()
}

/// 若本机有 kiro-cli，轻触一次以保持 CLI 侧会话活跃（不依赖其输出）。
fn try_kiro_cli_touch() {
    let candidates = [
        "kiro-cli",
        "kiro",
    ];
    for bin in candidates {
        let status = std::process::Command::new(bin)
            .arg("whoami")
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .status();
        match status {
            Ok(s) if s.success() => {
                eprintln!("[kiro] touched {bin} whoami before credential refresh");
                return;
            }
            Ok(_) => continue,
            Err(_) => continue,
        }
    }
}

/// 代理运行期间定时刷新共享 SSO 凭据，供 CLI 与 IDE 共用。
pub(crate) fn spawn_credential_refresh_loop(app: AppHandle, state: KiroProxyState) {
    let generation = state.refresh_generation.fetch_add(1, Ordering::SeqCst) + 1;
    thread::spawn(move || {
        eprintln!("[kiro] credential refresh loop start (gen={generation})");
        // 启动后先等一小段，再按 expiresAt 调度
        if !sleep_interruptible(Duration::from_secs(30), generation, &state) {
            eprintln!("[kiro] credential refresh loop stopped early (gen={generation})");
            return;
        }
        loop {
            if state.refresh_generation.load(Ordering::SeqCst) != generation {
                break;
            }
            if !is_proxy_running(&state) {
                break;
            }

            match refresh_shared_sso_credentials() {
                Ok((true, expires_at)) => {
                    eprintln!("[kiro] shared SSO credentials refreshed");
                    let mut status = build_kiro_status_from(&state);
                    if expires_at.is_some() {
                        status.expires_at = expires_at;
                    }
                    let _ = app.emit("kiro-token-refreshed", &status);
                }
                Ok((false, _)) => {
                    eprintln!("[kiro] credential refresh skipped: no refreshToken / env auth");
                }
                Err(e) => {
                    eprintln!("[kiro] credential refresh failed: {e}");
                    let status = build_kiro_status_from(&state);
                    let _ = app.emit("kiro-token-refresh-failed", &json_refresh_error(&e, &status));
                }
            }

            let delay = next_credential_refresh_delay(
                build_kiro_status_from(&state).expires_at.as_deref(),
            );
            eprintln!(
                "[kiro] next credential refresh in {}s (gen={generation})",
                delay.as_secs()
            );
            if !sleep_interruptible(delay, generation, &state) {
                break;
            }
        }
        eprintln!("[kiro] credential refresh loop exit (gen={generation})");
    });
}

fn json_refresh_error(message: &str, status: &KiroStatus) -> serde_json::Value {
    serde_json::json!({
        "message": message,
        "status": status,
    })
}

/// 从本地 Kiro 反代拉取模型 ID 列表。
pub(crate) fn fetch_kiro_proxy_model_ids(port: u16, api_key: &str) -> Result<Vec<String>, String> {
    let url = format!("http://127.0.0.1:{port}/v1/models");
    let client = reqwest::blocking::Client::builder()
        .timeout(Duration::from_secs(45))
        .build()
        .map_err(|e| format!("创建 HTTP 客户端失败: {e}"))?;

    let mut last_err = String::from("unknown");
    // 代理线程刚起来或上游 ListAvailableModels 较慢时，短暂重试
    for attempt in 1..=4u32 {
        match client
            .get(&url)
            .header("Authorization", format!("Bearer {api_key}"))
            .header("x-api-key", api_key)
            .header("anthropic-version", "2023-06-01")
            .send()
        {
            Ok(response) => {
                let status = response.status();
                if !status.is_success() {
                    let body = response.text().unwrap_or_default();
                    last_err = format!("HTTP {status}: {body}");
                } else {
                    let data: serde_json::Value = response
                        .json()
                        .map_err(|e| format!("解析模型列表失败: {e}"))?;
                    let mut ids: Vec<String> = data
                        .get("data")
                        .and_then(|v| v.as_array())
                        .map(|arr| {
                            arr.iter()
                                .filter_map(|item| item.get("id").and_then(|v| v.as_str()))
                                .map(|s| s.trim().to_string())
                                .filter(|s| !s.is_empty())
                                .collect()
                        })
                        .unwrap_or_default();
                    ids.sort();
                    ids.dedup();
                    if ids.is_empty() {
                        last_err = "模型列表为空".to_string();
                    } else {
                        return Ok(ids);
                    }
                }
            }
            Err(e) => {
                last_err = e.to_string();
            }
        }
        if attempt < 4 {
            thread::sleep(Duration::from_millis(400 * u64::from(attempt)));
        }
    }
    Err(format!("拉取 Kiro 模型失败: {last_err}"))
}

/// 把反代返回的模型写回 Claude settings + Kiro 偏好（不维护 API 列表中的 Kiro 项）。
pub(crate) fn sync_kiro_runtime_models(port: u16, api_key: &str) -> Result<Vec<String>, String> {
    let ids = fetch_kiro_proxy_model_ids(port, api_key)?;
    let mut prefs = load_kiro_proxy_prefs();
    let settings = read_claude_settings_json();
    let env_model = settings
        .get("env")
        .and_then(|value| value.as_object())
        .map(|env| env_string(env, "ANTHROPIC_MODEL"))
        .unwrap_or_default();
    let preferred = [prefs.default_model.as_str(), env_model.as_str()]
        .into_iter()
        .map(str::trim)
        .find(|model| !model.is_empty() && ids.iter().any(|id| id == model))
        .map(str::to_string)
        .or_else(|| ids.first().cloned())
        .unwrap_or_else(|| KIRO_DEFAULT_MODEL.to_string());

    prefs.display_models = ids.clone();
    prefs.default_model = preferred.clone();
    // 同步只更新 API 展示列表，保留用户自定义模型
    save_kiro_proxy_prefs(&prefs)?;

    let config = SaveClaudeCodeApiConfig {
        base_url: format!("http://127.0.0.1:{port}"),
        api_key: Some(api_key.to_string()),
        default_model: preferred.clone(),
        haiku_model: preferred.clone(),
        sonnet_model: preferred.clone(),
        opus_model: preferred,
        display_models: ids.clone(),
        custom_models: prefs.custom_models.clone(),
    };
    apply_save_config_to_settings(&config)?;
    Ok(ids)
}

fn require_running_proxy(state: &KiroProxyState) -> Result<(u16, String), String> {
    let running = is_proxy_running(state);
    if !running {
        return Err("请先启动 Kiro 代理".to_string());
    }
    let port = state
        .port
        .lock()
        .map_err(|_| "lock failed".to_string())?
        .ok_or_else(|| "Kiro 代理端口未知".to_string())?;
    let key = state
        .key
        .lock()
        .map_err(|_| "lock failed".to_string())?
        .clone()
        .ok_or_else(|| "Kiro 代理密钥未知".to_string())?;
    Ok((port, key))
}

fn normalize_model_list(models: &[String]) -> Vec<String> {
    let mut seen = std::collections::HashSet::new();
    let mut normalized = Vec::new();
    for model in models {
        let trimmed = model.trim();
        if trimmed.is_empty() || !seen.insert(trimmed.to_string()) {
            continue;
        }
        normalized.push(trimmed.to_string());
    }
    normalized
}

fn build_kiro_models_state(running: bool) -> KiroModelsState {
    let prefs = load_kiro_proxy_prefs();
    let settings = read_claude_settings_json();
    let env_model = settings
        .get("env")
        .and_then(|value| value.as_object())
        .map(|env| env_string(env, "ANTHROPIC_MODEL"))
        .unwrap_or_default();
    let default_model = if !prefs.default_model.trim().is_empty() {
        prefs.default_model.clone()
    } else {
        env_model
    };
    let mut merged = prefs.display_models.clone();
    for model in &prefs.custom_models {
        if !merged.iter().any(|existing| existing == model) {
            merged.push(model.clone());
        }
    }
    KiroModelsState {
        running,
        display_models: prefs.display_models,
        custom_models: prefs.custom_models,
        // 兼容旧前端：展示 + 自定义合并
        models: merged,
        default_model,
    }
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub(crate) struct KiroModelsState {
    pub(crate) running: bool,
    #[serde(default)]
    pub(crate) display_models: Vec<String>,
    #[serde(default)]
    pub(crate) custom_models: Vec<String>,
    /// 合并后的候选列表（兼容旧字段名 models）
    pub(crate) models: Vec<String>,
    pub(crate) default_model: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SaveKiroModelsConfig {
    #[serde(default)]
    pub(crate) display_models: Vec<String>,
    #[serde(default)]
    pub(crate) custom_models: Vec<String>,
    #[serde(default)]
    pub(crate) default_model: Option<String>,
}

/// 仅当用户上次开启过 Kiro（prefs.enabled）且本地有凭据时，重启后自动拉起。
pub(crate) fn spawn_kiro_autostart(app: AppHandle, state: KiroProxyState) {
    thread::spawn(move || {
        let prefs = load_kiro_proxy_prefs();
        if !prefs.enabled {
            eprintln!("[kiro] autostart skipped: proxy was left off");
            return;
        }
        if !has_kiro_credential_file() {
            eprintln!("[kiro] autostart skipped: no credential file");
            return;
        }
        let _op = match state.op_lock.lock() {
            Ok(guard) => guard,
            Err(_) => {
                eprintln!("[kiro] autostart skipped: op_lock poisoned");
                return;
            }
        };
        match start_kiro_proxy(Some(&app), &state, None) {
            Ok(status) => {
                eprintln!(
                    "[kiro] autostart ok: running={} port={:?}",
                    status.running, status.port
                );
                let _ = app.emit("kiro-ready", &status);
            }
            Err(e) => {
                eprintln!("[kiro] autostart failed: {e}");
            }
        }
    });
}

/// 查询 Kiro 反代状态。
#[tauri::command]
pub fn kiro_status(state: tauri::State<'_, KiroProxyState>) -> KiroStatus {
    build_kiro_status(&state)
}

/// 查询 Kiro 账户 Credits 额度（后台线程阻塞 HTTP，不卡住 UI）。
#[tauri::command]
pub async fn kiro_usage() -> Result<super::auth::KiroUsageInfo, String> {
    tauri::async_runtime::spawn_blocking(|| {
        let auth = super::auth::Auth::new(
            kiro_sso_cache_dir(),
            None,
            KIRO_RUNTIME_URL.to_string(),
            KIRO_MANAGEMENT_URL.to_string(),
        );
        auth.get_usage_limits()
    })
    .await
    .map_err(|e| format!("额度查询任务失败: {e}"))?
}

/// 手动刷新共享 SSO 凭据（写回 ~/.aws/sso/cache，IDE/CLI 共用）。
#[tauri::command]
pub async fn kiro_refresh_token(
    app: AppHandle,
    state: tauri::State<'_, KiroProxyState>,
) -> Result<KiroStatus, String> {
    let state_clone = (*state).clone();
    let (refreshed, expires_at) = tauri::async_runtime::spawn_blocking(refresh_shared_sso_credentials)
        .await
        .map_err(|e| format!("凭据刷新任务失败: {e}"))??;
    if !refreshed {
        return Err("未找到可刷新的 Kiro refreshToken，请先登录 Kiro IDE 或执行 kiro-cli login".to_string());
    }
    let mut status = build_kiro_status_from(&state_clone);
    // 优先使用刷新结果里的 expiresAt，避免刚写入文件后读到旧值导致 UI 不更新
    if let Some(exp) = expires_at {
        status.expires_at = Some(exp.clone());
        if status.auth_source.contains("SSO") || status.auth_source.contains("共享缓存") {
            status.auth_source = format!(
                "Kiro SSO 共享缓存（IDE/CLI 共用，{}），过期 {exp}",
                kiro_sso_cache_dir().join("kiro-auth-token.json").display()
            );
        }
    }
    let _ = app.emit("kiro-token-refreshed", &status);
    Ok(status)
}

fn validate_kiro_credentials() -> Result<(), String> {
    let auth = super::auth::Auth::new(
        kiro_sso_cache_dir(),
        None,
        KIRO_RUNTIME_URL.to_string(),
        KIRO_MANAGEMENT_URL.to_string(),
    );
    match auth.list_available_models() {
        Ok(models) if !models.is_empty() => return Ok(()),
        Ok(_) => {}
        Err(error) => {
            eprintln!("[kiro] send preflight initial validation failed: {error}");
        }
    }

    let (refreshed, _) = refresh_shared_sso_credentials()
        .map_err(|error| format!("Kiro 凭据续期失败：{error}"))?;
    if !refreshed {
        return Err("Kiro 凭据已失效且无法自动续期，请重新登录 Kiro IDE 或执行 kiro-cli login".to_string());
    }

    let retry_auth = super::auth::Auth::new(
        kiro_sso_cache_dir(),
        None,
        KIRO_RUNTIME_URL.to_string(),
        KIRO_MANAGEMENT_URL.to_string(),
    );
    let models = retry_auth
        .list_available_models()
        .map_err(|error| format!("Kiro 凭据续期后验证失败：{error}"))?;
    if models.is_empty() {
        return Err("Kiro 凭据续期后仍无法获取可用模型，请重新登录 Kiro".to_string());
    }
    Ok(())
}

/// 发送消息前检查 Kiro：仅当用户启用了代理时执行。
/// 代理意外停止则自动拉起；凭据失效则自动续期并重试一次。
#[tauri::command]
pub async fn kiro_prepare_send(
    app: AppHandle,
    state: tauri::State<'_, KiroProxyState>,
) -> Result<KiroStatus, String> {
    if !load_kiro_proxy_prefs().enabled {
        return Ok(build_kiro_status(&state));
    }

    let state_clone = (*state).clone();
    let app_clone = app.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let _op = state_clone
            .op_lock
            .lock()
            .map_err(|_| "Kiro 操作锁获取失败".to_string())?;
        if !is_proxy_running(&state_clone) {
            start_kiro_proxy(Some(&app_clone), &state_clone, None)
                .map_err(|error| format!("Kiro 代理自动恢复失败：{error}"))?;
        }

        validate_kiro_credentials()?;
        let status = build_kiro_status_from(&state_clone);
        if !status.running {
            return Err("Kiro 代理未运行，请在 Kiro 代理页重新启动".to_string());
        }
        Ok(status)
    })
    .await
    .map_err(|error| format!("Kiro 发送前检查任务失败：{error}"))?
}

/// 启动 Kiro 反代代理并自动接入 Claude Code。
#[tauri::command]
pub async fn kiro_start(
    app: AppHandle,
    state: tauri::State<'_, KiroProxyState>,
    port: Option<u16>,
) -> Result<KiroStatus, String> {
    let state_clone = (*state).clone();
    tauri::async_runtime::spawn_blocking(move || {
        let _op = state_clone
            .op_lock
            .lock()
            .map_err(|_| "Kiro 操作锁获取失败".to_string())?;
        start_kiro_proxy(Some(&app), &state_clone, port)
    })
    .await
    .map_err(|e| format!("Kiro 启动任务失败: {e}"))?
}

/// 停止 Kiro 反代代理，并还原开启前的 API 配置。
#[tauri::command]
pub async fn kiro_stop(state: tauri::State<'_, KiroProxyState>) -> Result<KiroStatus, String> {
    let state_clone = (*state).clone();
    tauri::async_runtime::spawn_blocking(move || {
        let _op = state_clone
            .op_lock
            .lock()
            .map_err(|_| "Kiro 操作锁获取失败".to_string())?;
        stop_credential_refresh_loop(&state_clone);
        if let Some(mut handle) = state_clone
            .inner
            .lock()
            .map_err(|_| "lock failed".to_string())?
            .take()
        {
            handle.stop();
        }
        *state_clone.port.lock().map_err(|_| "lock failed".to_string())? = None;
        *state_clone.key.lock().map_err(|_| "lock failed".to_string())? = None;
        if let Err(e) = deactivate_kiro_runtime() {
            eprintln!("[kiro] restore api config after stop failed: {e}");
        }
        Ok(build_kiro_status_from(&state_clone))
    })
    .await
    .map_err(|e| format!("Kiro 停止任务失败: {e}"))?
}

/// 读取 Kiro 模型列表与当前默认模型（来自偏好 / settings）。
#[tauri::command]
pub fn kiro_models_state(state: tauri::State<'_, KiroProxyState>) -> KiroModelsState {
    let running = is_proxy_running(&state);
    build_kiro_models_state(running)
}

/// 从运行中的本地代理同步可用模型，并写入 Claude settings。
#[tauri::command]
pub fn kiro_sync_models(state: tauri::State<'_, KiroProxyState>) -> Result<KiroModelsState, String> {
    let (port, key) = require_running_proxy(&state)?;
    sync_kiro_runtime_models(port, &key)?;
    Ok(build_kiro_models_state(true))
}

/// 保存 Kiro 展示/自定义模型列表（与 API 配置页行为一致）。
#[tauri::command]
pub fn kiro_save_models_config(
    state: tauri::State<'_, KiroProxyState>,
    config: SaveKiroModelsConfig,
) -> Result<KiroModelsState, String> {
    let mut prefs = load_kiro_proxy_prefs();
    prefs.display_models = normalize_model_list(&config.display_models);
    prefs.custom_models = normalize_model_list(&config.custom_models);

    let preferred = config
        .default_model
        .as_deref()
        .map(str::trim)
        .filter(|model| !model.is_empty())
        .map(str::to_string)
        .or_else(|| {
            let current = prefs.default_model.trim();
            if !current.is_empty()
                && (prefs.display_models.iter().any(|id| id == current)
                    || prefs.custom_models.iter().any(|id| id == current))
            {
                Some(current.to_string())
            } else {
                None
            }
        })
        .or_else(|| prefs.display_models.first().cloned())
        .or_else(|| prefs.custom_models.first().cloned())
        .unwrap_or_default();
    prefs.default_model = preferred.clone();
    save_kiro_proxy_prefs(&prefs)?;

    // 代理运行中时同步写回 Claude settings，供输入框快捷选择
    if let Ok((port, key)) = require_running_proxy(&state) {
        let save = SaveClaudeCodeApiConfig {
            base_url: format!("http://127.0.0.1:{port}"),
            api_key: Some(key),
            default_model: preferred.clone(),
            haiku_model: preferred.clone(),
            sonnet_model: preferred.clone(),
            opus_model: preferred,
            display_models: prefs.display_models.clone(),
            custom_models: prefs.custom_models.clone(),
        };
        apply_save_config_to_settings(&save)?;
    }

    Ok(build_kiro_models_state(is_proxy_running(&state)))
}

/// 设置 Kiro 默认模型（写入 Claude settings + 偏好）。
#[tauri::command]
pub fn kiro_set_default_model(
    state: tauri::State<'_, KiroProxyState>,
    model: String,
) -> Result<KiroModelsState, String> {
    let trimmed = model.trim().to_string();
    if trimmed.is_empty() {
        return Err("模型名称不能为空".to_string());
    }

    let mut prefs = load_kiro_proxy_prefs();
    let known = prefs
        .display_models
        .iter()
        .chain(prefs.custom_models.iter())
        .any(|id| id == &trimmed);
    if !known {
        prefs.custom_models.push(trimmed.clone());
    }
    prefs.default_model = trimmed.clone();
    save_kiro_proxy_prefs(&prefs)?;

    if let Ok((port, key)) = require_running_proxy(&state) {
        let config = SaveClaudeCodeApiConfig {
            base_url: format!("http://127.0.0.1:{port}"),
            api_key: Some(key),
            default_model: trimmed.clone(),
            haiku_model: trimmed.clone(),
            sonnet_model: trimmed.clone(),
            opus_model: trimmed,
            display_models: prefs.display_models.clone(),
            custom_models: prefs.custom_models.clone(),
        };
        apply_save_config_to_settings(&config)?;
    } else if prefs.enabled {
        // 已启用但代理暂未运行：仍更新 settings 中的模型字段
        let mut settings = read_claude_settings_json();
        if let Some(env) = settings
            .get_mut("env")
            .and_then(|value| value.as_object_mut())
        {
            set_env_string(env, "ANTHROPIC_MODEL", &prefs.default_model);
        }
        write_claude_settings_json(&settings)?;
    }

    Ok(build_kiro_models_state(is_proxy_running(&state)))
}
