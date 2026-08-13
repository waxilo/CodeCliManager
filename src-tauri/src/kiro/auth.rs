//! Kiro IDE SSO 认证：读取 `~/.aws/sso/cache/kiro-auth-token.json`，
//! 支持 IdC / Social 两种 OIDC token 刷新，并自动发现 Profile ARN。
//! 移植自 kiro2cli/src/auth.js（MIT）。

use std::fs;
use std::io::Write;
use std::path::PathBuf;
use std::sync::Mutex;
use std::time::Duration;

use chrono::{DateTime, Utc};
use reqwest::blocking::Client;
use serde::Serialize;
use serde_json::{json, Value};

const TOKEN_REFRESH_SKEW_SECS: i64 = 120;
/// 避免 Windows 网络异常时无超时阻塞导致 UI/IPC 卡死
const KIRO_HTTP_TIMEOUT_SECS: u64 = 30;
const PROFILE_ARN_RE: &str = r"^arn:aws[a-z-]*:codewhisperer:[a-z0-9-]+:\d{12}:profile/[A-Za-z0-9_-]+$";

#[derive(Default)]
struct AuthCache {
    cached_profile_arn: Option<String>,
    cached_available_models: Option<Vec<String>>,
}

/// Kiro 账户额度快照（来自 getUsageLimits）。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct KiroUsageInfo {
    pub subscription_title: Option<String>,
    pub subscription_type: Option<String>,
    pub current_usage: f64,
    pub usage_limit: f64,
    pub remaining: f64,
    pub percent_used: f64,
    pub next_reset_at: Option<String>,
    pub days_until_reset: Option<i64>,
    pub overage_status: Option<String>,
    pub currency: Option<String>,
    pub email: Option<String>,
}

pub struct Auth {
    pub sso_cache_dir: PathBuf,
    pub profile_arn_override: Option<String>,
    pub management_url: String,
    pub http: Client,
    cache: Mutex<AuthCache>,
}

impl Auth {
    pub fn new(
        sso_cache_dir: PathBuf,
        profile_arn_override: Option<String>,
        _runtime_url: String,
        management_url: String,
    ) -> Self {
        let http = Client::builder()
            .timeout(Duration::from_secs(KIRO_HTTP_TIMEOUT_SECS))
            .build()
            .unwrap_or_else(|_| Client::new());
        Self {
            sso_cache_dir,
            profile_arn_override,
            management_url,
            http,
            cache: Mutex::new(AuthCache::default()),
        }
    }

    fn sso_token_path(&self) -> PathBuf {
        self.sso_cache_dir.join("kiro-auth-token.json")
    }

    fn read_sso_token(&self) -> Option<Value> {
        let path = self.sso_token_path();
        if !path.exists() {
            return None;
        }
        fs::read_to_string(&path)
            .ok()
            .and_then(|content| serde_json::from_str(&content).ok())
    }

    fn read_client_registration(&self, token: &Value) -> Option<Value> {
        let client_id_hash = token.get("clientIdHash").and_then(|v| v.as_str())?;
        let path = self.sso_cache_dir.join(format!("{client_id_hash}.json"));
        if !path.exists() {
            return None;
        }
        fs::read_to_string(&path)
            .ok()
            .and_then(|content| serde_json::from_str(&content).ok())
    }

