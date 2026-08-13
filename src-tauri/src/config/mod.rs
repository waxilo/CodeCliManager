use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::{Path, PathBuf};

use crate::config_io::{
    atomic_write_json, lock_api_profiles, lock_global_config, lock_kiro_prefs, lock_settings,
    read_json_or, read_json_or_default,
};
use crate::model_fetch;
use crate::paths::{get_claude_settings_path, get_data_path};

#[derive(Debug, Serialize, Deserialize, Clone, Default)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ClaudeCodeApiConfig {
    pub(crate) base_url: String,
    #[serde(default)]
    pub(crate) has_api_key: bool,
    pub(crate) default_model: String,
    pub(crate) haiku_model: String,
    pub(crate) sonnet_model: String,
    pub(crate) opus_model: String,
    #[serde(default)]
    pub(crate) display_models: Vec<String>,
    #[serde(default)]
    pub(crate) custom_models: Vec<String>,
    pub(crate) config_path: String,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SaveClaudeCodeApiConfig {
    pub(crate) base_url: String,
    pub(crate) api_key: Option<String>,
    pub(crate) default_model: String,
    pub(crate) haiku_model: String,
    pub(crate) sonnet_model: String,
    pub(crate) opus_model: String,
    #[serde(default)]
    pub(crate) display_models: Vec<String>,
    #[serde(default)]
    pub(crate) custom_models: Vec<String>,
}

fn read_settings_from(path: &Path) -> Result<serde_json::Value, String> {
    read_json_or(path, serde_json::json!({ "env": {} }))
}

pub(crate) fn read_claude_settings_json() -> serde_json::Value {
    read_settings_from(&get_claude_settings_path())
        .unwrap_or_else(|_| serde_json::json!({ "env": {} }))
}

pub(crate) fn update_claude_settings<F>(update: F) -> Result<(), String>
where
    F: FnOnce(&mut serde_json::Value) -> Result<(), String>,
{
    let _guard = lock_settings()?;
    let path = get_claude_settings_path();
    let mut settings = read_settings_from(&path)?;
    update(&mut settings)?;
    atomic_write_json(&path, &settings)
}

// ── MCP 服务器管理（用户级配置位于 ~/.claude.json 的 mcpServers 字段） ─────

pub(crate) fn get_claude_global_config_path() -> PathBuf {
    let mut path = dirs::home_dir().unwrap_or_else(|| PathBuf::from("."));
    path.push(".claude.json");
    path
}

fn read_global_config_from(path: &Path) -> Result<serde_json::Value, String> {
    read_json_or(path, serde_json::json!({}))
}

pub(crate) fn read_claude_global_config() -> serde_json::Value {
    read_global_config_from(&get_claude_global_config_path())
        .unwrap_or_else(|_| serde_json::json!({}))
}

fn update_claude_global_config<F>(update: F) -> Result<(), String>
where
    F: FnOnce(&mut serde_json::Value) -> Result<(), String>,
{
    let _guard = lock_global_config()?;
    let path = get_claude_global_config_path();
    let mut config = read_global_config_from(&path)?;
    update(&mut config)?;
    atomic_write_json(&path, &config)
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub(crate) struct McpServerConfig {
    #[serde(rename = "type", default)]
    pub(crate) server_type: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) command: Option<String>,
    #[serde(default)]
    pub(crate) args: Vec<String>,
    #[serde(default)]
    pub(crate) env: HashMap<String, String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) url: Option<String>,
}

