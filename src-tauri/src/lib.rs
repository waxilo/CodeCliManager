use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use std::fs;
use std::io::{BufRead, BufReader, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::{
    atomic::{AtomicBool, Ordering},
    mpsc::{self, RecvTimeoutError},
    Arc, Mutex,
};
use std::thread;
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter, LogicalSize, Manager, PhysicalPosition, Position, Size, WebviewWindow};

use base64::{engine::general_purpose::STANDARD, Engine as _};

mod model_fetch;

// ── 全局进程注册表：用于支持 abort（取消正在运行的任务） ──────────────
static ACTIVE_PROCESSES: Mutex<Option<HashMap<String, Arc<Mutex<Child>>>>> = Mutex::new(None);

fn ensure_process_registry() {
    let mut reg = ACTIVE_PROCESSES.lock().unwrap();
    if reg.is_none() {
        *reg = Some(HashMap::new());
    }
}

fn register_active_process(key: &str, child: Arc<Mutex<Child>>) {
    ensure_process_registry();
    let mut reg = ACTIVE_PROCESSES.lock().unwrap();
    if let Some(map) = reg.as_mut() {
        map.insert(key.to_string(), child);
    }
}

fn unregister_active_process(key: &str) {
    let mut reg = ACTIVE_PROCESSES.lock().unwrap();
    if let Some(map) = reg.as_mut() {
        map.remove(key);
    }
}

// ── 用户主动终止标记：区分 abort 和异常退出 ──────────────────────────
static ABORTED_SESSIONS: Mutex<Option<HashSet<String>>> = Mutex::new(None);

fn mark_session_aborted(key: &str) {
    let mut set = ABORTED_SESSIONS.lock().unwrap();
    if set.is_none() {
        *set = Some(HashSet::new());
    }
    if let Some(s) = set.as_mut() {
        s.insert(key.to_string());
    }
}

fn is_session_aborted(key: &str) -> bool {
    let set = ABORTED_SESSIONS.lock().unwrap();
    set.as_ref().is_some_and(|s| s.contains(key))
}

fn clear_session_aborted(key: &str) {
    let mut set = ABORTED_SESSIONS.lock().unwrap();
    if let Some(s) = set.as_mut() {
        s.remove(key);
    }
}

/// 杀死进程及其子进程树
/// Windows: 使用 taskkill /T /F /PID 杀死整个进程树
/// Unix: 使用 SIGTERM 先尝试优雅退出，再 SIGKILL 强制杀死
fn kill_process_tree(child: &mut Child) {
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        let pid = child.id();
        // taskkill /T = 杀死进程树, /F = 强制终止
        let _ = std::process::Command::new("taskkill")
            .args(["/T", "/F", "/PID", &pid.to_string()])
            .creation_flags(0x08000000) // CREATE_NO_WINDOW: 不弹出 cmd 窗口
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status();
    }
    #[cfg(not(target_os = "windows"))]
    {
        // 先尝试 SIGTERM（优雅退出）
        #[cfg(unix)]
        {
            let pid = child.id();
            // kill -TERM pid（负号表示进程组）
            let _ = std::process::Command::new("kill")
                .args(["-TERM", &pid.to_string()])
                .status();
            // 等待 2 秒看进程是否自行退出
            for _ in 0..20 {
                if let Ok(Some(_)) = child.try_wait() {
                    return;
                }
                std::thread::sleep(std::time::Duration::from_millis(100));
            }
        }
        // 最终强制杀死
        let _ = child.kill();
    }
}

fn kill_active_process(key: &str) -> bool {
    let reg = ACTIVE_PROCESSES.lock().unwrap();
    if let Some(map) = reg.as_ref() {
        if let Some(child_arc) = map.get(key) {
            let child_arc = Arc::clone(child_arc);
            drop(reg); // 释放锁再 kill，避免死锁
            if let Ok(mut child) = child_arc.lock() {
                kill_process_tree(&mut child);
            }
            return true;
        }
    }
    false
}

#[allow(dead_code)]
fn kill_all_active_processes() {
    let keys: Vec<String> = {
        let reg = ACTIVE_PROCESSES.lock().unwrap();
        match reg.as_ref() {
            Some(map) => map.keys().cloned().collect(),
            None => vec![],
        }
    };
    for key in keys {
        kill_active_process(&key);
    }
}

#[derive(Debug, Serialize, Deserialize, Clone)]
struct Message {
    id: String,
    role: String,
    content: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    thinking: Option<String>,
    timestamp: i64,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
struct Conversation {
    id: String,
    title: String,
    messages: Vec<Message>,
    platform: String,
    #[serde(default)]
    project_dir: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    source_path: Option<String>,
    created_at: i64,
    updated_at: i64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    context_tokens: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    last_model: Option<String>,
}

#[derive(Debug, Serialize, Deserialize)]
struct PlatformConfig {
    name: String,
    command: String,
    args: Vec<String>,
    env_vars: HashMap<String, String>,
}

#[derive(Debug, Serialize, Deserialize, Default)]
struct AppState {
    conversations: Vec<Conversation>,
    platforms: HashMap<String, PlatformConfig>,
    active_platform: String,
    current_platform: String,
}

fn get_data_path() -> PathBuf {
    let mut path = dirs::data_dir().unwrap_or_else(|| PathBuf::from("."));
    path.push("CodeCliManager");
    path
}

fn get_claude_history_path() -> PathBuf {
    let mut path = dirs::home_dir().unwrap_or_else(|| PathBuf::from("."));
    path.push(".claude");
    path.push("projects");
    path
}

fn get_claude_settings_path() -> PathBuf {
    let mut path = dirs::home_dir().unwrap_or_else(|| PathBuf::from("."));
    path.push(".claude");
    let settings = path.join("settings.json");
    if settings.exists() {
        return settings;
    }
    let legacy = path.join("claude.json");
    if legacy.exists() {
        return legacy;
    }
    settings
}

#[derive(Debug, Serialize, Deserialize, Clone, Default)]
#[serde(rename_all = "camelCase")]
struct ClaudeCodeApiConfig {
    base_url: String,
    #[serde(default)]
    has_api_key: bool,
    default_model: String,
    haiku_model: String,
    sonnet_model: String,
    opus_model: String,
    #[serde(default)]
    display_models: Vec<String>,
    #[serde(default)]
    custom_models: Vec<String>,
    config_path: String,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SaveClaudeCodeApiConfig {
    base_url: String,
    api_key: Option<String>,
    default_model: String,
    haiku_model: String,
    sonnet_model: String,
    opus_model: String,
    #[serde(default)]
    display_models: Vec<String>,
    #[serde(default)]
    custom_models: Vec<String>,
}

fn read_claude_settings_json() -> serde_json::Value {
    let path = get_claude_settings_path();
    if !path.exists() {
        return serde_json::json!({ "env": {} });
    }
    fs::read_to_string(&path)
        .ok()
        .and_then(|content| serde_json::from_str(&content).ok())
        .unwrap_or_else(|| serde_json::json!({ "env": {} }))
}

fn write_claude_settings_json(settings: &serde_json::Value) -> Result<(), String> {
    let path = get_claude_settings_path();
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| format!("Failed to create config dir: {e}"))?;
    }
    let content =
        serde_json::to_string_pretty(settings).map_err(|e| format!("Failed to encode config: {e}"))?;
    fs::write(&path, content).map_err(|e| format!("Failed to write {}: {e}", path.display()))
}

fn env_string(env: &serde_json::Map<String, serde_json::Value>, key: &str) -> String {
    env.get(key)
        .and_then(|value| value.as_str())
        .unwrap_or("")
        .trim()
        .to_string()
}

fn set_env_string(env: &mut serde_json::Map<String, serde_json::Value>, key: &str, value: &str) {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        env.remove(key);
    } else {
        env.insert(key.to_string(), serde_json::Value::String(trimmed.to_string()));
    }
}

fn set_model_and_display_name(
    env: &mut serde_json::Map<String, serde_json::Value>,
    model_key: &str,
    name_key: &str,
    value: &str,
) {
    set_env_string(env, model_key, value);
    set_env_string(env, name_key, value);
}

fn claude_api_key_from_env(env: &serde_json::Map<String, serde_json::Value>) -> String {
    let auth_token = env_string(env, "ANTHROPIC_AUTH_TOKEN");
    if !auth_token.is_empty() {
        return auth_token;
    }
    env_string(env, "ANTHROPIC_API_KEY")
}