    fn write_sso_token_to(&self, path: &PathBuf, clean: &Value) -> Result<(), String> {
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent)
                .map_err(|e| format!("Failed to create SSO cache dir: {e}"))?;
        }
        let tmp_path = path.with_extension(format!("tmp.{}", std::process::id()));
        let mut file = fs::File::create(&tmp_path)
            .map_err(|e| format!("Failed to create token temp file: {e}"))?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mut perms = file
                .metadata()
                .map(|m| m.permissions())
                .map_err(|e| format!("Failed to stat token file: {e}"))?;
            perms.set_mode(0o600);
            let _ = file.set_permissions(perms);
        }
        writeln!(file, "{}", serde_json::to_string_pretty(clean).map_err(|e| e.to_string())?)
            .map_err(|e| format!("Failed to write token file: {e}"))?;
        file.sync_all()
            .map_err(|e| format!("Failed to sync token file: {e}"))?;
        drop(file);
        fs::rename(&tmp_path, path).map_err(|e| format!("Failed to rename token file: {e}"))
    }

    fn write_sso_token(&self, token: &Value) -> Result<(), String> {
        let mut clean = token.clone();
        if let Some(obj) = clean.as_object_mut() {
            obj.remove("cachePath");
        }
        // 始终写入规范路径，保证 get_sso_token_expiry / kiro_status 读到最新 expiresAt
        let canonical = self.sso_token_path();
        self.write_sso_token_to(&canonical, &clean)?;
        // 若 token 自带 cachePath 且与规范路径不同，同步一份给 IDE/CLI
        if let Some(extra) = token
            .get("cachePath")
            .and_then(|v| v.as_str())
            .map(PathBuf::from)
        {
            if extra != canonical {
                let _ = self.write_sso_token_to(&extra, &clean);
            }
        }
        Ok(())
    }

    fn is_fresh_expires_at(expires_at: Option<&str>) -> bool {
        let Some(expires_at) = expires_at else {
            return false;
        };
        let Some(expires_ms) = parse_expiry_ms(expires_at) else {
            return false;
        };
        expires_ms > now_ms() + TOKEN_REFRESH_SKEW_SECS * 1000
    }

    fn token_response_to_cache(&self, token: &Value, response: &Value) -> Result<Value, String> {
        let access_token = response
            .get("accessToken")
            .or_else(|| response.get("access_token"))
            .and_then(|v| v.as_str())
            .ok_or_else(|| "Token refresh response did not include accessToken.".to_string())?;
        let refresh_token = response
            .get("refreshToken")
            .or_else(|| response.get("refresh_token"))
            .and_then(|v| v.as_str())
            .map(|s| s.to_string())
            .or_else(|| token.get("refreshToken").and_then(|v| v.as_str()).map(|s| s.to_string()));
        let expires_in = response
            .get("expiresIn")
            .or_else(|| response.get("expires_in"))
            .and_then(|v| v.as_i64())
            .unwrap_or(3600);

        let mut result = token.clone();
        if let Some(obj) = result.as_object_mut() {
            obj.insert("accessToken".to_string(), Value::String(access_token.to_string()));
            if let Some(refresh_token) = refresh_token {
                obj.insert("refreshToken".to_string(), Value::String(refresh_token));
            }
            let expires_at = (Utc::now() + chrono::Duration::seconds(expires_in))
                .to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
            obj.insert("expiresAt".to_string(), Value::String(expires_at));
        }
        Ok(result)
    }

    fn refresh_idc(&self, token: &Value) -> Result<Value, String> {
        let client_registration = self.read_client_registration(token);
        let (client_id, client_secret) = match client_registration.as_ref() {
            Some(registration) => (
                registration.get("clientId").and_then(|v| v.as_str()),
                registration.get("clientSecret").and_then(|v| v.as_str()),
            ),
            None => (None, None),
        };
        let (Some(client_id), Some(client_secret)) = (client_id, client_secret) else {
            return Err("SSO access token expired, but no valid client registration was found.".to_string());
        };
        if !Self::is_fresh_expires_at(
            client_registration.as_ref().and_then(|r| r.get("expiresAt")).and_then(|v| v.as_str()),
        ) {
            return Err("SSO client registration expired. Reopen Kiro and sign in again.".to_string());
        }

        let region = token.get("region").and_then(|v| v.as_str()).unwrap_or("us-east-1");
        let response = self
            .http
            .post(format!("https://oidc.{region}.amazonaws.com/token"))
            .header("accept", "application/json")
            .header("content-type", "application/json")
            .header("user-agent", "KiroIDE")
            .json(&json!({
                "clientId": client_id,
                "clientSecret": client_secret,
                "grantType": "refresh_token",
                "refreshToken": token.get("refreshToken").and_then(|v| v.as_str()).unwrap_or(""),
            }))
            .send()
            .map_err(|e| format!("SSO OIDC refresh request failed: {e}"))?;

        let status = response.status();
        let text = response.text().unwrap_or_default();
        let data: Value = if text.trim().is_empty() {
            json!({})
        } else {
            serde_json::from_str(&text).unwrap_or_else(|_| json!({ "message": text }))
        };

        if !status.is_success() {
            let message = data
                .get("error_description")
                .or_else(|| data.get("message"))
                .or_else(|| data.get("error"))
                .and_then(|v| v.as_str())
                .map(|s| s.to_string())
                .unwrap_or_else(|| format!("SSO OIDC refresh failed: {status}"));
            return Err(message);
        }

        let mut refreshed = self.token_response_to_cache(token, &data)?;
        if let Some(obj) = refreshed.as_object_mut() {
            obj.insert("authMethod".to_string(), Value::String("IdC".to_string()));
            obj.insert("provider".to_string(), token.get("provider").cloned().unwrap_or(Value::Null));
            obj.insert("region".to_string(), Value::String(region.to_string()));
        }
        self.write_sso_token(&refreshed)?;
        Ok(refreshed)
    }

    fn refresh_social(&self, token: &Value) -> Result<Value, String> {
        let auth_service_url = "https://prod.us-east-1.auth.desktop.kiro.dev";
        let response = self
            .http
            .post(format!("{auth_service_url}/refreshToken"))
            .header("accept", "application/json")
            .header("content-type", "application/json")
            .header("user-agent", "KiroIDE")
            .json(&json!({
                "refreshToken": token.get("refreshToken").and_then(|v| v.as_str()).unwrap_or(""),
            }))
            .send()
            .map_err(|e| format!("Kiro auth refresh request failed: {e}"))?;

        let status = response.status();
        let text = response.text().unwrap_or_default();
        let data: Value = if text.trim().is_empty() {
            json!({})
        } else {
            serde_json::from_str(&text).unwrap_or_else(|_| json!({ "message": text }))
        };

        if !status.is_success() {
            let message = data
                .get("message")
                .or_else(|| data.get("error_description"))
                .or_else(|| data.get("error"))
                .and_then(|v| v.as_str())
                .map(|s| s.to_string())
                .unwrap_or_else(|| format!("Kiro auth refresh failed: {status}"));
            return Err(message);
        }

        let mut refreshed = self.token_response_to_cache(token, &data)?;
        if let Some(obj) = refreshed.as_object_mut() {
            obj.insert(
                "authMethod".to_string(),
                Value::String(
                    token.get("authMethod").and_then(|v| v.as_str()).unwrap_or("social").to_string(),
                ),
            );
            obj.insert("provider".to_string(), token.get("provider").cloned().unwrap_or(Value::Null));
            if let Some(profile_arn) = data
                .get("profileArn")
                .and_then(|v| v.as_str())
                .or_else(|| token.get("profileArn").and_then(|v| v.as_str()))
            {
                obj.insert("profileArn".to_string(), Value::String(profile_arn.to_string()));
            }
        }
        self.write_sso_token(&refreshed)?;
        Ok(refreshed)
    }

    fn refresh_sso_token(&self, token: &Value) -> Result<Value, String> {
        if token.get("refreshToken").and_then(|v| v.as_str()).is_none() {
            return Err("SSO access token expired, and no refreshToken was found.".to_string());
        }
        match token.get("authMethod").and_then(|v| v.as_str()) {
            Some("IdC") => self.refresh_idc(token),
            Some("social") => self.refresh_social(token),
            other => Err(format!(
                "Unsupported authMethod for refresh: {}",
                other.unwrap_or("unknown")
            )),
        }
    }

    fn get_fresh_sso_token(&self) -> Result<Option<Value>, String> {
        let token = self.read_sso_token();
        let Some(token) = token else {
            return Ok(None);
        };
        if token.get("accessToken").and_then(|v| v.as_str()).is_none()
            && token.get("refreshToken").and_then(|v| v.as_str()).is_none()
        {
            return Ok(None);
        }
        if token.get("accessToken").and_then(|v| v.as_str()).is_some()
            && Self::is_fresh_expires_at(token.get("expiresAt").and_then(|v| v.as_str()))
        {
            return Ok(Some(token));
        }
        let refreshed = self.refresh_sso_token(&token)?;
        Ok(Some(refreshed))
    }

    fn get_env_authorization() -> Option<String> {
        if let Ok(value) = std::env::var("KIRO_AUTHORIZATION") {
            if !value.trim().is_empty() {
                return Some(value);
            }
        }
        if let Ok(value) = std::env::var("KIRO_ACCESS_TOKEN") {
            if !value.trim().is_empty() {
                let trimmed = value.trim();
                return Some(if trimmed.starts_with("Bearer ") {
                    trimmed.to_string()
                } else {
                    format!("Bearer {trimmed}")
                });
            }
        }
        None
    }

    fn is_valid_profile_arn(arn: &str) -> bool {
        regex::Regex::new(PROFILE_ARN_RE)
            .map(|re| re.is_match(arn))
            .unwrap_or(false)
    }

    fn get_profile_arn_region(arn: &str) -> Option<String> {
        if !Self::is_valid_profile_arn(arn) {
            return None;
        }
        arn.split(':').nth(3).map(|s| s.to_string())
    }

    pub fn get_sso_profile_arn(&self) -> Option<String> {
        if let Some(cached) = self.cache.lock().ok().and_then(|c| c.cached_profile_arn.clone()) {
            return Some(cached);
        }
        let token = self.read_sso_token();
        let arn = token
            .and_then(|t| t.get("profileArn").and_then(|v| v.as_str()).map(|s| s.to_string()))
            .or_else(|| self.profile_arn_override.clone());
        arn.filter(|arn| Self::is_valid_profile_arn(arn))
    }

    /// 自动发现 Profile ARN（多种 Kiro/CodeWhisperer 端点形状依次尝试）。
    pub fn discover_profile_arn(&self) -> Result<Option<String>, String> {
        if let Some(cached) = self.cache.lock().ok().and_then(|c| c.cached_profile_arn.clone()) {
            return Ok(Some(cached));
        }
        let token = self.read_sso_token();
        if let Some(arn) = token
            .as_ref()
            .and_then(|t| t.get("profileArn").and_then(|v| v.as_str()))
            .filter(|arn| Self::is_valid_profile_arn(arn))
        {
            if let Ok(mut cache) = self.cache.lock() {
                cache.cached_profile_arn = Some(arn.to_string());
            }
            return Ok(Some(arn.to_string()));
        }
        if let Some(arn) = self
            .profile_arn_override
            .as_deref()
            .filter(|arn| Self::is_valid_profile_arn(arn))
        {
            if let Ok(mut cache) = self.cache.lock() {
                cache.cached_profile_arn = Some(arn.to_string());
            }
            return Ok(Some(arn.to_string()));
        }

        let Some(auth_header) = self.get_authorization()? else {
            return Ok(None);
        };
        let region = token
            .as_ref()
            .and_then(|t| t.get("region").and_then(|v| v.as_str()))
            .map(|s| s.to_string())
            .or_else(|| {
                self.profile_arn_override
                    .as_deref()
                    .and_then(Self::get_profile_arn_region)
            })
            .unwrap_or_else(|| "us-east-1".to_string());

        let management_url = self.management_url.trim_end_matches('/');
        let attempts: Vec<(String, &str, Option<Value>)> = vec![
            (
                format!("{management_url}/ListAvailableProfiles"),
                "POST",
                Some(json!({})),
            ),
            (format!("{management_url}/ListAvailableProfiles"), "GET", None),
            (
                format!("https://codewhisperer.{region}.amazonaws.com/ListAvailableProfiles"),
                "POST",
                Some(json!({})),
            ),
            (
                format!("https://codewhisperer.{region}.amazonaws.com/ListAvailableProfiles"),
                "GET",
                None,
            ),
        ];

        for (url, method, body) in attempts {
            let mut request = self
                .http
                .request(reqwest::Method::from_bytes(method.as_bytes()).unwrap(), &url)
                .header("authorization", &auth_header)
                .header("tokentype", "SSO_OIDC")
                .header("user-agent", "KiroIDE");
            if method == "POST" {
                request = request.header("content-type", "application/json");
                if let Some(body) = &body {
                    request = request.json(body);
                }
            }
            match request.send() {
                Ok(response) => {
                    let status = response.status();
                    let text = response.text().unwrap_or_default();
                    if !status.is_success() {
                        continue;
                    }
                    let data: Value = serde_json::from_str(&text).unwrap_or_else(|_| json!({}));
                    let profiles = data
                        .get("profiles")
                        .or_else(|| data.get("profileSummaries"))
                        .or_else(|| data.get("availableProfiles"))
                        .or_else(|| data.get("items"))
                        .and_then(|v| v.as_array())
                        .cloned()
                        .unwrap_or_default();
                    let arns: Vec<String> = profiles
                        .iter()
                        .filter_map(|p| p.get("arn").and_then(|v| v.as_str()))
                        .filter(|arn| Self::is_valid_profile_arn(arn))
                        .map(|s| s.to_string())
                        .collect();
                    let arn = arns
                        .iter()
                        .find(|arn| Self::get_profile_arn_region(arn).as_deref() == Some(region.as_str()))
                        .or_else(|| arns.first())
                        .cloned()
                        .or_else(|| {
                            data.get("profileArn")
                                .and_then(|v| v.as_str())
                                .filter(|arn| Self::is_valid_profile_arn(arn))
                                .map(|s| s.to_string())
                        });
                    if let Some(arn) = arn {
                        if let Ok(mut cache) = self.cache.lock() {
                            cache.cached_profile_arn = Some(arn.clone());
                        }
                        return Ok(Some(arn));
                    }
                }
                Err(_) => continue,
            }
        }
        Ok(None)
    }

    /// 获取 `Bearer <access_token>`，必要时自动刷新。
    pub fn get_authorization(&self) -> Result<Option<String>, String> {
        if let Some(env_auth) = Self::get_env_authorization() {
            return Ok(Some(env_auth));
        }
        let sso_token = self.read_sso_token();
        if sso_token.is_some() {
            if let Some(fresh) = self.get_fresh_sso_token()? {
                if let Some(access_token) = fresh.get("accessToken").and_then(|v| v.as_str()) {
                    return Ok(Some(format!("Bearer {access_token}")));
                }
            }
        }
        Ok(None)
    }

    /// 认证失败后强制刷新一次 token，返回是否刷新成功。
    pub fn refresh_after_auth_failure(&self) -> Result<bool, String> {
        if Self::get_env_authorization().is_some() {
            return Ok(false);
        }
        if let Some(token) = self.read_sso_token() {
            if token.get("refreshToken").and_then(|v| v.as_str()).is_some() {
                self.refresh_sso_token(&token)?;
                return Ok(true);
            }
        }
        Ok(false)
    }

    /// 强制刷新 SSO。成功时返回 `(true, 新的 expiresAt)`，便于调用方直接回传 UI。
    pub fn force_refresh(&self) -> Result<(bool, Option<String>), String> {
        if let Some(token) = self.read_sso_token() {
            if token.get("refreshToken").and_then(|v| v.as_str()).is_some() {
                let refreshed = self.refresh_sso_token(&token)?;
                let expires = refreshed
                    .get("expiresAt")
                    .and_then(|v| v.as_str())
                    .map(|s| s.to_string());
                return Ok((true, expires));
            }
        }
        Ok((false, self.get_sso_token_expiry()))
    }

    pub fn describe_auth_source(&self) -> String {
        if Self::get_env_authorization().is_some() {
            return "环境变量 KIRO_AUTHORIZATION/KIRO_ACCESS_TOKEN".to_string();
        }
        if let Some(token) = self.read_sso_token() {
            if token.get("accessToken").and_then(|v| v.as_str()).is_some()
                || token.get("refreshToken").and_then(|v| v.as_str()).is_some()
            {
                let expires = token
                    .get("expiresAt")
                    .and_then(|v| v.as_str())
                    .map(|s| format!("，过期 {s}"))
                    .unwrap_or_default();
                return format!(
                    "Kiro SSO 共享缓存（IDE/CLI 共用，{}）{expires}",
                    self.sso_token_path().display()
                );
            }
        }
        "未找到 Kiro 凭据".to_string()
    }

    pub fn get_sso_token_expiry(&self) -> Option<String> {
        self.read_sso_token()
            .and_then(|t| t.get("expiresAt").and_then(|v| v.as_str()).map(|s| s.to_string()))
    }

    /// 拉取当前账户可用模型列表（Kiro 模型 ID），带缓存。
    /// 账户套餐可能不含 Claude 模型（如仅有 GPT/DeepSeek/GLM 等），
    /// 代理据此做默认模型与降级选择，避免向 Kiro 请求不可用模型。
    pub fn list_available_models(&self) -> Result<Vec<String>, String> {
        if let Some(cached) = self.cache.lock().ok().and_then(|c| c.cached_available_models.clone()) {
            return Ok(cached);
        }
        let profile_arn = match self.get_sso_profile_arn() {
            Some(arn) => arn,
            None => match self.discover_profile_arn()? {
                Some(arn) => arn,
                None => return Ok(Vec::new()),
            },
        };
        let Some(auth_header) = self.get_authorization()? else {
            return Ok(Vec::new());
        };
        let management_url = self.management_url.trim_end_matches('/');
        let response = self
            .http
            .post(format!("{management_url}/ListAvailableModels"))
            .header("authorization", &auth_header)
            .header("tokentype", "SSO_OIDC")
            .header("content-type", "application/x-amz-json-1.0")
            .header("x-amz-target", "KiroControlPlaneBearerService.ListAvailableModels")
            .header("user-agent", "KiroIDE")
            .json(&json!({ "origin": "AI_EDITOR", "profileArn": profile_arn }))
            .send()
            .map_err(|e| format!("ListAvailableModels request failed: {e}"))?;
        let status = response.status();
        let data: Value = response.json().unwrap_or_else(|_| json!({}));
        if !status.is_success() {
            return Err(format!("ListAvailableModels failed: {status}"));
        }
        let mut ids: Vec<String> = Vec::new();
        if let Some(models) = data.get("models").and_then(|v| v.as_array()) {
            for model in models {
                if let Some(id) = model.get("modelId").and_then(|v| v.as_str()) {
                    if !ids.iter().any(|existing| existing == id) {
                        ids.push(id.to_string());
                    }
                }
            }
        }
        if let Ok(mut cache) = self.cache.lock() {
            cache.cached_available_models = Some(ids.clone());
        }
        Ok(ids)
    }

    /// 从可用模型里挑一个稳妥默认：优先 Claude 系（最贴近 Anthropic 语义），
    /// 否则退回第一个可用模型。失败或为空时返回 None，由调用方回退到内置默认。
    pub fn pick_available_default_model(&self) -> Option<String> {
        let models = self.list_available_models().ok()?;
        if models.is_empty() {
            return None;
        }
        let claude = models
            .iter()
            .find(|m| m.starts_with("claude-"))
            .cloned()
            .or_else(|| models.iter().find(|m| m.to_lowercase().contains("opus")).cloned())
            .or_else(|| models.iter().find(|m| m.to_lowercase().contains("sonnet")).cloned());
        Some(claude.unwrap_or_else(|| models[0].clone()))
    }

    /// 查询当前账户 Kiro Credits 额度（不消耗额度）。
    ///
    /// `GET https://q.{region}.amazonaws.com/getUsageLimits?...`
    pub fn get_usage_limits(&self) -> Result<KiroUsageInfo, String> {
        let Some(auth_header) = self.get_authorization()? else {
            return Err("未找到 Kiro 凭据，请先登录 Kiro IDE".to_string());
        };
        let profile_arn = match self.get_sso_profile_arn() {
            Some(arn) => arn,
            None => match self.discover_profile_arn()? {
                Some(arn) => arn,
                None => return Err("未找到 Profile ARN，无法查询额度".to_string()),
            },
        };
        let region = Self::get_profile_arn_region(&profile_arn)
            .or_else(|| {
                self.read_sso_token()
                    .and_then(|t| t.get("region").and_then(|v| v.as_str()).map(|s| s.to_string()))
            })
            .unwrap_or_else(|| "us-east-1".to_string());

        let mut url = reqwest::Url::parse(&format!(
            "https://q.{region}.amazonaws.com/getUsageLimits"
        ))
        .map_err(|e| format!("构造额度查询 URL 失败: {e}"))?;
        {
            let mut pairs = url.query_pairs_mut();
            pairs.append_pair("isEmailRequired", "true");
            pairs.append_pair("origin", "AI_EDITOR");
            pairs.append_pair("resourceType", "AGENTIC_REQUEST");
            pairs.append_pair("profileArn", &profile_arn);
        }

        let mut request = self
            .http
            .get(url)
            .header("authorization", &auth_header)
            .header("accept", "application/json")
            .header("user-agent", "KiroIDE");

        // Social / 外部 IdP 账户需要 TokenType，否则部分区域会 403
        if let Some(token) = self.read_sso_token() {
            let auth_method = token
                .get("authMethod")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_ascii_lowercase();
            if auth_method == "social" || auth_method.contains("external") {
                request = request.header("TokenType", "EXTERNAL_IDP");
            }
        }

        let response = request
            .send()
            .map_err(|e| format!("查询 Kiro 额度失败: {e}"))?;
        let status = response.status();
        let data: Value = response.json().unwrap_or_else(|_| json!({}));
        if !status.is_success() {
            let reason = data
                .get("reason")
                .and_then(|v| v.as_str())
                .or_else(|| data.get("message").and_then(|v| v.as_str()))
                .unwrap_or("");
            return Err(if reason.is_empty() {
                format!("查询 Kiro 额度失败: HTTP {status}")
            } else {
                format!("查询 Kiro 额度失败: HTTP {status} ({reason})")
            });
        }

        Ok(parse_kiro_usage_limits(&data))
    }
}