impl Default for McpServerConfig {
    fn default() -> Self {
        McpServerConfig {
            server_type: "stdio".to_string(),
            command: None,
            args: Vec::new(),
            env: HashMap::new(),
            url: None,
        }
    }
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub(crate) struct McpServerEntry {
    pub(crate) name: String,
    pub(crate) config: McpServerConfig,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) parse_error: Option<String>,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct McpServersState {
    pub(crate) servers: Vec<McpServerEntry>,
    pub(crate) config_path: String,
}

pub(crate) fn build_mcp_servers_state() -> McpServersState {
    let global = read_claude_global_config();
    let mut servers = Vec::new();
    if let Some(map) = global.get("mcpServers").and_then(|v| v.as_object()) {
        for (name, value) in map {
            let entry = match serde_json::from_value::<McpServerConfig>(value.clone()) {
                Ok(config) => McpServerEntry {
                    name: name.clone(),
                    config,
                    parse_error: None,
                },
                Err(_) => McpServerEntry {
                    name: name.clone(),
                    config: McpServerConfig::default(),
                    parse_error: Some("无法解析该服务器配置（格式不受支持）".to_string()),
                },
            };
            servers.push(entry);
        }
    }
    servers.sort_by(|a, b| a.name.cmp(&b.name));
    McpServersState {
        servers,
        config_path: get_claude_global_config_path().display().to_string(),
    }
}

#[tauri::command]
pub fn get_mcp_servers() -> McpServersState {
    build_mcp_servers_state()
}

#[tauri::command]
pub fn upsert_mcp_server(name: String, config: McpServerConfig) -> Result<McpServersState, String> {
    let trimmed = name.trim();
    if trimmed.is_empty() {
        return Err("服务器名称不能为空".to_string());
    }
    // 归一化：stdio 只保留 command，远程类型只保留 url
    let mut config = config;
    if config.server_type == "stdio" {
        config.url = None;
        if config.command.as_deref().map(str::trim).unwrap_or("").is_empty() {
            config.command = None;
        }
    } else {
        config.command = None;
        if config.url.as_deref().map(str::trim).unwrap_or("").is_empty() {
            config.url = None;
        }
    }
    update_claude_global_config(|global| {
        if !global.is_object() {
            return Err("配置文件格式异常".to_string());
        }
        let obj = global
            .as_object_mut()
            .ok_or_else(|| "配置文件格式异常".to_string())?;
        let servers = obj
            .entry("mcpServers")
            .or_insert_with(|| serde_json::json!({}));
        let map = servers
            .as_object_mut()
            .ok_or_else(|| "mcpServers 配置格式异常".to_string())?;
        let value = serde_json::to_value(config)
            .map_err(|e| format!("配置序列化失败: {e}"))?;
        map.insert(trimmed.to_string(), value);
        Ok(())
    })?;
    Ok(build_mcp_servers_state())
}

#[tauri::command]
pub fn delete_mcp_server(name: String) -> Result<McpServersState, String> {
    update_claude_global_config(|global| {
        let obj = global
            .as_object_mut()
            .ok_or_else(|| "配置文件格式异常".to_string())?;
        if let Some(map) = obj.get_mut("mcpServers").and_then(|v| v.as_object_mut()) {
            map.remove(&name);
        }
        Ok(())
    })?;
    Ok(build_mcp_servers_state())
}

pub(crate) fn env_string(env: &serde_json::Map<String, serde_json::Value>, key: &str) -> String {
    env.get(key)
        .and_then(|value| value.as_str())
        .unwrap_or("")
        .trim()
        .to_string()
}

pub(crate) fn set_env_string(env: &mut serde_json::Map<String, serde_json::Value>, key: &str, value: &str) {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        env.remove(key);
    } else {
        env.insert(key.to_string(), serde_json::Value::String(trimmed.to_string()));
    }
}

pub(crate) fn set_model_and_display_name(
    env: &mut serde_json::Map<String, serde_json::Value>,
    model_key: &str,
    name_key: &str,
    value: &str,
) {
    set_env_string(env, model_key, value);
    set_env_string(env, name_key, value);
}

pub(crate) fn claude_api_key_from_env(env: &serde_json::Map<String, serde_json::Value>) -> String {
    let auth_token = env_string(env, "ANTHROPIC_AUTH_TOKEN");
    if !auth_token.is_empty() {
        return auth_token;
    }
    env_string(env, "ANTHROPIC_API_KEY")
}

