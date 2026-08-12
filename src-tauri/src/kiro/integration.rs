use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::Duration;
use tauri::{AppHandle, Emitter};

use crate::config::{
    apply_save_config_to_settings, build_api_profiles_state, env_string, load_api_profiles_store,
    profile_to_save_config, read_claude_settings_json, save_api_profiles_store, ApiProfile,
    ApiProfilesState,
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

pub struct KiroProxyState {
    pub(crate) inner: Arc<Mutex<Option<super::server::ProxyHandle>>>,
    pub(crate) key: Arc<Mutex<Option<String>>>,
    pub(crate) port: Arc<Mutex<Option<u16>>>,
}

impl Clone for KiroProxyState {
    fn clone(&self) -> Self {
        Self {
            inner: Arc::clone(&self.inner),
            key: Arc::clone(&self.key),
            port: Arc::clone(&self.port),
        }
    }
}

impl Default for KiroProxyState {
    fn default() -> Self {
        Self {
            inner: Arc::new(Mutex::new(None)),
            key: Arc::new(Mutex::new(None)),
            port: Arc::new(Mutex::new(None)),
        }
    }
}

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub(crate) struct KiroStatus {
    pub(crate) running: bool,
    pub(crate) port: Option<u16>,
    pub(crate) has_key: bool,
    pub(crate) auth_source: String,
    pub(crate) expires_at: Option<String>,
    pub(crate) profile_arn: Option<String>,
}

pub(crate) fn build_kiro_status_from(state: &KiroProxyState) -> KiroStatus {
    let running = state.inner.lock().map(|inner| inner.is_some()).unwrap_or(false);
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

/// 创建或更新名为「Kiro」的 API profile 并激活它。
pub(crate) fn ensure_kiro_profile(port: u16, api_key: &str, default_model: &str) -> Result<ApiProfilesState, String> {
    let mut store = load_api_profiles_store();
    let base_url = format!("http://127.0.0.1:{port}");
    let now = chrono::Utc::now().timestamp();

    let profile = match store.profiles.iter_mut().find(|p| p.name == "Kiro") {
        Some(existing) => {
            existing.base_url = base_url;
            existing.api_key = api_key.to_string();
            existing.default_model = default_model.to_string();
            existing.haiku_model = default_model.to_string();
            existing.sonnet_model = default_model.to_string();
            existing.opus_model = default_model.to_string();
            // 用账户实际可用模型覆盖旧的 Claude 展示项，避免 Claude Code 继续请求无额度模型
            existing.display_models = vec![default_model.to_string()];
            existing.updated_at = now;
            existing.clone()
        }
        None => {
            let profile = ApiProfile {
                id: uuid::Uuid::new_v4().to_string(),
                name: "Kiro".to_string(),
                base_url,
                api_key: api_key.to_string(),
                default_model: default_model.to_string(),
                haiku_model: default_model.to_string(),
                sonnet_model: default_model.to_string(),
                opus_model: default_model.to_string(),
                display_models: vec![default_model.to_string()],
                custom_models: Vec::new(),
                created_at: now,
                updated_at: now,
            };
            store.profiles.push(profile.clone());
            profile
        }
    };

    apply_save_config_to_settings(&profile_to_save_config(&profile))?;
    store.active_profile_id = Some(profile.id.clone());
    save_api_profiles_store(&store)?;
    Ok(build_api_profiles_state(&store))
}

/// 本地是否已有 Kiro SSO 凭据文件（快速判断，不发起网络请求）。
pub(crate) fn has_kiro_credential_file() -> bool {
    kiro_sso_cache_dir().join("kiro-auth-token.json").is_file()
}

/// 启动 Kiro 反代核心逻辑（命令与自动启动共用）。
pub(crate) fn start_kiro_proxy(state: &KiroProxyState, port: Option<u16>) -> Result<KiroStatus, String> {
    // 已在运行则直接返回当前状态
    if state.inner.lock().map(|inner| inner.is_some()).unwrap_or(false) {
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
            "未找到 Kiro 凭据：请先安装并登录 Kiro IDE，确认 ~/.aws/sso/cache/kiro-auth-token.json 存在后再试。"
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

    // 自动创建并激活 Kiro profile
    let profile_result = ensure_kiro_profile(actual_port, &key, &default_model);
    if let Err(e) = profile_result {
        eprintln!("[kiro] profile setup failed: {e}");
    }

    // 启动后从反代 /v1/models 拉取可用模型，写入 Kiro profile 展示列表
    match sync_kiro_profile_models(actual_port, &key) {
        Ok(ids) => {
            eprintln!("[kiro] synced {} models after start", ids.len());
        }
        Err(e) => {
            eprintln!("[kiro] sync models after start failed: {e}");
        }
    }

    Ok(build_kiro_status_from(state))
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

/// 把反代返回的模型写入名为「Kiro」的 profile.display_models。
pub(crate) fn sync_kiro_profile_models(port: u16, api_key: &str) -> Result<Vec<String>, String> {
    let ids = fetch_kiro_proxy_model_ids(port, api_key)?;
    let mut store = load_api_profiles_store();
    let Some(profile) = store.profiles.iter_mut().find(|p| p.name == "Kiro") else {
        return Err("未找到 Kiro profile".to_string());
    };
    profile.display_models = ids.clone();
    // 若当前默认模型不在新列表里，才回退到列表首项；否则保留用户已选模型
    let settings = read_claude_settings_json();
    let env_model = settings
        .get("env")
        .and_then(|value| value.as_object())
        .map(|env| env_string(env, "ANTHROPIC_MODEL"))
        .unwrap_or_default();
    let preferred = [profile.default_model.as_str(), env_model.as_str()]
        .into_iter()
        .map(str::trim)
        .find(|model| !model.is_empty() && ids.iter().any(|id| id == model))
        .map(str::to_string);
    if let Some(model) = preferred {
        profile.default_model = model;
    } else if !ids.is_empty() {
        let first = ids[0].clone();
        profile.default_model = first.clone();
        profile.haiku_model = first.clone();
        profile.sonnet_model = first.clone();
        profile.opus_model = first;
    }
    profile.updated_at = chrono::Utc::now().timestamp();
    let profile_snapshot = profile.clone();
    apply_save_config_to_settings(&profile_to_save_config(&profile_snapshot))?;
    save_api_profiles_store(&store)?;
    Ok(ids)
}

/// 后台检测本地 Kiro 凭据，存在则自动启动反代（不阻塞 UI）。
pub(crate) fn spawn_kiro_autostart(app: AppHandle, state: KiroProxyState) {
    thread::spawn(move || {
        if !has_kiro_credential_file() {
            eprintln!("[kiro] autostart skipped: no credential file");
            return;
        }
        match start_kiro_proxy(&state, None) {
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

/// 启动 Kiro 反代代理并自动接入 Claude Code。
#[tauri::command]
pub fn kiro_start(
    state: tauri::State<'_, KiroProxyState>,
    port: Option<u16>,
) -> Result<KiroStatus, String> {
    start_kiro_proxy(&state, port)
}

/// 停止 Kiro 反代代理。
#[tauri::command]
pub fn kiro_stop(state: tauri::State<'_, KiroProxyState>) -> Result<KiroStatus, String> {
    if let Some(mut handle) = state.inner.lock().map_err(|_| "lock failed".to_string())?.take() {
        handle.stop();
    }
    *state.port.lock().map_err(|_| "lock failed".to_string())? = None;
    *state.key.lock().map_err(|_| "lock failed".to_string())? = None;
    Ok(build_kiro_status(&state))
}