fn json_f64(value: &Value) -> Option<f64> {
    value
        .as_f64()
        .or_else(|| value.as_i64().map(|n| n as f64))
        .or_else(|| value.as_u64().map(|n| n as f64))
        .or_else(|| value.as_str().and_then(|s| s.parse::<f64>().ok()))
}

fn format_epoch_reset(value: &Value) -> Option<String> {
    if let Some(s) = value.as_str() {
        if !s.trim().is_empty() {
            return Some(s.to_string());
        }
    }
    let ts = json_f64(value)?;
    // 上游可能返回秒或毫秒 epoch（含科学计数法 float）
    let secs = if ts > 10_000_000_000.0 {
        (ts / 1000.0) as i64
    } else {
        ts as i64
    };
    // 过滤 day-of-month 等非 epoch 小数（如 1），避免解析成 1970
    if secs < 1_600_000_000 {
        return None;
    }
    DateTime::from_timestamp(secs, 0).map(|dt| dt.to_rfc3339())
}

/// 由重置时间推算剩余整天数（向上取整；已过期为 0）。
fn days_until_reset_from_at(reset_at: &str) -> Option<i64> {
    let reset_ms = parse_expiry_ms(reset_at)?;
    let remaining_ms = reset_ms - now_ms();
    if remaining_ms <= 0 {
        return Some(0);
    }
    Some((remaining_ms + 86_400_000 - 1) / 86_400_000)
}

