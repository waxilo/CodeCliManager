//! Kiro IDE SSO 认证：读取 `~/.aws/sso/cache/kiro-auth-token.json`，
//! 支持 IdC / Social 两种 OIDC token 刷新，并自动发现 Profile ARN。
//! 移植自 kiro2cli/src/auth.js（MIT）。

use std::fs;
use std::io::Write;
use std::path::PathBuf;
use std::sync::Mutex;

use chrono::{DateTime, Utc};
use reqwest::blocking::Client;
use serde_json::{json, Value};

const TOKEN_REFRESH_SKEW_SECS: i64 = 120;
const PROFILE_ARN_RE: &str = r"^arn:aws[a-z-]*:codewhisperer:[a-z0-9-]+:\d{12}:profile/[A-Za-z0-9_-]+$";

#[derive(Default)]
struct AuthCache {
    cached_profile_arn: Option<String>,
    cached_available_models: Option<Vec<String>>,
}

pub struct Auth {
    pub sso_cache_dir: PathBuf,
    pub profile_arn_override: Option<String>,
    pub runtime_url: String,
    pub management_url: String,
    pub http: Client,
    cache: Mutex<AuthCache>,
}

impl Auth {
    pub fn new(
        sso_cache_dir: PathBuf,
        profile_arn_override: Option<String>,
        runtime_url: String,
        management_url: String,
    ) -> Self {
        Self {
            sso_cache_dir,
            profile_arn_override,
            runtime_url,
            management_url,
            http: Client::new(),
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

    fn write_sso_token(&self, token: &Value) -> Result<(), String> {
        let cache_path = token
            .get("cachePath")
            .and_then(|v| v.as_str())
            .map(PathBuf::from)
            .unwrap_or_else(|| self.sso_token_path());
        let mut clean = token.clone();
        if let Some(obj) = clean.as_object_mut() {
            obj.remove("cachePath");
        }
        let tmp_path = cache_path.with_extension(format!("tmp.{}", std::process::id()));
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
        writeln!(file, "{}", serde_json::to_string_pretty(&clean).map_err(|e| e.to_string())?)
            .map_err(|e| format!("Failed to write token file: {e}"))?;
        drop(file);
        fs::rename(&tmp_path, &cache_path).map_err(|e| format!("Failed to rename token file: {e}"))
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

    pub fn force_refresh(&self) -> Result<bool, String> {
        if let Some(token) = self.read_sso_token() {
            if token.get("refreshToken").and_then(|v| v.as_str()).is_some() {
                self.refresh_sso_token(&token)?;
                return Ok(true);
            }
        }
        Ok(false)
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
                return format!("Kiro IDE SSO 缓存（{}）{expires}", self.sso_token_path().display());
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