/// 是否配置了自定义 API（第三方中转）。官方订阅模式下 ANTHROPIC_BASE_URL 为空。
pub(crate) fn has_custom_api_base() -> bool {
    let settings = read_claude_settings_json();
    settings
        .get("env")
        .and_then(|value| value.as_object())
        .map(|env| !env_string(env, "ANTHROPIC_BASE_URL").is_empty())
        .unwrap_or(false)
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ApiProfile {
    pub(crate) id: String,
    pub(crate) name: String,
    pub(crate) base_url: String,
    pub(crate) api_key: String,
    pub(crate) default_model: String,
    pub(crate) haiku_model: String,
    pub(crate) sonnet_model: String,
    pub(crate) opus_model: String,
    #[serde(default)]
    pub(crate) display_models: Vec<String>,
    #[serde(default)]
    pub(crate) custom_models: Vec<String>,
    pub(crate) created_at: i64,
    pub(crate) updated_at: i64,
}

#[derive(Debug, Serialize, Deserialize, Default, Clone)]
pub(crate) struct ApiProfilesStore {
    #[serde(default)]
    pub(crate) active_profile_id: Option<String>,
    #[serde(default)]
    pub(crate) profiles: Vec<ApiProfile>,
}

/// Kiro 代理用户偏好：是否启用（用于重启恢复），以及关闭时要还原的 API 配置。
/// Kiro 不写入 api-profiles 列表，仅静默套用到 Claude settings。
#[derive(Debug, Serialize, Deserialize, Default, Clone)]
#[serde(rename_all = "camelCase")]
pub(crate) struct KiroProxyPrefs {
    /// 用户上次是否开启了 Kiro 代理；重启后仅在此为 true 时自动启动。
    #[serde(default)]
    pub(crate) enabled: bool,
    /// 开启 Kiro 前的 active profile；None 表示当时是官方默认。
    #[serde(default)]
    pub(crate) previous_profile_id: Option<String>,
    /// 最近一次同步到的可用模型列表（供聊天页选择器使用）。
    #[serde(default)]
    pub(crate) display_models: Vec<String>,
    /// 用户自定义补充的模型 ID（与 API 配置页一致）。
    #[serde(default)]
    pub(crate) custom_models: Vec<String>,
    /// 用户在 Kiro 页选中的默认模型。
    #[serde(default)]
    pub(crate) default_model: String,
}

pub(crate) fn get_kiro_proxy_prefs_path() -> PathBuf {
    get_data_path().join("kiro-proxy.json")
}

pub(crate) fn load_kiro_proxy_prefs() -> KiroProxyPrefs {
    read_json_or_default(&get_kiro_proxy_prefs_path()).unwrap_or_default()
}

pub(crate) fn update_kiro_proxy_prefs<F, R>(update: F) -> Result<R, String>
where
    F: FnOnce(&mut KiroProxyPrefs) -> Result<R, String>,
{
    let _guard = lock_kiro_prefs()?;
    let path = get_kiro_proxy_prefs_path();
    let mut prefs: KiroProxyPrefs = read_json_or_default(&path)?;
    let result = update(&mut prefs)?;
    atomic_write_json(&path, &prefs)?;
    Ok(result)
}

/// 用户改用其它 API 配置时放弃「重启后自动开 Kiro」。
pub(crate) fn abandon_kiro_proxy_preference() {
    let _ = update_kiro_proxy_prefs(|prefs| {
        if prefs.enabled || prefs.previous_profile_id.is_some() {
            prefs.enabled = false;
            prefs.previous_profile_id = None;
        }
        Ok(())
    });
}

/// 从 store 中移除历史遗留的名为「Kiro」的列表项（不再作为 API 配置展示）。
pub(crate) fn purge_kiro_named_profiles(store: &mut ApiProfilesStore) -> bool {
    let removed_ids: Vec<String> = store
        .profiles
        .iter()
        .filter(|profile| profile.name == "Kiro")
        .map(|profile| profile.id.clone())
        .collect();
    if removed_ids.is_empty() {
        return false;
    }
    store.profiles.retain(|profile| profile.name != "Kiro");
    if store
        .active_profile_id
        .as_ref()
        .map(|id| removed_ids.iter().any(|removed| removed == id))
        .unwrap_or(false)
    {
        store.active_profile_id = None;
    }
    true
}

pub(crate) fn is_kiro_named_profile(name: &str) -> bool {
    name.trim() == "Kiro"
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ApiProfileItem {
    pub(crate) id: String,
    pub(crate) name: String,
    pub(crate) base_url: String,
    pub(crate) default_model: String,
    pub(crate) has_api_key: bool,
    pub(crate) is_active: bool,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ApiProfilesState {
    pub(crate) active_profile_id: Option<String>,
    pub(crate) profiles: Vec<ApiProfileItem>,
    pub(crate) current: ClaudeCodeApiConfig,
}

pub(crate) fn get_api_profiles_path() -> PathBuf {
    get_data_path().join("api-profiles.json")
}

pub(crate) fn load_api_profiles_store() -> ApiProfilesStore {
    read_json_or_default(&get_api_profiles_path()).unwrap_or_default()
}

pub(crate) fn update_api_profiles_store<F, R>(update: F) -> Result<R, String>
where
    F: FnOnce(&mut ApiProfilesStore) -> Result<R, String>,
{
    let _guard = lock_api_profiles()?;
    let path = get_api_profiles_path();
    let mut store: ApiProfilesStore = read_json_or_default(&path)?;
    let result = update(&mut store)?;
    atomic_write_json(&path, &store)?;
    Ok(result)
}

pub(crate) fn apply_model_override_env(cmd: &mut std::process::Command, model: &str) {
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

pub(crate) fn config_from_env(env: &serde_json::Map<String, serde_json::Value>) -> ClaudeCodeApiConfig {
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

pub(crate) fn config_from_profile(profile: &ApiProfile) -> ClaudeCodeApiConfig {
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

pub(crate) fn resolve_profile_env_model(profile: &ApiProfile) -> String {
    // 优先保留用户选中的默认模型；仅在缺失时回退到展示/自定义列表首项
    let default = profile.default_model.trim();
    if !default.is_empty() {
        return default.to_string();
    }

    profile
        .display_models
        .iter()
        .find(|model| !model.trim().is_empty())
        .cloned()
        .or_else(|| {
            profile
                .custom_models
                .iter()
                .find(|model| !model.trim().is_empty())
                .cloned()
        })
        .unwrap_or_default()
}

pub(crate) fn profile_to_save_config(profile: &ApiProfile) -> SaveClaudeCodeApiConfig {
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

fn apply_save_config_to_value(
    settings: &mut serde_json::Value,
    config: &SaveClaudeCodeApiConfig,
) -> Result<(), String> {
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

    if let Some(api_key) = &config.api_key {
        let trimmed = api_key.trim();
        if trimmed.is_empty() {
            env.remove("ANTHROPIC_AUTH_TOKEN");
            env.remove("ANTHROPIC_API_KEY");
        } else {
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
    }
    Ok(())
}

pub(crate) fn apply_save_config_to_settings(config: &SaveClaudeCodeApiConfig) -> Result<(), String> {
    update_claude_settings(|settings| apply_save_config_to_value(settings, config))
}

pub(crate) fn build_api_profiles_state(store: &ApiProfilesStore) -> ApiProfilesState {
    ApiProfilesState {
        active_profile_id: store.active_profile_id.clone(),
        profiles: store
            .profiles
            .iter()
            .filter(|profile| !is_kiro_named_profile(&profile.name))
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

pub(crate) fn ensure_default_profile_from_live(store: &mut ApiProfilesStore) -> bool {
    if !store.profiles.is_empty() {
        return false;
    }

    // Kiro 运行时配置不写入 API 列表，避免把本地代理地址当成「默认配置」
    if load_kiro_proxy_prefs().enabled {
        return false;
    }

    let settings = read_claude_settings_json();
    let env = settings
        .get("env")
        .and_then(|value| value.as_object())
        .cloned()
        .unwrap_or_default();
    let config = config_from_env(&env);
    if config.base_url.is_empty() && !config.has_api_key && config.default_model.is_empty() {
        return false;
    }
    let base = config.base_url.trim().to_lowercase();
    if base.starts_with("http://127.0.0.1:") || base.starts_with("http://localhost:") {
        return false;
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
    true
}

pub(crate) fn load_api_profiles_state() -> ApiProfilesState {
    let store = update_api_profiles_store(|store| {
        purge_kiro_named_profiles(store);
        ensure_default_profile_from_live(store);
        Ok(ApiProfilesStore {
            active_profile_id: store.active_profile_id.clone(),
            profiles: store.profiles.clone(),
        })
    })
    .unwrap_or_else(|_| load_api_profiles_store());
    build_api_profiles_state(&store)
}

#[tauri::command]
pub fn get_api_profiles_state() -> ApiProfilesState {
    load_api_profiles_state()
}

#[tauri::command]
pub fn switch_api_profile(profile_id: String) -> Result<ApiProfilesState, String> {
    // 改用普通 API 配置后，不再在重启时自动拉起 Kiro
    abandon_kiro_proxy_preference();

    let store = update_api_profiles_store(|store| {
        let profile = store
            .profiles
            .iter()
            .find(|profile| profile.id == profile_id && !is_kiro_named_profile(&profile.name))
            .cloned()
            .ok_or_else(|| "API profile not found".to_string())?;
        apply_save_config_to_settings(&profile_to_save_config(&profile))?;
        store.active_profile_id = Some(profile_id);
        Ok(store.clone())
    })?;
    Ok(build_api_profiles_state(&store))
}

/// 恢复官方默认：清除 settings.json 中自定义的 Anthropic API / 模型 env，
/// 让 Claude Code 回退到官方订阅（OAuth 登录），并取消激活的自定义配置。
#[tauri::command]
pub fn use_official_api() -> Result<ApiProfilesState, String> {
    abandon_kiro_proxy_preference();
    apply_official_api_settings()
}

/// 清除 Claude settings 中的自定义 Anthropic env，并取消激活的 API 配置。
pub(crate) fn apply_official_api_settings() -> Result<ApiProfilesState, String> {
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

    update_claude_settings(|settings| {
        if let Some(env) = settings
            .get_mut("env")
            .and_then(|value| value.as_object_mut())
        {
            for key in KEYS {
                env.remove(*key);
            }
        }
        Ok(())
    })?;

    let store = update_api_profiles_store(|store| {
        store.active_profile_id = None;
        Ok(store.clone())
    })?;
    Ok(build_api_profiles_state(&store))
}

/// 按 id 恢复某条 API 配置；找不到则回退官方默认。供 Kiro 停止时还原使用。
pub(crate) fn restore_api_profile_or_official(
    profile_id: Option<String>,
) -> Result<ApiProfilesState, String> {
    let Some(profile_id) = profile_id.filter(|id| !id.trim().is_empty()) else {
        return apply_official_api_settings();
    };
    let store = update_api_profiles_store(|store| {
        let Some(profile) = store
            .profiles
            .iter()
            .find(|profile| profile.id == profile_id && !is_kiro_named_profile(&profile.name))
            .cloned()
        else {
            return Err("API profile not found".to_string());
        };
        apply_save_config_to_settings(&profile_to_save_config(&profile))?;
        store.active_profile_id = Some(profile_id);
        Ok(store.clone())
    });
    match store {
        Ok(store) => Ok(build_api_profiles_state(&store)),
        Err(error) if error == "API profile not found" => apply_official_api_settings(),
        Err(error) => Err(error),
    }
}

#[tauri::command]
pub fn upsert_api_profile(
    profile_id: Option<String>,
    name: String,
    config: SaveClaudeCodeApiConfig,
    apply: bool,
) -> Result<ApiProfilesState, String> {
    let trimmed_name = name.trim();
    if trimmed_name.is_empty() {
        return Err("Profile name cannot be empty".to_string());
    }
    if is_kiro_named_profile(trimmed_name) {
        return Err("Kiro 由「Kiro 代理」页管理，不能作为 API 配置保存".to_string());
    }

    let store = update_api_profiles_store(|store| {
        let now = chrono::Utc::now().timestamp();

        let resolved_id = if let Some(id) = profile_id.filter(|value| !value.trim().is_empty()) {
        let profile = store
            .profiles
            .iter_mut()
            .find(|profile| profile.id == id)
            .ok_or_else(|| "API profile not found".to_string())?;

        profile.name = trimmed_name.to_string();
        profile.base_url = config.base_url.trim().to_string();
        // 空字符串表示“本次不改默认模型”，避免同步展示列表时把用户已选模型清掉
        let next_default = config.default_model.trim();
        if !next_default.is_empty() {
            profile.default_model = next_default.to_string();
        }
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
            default_model: config.default_model.trim().to_string(),
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
            abandon_kiro_proxy_preference();
            let profile = store
                .profiles
                .iter()
                .find(|profile| profile.id == resolved_id)
                .cloned()
                .ok_or_else(|| "API profile not found".to_string())?;
            apply_save_config_to_settings(&profile_to_save_config(&profile))?;
            store.active_profile_id = Some(resolved_id);
        }

        Ok(store.clone())
    })?;
    Ok(build_api_profiles_state(&store))
}

#[tauri::command]
pub fn delete_api_profile(profile_id: String) -> Result<ApiProfilesState, String> {
    let store = update_api_profiles_store(|store| {
        if store.active_profile_id.as_deref() == Some(profile_id.as_str()) {
            return Err("Cannot delete the active API profile".to_string());
        }

        let before = store.profiles.len();
        store.profiles.retain(|profile| profile.id != profile_id);
        if store.profiles.len() == before {
            return Err("API profile not found".to_string());
        }
        Ok(store.clone())
    })?;
    Ok(build_api_profiles_state(&store))
}

pub(crate) fn get_cc_switch_config_dir() -> PathBuf {
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

pub(crate) fn get_cc_switch_db_path() -> PathBuf {
    get_cc_switch_config_dir().join("cc-switch.db")
}

pub(crate) struct CcSwitchProviderRow {
    pub(crate) name: String,
    pub(crate) settings_config: String,
}

pub(crate) fn read_cc_switch_claude_providers() -> Result<Vec<CcSwitchProviderRow>, String> {
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

pub(crate) fn profile_from_cc_switch_row(name: &str, settings_config: &str, now: i64) -> Option<ApiProfile> {
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

pub(crate) fn is_duplicate_api_profile(store: &ApiProfilesStore, profile: &ApiProfile) -> bool {
    store.profiles.iter().any(|existing| {
        existing.name == profile.name
            || (existing.base_url == profile.base_url
                && !profile.api_key.is_empty()
                && existing.api_key == profile.api_key)
    })
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub(crate) struct CcSwitchImportResult {
    pub(crate) imported_count: usize,
    pub(crate) skipped_count: usize,
    pub(crate) skipped_names: Vec<String>,
    pub(crate) cc_switch_path: String,
    pub(crate) state: ApiProfilesState,
}

#[tauri::command]
pub fn import_cc_switch_profiles() -> Result<CcSwitchImportResult, String> {
    let cc_switch_path = get_cc_switch_db_path();
    let providers = read_cc_switch_claude_providers()?;
    if providers.is_empty() {
        return Err("CC Switch 中没有 Claude 配置可导入".to_string());
    }

    let now = chrono::Utc::now().timestamp();
    let (store, imported_count, skipped_count, skipped_names) =
        update_api_profiles_store(|store| {
            ensure_default_profile_from_live(store);
            let mut imported_count = 0usize;
            let mut skipped_count = 0usize;
            let mut skipped_names = Vec::new();

            for provider in providers {
                let Some(profile) =
                    profile_from_cc_switch_row(&provider.name, &provider.settings_config, now)
                else {
                    skipped_count += 1;
                    skipped_names.push(format!("{}（配置为空）", provider.name));
                    continue;
                };

                if is_duplicate_api_profile(store, &profile) {
                    skipped_count += 1;
                    skipped_names.push(profile.name);
                    continue;
                }

                store.profiles.push(profile);
                imported_count += 1;
            }

            Ok((
                store.clone(),
                imported_count,
                skipped_count,
                skipped_names,
            ))
        })?;

    // 全部已存在 / 无新增不算失败，照常返回结果，由前端给出友好提示
    Ok(CcSwitchImportResult {
        imported_count,
        skipped_count,
        skipped_names,
        cc_switch_path: cc_switch_path.to_string_lossy().to_string(),
        state: build_api_profiles_state(&store),
    })
}

#[tauri::command]
pub fn get_api_profile_config(profile_id: String) -> Result<ClaudeCodeApiConfig, String> {
    let store = load_api_profiles_store();
    let profile = store
        .profiles
        .iter()
        .find(|profile| profile.id == profile_id)
        .ok_or_else(|| "API profile not found".to_string())?;
    Ok(config_from_profile(profile))
}

/// 返回指定配置的原始 API Key，用于前端的「复制」与「显示首尾」预览。
/// 注意：仅在用户主动点击复制 / 显示时调用，避免将密钥放入常规列表数据中。
#[tauri::command]
pub fn get_api_profile_key(profile_id: String) -> Result<String, String> {
    let store = load_api_profiles_store();
    let profile = store
        .profiles
        .iter()
        .find(|profile| profile.id == profile_id)
        .ok_or_else(|| "API profile not found".to_string())?;
    Ok(profile.api_key.clone())
}

/// 立即把当前选中的默认模型写入配置文件：
/// 1. Claude Code 的 settings.json（env.ANTHROPIC_MODEL）
/// 2. 当前活跃 API profile 的 default_model 字段（若存在）
/// 返回最新的 ClaudeCodeApiConfig，便于前端做后续刷新。
#[tauri::command]
pub fn set_active_default_model(model: String) -> Result<ClaudeCodeApiConfig, String> {
    let trimmed = model.trim().to_string();

    // 1) 写入 Claude Code settings.json
    update_claude_settings(|settings| {
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
        set_env_string(env, "ANTHROPIC_MODEL", &trimmed);
        Ok(())
    })?;

    // 2) 同步活跃 profile 的 default_model（如果有）
    update_api_profiles_store(|store| {
        if let Some(active_id) = store.active_profile_id.clone() {
            if let Some(profile) = store.profiles.iter_mut().find(|p| p.id == active_id) {
                profile.default_model = trimmed.clone();
                profile.updated_at = chrono::Utc::now().timestamp();
            }
        }
        Ok(())
    })?;

    // 3) Kiro 启用时同步偏好里的默认模型
    let _ = update_kiro_proxy_prefs(|prefs| {
        if prefs.enabled {
            prefs.default_model = trimmed;
        }
        Ok(())
    });

    Ok(get_claude_api_config())
}

pub(crate) fn resolve_api_key_for_fetch(api_key: Option<String>, profile_id: Option<String>) -> Result<String, String> {
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
pub async fn fetch_api_models(
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

/// 查询当前选中 profile 的 DeepSeek 余额（仅 deepseek.com Base URL）。
#[tauri::command]
pub async fn fetch_deepseek_balance(
    base_url: String,
    api_key: Option<String>,
    profile_id: Option<String>,
) -> Result<model_fetch::DeepSeekBalance, String> {
    let trimmed_base_url = base_url.trim();
    if trimmed_base_url.is_empty() {
        return Err("Base URL 不能为空".to_string());
    }
    if !model_fetch::is_deepseek_base_url(trimmed_base_url) {
        return Err("当前配置不是 DeepSeek API".to_string());
    }
    let resolved_key = resolve_api_key_for_fetch(api_key, profile_id)?;
    model_fetch::fetch_deepseek_balance(trimmed_base_url, &resolved_key).await
}

pub(crate) fn active_api_profile<'a>(store: &'a ApiProfilesStore) -> Option<&'a ApiProfile> {
    store
        .active_profile_id
        .as_ref()
        .and_then(|id| store.profiles.iter().find(|profile| profile.id == *id))
        .or_else(|| store.profiles.first())
}

#[tauri::command]
pub fn get_claude_api_config() -> ClaudeCodeApiConfig {
    let settings = read_claude_settings_json();
    let env = settings
        .get("env")
        .and_then(|value| value.as_object())
        .cloned()
        .unwrap_or_default();
    let mut config = config_from_env(&env);

    let kiro_prefs = load_kiro_proxy_prefs();
    if kiro_prefs.enabled {
        config.display_models = kiro_prefs.display_models;
        config.custom_models = kiro_prefs.custom_models;
        if config.default_model.trim().is_empty() && !kiro_prefs.default_model.trim().is_empty() {
            config.default_model = kiro_prefs.default_model;
        }
        return config;
    }

    let store = load_api_profiles_store();
    if let Some(profile) = active_api_profile(&store) {
        config.display_models = profile.display_models.clone();
        config.custom_models = profile.custom_models.clone();
    }

    config
}