fn parse_kiro_usage_limits(data: &Value) -> KiroUsageInfo {
    let subscription = data.get("subscriptionInfo").cloned().unwrap_or(Value::Null);
    let overage = data
        .get("overageConfiguration")
        .cloned()
        .unwrap_or(Value::Null);
    let user = data.get("userInfo").cloned().unwrap_or(Value::Null);

    let breakdowns = data
        .get("usageBreakdownList")
        .or_else(|| data.get("usageBreakdowns"))
        .and_then(|v| v.as_array())
        .cloned()
        .unwrap_or_default();

    let credit = breakdowns
        .iter()
        .find(|item| {
            item.get("resourceType")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .eq_ignore_ascii_case("CREDIT")
                || item
                    .get("type")
                    .and_then(|v| v.as_str())
                    .unwrap_or("")
                    .eq_ignore_ascii_case("CREDIT")
        })
        .or_else(|| breakdowns.first())
        .cloned()
        .unwrap_or(Value::Null);

    let current_usage = credit
        .get("currentUsageWithPrecision")
        .and_then(json_f64)
        .or_else(|| credit.get("currentUsage").and_then(json_f64))
        .unwrap_or(0.0);
    let usage_limit = credit
        .get("usageLimitWithPrecision")
        .and_then(json_f64)
        .or_else(|| credit.get("usageLimit").and_then(json_f64))
        .unwrap_or(0.0);
    let remaining = (usage_limit - current_usage).max(0.0);
    let percent_used = if usage_limit > 0.0 {
        (current_usage / usage_limit * 100.0).clamp(0.0, 100.0)
    } else {
        0.0
    };

    let next_reset_at = data
        .get("nextDateReset")
        .and_then(format_epoch_reset)
        .or_else(|| credit.get("nextDateReset").and_then(format_epoch_reset))
        .or_else(|| credit.get("resetDate").and_then(|v| v.as_str().map(|s| s.to_string())));

    // 上游经常返回 daysUntilReset=0，真实周期在 nextDateReset；优先按重置时间推算。
    let upstream_days = data
        .get("daysUntilReset")
        .and_then(|v| v.as_i64().or_else(|| json_f64(v).map(|n| n as i64)));
    let computed_days = next_reset_at
        .as_deref()
        .and_then(days_until_reset_from_at);
    let days_until_reset = match (upstream_days, computed_days) {
        (_, Some(computed)) if computed > 0 => Some(computed),
        (Some(upstream), Some(computed)) if upstream > 0 => Some(upstream.max(computed)),
        (Some(upstream), None) if upstream > 0 => Some(upstream),
        (_, Some(computed)) => Some(computed),
        (Some(upstream), None) => Some(upstream),
        _ => None,
    };

    KiroUsageInfo {
        subscription_title: subscription
            .get("subscriptionTitle")
            .and_then(|v| v.as_str())
            .map(|s| s.to_string()),
        subscription_type: subscription
            .get("type")
            .and_then(|v| v.as_str())
            .map(|s| s.to_string()),
        current_usage,
        usage_limit,
        remaining,
        percent_used,
        next_reset_at,
        days_until_reset,
        overage_status: overage
            .get("overageStatus")
            .and_then(|v| v.as_str())
            .map(|s| s.to_string()),
        currency: credit
            .get("currency")
            .and_then(|v| v.as_str())
            .map(|s| s.to_string()),
        email: user
            .get("email")
            .and_then(|v| v.as_str())
            .map(|s| s.to_string()),
    }
}

