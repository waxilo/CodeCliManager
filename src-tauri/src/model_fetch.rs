use reqwest::StatusCode;
use serde::Deserialize;
use std::time::Duration;

const FETCH_TIMEOUT_SECS: u64 = 15;
const ERROR_BODY_MAX_CHARS: usize = 512;

const KNOWN_COMPAT_SUFFIXES: &[&str] = &[
    "/api/claudecode",
    "/api/anthropic",
    "/apps/anthropic",
    "/api/coding",
    "/claudecode",
    "/anthropic",
    "/step_plan",
    "/coding",
    "/claude",
];

#[derive(Debug, Deserialize)]
struct ModelsResponse {
    data: Option<Vec<ModelEntry>>,
}

#[derive(Debug, Deserialize)]
struct ModelEntry {
    id: String,
    #[serde(default)]
    owned_by: Option<String>,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FetchedModel {
    pub id: String,
    pub owned_by: Option<String>,
}

pub fn build_models_url_candidates(base_url: &str) -> Result<Vec<String>, String> {
    let trimmed = base_url.trim().trim_end_matches('/');
    if trimmed.is_empty() {
        return Err("Base URL 不能为空".to_string());
    }

    let mut candidates = Vec::new();
    let primary = if trimmed.ends_with("/v1") {
        format!("{trimmed}/models")
    } else {
        format!("{trimmed}/v1/models")
    };
    candidates.push(primary);

    if let Some(stripped) = strip_compat_suffix(trimmed) {
        let root = stripped.trim_end_matches('/');
        if !root.is_empty() && root.contains("://") {
            candidates.push(format!("{root}/v1/models"));
            candidates.push(format!("{root}/models"));
        }
    }

    let mut unique = Vec::new();
    for url in candidates {
        if !unique.iter().any(|existing| existing == &url) {
            unique.push(url);
        }
    }
    Ok(unique)
}

fn strip_compat_suffix(base_url: &str) -> Option<&str> {
    for suffix in KNOWN_COMPAT_SUFFIXES {
        if base_url.ends_with(*suffix) {
            return Some(&base_url[..base_url.len() - suffix.len()]);
        }
    }
    None
}

fn truncate_body(body: String) -> String {
    if body.chars().count() <= ERROR_BODY_MAX_CHARS {
        body
    } else {
        let mut truncated: String = body.chars().take(ERROR_BODY_MAX_CHARS).collect();
        truncated.push('…');
        truncated
    }
}

pub async fn fetch_models(base_url: &str, api_key: &str) -> Result<Vec<FetchedModel>, String> {
    if api_key.trim().is_empty() {
        return Err("拉取模型需要填写 API Key".to_string());
    }

    let candidates = build_models_url_candidates(base_url)?;
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(FETCH_TIMEOUT_SECS))
        .build()
        .map_err(|e| format!("创建 HTTP 客户端失败: {e}"))?;

    let mut last_err: Option<String> = None;

    for url in &candidates {
        let response = match client
            .get(url)
            .header("Authorization", format!("Bearer {}", api_key.trim()))
            .header("x-api-key", api_key.trim())
            .header("anthropic-version", "2023-06-01")
            .send()
            .await
        {
            Ok(response) => response,
            Err(err) => return Err(format!("请求失败: {err}")),
        };

        let status = response.status();
        if status.is_success() {
            let resp: ModelsResponse = response
                .json()
                .await
                .map_err(|err| format!("解析模型列表失败: {err}"))?;

            let mut models = resp
                .data
                .unwrap_or_default()
                .into_iter()
                .map(|entry| FetchedModel {
                    id: entry.id,
                    owned_by: entry.owned_by,
                })
                .collect::<Vec<_>>();

            models.sort_by(|a, b| a.id.cmp(&b.id));
            if models.is_empty() {
                return Err("接口返回的模型列表为空".to_string());
            }
            return Ok(models);
        }

        let body = truncate_body(response.text().await.unwrap_or_default());
        if status == StatusCode::NOT_FOUND || status == StatusCode::METHOD_NOT_ALLOWED {
            last_err = Some(format!("HTTP {status}: {body}"));
            continue;
        }

        return Err(format!("HTTP {status}: {body}"));
    }

    Err(format!(
        "未找到可用的模型列表接口，已尝试: {}。{}",
        candidates.join(", "),
        last_err.unwrap_or_else(|| "无更多错误信息".to_string())
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn candidates_plain_root() {
        let urls = build_models_url_candidates("https://api.siliconflow.cn").unwrap();
        assert_eq!(urls, vec!["https://api.siliconflow.cn/v1/models"]);
    }

    #[test]
    fn candidates_anthropic_subpath() {
        let urls = build_models_url_candidates("https://api.deepseek.com/anthropic").unwrap();
        assert_eq!(
            urls,
            vec![
                "https://api.deepseek.com/anthropic/v1/models",
                "https://api.deepseek.com/v1/models",
                "https://api.deepseek.com/models",
            ]
        );
    }
}