/// 是否配置了自定义 API（第三方中转）。官方订阅模式下 ANTHROPIC_BASE_URL 为空。
fn has_custom_api_base() -> bool {
    let settings = read_claude_settings_json();
    settings
        .get("env")
        .and_then(|value| value.as_object())
        .map(|env| !env_string(env, "ANTHROPIC_BASE_URL").is_empty())
        .unwrap_or(false)
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
struct ApiProfile {
    id: String,
    name: String,
    base_url: String,
    api_key: String,
    default_model: String,
    haiku_model: String,
    sonnet_model: String,
    opus_model: String,
    #[serde(default)]
    display_models: Vec<String>,
    #[serde(default)]
    custom_models: Vec<String>,
    created_at: i64,
    updated_at: i64,
}

#[derive(Debug, Serialize, Deserialize, Default)]
struct ApiProfilesStore {
    #[serde(default)]
    active_profile_id: Option<String>,
    #[serde(default)]
    profiles: Vec<ApiProfile>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
struct ApiProfileItem {
    id: String,
    name: String,
    base_url: String,
    default_model: String,
    has_api_key: bool,
    is_active: bool,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
struct ApiProfilesState {
    active_profile_id: Option<String>,
    profiles: Vec<ApiProfileItem>,
    current: ClaudeCodeApiConfig,
}

fn get_api_profiles_path() -> PathBuf {
    get_data_path().join("api-profiles.json")
}

fn load_api_profiles_store() -> ApiProfilesStore {
    let path = get_api_profiles_path();
    if !path.exists() {
        return ApiProfilesStore::default();
    }
    fs::read_to_string(&path)
        .ok()
        .and_then(|content| serde_json::from_str(&content).ok())
        .unwrap_or_default()
}

fn save_api_profiles_store(store: &ApiProfilesStore) -> Result<(), String> {
    let data_path = get_data_path();
    if !data_path.exists() {
        fs::create_dir_all(&data_path).map_err(|e| format!("Failed to create data dir: {e}"))?;
    }
    let content = serde_json::to_string_pretty(store)
        .map_err(|e| format!("Failed to encode api profiles: {e}"))?;
    fs::write(get_api_profiles_path(), content)
        .map_err(|e| format!("Failed to write api profiles: {e}"))
}

fn apply_model_override_env(cmd: &mut std::process::Command, model: &str) {
    let trimmed = model.trim();
    if trimmed.is_empty() {
        return;
    }
    cmd.env("ANTHROPIC_MODEL", trimmed);
    cmd.env("ANTHROPIC_DEFAULT_HAIKU_MODEL", trimmed);
    cmd.env("ANTHROPIC_DEFAULT_SONNET_MODEL", trimmed);
    cmd.env("ANTHROPIC_DEFAULT_OPUS_MODEL", trimmed);
    cmd.env("ANTHROPIC_DEFAULT_HAIKU_MODEL_NAME", trimmed);
    cmd.env("ANTHROPIC_DEFAULT_SONNET_MODEL_NAME", trimmed);
    cmd.env("ANTHROPIC_DEFAULT_OPUS_MODEL_NAME", trimmed);
}

fn config_from_env(env: &serde_json::Map<String, serde_json::Value>) -> ClaudeCodeApiConfig {
    let api_key = claude_api_key_from_env(env);
    ClaudeCodeApiConfig {
        base_url: env_string(env, "ANTHROPIC_BASE_URL"),
        has_api_key: !api_key.is_empty(),
        default_model: env_string(env, "ANTHROPIC_MODEL"),
        haiku_model: env_string(env, "ANTHROPIC_DEFAULT_HAIKU_MODEL"),
        sonnet_model: env_string(env, "ANTHROPIC_DEFAULT_SONNET_MODEL"),
        opus_model: env_string(env, "ANTHROPIC_DEFAULT_OPUS_MODEL"),
        display_models: Vec::new(),
        custom_models: Vec::new(),
        config_path: get_claude_settings_path().to_string_lossy().to_string(),
    }
}

fn config_from_profile(profile: &ApiProfile) -> ClaudeCodeApiConfig {
    ClaudeCodeApiConfig {
        base_url: profile.base_url.clone(),
        has_api_key: !profile.api_key.trim().is_empty(),
        default_model: profile.default_model.clone(),
        haiku_model: profile.haiku_model.clone(),
        sonnet_model: profile.sonnet_model.clone(),
        opus_model: profile.opus_model.clone(),
        display_models: profile.display_models.clone(),
        custom_models: profile.custom_models.clone(),
        config_path: get_claude_settings_path().to_string_lossy().to_string(),
    }
}

fn resolve_profile_env_model(profile: &ApiProfile) -> String {
    profile
        .custom_models
        .iter()
        .find(|model| !model.trim().is_empty())
        .cloned()
        .or_else(|| {
            profile
                .display_models
                .iter()
                .find(|model| !model.trim().is_empty())
                .cloned()
        })
        .unwrap_or_default()
}

fn profile_to_save_config(profile: &ApiProfile) -> SaveClaudeCodeApiConfig {
    let env_model = resolve_profile_env_model(profile);
    SaveClaudeCodeApiConfig {
        base_url: profile.base_url.clone(),
        api_key: Some(profile.api_key.clone()),
        default_model: env_model.clone(),
        haiku_model: env_model.clone(),
        sonnet_model: env_model.clone(),
        opus_model: env_model,
        display_models: profile.display_models.clone(),
        custom_models: profile.custom_models.clone(),
    }
}

fn apply_save_config_to_settings(config: &SaveClaudeCodeApiConfig) -> Result<(), String> {
    let mut settings = read_claude_settings_json();
    let env_value = settings
        .as_object_mut()
        .map(|obj| {
            if !obj.contains_key("env") {
                obj.insert("env".to_string(), serde_json::json!({}));
            }
            obj.get_mut("env").unwrap()
        })
        .ok_or_else(|| "Invalid settings.json structure".to_string())?;

    let env = env_value
        .as_object_mut()
        .ok_or_else(|| "Invalid env section in settings.json".to_string())?;

    set_env_string(env, "ANTHROPIC_BASE_URL", &config.base_url);
    set_env_string(env, "ANTHROPIC_MODEL", &config.default_model);
    set_model_and_display_name(
        env,
        "ANTHROPIC_DEFAULT_HAIKU_MODEL",
        "ANTHROPIC_DEFAULT_HAIKU_MODEL_NAME",
        &config.haiku_model,
    );
    set_model_and_display_name(
        env,
        "ANTHROPIC_DEFAULT_SONNET_MODEL",
        "ANTHROPIC_DEFAULT_SONNET_MODEL_NAME",
        &config.sonnet_model,
    );
    set_model_and_display_name(
        env,
        "ANTHROPIC_DEFAULT_OPUS_MODEL",
        "ANTHROPIC_DEFAULT_OPUS_MODEL_NAME",
        &config.opus_model,
    );

    if let Some(api_key) = config.api_key.as_ref().filter(|key| !key.trim().is_empty()) {
        let trimmed = api_key.trim();
        env.insert(
            "ANTHROPIC_AUTH_TOKEN".to_string(),
            serde_json::Value::String(trimmed.to_string()),
        );
        if env.contains_key("ANTHROPIC_API_KEY") {
            env.insert(
                "ANTHROPIC_API_KEY".to_string(),
                serde_json::Value::String(trimmed.to_string()),
            );
        }
    }

    write_claude_settings_json(&settings)
}

fn build_api_profiles_state(store: &ApiProfilesStore) -> ApiProfilesState {
    ApiProfilesState {
        active_profile_id: store.active_profile_id.clone(),
        profiles: store
            .profiles
            .iter()
            .map(|profile| ApiProfileItem {
                id: profile.id.clone(),
                name: profile.name.clone(),
                base_url: profile.base_url.clone(),
                default_model: profile.default_model.clone(),
                has_api_key: !profile.api_key.trim().is_empty(),
                is_active: store.active_profile_id.as_deref() == Some(profile.id.as_str()),
            })
            .collect(),
        current: get_claude_api_config(),
    }
}

fn ensure_default_profile_from_live(store: &mut ApiProfilesStore) {
    if !store.profiles.is_empty() {
        return;
    }

    let settings = read_claude_settings_json();
    let env = settings
        .get("env")
        .and_then(|value| value.as_object())
        .cloned()
        .unwrap_or_default();
    let config = config_from_env(&env);
    if config.base_url.is_empty() && !config.has_api_key && config.default_model.is_empty() {
        return;
    }

    let now = chrono::Utc::now().timestamp();
    let profile = ApiProfile {
        id: uuid::Uuid::new_v4().to_string(),
        name: "默认配置".to_string(),
        base_url: config.base_url,
        api_key: claude_api_key_from_env(&env),
        default_model: config.default_model,
        haiku_model: config.haiku_model,
        sonnet_model: config.sonnet_model,
        opus_model: config.opus_model,
        display_models: Vec::new(),
        custom_models: Vec::new(),
        created_at: now,
        updated_at: now,
    };
    store.active_profile_id = Some(profile.id.clone());
    store.profiles.push(profile);
    let _ = save_api_profiles_store(store);
}

fn load_api_profiles_state() -> ApiProfilesState {
    let mut store = load_api_profiles_store();
    ensure_default_profile_from_live(&mut store);
    build_api_profiles_state(&store)
}

#[tauri::command]
fn get_api_profiles_state() -> ApiProfilesState {
    load_api_profiles_state()
}

#[tauri::command]
fn switch_api_profile(profile_id: String) -> Result<ApiProfilesState, String> {
    let mut store = load_api_profiles_store();
    let profile = store
        .profiles
        .iter()
        .find(|profile| profile.id == profile_id)
        .cloned()
        .ok_or_else(|| "API profile not found".to_string())?;

    apply_save_config_to_settings(&profile_to_save_config(&profile))?;
    store.active_profile_id = Some(profile_id);
    save_api_profiles_store(&store)?;
    Ok(build_api_profiles_state(&store))
}

/// 恢复官方默认：清除 settings.json 中自定义的 Anthropic API / 模型 env，
/// 让 Claude Code 回退到官方订阅（OAuth 登录），并取消激活的自定义配置。
#[tauri::command]
fn use_official_api() -> Result<ApiProfilesState, String> {
    const KEYS: &[&str] = &[
        "ANTHROPIC_BASE_URL",
        "ANTHROPIC_AUTH_TOKEN",
        "ANTHROPIC_API_KEY",
        "ANTHROPIC_MODEL",
        "ANTHROPIC_DEFAULT_HAIKU_MODEL",
        "ANTHROPIC_DEFAULT_SONNET_MODEL",
        "ANTHROPIC_DEFAULT_OPUS_MODEL",
        "ANTHROPIC_DEFAULT_HAIKU_MODEL_NAME",
        "ANTHROPIC_DEFAULT_SONNET_MODEL_NAME",
        "ANTHROPIC_DEFAULT_OPUS_MODEL_NAME",
    ];

    let mut settings = read_claude_settings_json();
    if let Some(env) = settings
        .get_mut("env")
        .and_then(|value| value.as_object_mut())
    {
        for key in KEYS {
            env.remove(*key);
        }
    }
    write_claude_settings_json(&settings)?;

    let mut store = load_api_profiles_store();
    store.active_profile_id = None;
    save_api_profiles_store(&store)?;
    Ok(build_api_profiles_state(&store))
}

#[tauri::command]
fn upsert_api_profile(
    profile_id: Option<String>,
    name: String,
    config: SaveClaudeCodeApiConfig,
    apply: bool,
) -> Result<ApiProfilesState, String> {
    let trimmed_name = name.trim();
    if trimmed_name.is_empty() {
        return Err("Profile name cannot be empty".to_string());
    }

    let mut store = load_api_profiles_store();
    let now = chrono::Utc::now().timestamp();

    let resolved_id = if let Some(id) = profile_id.filter(|value| !value.trim().is_empty()) {
        let profile = store
            .profiles
            .iter_mut()
            .find(|profile| profile.id == id)
            .ok_or_else(|| "API profile not found".to_string())?;

        profile.name = trimmed_name.to_string();
        profile.base_url = config.base_url.trim().to_string();
        profile.default_model.clear();
        profile.haiku_model.clear();
        profile.sonnet_model.clear();
        profile.opus_model.clear();
        profile.display_models = config
            .display_models
            .iter()
            .map(|model| model.trim().to_string())
            .filter(|model| !model.is_empty())
            .collect();
        profile.custom_models = config
            .custom_models
            .iter()
            .map(|model| model.trim().to_string())
            .filter(|model| !model.is_empty())
            .collect();
        profile.updated_at = now;

        if let Some(api_key) = config.api_key.filter(|key| !key.trim().is_empty()) {
            profile.api_key = api_key.trim().to_string();
        }

        profile.id.clone()
    } else {
        let api_key = config
            .api_key
            .filter(|key| !key.trim().is_empty())
            .unwrap_or_default();
        let profile = ApiProfile {
            id: uuid::Uuid::new_v4().to_string(),
            name: trimmed_name.to_string(),
            base_url: config.base_url.trim().to_string(),
            api_key: api_key.trim().to_string(),
            default_model: String::new(),
            haiku_model: String::new(),
            sonnet_model: String::new(),
            opus_model: String::new(),
            display_models: config
                .display_models
                .iter()
                .map(|model| model.trim().to_string())
                .filter(|model| !model.is_empty())
                .collect(),
            custom_models: config
                .custom_models
                .iter()
                .map(|model| model.trim().to_string())
                .filter(|model| !model.is_empty())
                .collect(),
            created_at: now,
            updated_at: now,
        };
        let id = profile.id.clone();
        store.profiles.push(profile);
        id
    };

    if apply {
        let profile = store
            .profiles
            .iter()
            .find(|profile| profile.id == resolved_id)
            .cloned()
            .ok_or_else(|| "API profile not found".to_string())?;
        apply_save_config_to_settings(&profile_to_save_config(&profile))?;
        store.active_profile_id = Some(resolved_id);
    }

    save_api_profiles_store(&store)?;
    Ok(build_api_profiles_state(&store))
}

#[tauri::command]
fn delete_api_profile(profile_id: String) -> Result<ApiProfilesState, String> {
    let mut store = load_api_profiles_store();

    if store.active_profile_id.as_deref() == Some(profile_id.as_str()) {
        return Err("Cannot delete the active API profile".to_string());
    }

    let before = store.profiles.len();
    store.profiles.retain(|profile| profile.id != profile_id);
    if store.profiles.len() == before {
        return Err("API profile not found".to_string());
    }

    save_api_profiles_store(&store)?;
    Ok(build_api_profiles_state(&store))
}

fn get_cc_switch_config_dir() -> PathBuf {
    if let Ok(dir) = std::env::var("CC_SWITCH_CONFIG_DIR") {
        let path = PathBuf::from(dir.trim());
        if path.is_dir() {
            return path;
        }
    }
    dirs::home_dir()
        .unwrap_or_else(|| PathBuf::from("."))
        .join(".cc-switch")
}

fn get_cc_switch_db_path() -> PathBuf {
    get_cc_switch_config_dir().join("cc-switch.db")
}

struct CcSwitchProviderRow {
    name: String,
    settings_config: String,
}

fn read_cc_switch_claude_providers() -> Result<Vec<CcSwitchProviderRow>, String> {
    let db_path = get_cc_switch_db_path();
    if !db_path.exists() {
        return Err(format!(
            "未找到 CC Switch 数据库：{}",
            db_path.display()
        ));
    }

    let conn = rusqlite::Connection::open(&db_path)
        .map_err(|e| format!("无法打开 CC Switch 数据库: {e}"))?;
    let mut stmt = conn
        .prepare(
            "SELECT name, settings_config
             FROM providers
             WHERE app_type = 'claude'
             ORDER BY sort_index ASC, created_at ASC",
        )
        .map_err(|e| format!("读取 CC Switch 配置失败: {e}"))?;

    let rows = stmt
        .query_map([], |row| {
            Ok(CcSwitchProviderRow {
                name: row.get(0)?,
                settings_config: row.get(1)?,
            })
        })
        .map_err(|e| format!("读取 CC Switch 配置失败: {e}"))?;

    let mut providers = Vec::new();
    for row in rows {
        providers.push(row.map_err(|e| format!("读取 CC Switch 配置失败: {e}"))?);
    }
    Ok(providers)
}

fn profile_from_cc_switch_row(name: &str, settings_config: &str, now: i64) -> Option<ApiProfile> {
    let config: serde_json::Value = serde_json::from_str(settings_config).ok()?;
    let env = config.get("env").and_then(|value| value.as_object())?;
    let api_config = config_from_env(env);
    if api_config.base_url.is_empty()
        && !api_config.has_api_key
        && api_config.default_model.is_empty()
    {
        return None;
    }

    Some(ApiProfile {
        id: uuid::Uuid::new_v4().to_string(),
        name: name.trim().to_string(),
        base_url: api_config.base_url,
        api_key: claude_api_key_from_env(env),
        default_model: api_config.default_model,
        haiku_model: api_config.haiku_model,
        sonnet_model: api_config.sonnet_model,
        opus_model: api_config.opus_model,
        display_models: Vec::new(),
        custom_models: Vec::new(),
        created_at: now,
        updated_at: now,
    })
}

fn is_duplicate_api_profile(store: &ApiProfilesStore, profile: &ApiProfile) -> bool {
    store.profiles.iter().any(|existing| {
        existing.name == profile.name
            || (existing.base_url == profile.base_url
                && !profile.api_key.is_empty()
                && existing.api_key == profile.api_key)
    })
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
struct CcSwitchImportResult {
    imported_count: usize,
    skipped_count: usize,
    skipped_names: Vec<String>,
    cc_switch_path: String,
    state: ApiProfilesState,
}

#[tauri::command]
fn import_cc_switch_profiles() -> Result<CcSwitchImportResult, String> {
    let cc_switch_path = get_cc_switch_db_path();
    let providers = read_cc_switch_claude_providers()?;
    if providers.is_empty() {
        return Err("CC Switch 中没有 Claude 配置可导入".to_string());
    }

    let mut store = load_api_profiles_store();
    ensure_default_profile_from_live(&mut store);

    let now = chrono::Utc::now().timestamp();
    let mut imported_count = 0usize;
    let mut skipped_count = 0usize;
    let mut skipped_names = Vec::new();

    for provider in providers {
        let Some(profile) = profile_from_cc_switch_row(&provider.name, &provider.settings_config, now)
        else {
            skipped_count += 1;
            skipped_names.push(format!("{}（配置为空）", provider.name));
            continue;
        };

        if is_duplicate_api_profile(&store, &profile) {
            skipped_count += 1;
            skipped_names.push(profile.name);
            continue;
        }

        store.profiles.push(profile);
        imported_count += 1;
    }

    // 全部已存在 / 无新增不算失败，照常返回结果，由前端给出友好提示
    save_api_profiles_store(&store)?;
    Ok(CcSwitchImportResult {
        imported_count,
        skipped_count,
        skipped_names,
        cc_switch_path: cc_switch_path.to_string_lossy().to_string(),
        state: build_api_profiles_state(&store),
    })
}

#[tauri::command]
fn get_api_profile_config(profile_id: String) -> Result<ClaudeCodeApiConfig, String> {
    let store = load_api_profiles_store();
    let profile = store
        .profiles
        .iter()
        .find(|profile| profile.id == profile_id)
        .ok_or_else(|| "API profile not found".to_string())?;
    Ok(config_from_profile(profile))
}

fn resolve_api_key_for_fetch(api_key: Option<String>, profile_id: Option<String>) -> Result<String, String> {
    if let Some(key) = api_key.filter(|value| !value.trim().is_empty()) {
        return Ok(key.trim().to_string());
    }

    if let Some(profile_id) = profile_id.filter(|value| !value.trim().is_empty()) {
        let store = load_api_profiles_store();
        let profile = store
            .profiles
            .iter()
            .find(|profile| profile.id == profile_id)
            .ok_or_else(|| "API profile not found".to_string())?;
        if !profile.api_key.trim().is_empty() {
            return Ok(profile.api_key.trim().to_string());
        }
    }

    let settings = read_claude_settings_json();
    let env = settings
        .get("env")
        .and_then(|value| value.as_object())
        .cloned()
        .unwrap_or_default();
    let key = claude_api_key_from_env(&env);
    if key.trim().is_empty() {
        return Err("拉取模型需要填写 API Key".to_string());
    }
    Ok(key)
}

#[tauri::command]
async fn fetch_api_models(
    base_url: String,
    api_key: Option<String>,
    profile_id: Option<String>,
) -> Result<Vec<model_fetch::FetchedModel>, String> {
    let trimmed_base_url = base_url.trim();
    if trimmed_base_url.is_empty() {
        return Err("Base URL 不能为空".to_string());
    }

    let resolved_key = resolve_api_key_for_fetch(api_key, profile_id)?;
    model_fetch::fetch_models(trimmed_base_url, &resolved_key).await
}

fn active_api_profile<'a>(store: &'a ApiProfilesStore) -> Option<&'a ApiProfile> {
    store
        .active_profile_id
        .as_ref()
        .and_then(|id| store.profiles.iter().find(|profile| profile.id == *id))
        .or_else(|| store.profiles.first())
}

#[tauri::command]
fn get_claude_api_config() -> ClaudeCodeApiConfig {
    let settings = read_claude_settings_json();
    let env = settings
        .get("env")
        .and_then(|value| value.as_object())
        .cloned()
        .unwrap_or_default();
    let mut config = config_from_env(&env);

    let store = load_api_profiles_store();
    if let Some(profile) = active_api_profile(&store) {
        config.display_models = profile.display_models.clone();
        config.custom_models = profile.custom_models.clone();
    }

    config
}

#[tauri::command]
fn save_claude_api_config(config: SaveClaudeCodeApiConfig) -> Result<ClaudeCodeApiConfig, String> {
    apply_save_config_to_settings(&config)?;
    Ok(get_claude_api_config())
}

#[derive(Debug, Serialize, Deserialize, Default)]
struct AppOverlay {
    deleted_session_ids: Vec<String>,
    #[serde(default)]
    title_overrides: HashMap<String, String>,
}

fn get_overlay_path() -> PathBuf {
    get_data_path().join("overlay.json")
}

fn load_overlay() -> AppOverlay {
    let path = get_overlay_path();
    if !path.exists() {
        return AppOverlay::default();
    }
    fs::read_to_string(&path)
        .ok()
        .and_then(|content| serde_json::from_str(&content).ok())
        .unwrap_or_default()
}

fn save_overlay(overlay: &AppOverlay) {
    let data_path = get_data_path();
    if !data_path.exists() {
        let _ = fs::create_dir_all(&data_path);
    }
    if let Ok(content) = serde_json::to_string_pretty(overlay) {
        let _ = fs::write(get_overlay_path(), content);
    }
}

fn mark_session_deleted(session_id: &str) {
    let mut overlay = load_overlay();
    if !overlay.deleted_session_ids.iter().any(|id| id == session_id) {
        overlay.deleted_session_ids.push(session_id.to_string());
        save_overlay(&overlay);
    }
}

#[allow(dead_code)]
fn is_deleted_session(session_id: &str) -> bool {
    load_overlay()
        .deleted_session_ids
        .iter()
        .any(|id| id == session_id)
}

#[allow(dead_code)]
fn get_title_override(session_id: &str) -> Option<String> {
    load_overlay().title_overrides.get(session_id).cloned()
}

fn set_title_override(session_id: &str, title: &str) {
    let mut overlay = load_overlay();
    overlay
        .title_overrides
        .insert(session_id.to_string(), title.to_string());
    save_overlay(&overlay);
}

#[allow(dead_code)]
fn apply_title_override(conv: &mut Conversation) {
    if let Some(title) = get_title_override(&conv.id) {
        conv.title = title;
    }
}

fn is_agent_session(path: &Path) -> bool {
    path.file_name()
        .and_then(|name| name.to_str())
        .map(|name| name.starts_with("agent-"))
        .unwrap_or(false)
}

// ── 会话解析缓存：按文件 mtime 缓存解析结果，避免每次点击全量重解析 ──────
static SESSION_CACHE: Mutex<Option<HashMap<PathBuf, (i64, Conversation)>>> = Mutex::new(None);

fn file_mtime_secs(path: &Path) -> i64 {
    fs::metadata(path)
        .and_then(|m| m.modified())
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

/// 解析会话文件，命中（路径 + mtime 未变）则直接复用缓存，避免重复读盘 + JSON 解析
fn parse_claude_session_cached(path: &PathBuf) -> Option<Conversation> {
    let mtime = file_mtime_secs(path);
    {
        let cache = SESSION_CACHE.lock().unwrap();
        if let Some(map) = cache.as_ref() {
            if let Some((cached_mtime, conv)) = map.get(path) {
                if *cached_mtime == mtime {
                    return Some(conv.clone());
                }
            }
        }
    }
    let conv = parse_claude_session(path)?;
    let mut cache = SESSION_CACHE.lock().unwrap();
    let map = cache.get_or_insert_with(HashMap::new);
    map.insert(path.clone(), (mtime, conv.clone()));
    Some(conv)
}

fn load_claude_history() -> Vec<Conversation> {
    let root = get_claude_history_path();
    if !root.exists() {
        return Vec::new();
    }

    let mut files = Vec::new();
    collect_jsonl_files(&root, &mut files);

    // overlay 只读一次，避免对每条会话各读盘解析两次（删除标记 + 标题覆盖）
    let overlay = load_overlay();
    let mut conversations = Vec::new();
    for path in files {
        if is_agent_session(&path) {
            continue;
        }
        if let Some(mut conv) = parse_claude_session_cached(&path) {
            if overlay.deleted_session_ids.iter().any(|id| id == &conv.id) {
                continue;
            }
            if let Some(title) = overlay.title_overrides.get(&conv.id) {
                conv.title = title.clone();
            }
            conversations.push(conv);
        }
    }

    conversations.sort_by(|a, b| b.updated_at.cmp(&a.updated_at));
    conversations
}

fn collect_jsonl_files(root: &PathBuf, files: &mut Vec<PathBuf>) {
    let entries = match std::fs::read_dir(root) {
        Ok(entries) => entries,
        Err(_) => return,
    };
    
    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_dir() {
            collect_jsonl_files(&path, files);
        } else if path.extension().and_then(|ext| ext.to_str()) == Some("jsonl") {
            files.push(path);
        }
    }
}

fn parse_claude_session(path: &PathBuf) -> Option<Conversation> {
    let content = match std::fs::read_to_string(path) {
        Ok(c) => c,
        Err(_) => return None,
    };
    
    let mut session_id: Option<String> = None;
    let mut messages = Vec::new();
    let mut first_user_message: Option<String> = None;
    let mut created_at: Option<i64> = None;
    let mut updated_at: Option<i64> = None;
    let mut custom_title: Option<String> = None;
    let mut project_dir: Option<String> = None;
    let mut last_context_tokens: Option<i64> = None;
    let mut last_model: Option<String> = None;

    for line in content.lines() {
        if line.trim().is_empty() {
            continue;
        }

        let value: serde_json::Value = match serde_json::from_str(line) {
            Ok(v) => v,
            Err(_) => continue,
        };

        if project_dir.is_none() {
            project_dir = value
                .get("cwd")
                .and_then(|c| c.as_str())
                .map(str::trim)
                .filter(|cwd| !cwd.is_empty())
                .map(|cwd| cwd.to_string());
        }

        if value.get("type").and_then(|t| t.as_str()) == Some("custom-title") {
            custom_title = value.get("customTitle").and_then(|t| t.as_str()).map(|s| s.to_string());
            continue;
        }

        if value.get("isMeta").and_then(|m| m.as_bool()) == Some(true) {
            continue;
        }

        // 跳过 /compact 压缩摘要与系统元信息条目：
        // Claude Code 把压缩摘要存成 isCompactSummary 的 user 消息，
        // 不处理会被显示成用户发出的消息。
        if value.get("isCompactSummary").and_then(|v| v.as_bool()) == Some(true) {
            continue;
        }
        if value.get("type").and_then(|t| t.as_str()) == Some("system") {
            continue;
        }

        if session_id.is_none() {
            session_id = value.get("sessionId").and_then(|s| s.as_str()).map(|s| s.to_string());
        }
        
        let ts = value.get("timestamp").and_then(|t| t.as_str()).and_then(parse_timestamp);
        if ts.is_some() {
            if created_at.is_none() {
                created_at = ts;
            }
            updated_at = ts;
        }
        
        // 处理 standalone thinking 类型消息
        if value.get("type").and_then(|t| t.as_str()) == Some("thinking") {
            if let Some(msg) = value.get("message") {
                let th_content = msg.get("content")
                    .and_then(|c| c.as_str())
                    .unwrap_or("")
                    .to_string();
                if !th_content.trim().is_empty() {
                    messages.push(Message {
                        id: uuid::Uuid::new_v4().to_string(),
                        role: "thinking".to_string(),
                        content: th_content,
                        thinking: None,
                        timestamp: ts.unwrap_or_default(),
                    });
                }
            }
            continue;
        }

        let message = value.get("message");
        if message.is_none() {
            continue;
        }

        let message = message.unwrap();

        // 捕获最近一轮 assistant 的上下文用量与实际模型（用户消息无此字段，自动跳过）
        if let Some(usage) = message.get("usage") {
            let field = |k: &str| usage.get(k).and_then(|v| v.as_i64()).unwrap_or(0);
            let ctx = field("input_tokens")
                + field("cache_creation_input_tokens")
                + field("cache_read_input_tokens");
            if ctx > 0 {
                last_context_tokens = Some(ctx);
            }
        }
        if let Some(model) = message.get("model").and_then(|m| m.as_str()) {
            if !model.trim().is_empty() {
                last_model = Some(model.to_string());
            }
        }

        let role = message.get("role").and_then(|r| r.as_str()).unwrap_or("unknown").to_string();
        let (content, thinking) = extract_text_and_thinking(message.get("content"));

        // 空消息跳过（但保留纯 thinking 的消息）
        if content.trim().is_empty() && thinking.is_none() {
            continue;
        }

        // 跳过内部消息（系统提醒、本地命令输出等）
        let trimmed = content.trim();
        if trimmed.starts_with("<system-reminder>")
            || trimmed.starts_with("<local-command-caveat>")
            || trimmed.starts_with("<command-name>")
            || trimmed.starts_with("<local-command-stdout>")
        {
            continue;
        }

        // 如果只有 thinking 没有文本，归类为 thinking 角色
        let effective_role = if content.trim().is_empty() && thinking.is_some() {
            "thinking".to_string()
        } else {
            role.clone()
        };

        if first_user_message.is_none() && role == "user" {
            if !content.contains("<local-command-caveat>") && !content.starts_with("<command-name>") {
                first_user_message = Some(content.clone());
            }
        }

        messages.push(Message {
            id: uuid::Uuid::new_v4().to_string(),
            role: effective_role,
            content,
            thinking,
            timestamp: ts.unwrap_or_default(),
        });
    }
    
    let session_id = session_id.or_else(|| {
        path.file_stem().and_then(|s| s.to_str()).map(|s| s.to_string())
    });
    
    let session_id = session_id?;
    
    let title = custom_title.or_else(|| {
        first_user_message.map(|t| {
            if t.len() > 50 {
                t.chars().take(50).collect::<String>() + "..."
            } else {
                t
            }
        })
    }).unwrap_or_else(|| "Untitled".to_string());

    let project_dir = project_dir.or_else(|| decode_project_dir_from_jsonl_path(path));
    
    Some(Conversation {
        id: session_id,
        title,
        messages,
        platform: "claude".to_string(),
        project_dir,
        source_path: Some(path.to_string_lossy().to_string()),
        created_at: created_at.unwrap_or_default(),
        updated_at: updated_at.unwrap_or_default(),
        context_tokens: last_context_tokens,
        last_model,
    })
}

/// 从 JSONL 文件所在目录名反推工作目录（Claude 编码规则：`/` → `-`，并以 `-` 开头）
fn decode_project_dir_from_jsonl_path(path: &PathBuf) -> Option<String> {
    let encoded = path
        .parent()
        .and_then(|p| p.file_name())
        .and_then(|name| name.to_str())?;

    if !encoded.starts_with('-') {
        return None;
    }

    let decoded = encoded.replace('-', "/");
    if decoded == "/" {
        Some("/".to_string())
    } else if decoded.is_empty() {
        None
    } else {
        Some(decoded)
    }
}

// 从 content 中提取文本和思考内容
// tool_use 和 tool_result 不提取为可见文本（它们是内部工具调用细节）
// 返回 (纯文本, 思考内容)
fn extract_text_and_thinking(content: Option<&serde_json::Value>) -> (String, Option<String>) {
    match content {
        Some(serde_json::Value::String(s)) => (s.clone(), None),
        Some(serde_json::Value::Array(items)) => {
            let mut texts = Vec::new();
            let mut thinking_parts = Vec::new();
            for item in items {
                let t = item.get("type").and_then(|t| t.as_str());
                match t {
                    Some("text") => {
                        if let Some(text) = item.get("text").and_then(|t| t.as_str()) {
                            texts.push(text.to_string());
                        }
                    }
                    Some("thinking") => {
                        if let Some(th) = item.get("thinking").and_then(|t| t.as_str()) {
                            thinking_parts.push(th.to_string());
                        }
                    }
                    // tool_use 和 tool_result 跳过——不对用户显示内部工具调用细节
                    _ => {}
                }
            }
            let text = texts.join("\n");
            let thinking = if thinking_parts.is_empty() {
                None
            } else {
                Some(thinking_parts.join("\n"))
            };
            (text, thinking)
        }
        _ => (String::new(), None),
    }
}

// 兼容旧代码：只提取纯文本
#[allow(dead_code)]
fn extract_text(content: Option<&serde_json::Value>) -> String {
    extract_text_and_thinking(content).0
}

fn parse_timestamp(iso_string: &str) -> Option<i64> {
    if let Ok(dt) = chrono::DateTime::parse_from_rfc3339(iso_string) {
        Some(dt.timestamp())
    } else {
        None
    }
}

fn detect_os() -> String {
    std::env::consts::OS.to_string()
}

fn load_persisted_state() -> AppState {
    let path = get_data_path().join("state.json");
    if path.exists() {
        match fs::read_to_string(&path) {
            Ok(content) => {
                let mut state: AppState =
                    serde_json::from_str(&content).unwrap_or_else(|_| get_default_state());
                state.current_platform = detect_os();
                state
            }
            Err(_) => get_default_state(),
        }
    } else {
        get_default_state()
    }
}

fn load_app_state() -> AppState {
    let claude_history = load_claude_history();
    let os = detect_os();

    if !claude_history.is_empty() {
        AppState {
            conversations: claude_history,
            platforms: get_default_platforms(),
            active_platform: "claude".to_string(),
            current_platform: os,
        }
    } else {
        load_persisted_state()
    }
}

fn get_default_state() -> AppState {
    let mut conversations = Vec::new();
    
    let now = chrono::Utc::now().timestamp();
    let hour_ago = now - 3600;
    let two_hours_ago = now - 7200;
    
    conversations.push(Conversation {
        id: "session-1".to_string(),
        title: "如何学习 Rust".to_string(),
        messages: vec![
            Message {
                id: "msg-1".to_string(),
                role: "user".to_string(),
                content: "告诉我如何学习 Rust 编程语言".to_string(),
                thinking: None,
                timestamp: two_hours_ago,
            },
            Message {
                id: "msg-2".to_string(),
                role: "assistant".to_string(),
                content: "学习 Rust 的最佳方式：\n1. 阅读官方文档 \"The Rust Programming Language\"\n2. 完成 Rustlings 练习\n3. 构建小项目\n4. 参与开源项目".to_string(),
                thinking: None,
                timestamp: two_hours_ago + 1,
            },
        ],
        platform: "claude".to_string(),
        project_dir: None,
        source_path: None,
        created_at: two_hours_ago,
        updated_at: two_hours_ago + 1,
        context_tokens: None,
        last_model: None,
    });
    
    conversations.push(Conversation {
        id: "session-2".to_string(),
        title: "前端性能优化".to_string(),
        messages: vec![
            Message {
                id: "msg-3".to_string(),
                role: "user".to_string(),
                content: "前端性能优化有哪些方法？".to_string(),
                thinking: None,
                timestamp: hour_ago,
            },
            Message {
                id: "msg-4".to_string(),
                role: "assistant".to_string(),
                content: "前端性能优化技巧：\n- 代码分割和懒加载\n- 图片优化（WebP/AVIF）\n- 缓存策略\n- CDN 加速\n- 减少重绘重排".to_string(),
                thinking: None,
                timestamp: hour_ago + 1,
            },
        ],
        platform: "claude".to_string(),
        project_dir: None,
        source_path: None,
        created_at: hour_ago,
        updated_at: hour_ago + 1,
        context_tokens: None,
        last_model: None,
    });
    
    conversations.push(Conversation {
        id: "session-3".to_string(),
        title: "Tauri 框架介绍".to_string(),
        messages: vec![
            Message {
                id: "msg-5".to_string(),
                role: "user".to_string(),
                content: "什么是 Tauri 框架？".to_string(),
                thinking: None,
                timestamp: now - 300,
            },
            Message {
                id: "msg-6".to_string(),
                role: "assistant".to_string(),
                content: "Tauri 是一个用于构建跨平台桌面应用的框架，使用 Rust 作为后端，前端可以使用任何 Web 技术。相比 Electron，Tauri 应用体积更小、性能更好。".to_string(),
                thinking: None,
                timestamp: now - 299,
            },
        ],
        platform: "claude".to_string(),
        project_dir: None,
        source_path: None,
        created_at: now - 300,
        updated_at: now - 299,
        context_tokens: None,
        last_model: None,
    });
    
    AppState {
        conversations,
        platforms: get_default_platforms(),
        active_platform: "claude".to_string(),
        current_platform: detect_os(),
    }
}

fn save_app_state(state: &AppState) {
    let data_path = get_data_path();
    if !data_path.exists() {
        let _ = fs::create_dir_all(&data_path);
    }
    let path = data_path.join("state.json");
    if let Ok(content) = serde_json::to_string_pretty(state) {
        let _ = fs::write(path, content);
    }
}

fn get_default_platforms() -> HashMap<String, PlatformConfig> {
    let mut platforms = HashMap::new();
    
    platforms.insert(
        "claude".to_string(),
        PlatformConfig {
            name: "Claude".to_string(),
            command: "claude".to_string(),
            args: vec!["chat".to_string()],
            env_vars: HashMap::new(),
        },
    );
    
    platforms
}

#[derive(Debug, Serialize, Deserialize, Clone)]
struct SessionEventPayload {
    conversation_id: String,
    title: String,
    messages: Vec<Message>,
    project_dir: Option<String>,
    updated_at: i64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    context_tokens: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    last_model: Option<String>,
}

/// 流式消息块，参考 claudecodeui 的 NormalizedMessage.kind
#[derive(Debug, Serialize, Deserialize, Clone)]
struct MessageChunkPayload {
    conversation_id: String,
    kind: String,
    content: String,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
struct SessionErrorPayload {
    conversation_id: Option<String>,
    error: String,
}

enum StreamOutcome {
    Success(Option<String>),
    Failed {
        session_id: Option<String>,
        error: String,
    },
}

fn emit_message_chunk(app: &AppHandle, conversation_id: &str, kind: &str, content: &str) {
    let payload = MessageChunkPayload {
        conversation_id: conversation_id.to_string(),
        kind: kind.to_string(),
        content: content.to_string(),
    };
    let _ = app.emit("message-chunk", &payload);
}

fn emit_session_error(app: &AppHandle, conversation_id: Option<&str>, error: &str) {
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

fn is_api_error_text(text: &str) -> bool {
    let trimmed = text.trim();
    trimmed.starts_with("API Error:")
        || trimmed.starts_with("Error:")
        || trimmed.contains("authentication_error")
        || trimmed.contains("rate_limit_error")
        || trimmed.contains("overloaded_error")
}

fn extract_result_error(value: &serde_json::Value) -> String {
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

fn extract_top_level_error(value: &serde_json::Value) -> Option<String> {
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

fn extract_assistant_text(value: &serde_json::Value) -> Option<String> {
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

fn record_stream_error(
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

fn resolve_stream_session_id(
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

/// 解析 claude --output-format stream-json 的 NDJSON 行
fn process_claude_stream_line(
    line: &str,
    app: &AppHandle,
    captured_session_id: &mut Option<String>,
    block_types: &mut HashMap<usize, String>,
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
                                        emit_message_chunk(app, &sid, "text_delta", text);
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
                        Some("text") => "text_end",
                        _ => return,
                    };
                    emit_message_chunk(app, &sid, kind, "");
                    block_types.remove(&index);
                }
                "message_stop" => {
                    emit_message_chunk(app, &sid, "stream_end", "");
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
            let sid = resolve_stream_session_id(captured_session_id, &value);
            if value.get("is_error").and_then(|v| v.as_bool()) == Some(true) {
                let error = extract_result_error(&value);
                record_stream_error(stream_error, app, sid.as_deref(), error);
                return;
            }
            if let Some(sid) = sid {
                emit_message_chunk(app, &sid, "complete", "");
            }
        }
        _ => {}
    }
}

/// macOS GUI 应用从 Finder 启动时 PATH 很窄，通常找不到 /usr/local/bin/claude。
fn extended_path_for_cli() -> String {
    let home = dirs::home_dir().unwrap_or_else(|| PathBuf::from("."));

    #[cfg(target_os = "windows")]
    let separator = ";";
    #[cfg(not(target_os = "windows"))]
    let separator = ":";

    let mut segments: Vec<PathBuf> = if cfg!(target_os = "windows") {
        vec![
            // npm 全局路径（Windows）
            home.join("AppData").join("Roaming").join("npm"),
            home.join("AppData").join("Local").join("Programs").join("nodejs"),
            PathBuf::from("C:\\Program Files\\nodejs"),
        ]
    } else {
        vec![
            PathBuf::from("/usr/local/bin"),
            PathBuf::from("/opt/homebrew/bin"),
            home.join(".local/bin"),
            home.join(".npm-global/bin"),
            home.join("bin"),
        ]
    };

    if let Ok(existing) = std::env::var("PATH") {
        for part in existing.split(separator).filter(|s| !s.is_empty()) {
            segments.push(PathBuf::from(part));
        }
    }

    #[cfg(not(target_os = "windows"))]
    {
        segments.extend([
            PathBuf::from("/usr/bin"),
            PathBuf::from("/bin"),
            PathBuf::from("/usr/sbin"),
            PathBuf::from("/sbin"),
        ]);
    }

    let mut seen = HashSet::new();
    segments
        .into_iter()
        .map(|p| p.to_string_lossy().to_string())
        .filter(|p| seen.insert(p.clone()))
        .collect::<Vec<_>>()
        .join(separator)
}

fn resolve_claude_executable() -> PathBuf {
    let home = dirs::home_dir().unwrap_or_else(|| PathBuf::from("."));
    let mut candidates = vec![
        PathBuf::from("/usr/local/bin/claude"),
        PathBuf::from("/opt/homebrew/bin/claude"),
        home.join(".local/bin/claude"),
        home.join(".npm-global/bin/claude"),
        home.join("bin/claude"),
    ];

    #[cfg(target_os = "windows")]
    {
        candidates.extend([
            home.join(".claude/bin/claude.exe"),
            // npm 全局安装路径 (npm install -g @anthropic-ai/claude-code)
            home.join("AppData/Roaming/npm/claude.cmd"),
            home.join("AppData/Roaming/npm/claude.exe"),
            PathBuf::from("C:\\Program Files\\Claude\\claude.exe"),
            PathBuf::from("C:\\Program Files (x86)\\Claude\\claude.exe"),
            dirs::data_local_dir().unwrap_or_default().join("claude/bin/claude.exe"),
            dirs::data_dir().unwrap_or_default().join("claude/bin/claude.exe"),
        ]);
    }

    #[cfg(unix)]
    {
        if let Ok(output) = Command::new("/bin/zsh")
            .args(["-l", "-c", "command -v claude"])
            .output()
        {
            if output.status.success() {
                let path = String::from_utf8_lossy(&output.stdout).trim().to_string();
                if !path.is_empty() {
                    candidates.insert(0, PathBuf::from(path));
                }
            }
        }
    }

    for candidate in candidates {
        if candidate.is_file() {
            return candidate;
        }
    }

    #[cfg(target_os = "windows")]
    {
        // 优先尝试不带扩展名的命令（PowerShell 会自动查找 .ps1）
        PathBuf::from("claude")
    }
    #[cfg(not(target_os = "windows"))]
    {
        PathBuf::from("claude")
    }
}

fn apply_cli_runtime_env(cmd: &mut Command) {
    cmd.env("PATH", extended_path_for_cli());
    if let Some(home) = dirs::home_dir() {
        cmd.env("HOME", home);
    }
    if let Ok(user) = std::env::var("USER") {
        cmd.env("USER", user);
    } else if let Ok(logname) = std::env::var("LOGNAME") {
        cmd.env("USER", logname);
    }
}

/// 使用 stream-json 模式启动 claude，实时推送 thinking / answer 增量
fn spawn_claude_stream(
    app: AppHandle,
    prompt: &str,
    conversation_id: Option<&String>,
    project_dir: Option<&String>,
    model: Option<&str>,
) -> std::io::Result<StreamOutcome> {
    const REQUEST_TIMEOUT: Duration = Duration::from_secs(7200); // 2 小时（Claude Code 复杂任务可能非常久，参考 claudecodeui 不设总超时）
    const IDLE_TIMEOUT: Duration = Duration::from_secs(600);      // 10 分钟（工具执行期间可能长时间无输出）

    #[cfg(target_os = "windows")]
    use std::os::windows::process::CommandExt;

    let mut args = vec![
        "-p".to_string(),
        "--verbose".to_string(),
        "--output-format".to_string(),
        "stream-json".to_string(),
        "--include-partial-messages".to_string(),
        "--dangerously-skip-permissions".to_string(),
    ];

    if let Some(cid) = conversation_id.filter(|c| !c.is_empty()) {
        args.push("--resume".to_string());
        args.push(cid.clone());
    }
    // "default" 视为订阅默认（不显式指定模型）；其余通过原生 --model 传递
    let effective_model = model
        .map(|value| value.trim())
        .filter(|value| !value.is_empty() && *value != "default");
    if let Some(model) = effective_model {
        args.push("--model".to_string());
        args.push(model.to_string());
    }
    // prompt 通过 stdin 传递，不作为命令行参数。
    // Windows 上 claude.cmd 是批处理文件，通过 cmd.exe /c 执行，
    // 如果 prompt 包含代码（引号、管道符、& 等特殊字符），
    // cmd.exe 会解析这些字符导致 "batch file arguments are invalid" 错误。
    // 使用 stdin 可以完全避免 shell 转义问题。

    let effective_cwd = project_dir.and_then(|cwd| resolve_or_create_dir(cwd));

    let claude_bin = resolve_claude_executable();
    let mut cmd = Command::new(&claude_bin);
    cmd.args(&args);
    apply_cli_runtime_env(&mut cmd);
    // env 覆盖仅用于第三方中转（强制各档模型一致）；官方订阅靠 --model，避免污染后台任务模型
    if let Some(model) = effective_model {
        if has_custom_api_base() {
            apply_model_override_env(&mut cmd, model);
        }
    }
    #[cfg(target_os = "windows")]
    {
        cmd.creation_flags(0x08000000);
    }
    if let Some(ref cwd) = effective_cwd {
        cmd.current_dir(cwd);
    }
    cmd.stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());

    eprintln!("[spawn_stream] {:?} {} (prompt via stdin, {} bytes)", claude_bin, args.join(" "), prompt.len());
    eprintln!("[spawn_stream] cwd: {:?}", effective_cwd);

    let mut child = cmd.spawn()?;

    // 通过 stdin 写入 prompt，然后立即关闭 stdin（Drop），告知 CLI 输入结束
    if let Some(mut stdin) = child.stdin.take() {
        use std::io::Write;
        stdin.write_all(prompt.as_bytes()).ok();
        stdin.flush().ok();
        // stdin 在此 drop，子进程收到 EOF
    }

    let stdout = child.stdout.take().expect("stdout should be piped");
    let stderr = child.stderr.take();

    // 将子进程注册到全局注册表，支持外部 abort
    let child_arc = Arc::new(Mutex::new(child));
    let registry_key = conversation_id
        .filter(|c| !c.is_empty())
        .cloned()
        .unwrap_or_else(|| format!("pending-{}", Instant::now().elapsed().as_nanos()));
    register_active_process(&registry_key, Arc::clone(&child_arc));

    let mut captured_session_id = conversation_id.filter(|c| !c.is_empty()).cloned();
    let mut captured_registry_key = registry_key.clone();
    let mut block_types: HashMap<usize, String> = HashMap::new();
    let mut stream_error: Option<String> = None;

    let stderr_buffer = Arc::new(Mutex::new(String::new()));
    if let Some(stderr) = stderr {
        let stderr_buffer = Arc::clone(&stderr_buffer);
        thread::spawn(move || {
            let content = BufReader::new(stderr)
                .lines()
                .filter_map(|line| line.ok())
                .collect::<Vec<_>>()
                .join("\n");
            if let Ok(mut guard) = stderr_buffer.lock() {
                *guard = content;
            }
        });
    }

    let (line_tx, line_rx) = mpsc::channel();
    thread::spawn(move || {
        for line in BufReader::new(stdout).lines() {
            match line {
                Ok(value) => {
                    if line_tx.send(Ok(value)).is_err() {
                        break;
                    }
                }
                Err(err) => {
                    let _ = line_tx.send(Err(err));
                    break;
                }
            }
        }
    });

    let started = Instant::now();
    let mut last_activity = Instant::now();
    let mut stdout_finished = false;

    while !stdout_finished {
        match line_rx.recv_timeout(Duration::from_secs(1)) {
            Ok(Ok(line)) => {
                last_activity = Instant::now();
                if line.trim().is_empty() {
                    continue;
                }
                process_claude_stream_line(
                    &line,
                    &app,
                    &mut captured_session_id,
                    &mut block_types,
                    &mut stream_error,
                );
                // 首次捕获到 session_id 时，用 session_id 重新注册进程（方便按 session_id abort）
                if let Some(ref sid) = captured_session_id {
                    if *sid != captured_registry_key {
                        unregister_active_process(&captured_registry_key);
                        register_active_process(sid, Arc::clone(&child_arc));
                        captured_registry_key = sid.clone();
                    }
                }
                if stream_error.is_some() {
                    if let Ok(mut c) = child_arc.lock() { kill_process_tree(&mut c); }
                    break;
                }
            }
            Ok(Err(_err)) => {
                // stdout 管道断裂（可能是进程被 abort kill），检查是否为用户终止
                let was_aborted = is_session_aborted(&captured_registry_key)
                    || captured_session_id.as_ref().is_some_and(|sid| is_session_aborted(sid));
                if was_aborted {
                    eprintln!("[claude] stdout 管道断裂（用户 abort），正常退出");
                    stdout_finished = true;
                    continue;
                }
                // 非 abort 情况，让后续 child.wait() 处理
                stdout_finished = true;
                continue;
            }
            Err(RecvTimeoutError::Timeout) => {
                let child_exited = child_arc.lock().ok()
                    .and_then(|mut c| c.try_wait().ok().flatten())
                    .is_some();
                if child_exited {
                    stdout_finished = true;
                    continue;
                }

                let elapsed = started.elapsed();
                let idle = last_activity.elapsed();
                if elapsed >= REQUEST_TIMEOUT || idle >= IDLE_TIMEOUT {
                    if let Ok(mut c) = child_arc.lock() { kill_process_tree(&mut c); }
                    let timeout_msg = if elapsed >= REQUEST_TIMEOUT {
                        format!(
                            "请求超时：模型在 {} 秒内未完成响应",
                            REQUEST_TIMEOUT.as_secs()
                        )
                    } else {
                        format!(
                            "请求超时：{} 秒内未收到任何响应，请检查 API 地址、密钥和网络连接",
                            IDLE_TIMEOUT.as_secs()
                        )
                    };
                    emit_session_error(
                        &app,
                        captured_session_id.as_deref(),
                        &timeout_msg,
                    );
                    if let Ok(mut c) = child_arc.lock() { let _ = c.wait(); }
                    unregister_active_process(&captured_registry_key);
                    return Ok(StreamOutcome::Failed {
                        session_id: captured_session_id,
                        error: timeout_msg,
                    });
                }
            }
            Err(RecvTimeoutError::Disconnected) => {
                stdout_finished = true;
            }
        }
    }

    while let Ok(Ok(line)) = line_rx.try_recv() {
        if line.trim().is_empty() {
            continue;
        }
        process_claude_stream_line(
            &line,
            &app,
            &mut captured_session_id,
            &mut block_types,
            &mut stream_error,
        );
    }

    let stderr_content = stderr_buffer
        .lock()
        .map(|guard| guard.clone())
        .unwrap_or_default();
    if !stderr_content.trim().is_empty() {
        eprintln!("[claude stderr]\n{}", stderr_content);
    }

    let status = match child_arc.lock() {
        Ok(mut c) => c.wait()?,
        Err(poisoned) => {
            eprintln!("[claude] mutex poisoned, recovering...");
            let mut c = poisoned.into_inner();
            c.wait()?
        }
    };
    eprintln!("[claude] 退出码: {}", status);

    // 从注册表中移除
    unregister_active_process(&captured_registry_key);

    if let Some(error) = stream_error {
        // 用户主动终止时，stream 解析错误不视为失败
        let was_aborted = is_session_aborted(&captured_registry_key)
            || captured_session_id.as_ref().is_some_and(|sid| is_session_aborted(sid));
        if was_aborted {
            clear_session_aborted(&captured_registry_key);
            if let Some(ref sid) = captured_session_id { clear_session_aborted(sid); }
            eprintln!("[claude] 用户主动终止，忽略 stream error: {}", error);
            return Ok(StreamOutcome::Success(captured_session_id));
        }
        return Ok(StreamOutcome::Failed {
            session_id: captured_session_id,
            error,
        });
    }

    if !status.success() {
        // 检查是否是用户主动终止（abort），如果是则视为正常结束，不显示错误
        let was_aborted = is_session_aborted(&captured_registry_key)
            || captured_session_id.as_ref().is_some_and(|sid| is_session_aborted(sid));
        // 清理 abort 标记
        clear_session_aborted(&captured_registry_key);
        if let Some(ref sid) = captured_session_id {
            clear_session_aborted(sid);
        }

        if was_aborted {
            eprintln!("[claude] 用户主动终止，不视为错误");
            return Ok(StreamOutcome::Success(captured_session_id));
        }

        let error_msg = if !stderr_content.trim().is_empty() {
            stderr_content.trim().to_string()
        } else {
            format!("Claude 通用异常退出（收到 exit code: {}）", status)
        };
        emit_session_error(
            &app,
            captured_session_id.as_deref(),
            &error_msg,
        );
        return Ok(StreamOutcome::Failed {
            session_id: captured_session_id,
            error: error_msg,
        });
    }

    Ok(StreamOutcome::Success(captured_session_id))
}

#[tauri::command]
fn get_conversations() -> Vec<Conversation> {
    let state = load_app_state();
    state.conversations
}

#[tauri::command]
fn get_platforms() -> HashMap<String, PlatformConfig> {
    // 平台列表与历史无关：只读持久化状态，避免触发全量历史解析
    let persisted = load_persisted_state();
    if persisted.platforms.is_empty() {
        get_default_platforms()
    } else {
        persisted.platforms
    }
}

#[tauri::command]
fn get_active_platform() -> String {
    let persisted = load_persisted_state();
    if persisted.active_platform.is_empty() {
        "claude".to_string()
    } else {
        persisted.active_platform
    }
}

#[tauri::command]
fn get_current_platform() -> String {
    detect_os()
}

#[tauri::command]
fn set_active_platform(platform_id: String) {
    let mut state = load_app_state();
    if state.platforms.contains_key(&platform_id) {
        state.active_platform = platform_id;
        save_app_state(&state);
    }
}

#[tauri::command]
fn add_platform(id: String, name: String, command: String, args: Vec<String>) {
    let mut state = load_app_state();
    state.platforms.insert(
        id,
        PlatformConfig {
            name,
            command,
            args,
            env_vars: HashMap::new(),
        },
    );
    save_app_state(&state);
}

#[tauri::command]
fn delete_conversation(conversation_id: String, source_path: Option<String>) -> Result<bool, String> {
    let mut delete_error: Option<String> = None;

    let resolved_path = if let Some(path) = source_path.filter(|p| !p.trim().is_empty()) {
        match validate_claude_source_path(Path::new(&path)) {
            Ok(path) => Some(path),
            Err(err) => {
                delete_error = Some(err);
                find_claude_session_file(&conversation_id)
            }
        }
    } else {
        find_claude_session_file(&conversation_id)
    };

    if let Some(path) = resolved_path {
        if let Err(err) = delete_claude_session_file(&path, &conversation_id) {
            delete_error = Some(err);
        }
    }

    mark_session_deleted(&conversation_id);

    let mut state = load_persisted_state();
    let before = state.conversations.len();
    state.conversations.retain(|c| c.id != conversation_id);
    if state.conversations.len() != before {
        save_app_state(&state);
    }

    if let Some(err) = delete_error {
        eprintln!("[delete] session hidden but file delete failed: {err}");
    }

    Ok(true)
}

fn read_claude_session_id_from_file(path: &Path) -> Option<String> {
    if let Some(stem) = path.file_stem().and_then(|s| s.to_str()) {
        if !stem.is_empty() {
            return Some(stem.to_string());
        }
    }

    let file = fs::File::open(path).ok()?;
    let reader = BufReader::new(file);
    for line in reader.lines().take(20) {
        let line = line.ok()?;
        if line.trim().is_empty() {
            continue;
        }
        let value: serde_json::Value = serde_json::from_str(&line).ok()?;
        if let Some(session_id) = value.get("sessionId").and_then(|s| s.as_str()) {
            return Some(session_id.to_string());
        }
    }
    None
}

fn session_id_matches_path(session_id: &str, path: &Path) -> bool {
    if path
        .file_stem()
        .and_then(|stem| stem.to_str())
        .is_some_and(|stem| stem == session_id)
    {
        return true;
    }

    read_claude_session_id_from_file(path)
        .is_some_and(|id| id == session_id)
}

fn delete_claude_session_file(path: &Path, session_id: &str) -> Result<(), String> {
    if !path.exists() {
        return Ok(());
    }

    if !session_id_matches_path(session_id, path) {
        return Err(format!(
            "Session ID mismatch for file {}",
            path.display()
        ));
    }

    if let Some(stem) = path.file_stem() {
        let sibling = path.parent().unwrap_or_else(|| Path::new("")).join(stem);
        remove_path_if_exists(&sibling).map_err(|e| {
            format!(
                "Failed to delete Claude session sidecar {}: {e}",
                sibling.display()
            )
        })?;
    }

    fs::remove_file(path).map_err(|e| {
        format!(
            "Failed to delete Claude session file {}: {e}",
            path.display()
        )
    })?;

    Ok(())
}

fn validate_claude_source_path(source_path: &Path) -> Result<PathBuf, String> {
    let root = get_claude_history_path();
    if !root.exists() {
        return Err("Claude history directory not found".to_string());
    }

    let canonical_root = fs::canonicalize(&root)
        .map_err(|e| format!("Failed to resolve Claude history root: {e}"))?;
    let canonical_source = fs::canonicalize(source_path)
        .map_err(|e| format!("Session file not found: {e}"))?;

    if !canonical_source.starts_with(&canonical_root) {
        return Err("Session path is outside Claude history directory".to_string());
    }

    if canonical_source.extension().and_then(|ext| ext.to_str()) != Some("jsonl") {
        return Err("Session source must be a .jsonl file".to_string());
    }

    Ok(canonical_source)
}

fn find_claude_session_file(session_id: &str) -> Option<PathBuf> {
    let root = get_claude_history_path();
    if !root.exists() {
        return None;
    }

    let mut files = Vec::new();
    collect_jsonl_files(&root, &mut files);

    for path in &files {
        if is_agent_session(path) {
            continue;
        }
        if path
            .file_stem()
            .and_then(|stem| stem.to_str())
            .is_some_and(|stem| stem == session_id)
        {
            return Some(path.clone());
        }
    }

    for path in files {
        if is_agent_session(&path) {
            continue;
        }
        if let Some(conv) = parse_claude_session(&path) {
            if conv.id == session_id {
                return Some(path);
            }
        }
    }

    None
}

/// 修改 JSONL 会话文件中所有 assistant 消息的 model 字段为新模型。
/// 这样 CLI --resume 恢复会话时，对话历史中的模型名称与当前选择一致，
/// 避免模型看到历史中的旧模型名而产生自我认知混乱。
fn rewrite_session_model(session_id: &str, new_model: &str) -> Result<bool, String> {
    let path = find_claude_session_file(session_id)
        .ok_or_else(|| format!("Session file not found for {}", session_id))?;

    let content = std::fs::read_to_string(&path)
        .map_err(|e| format!("Failed to read session file: {}", e))?;

    let mut modified = false;
    let mut new_lines = Vec::new();

    for line in content.lines() {
        if line.trim().is_empty() {
            new_lines.push(line.to_string());
            continue;
        }

        match serde_json::from_str::<serde_json::Value>(line) {
            Ok(mut value) => {
                // 检查是否为 assistant 消息且包含 model 字段
                let is_assistant = value
                    .get("message")
                    .and_then(|m| m.get("role"))
                    .and_then(|r| r.as_str())
                    == Some("assistant");

                if is_assistant {
                    if let Some(msg) = value.get_mut("message") {
                        if let Some(obj) = msg.as_object_mut() {
                            if let Some(current_model) = obj.get("model").and_then(|m| m.as_str())
                            {
                                if current_model != new_model {
                                    obj.insert(
                                        "model".to_string(),
                                        serde_json::Value::String(new_model.to_string()),
                                    );
                                    modified = true;
                                }
                            }
                        }
                    }
                }

                new_lines.push(serde_json::to_string(&value).unwrap_or_else(|_| line.to_string()));
            }
            Err(_) => {
                // 无法解析的行保持原样
                new_lines.push(line.to_string());
            }
        }
    }

    if modified {
        let new_content = new_lines.join("\n");
        std::fs::write(&path, new_content)
            .map_err(|e| format!("Failed to write session file: {}", e))?;
        eprintln!(
            "[rewrite_session_model] Updated model to '{}' in {}",
            new_model,
            path.display()
        );
    }

    Ok(modified)
}

fn remove_path_if_exists(path: &Path) -> std::io::Result<()> {
    match fs::metadata(path) {
        Ok(meta) => {
            if meta.is_dir() {
                fs::remove_dir_all(path)
            } else {
                fs::remove_file(path)
            }
        }
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(err) => Err(err),
    }
}

#[tauri::command]
fn get_conversation(conversation_id: String) -> Option<Conversation> {
    // 只定位并解析目标会话文件，不再全量扫描解析整个历史目录
    if let Some(path) = find_claude_session_file(&conversation_id) {
        if let Some(mut conv) = parse_claude_session_cached(&path) {
            let overlay = load_overlay();
            if overlay.deleted_session_ids.iter().any(|id| id == &conv.id) {
                return None;
            }
            if let Some(title) = overlay.title_overrides.get(&conv.id) {
                conv.title = title.clone();
            }
            return Some(conv);
        }
    }
    // 回退：非 claude 历史的持久化会话
    load_persisted_state()
        .conversations
        .into_iter()
        .find(|c| c.id == conversation_id)
}

#[tauri::command]
fn update_conversation_title(
    conversation_id: String,
    title: String,
    source_path: Option<String>,
) -> Result<Conversation, String> {
    let trimmed = title.trim().to_string();
    if trimmed.is_empty() {
        return Err("Title cannot be empty".to_string());
    }

    let resolved_path = if let Some(path) = source_path.filter(|p| !p.trim().is_empty()) {
        match validate_claude_source_path(Path::new(&path)) {
            Ok(path) => Some(path),
            Err(_) => find_claude_session_file(&conversation_id),
        }
    } else {
        find_claude_session_file(&conversation_id)
    };

    let session_path = resolved_path.or_else(|| find_claude_session_file(&conversation_id));

    if let Some(path) = &session_path {
        if let Err(err) = write_claude_custom_title(path, &conversation_id, &trimmed) {
            eprintln!("[title] failed to write custom-title to {}: {err}", path.display());
        }
    }

    set_title_override(&conversation_id, &trimmed);

    if let Some(path) = session_path.clone() {
        if let Some(mut conv) = parse_claude_session(&path) {
            conv.title = trimmed.clone();
            return Ok(conv);
        }
    }

    let mut state = load_persisted_state();
    if let Some(c) = state.conversations.iter_mut().find(|c| c.id == conversation_id) {
        c.title = trimmed.clone();
        c.updated_at = chrono::Utc::now().timestamp();
        let result = c.clone();
        save_app_state(&state);
        return Ok(result);
    }

    Ok(Conversation {
        id: conversation_id,
        title: trimmed.clone(),
        messages: Vec::new(),
        platform: "claude".to_string(),
        project_dir: None,
        source_path: session_path.map(|p| p.to_string_lossy().to_string()),
        created_at: chrono::Utc::now().timestamp(),
        updated_at: chrono::Utc::now().timestamp(),
        context_tokens: None,
        last_model: None,
    })
}

fn write_claude_custom_title(path: &Path, session_id: &str, title: &str) -> Result<(), String> {
    if !path.exists() {
        return Err(format!("Session file not found: {}", path.display()));
    }

    if !session_id_matches_path(session_id, path) {
        return Err(format!(
            "Session ID mismatch for file {}",
            path.display()
        ));
    }

    let entry = serde_json::json!({
        "type": "custom-title",
        "customTitle": title,
        "sessionId": session_id,
        "timestamp": chrono::Utc::now().to_rfc3339(),
    });

    let mut file = fs::OpenOptions::new()
        .append(true)
        .open(path)
        .map_err(|e| format!("Failed to open session file {}: {e}", path.display()))?;

    writeln!(file, "{entry}").map_err(|e| {
        format!(
            "Failed to append custom title to {}: {e}",
            path.display()
        )
    })?;

    Ok(())
}

#[tauri::command]
async fn send_message(conversation_id: String, content: String) -> Result<Conversation, String> {
    let mut state = load_app_state();
    let now = chrono::Utc::now().timestamp();
    
    let user_message = Message {
        id: uuid::Uuid::new_v4().to_string(),
        role: "user".to_string(),
        content: content.clone(),
        thinking: None,
        timestamp: now,
    };
    
    let conversation_id = if conversation_id.is_empty() {
        let new_conv = Conversation {
            id: uuid::Uuid::new_v4().to_string(),
            title: content.chars().take(30).collect(),
            messages: vec![user_message],
            platform: state.active_platform.clone(),
            project_dir: None,
            source_path: None,
            created_at: now,
            updated_at: now,
            context_tokens: None,
            last_model: None,
        };
        let id = new_conv.id.clone();
        state.conversations.push(new_conv);
        save_app_state(&state);
        id
    } else {
        if let Some(c) = state.conversations.iter_mut().find(|c| c.id == conversation_id) {
            c.messages.push(user_message);
            c.updated_at = now;
        }
        save_app_state(&state);
        conversation_id
    };
    
    let response_result = run_claude_command(&content).await;
    
    let response_content = if !response_result.success {
        format!(
            "Error: {}\n{}",
            response_result.error.as_deref().unwrap_or("Unknown error"),
            response_result.output
        )
    } else {
        response_result.output
    };
    
    let mut state3 = load_app_state();
    if let Some(c) = state3.conversations.iter_mut().find(|c| c.id == conversation_id) {
        let assistant_message = Message {
            id: uuid::Uuid::new_v4().to_string(),
            role: "assistant".to_string(),
            content: response_content,
            thinking: None,
            timestamp: chrono::Utc::now().timestamp(),
        };
        c.messages.push(assistant_message);
        c.updated_at = chrono::Utc::now().timestamp();
        save_app_state(&state3);
    }
    
    let state4 = load_app_state();
    state4.conversations.into_iter().find(|c| c.id == conversation_id)
        .ok_or_else(|| "Conversation not found".to_string())
}

// 确保目录存在：先验证，不存在则尝试创建
fn resolve_or_create_dir(cwd: &str) -> Option<String> {
    let path = std::path::Path::new(cwd);
    if path.exists() && path.is_dir() {
        return Some(cwd.to_string());
    }
    match std::fs::create_dir_all(path) {
        Ok(()) => {
            eprintln!("[spawn] 已创建目录: {}", cwd);
            Some(cwd.to_string())
        }
        Err(e) => {
            eprintln!("[spawn] 创建目录失败 '{}': {}", cwd, e);
            None
        }
    }
}

fn collect_files(root: &Path, dir: &Path, out: &mut Vec<String>) {
    if let Ok(entries) = fs::read_dir(dir) {
        for entry in entries.flatten() {
            let path = entry.path();
            let file_name = path.file_name().and_then(|n| n.to_str()).unwrap_or("");
            // 跳过隐藏文件和常见忽略目录
            if file_name.starts_with('.') {
                continue;
            }
            if file_name == "node_modules" || file_name == "target" || file_name == "dist"
                || file_name == ".next" || file_name == "__pycache__" || file_name == "vendor"
                || file_name == "build" || file_name == ".turbo" || file_name == ".cache"
            {
                continue;
            }
            if let Ok(rel) = path.strip_prefix(root) {
                let mut rel_str = rel.to_string_lossy().to_string();
                if path.is_dir() {
                    rel_str.push('/');
                }
                out.push(rel_str);
                if path.is_dir() {
                    collect_files(root, &path, out);
                }
            }
        }
    }
}

// ── 文件引用功能：列出项目文件 ─────────────────────────────────────
/// 递归列出项目目录下的所有文件和目录（排除隐藏目录、node_modules 等）
#[tauri::command]
fn list_project_files(project_dir: String) -> Result<Vec<String>, String> {
    let root = Path::new(&project_dir);
    if !root.is_dir() {
        return Err(format!("目录不存在: {}", project_dir));
    }
    let mut files = Vec::new();
    collect_files(root, root, &mut files);
    // 排序：目录在前，文件在后，各自按字母序
    files.sort_by(|a, b| {
        let a_is_dir = a.ends_with('/');
        let b_is_dir = b.ends_with('/');
        b_is_dir.cmp(&a_is_dir).then_with(|| a.cmp(b))
    });
    Ok(files)
}

// ── 文件引用功能：读取文件内容 ──────────────────────────────────────
#[tauri::command]
fn read_file_content(file_path: String) -> Result<String, String> {
    let path = Path::new(&file_path);
    if !path.is_file() {
        return Err(format!("文件不存在: {}", file_path));
    }
    fs::read_to_string(path).map_err(|e| format!("读取文件失败: {}", e))
}

/// 写入二进制文件（用于保存粘贴的图片）
#[tauri::command]
fn write_file_bytes(file_path: String, data: Vec<u8>) -> Result<(), String> {
    let path = Path::new(&file_path);
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| format!("创建目录失败: {}", e))?;
    }
    fs::write(path, &data).map_err(|e| format!("写入文件失败: {}", e))
}

/// 读取文件为 base64 字符串（用于图片预览）
#[tauri::command]
fn read_file_base64(file_path: String) -> Result<String, String> {
    let path = Path::new(&file_path);
    if !path.is_file() {
        return Err(format!("文件不存在: {}", file_path));
    }
    let bytes = fs::read(path).map_err(|e| format!("读取文件失败: {}", e))?;
    Ok(STANDARD.encode(&bytes))
}

#[tauri::command]
async fn execute_prompt(
    app: AppHandle,
    prompt: String,
    conversation_id: Option<String>,
    model: Option<String>,
    project_dir: Option<String>,
) -> Result<(), String> {
    let active_cid = conversation_id.clone();
    let active_model = model.filter(|value| !value.trim().is_empty());
    let explicit_project_dir = project_dir.filter(|value| !value.trim().is_empty());
    eprintln!(
        "[execute_prompt] received: prompt='{}', conversation_id={:?}, model={:?}, project_dir={:?}",
        prompt, active_cid, active_model, explicit_project_dir
    );

    tauri::async_runtime::spawn(async move {
        let before_conversations = load_claude_history();
        let before_ids: std::collections::HashSet<String> =
            before_conversations.iter().map(|c| c.id.clone()).collect();

        let project_dir = active_cid
            .as_ref()
            .and_then(|cid| {
                before_conversations
                    .iter()
                    .find(|c| c.id == *cid)
                    .and_then(|c| c.project_dir.as_ref())
                    .cloned()
            })
            .or(explicit_project_dir);

        let app_handle = app.clone();
        let prompt_clone = prompt.clone();
        let cid_clone = active_cid.clone();
        let model_clone = active_model.clone();

        // resume 已有会话时，先修改 JSONL 文件中历史 assistant 消息的 model 字段，
        // 使 CLI 恢复会话时看到的对话历史与当前选择的模型一致，
        // 避免模型因看到旧模型名而自我认知混乱。
        if let (Some(ref cid), Some(ref new_model)) = (&active_cid, &active_model) {
            match rewrite_session_model(cid, new_model) {
                Ok(true) => {
                    eprintln!(
                        "[execute_prompt] JSONL model rewritten to '{}' for session {}",
                        new_model, cid
                    );
                }
                Ok(false) => {
                    // 模型未变或文件中无需修改
                }
                Err(e) => {
                    eprintln!(
                        "[execute_prompt] Warning: failed to rewrite session model: {}",
                        e
                    );
                }
            }
        }

        let stream_result = tauri::async_runtime::spawn_blocking(move || {
            spawn_claude_stream(
                app_handle,
                &prompt_clone,
                cid_clone.as_ref(),
                project_dir.as_ref(),
                model_clone.as_deref(),
            )
        })
        .await;

        match stream_result {
            Ok(Ok(outcome)) => match outcome {
                StreamOutcome::Success(final_session_id) => {
                    let after_conversations = load_claude_history();
                    let resolved_id = final_session_id
                        .or(active_cid.clone())
                        .or_else(|| {
                            after_conversations
                                .iter()
                                .max_by_key(|c| c.updated_at)
                                .map(|c| c.id.clone())
                        });

                    if let Some(sid) = resolved_id {
                        if let Some(conv) = after_conversations.iter().find(|c| c.id == sid) {
                            let is_existing = before_ids.contains(&conv.id);
                            let event_name = if is_existing {
                                "messages-updated"
                            } else {
                                "session-created"
                            };

                            let payload = SessionEventPayload {
                                conversation_id: conv.id.clone(),
                                title: conv.title.clone(),
                                messages: conv.messages.clone(),
                                project_dir: conv.project_dir.clone(),
                                updated_at: conv.updated_at,
                                context_tokens: conv.context_tokens,
                                last_model: conv.last_model.clone(),
                            };
                            eprintln!("[execute_prompt] emit {} for session {}", event_name, conv.id);
                            let _ = app.emit(event_name, &payload);
                            let _ = app.emit("session-ended", Some(conv.id.clone()));
                            return;
                        }
                    }

                    eprintln!("[execute_prompt] 未找到更新的会话");
                    let _ = app.emit("session-ended", active_cid.clone());
                }
                StreamOutcome::Failed { session_id, error } => {
                    eprintln!(
                        "[execute_prompt] claude 执行失败 (session={:?}): {}",
                        session_id, error
                    );
                    let _ = app.emit("session-ended", active_cid.clone());
                }
            },
            Ok(Err(e)) => {
                let error = format!("Claude 执行失败: {e}");
                eprintln!("[execute_prompt] {error}");
                emit_session_error(&app, active_cid.as_deref(), &error);
                let _ = app.emit("session-ended", active_cid.clone());
            }
            Err(e) => {
                let error = format!("启动 Claude 进程失败: {e}");
                eprintln!("[execute_prompt] {error}");
                emit_session_error(&app, active_cid.as_deref(), &error);
                let _ = app.emit("session-ended", active_cid.clone());
            }
        }
    });

    Ok(())
}

/// 终止正在运行的 Claude 会话（用户主动取消）
#[tauri::command]
async fn abort_session(conversation_id: Option<String>) -> Result<bool, String> {
    if let Some(ref cid) = conversation_id {
        mark_session_aborted(cid);
        if kill_active_process(cid) {
            eprintln!("[abort] killed process for session: {}", cid);
            return Ok(true);
        }
    }
    // 尝试 kill 所有 pending-* 进程
    let reg = ACTIVE_PROCESSES.lock().unwrap();
    if let Some(map) = reg.as_ref() {
        let pending_keys: Vec<String> = map.keys()
            .filter(|k| k.starts_with("pending-"))
            .cloned()
            .collect();
        drop(reg);
        for key in pending_keys {
            mark_session_aborted(&key);
            if kill_active_process(&key) {
                eprintln!("[abort] killed pending process: {}", key);
                return Ok(true);
            }
        }
    }
    eprintln!("[abort] no active process found for {:?}", conversation_id);
    Ok(false)
}

#[derive(Debug, Serialize, Deserialize, Default)]
struct SimpleConversation {
    id: String,
    title: String,
    updated_at: i64,
}

#[tauri::command]
fn get_conversation_list() -> Vec<SimpleConversation> {
    let state = load_app_state();
    state.conversations.iter()
        .map(|c| SimpleConversation {
            id: c.id.clone(),
            title: c.title.clone(),
            updated_at: c.updated_at,
        })
        .collect()
}

#[tauri::command]
fn get_conversation_messages(conversation_id: String) -> Vec<Message> {
    let state = load_app_state();
    state.conversations.iter()
        .find(|c| c.id == conversation_id)
        .map(|c| c.messages.clone())
        .unwrap_or_default()
}

#[derive(Debug, Serialize, Deserialize)]
struct CommandResult {
    success: bool,
    output: String,
    error: Option<String>,
}

#[tauri::command]
async fn execute_cli_command(platform_id: String, input: String) -> Result<CommandResult, String> {
    let _state = load_app_state();
    let _ = platform_id;
    
    let result = run_claude_command(&input).await;
    
    Ok(result)
}

async fn run_claude_command(input: &str) -> CommandResult {
    #[cfg(target_os = "windows")]
    use std::os::windows::process::CommandExt;

    let claude_bin = resolve_claude_executable();

    #[cfg(target_os = "windows")]
    {
        let mut cmd = Command::new(&claude_bin);
        cmd.creation_flags(0x08000000);
        
        run_command_with_input(cmd, input).await
    }
    
    #[cfg(not(target_os = "windows"))]
    {
        let mut cmd = Command::new(&claude_bin);
        apply_cli_runtime_env(&mut cmd);

        run_command_with_input(cmd, input).await
    }
}

#[allow(dead_code)]
async fn run_claude_command_with_resume(input: &str, conversation_id: &str) -> CommandResult {
    #[cfg(target_os = "windows")]
    use std::os::windows::process::CommandExt;

    let claude_bin = resolve_claude_executable();

    #[cfg(target_os = "windows")]
    {
        let mut cmd = Command::new(&claude_bin);
        cmd.args(["--resume", conversation_id]);
        cmd.creation_flags(0x08000000);
        
        run_command_with_input(cmd, input).await
    }
    
    #[cfg(not(target_os = "windows"))]
    {
        let mut cmd = Command::new(&claude_bin);
        cmd.args(["--resume", conversation_id]);
        apply_cli_runtime_env(&mut cmd);

        run_command_with_input(cmd, input).await
    }
}

async fn run_command_with_input(mut cmd: Command, input: &str) -> CommandResult {
    let mut child = match cmd
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
    {
        Ok(c) => c,
        Err(e) => return CommandResult {
            success: false,
            output: String::new(),
            error: Some(format!("Failed to start claude: {}", e)),
        },
    };
    
    if let Some(mut stdin) = child.stdin.take() {
        if let Err(e) = stdin.write_all(input.as_bytes()) {
            return CommandResult {
                success: false,
                output: String::new(),
                error: Some(format!("Failed to write input to claude: {}", e)),
            };
        }
    }
    
    let output = match child.wait_with_output() {
        Ok(o) => o,
        Err(e) => return CommandResult {
            success: false,
            output: String::new(),
            error: Some(format!("Claude execution failed: {}", e)),
        },
    };
    
    let stdout = String::from_utf8_lossy(&output.stdout).to_string();
    let stderr = String::from_utf8_lossy(&output.stderr).to_string();
    
    CommandResult {
        success: output.status.success(),
        output: stdout,
        error: if stderr.is_empty() { None } else { Some(stderr) },
    }
}

const WINDOW_ASPECT_WIDTH: f64 = 16.0;
const WINDOW_ASPECT_HEIGHT: f64 = 10.0;
const WINDOW_MAX_SCREEN_RATIO: f64 = 0.85;
const WINDOW_MIN_WIDTH: f64 = 576.0;
const WINDOW_MIN_HEIGHT: f64 = 360.0;

/// 将物理像素转换为逻辑像素
fn physical_to_logical(value: u32, scale_factor: f64) -> f64 {
    value as f64 / scale_factor
}

/// 在屏幕工作区内计算 16:10 比例的最佳窗口尺寸
fn compute_optimal_window_size(screen_width: f64, screen_height: f64) -> (f64, f64) {
    let max_width = screen_width * WINDOW_MAX_SCREEN_RATIO;
    let max_height = screen_height * WINDOW_MAX_SCREEN_RATIO;

    let width_by_width = max_width;
    let height_by_width = width_by_width * WINDOW_ASPECT_HEIGHT / WINDOW_ASPECT_WIDTH;

    let (mut width, mut height) = if height_by_width <= max_height {
        (width_by_width, height_by_width)
    } else {
        let height = max_height;
        let width = height * WINDOW_ASPECT_WIDTH / WINDOW_ASPECT_HEIGHT;
        (width, height)
    };

    if width < WINDOW_MIN_WIDTH {
        width = WINDOW_MIN_WIDTH;
        height = width * WINDOW_ASPECT_HEIGHT / WINDOW_ASPECT_WIDTH;
    }
    if height < WINDOW_MIN_HEIGHT {
        height = WINDOW_MIN_HEIGHT;
        width = height * WINDOW_ASPECT_WIDTH / WINDOW_ASPECT_HEIGHT;
    }

    if width > max_width {
        width = max_width;
        height = width * WINDOW_ASPECT_HEIGHT / WINDOW_ASPECT_WIDTH;
    }
    if height > max_height {
        height = max_height;
        width = height * WINDOW_ASPECT_WIDTH / WINDOW_ASPECT_HEIGHT;
    }

    (width.round(), height.round())
}

/// 根据工作区与窗口外框尺寸，计算居中位置（物理坐标）
fn compute_centered_physical_position(
    work_x: i32,
    work_y: i32,
    work_width: u32,
    work_height: u32,
    window_width: u32,
    window_height: u32,
) -> (i32, i32) {
    let x = work_x + ((work_width as i32 - window_width as i32) / 2);
    let y = work_y + ((work_height as i32 - window_height as i32) / 2);
    (x, y)
}

fn resolve_target_monitor(window: &WebviewWindow, app: &AppHandle) -> Option<tauri::Monitor> {
    window
        .current_monitor()
        .ok()
        .flatten()
        .or_else(|| app.primary_monitor().ok().flatten())
}

/// 计算尺寸并将主窗口居中到目标显示器工作区
fn layout_main_window(window: &WebviewWindow, app: &AppHandle) -> bool {
    let Some(monitor) = resolve_target_monitor(window, app) else {
        eprintln!("[window] monitor not found");
        return false;
    };

    let scale_factor = monitor.scale_factor();
    let work_area = monitor.work_area();
    let work_width = physical_to_logical(work_area.size.width, scale_factor);
    let work_height = physical_to_logical(work_area.size.height, scale_factor);
    let (width, height) = compute_optimal_window_size(work_width, work_height);

    eprintln!(
        "[window] work_area={}x{}@({},{}), target={:.0}x{:.0} (16:10)",
        work_area.size.width,
        work_area.size.height,
        work_area.position.x,
        work_area.position.y,
        width,
        height
    );

    if let Err(e) = window.set_size(Size::Logical(LogicalSize::new(width, height))) {
        eprintln!("[window] failed to set size: {e}");
        return false;
    }

    let Ok(outer) = window.outer_size() else {
        eprintln!("[window] failed to read outer size");
        return false;
    };

    let (pos_x, pos_y) = compute_centered_physical_position(
        work_area.position.x,
        work_area.position.y,
        work_area.size.width,
        work_area.size.height,
        outer.width,
        outer.height,
    );

    eprintln!(
        "[window] outer={}x{}, centered at physical ({}, {})",
        outer.width, outer.height, pos_x, pos_y
    );

    if let Err(e) = window.set_position(Position::Physical(PhysicalPosition::new(pos_x, pos_y))) {
        eprintln!("[window] failed to set position: {e}, fallback to center()");
        let _ = window.center();
        return false;
    }

    true
}

fn schedule_main_window_layout(window: WebviewWindow, app: AppHandle) {
    let applied = Arc::new(AtomicBool::new(false));

    let apply_once = |window: &WebviewWindow, app: &AppHandle, show: bool| {
        if layout_main_window(window, app) && show {
            let _ = window.show();
            let _ = window.set_focus();
        }
    };

    apply_once(&window, &app, true);

    let window_for_main = window.clone();
    let app_for_main = app.clone();
    let _ = app.run_on_main_thread(move || {
        apply_once(&window_for_main, &app_for_main, true);
    });

    let window_for_event = window.clone();
    let app_for_event = app.clone();
    let applied_for_event = Arc::clone(&applied);
    window.on_window_event(move |event| {
        if !matches!(event, tauri::WindowEvent::Focused(true)) {
            return;
        }
        if applied_for_event.swap(true, Ordering::SeqCst) {
            return;
        }
        layout_main_window(&window_for_event, &app_for_event);
    });

    let window_for_delay = window.clone();
    let app_for_delay = app.clone();
    tauri::async_runtime::spawn_blocking(move || {
        std::thread::sleep(Duration::from_millis(120));
        let app_handle = app_for_delay.clone();
        let _ = app_for_delay.run_on_main_thread(move || {
            layout_main_window(&window_for_delay, &app_handle);
        });
    });
}

fn apply_responsive_window_size(app: &tauri::App) {
    let Some(window) = app.get_webview_window("main") else {
        eprintln!("[window] main window not found");
        return;
    };

    schedule_main_window_layout(window, app.handle().clone());
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            apply_responsive_window_size(app);
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            get_conversations,
            get_platforms,
            get_active_platform,
            get_current_platform,
            set_active_platform,
            add_platform,
            delete_conversation,
            get_conversation,
            update_conversation_title,
            send_message,
            execute_cli_command,
            execute_prompt,
            abort_session,
            get_conversation_list,
            get_conversation_messages,
            get_claude_api_config,
            save_claude_api_config,
            get_api_profiles_state,
            get_api_profile_config,
            upsert_api_profile,
            switch_api_profile,
            use_official_api,
            delete_api_profile,
            import_cc_switch_profiles,
            fetch_api_models,
            list_project_files,
            read_file_content,
            write_file_bytes,
            read_file_base64,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application")
}