fn now_ms() -> i64 {
    Utc::now().timestamp_millis()
}

/// 解析过期时间：优先 RFC3339，其次 epoch 毫秒/秒。
fn parse_expiry_ms(value: &str) -> Option<i64> {
    if let Ok(dt) = DateTime::parse_from_rfc3339(value) {
        return Some(dt.timestamp_millis());
    }
    if let Ok(ms) = value.trim().parse::<f64>() {
        if ms > 1e12 {
            return Some(ms as i64);
        }
        return Some((ms * 1000.0) as i64);
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn usage_prefers_next_date_when_days_is_zero() {
        // 约 20 天后
        let reset_secs = Utc::now().timestamp() + 20 * 86_400;
        let data = json!({
            "daysUntilReset": 0,
            "nextDateReset": reset_secs as f64,
            "subscriptionInfo": { "subscriptionTitle": "KIRO PRO", "type": "Q_DEVELOPER_STANDALONE_PRO" },
            "usageBreakdownList": [{
                "resourceType": "CREDIT",
                "currentUsage": 10,
                "usageLimit": 1000
            }]
        });
        let info = parse_kiro_usage_limits(&data);
        assert!(info.days_until_reset.unwrap_or(0) >= 19);
        assert!(info.days_until_reset.unwrap_or(0) <= 21);
        assert!(info.next_reset_at.is_some());
    }

    #[test]
    fn usage_ignores_day_of_month_as_epoch() {
        let data = json!({
            "daysUntilReset": 0,
            "nextDateReset": 1,
            "usageBreakdownList": [{ "resourceType": "CREDIT", "currentUsage": 1, "usageLimit": 50 }]
        });
        let info = parse_kiro_usage_limits(&data);
        assert!(info.next_reset_at.is_none());
    }
}
