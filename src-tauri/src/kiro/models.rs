//! 模型名映射、effort 归一化与 token 估算。
//! 移植自 kiro2cli/src/models.js + utils.js 中的 estimateTokens（MIT）。

use serde_json::Value;

/// Kiro 内置模型名（public 名称）。
pub fn is_known_kiro_model(model: &str) -> bool {
    matches!(
        model,
        "auto"
            | "claude-sonnet-5"
            | "claude-opus-5"
            | "claude-opus-4.8"
            | "gpt-5.6-sol"
            | "gpt-5.6-terra"
            | "gpt-5.6-luna"
            | "claude-opus-4.7"
            | "claude-opus-4.6"
            | "claude-sonnet-4.6"
            | "claude-opus-4.5"
            | "claude-sonnet-4.5"
            | "claude-sonnet-4"
            | "claude-haiku-4.5"
            | "deepseek-3.2"
            | "minimax-m2.5"
            | "minimax-m2.1"
            | "glm-5"
            | "qwen3-coder-next"
    )
}

/// 模型支持的 effort 级别（none/low/medium/high/xhigh/max）。
pub fn effort_levels_for_model(kiro_model: &str) -> &'static [&'static str] {
    match kiro_model {
        "claude-sonnet-5" | "claude-opus-5" | "claude-opus-4.8" | "claude-opus-4.7" => {
            &["low", "medium", "high", "xhigh", "max"]
        }
        "claude-opus-4.6" | "claude-sonnet-4.6" => &["low", "medium", "high", "max"],
        "gpt-5.6-sol" | "gpt-5.6-terra" | "gpt-5.6-luna" => {
            &["none", "low", "medium", "high", "xhigh", "max"]
        }
        _ => &[],
    }
}

pub fn kiro_model_to_public_model_id(model_id: &str) -> String {
    if model_id == "claude-sonnet-4" {
        return "claude-sonnet-4-0".to_string();
    }
    if let Some((base, minor)) = model_id.split_once('.') {
        let parts: Vec<&str> = base.split('-').collect();
        if parts.len() == 3
            && parts[0] == "claude"
            && matches!(parts[1], "opus" | "sonnet" | "haiku")
            && parts[2] == "4"
        {
            return format!("{}-{}-{}-{}", parts[0], parts[1], parts[2], minor);
        }
    }
    model_id.to_string()
}

pub fn public_model_id_to_kiro_model(model_id: &str) -> String {
    if model_id == "claude-sonnet-4-0" {
        return "claude-sonnet-4".to_string();
    }
    let parts: Vec<&str> = model_id.split('-').collect();
    if parts.len() == 4
        && parts[0] == "claude"
        && matches!(parts[1], "opus" | "sonnet" | "haiku")
        && parts[2] == "4"
    {
        return format!("claude-{}-4.{}", parts[1], parts[3]);
    }
    model_id.to_string()
}

pub fn public_display_name(name: &str) -> String {
    name.strip_prefix("Claude ").unwrap_or(name).to_string()
}

fn get_effort_schema(schema: &Value) -> Option<&Value> {
    schema
        .get("properties")
        .and_then(|p| p.get("output_config"))
        .and_then(|oc| oc.get("properties"))
        .and_then(|p| p.get("effort"))
        .or_else(|| {
            schema
                .get("properties")
                .and_then(|p| p.get("reasoning"))
                .and_then(|r| r.get("properties"))
                .and_then(|p| p.get("effort"))
        })
}

pub fn get_supported_effort_levels(schema: &Value) -> Vec<String> {
    get_effort_schema(schema)
        .and_then(|effort| effort.get("enum"))
        .and_then(|values| values.as_array())
        .map(|values| {
            values
                .iter()
                .filter_map(|v| v.as_str())
                .map(|s| s.to_string())
                .collect()
        })
        .unwrap_or_default()
}

pub fn normalize_effort_for_kiro_model(effort: Option<&str>, kiro_model: &str) -> Option<String> {
    let effort = effort?;
    let supported = effort_levels_for_model(kiro_model);
    if supported.is_empty() {
        return None;
    }
    if supported.contains(&effort) {
        return Some(effort.to_string());
    }
    if effort == "xhigh" && supported.contains(&"max") {
        return Some("max".to_string());
    }
    if effort == "none" {
        return None;
    }
    None
}

pub fn normalize_effort_level(value: Option<&str>) -> Option<String> {
    let value = value?;
    let normalized: String = value
        .to_lowercase()
        .chars()
        .filter(|ch| !matches!(ch, '_' | ' ' | '-' | '\t'))
        .collect();
    let mapped = match normalized.as_str() {
        "none" => "none",
        "low" => "low",
        "medium" | "med" => "medium",
        "high" => "high",
        "xhigh" | "extrahigh" => "xhigh",
        "max" | "maximum" => "max",
        _ => return None,
    };
    Some(mapped.to_string())
}

/// 从请求体中提取用户请求的 effort（兼容各种字段名）。
pub fn get_requested_effort(body: &Value) -> Option<String> {
    let candidates = [
        body.get("effort"),
        body.get("effort_level"),
        body.get("reasoning_effort"),
        body.get("reasoning").and_then(|r| r.get("effort")),
        body.get("output_config").and_then(|oc| oc.get("effort")),
        body.get("additionalModelRequestFields")
            .and_then(|f| f.get("output_config"))
            .and_then(|oc| oc.get("effort")),
        body.get("additional_model_request_fields")
            .and_then(|f| f.get("output_config"))
            .and_then(|oc| oc.get("effort")),
    ];
    for candidate in candidates.into_iter().flatten() {
        if let Some(value) = candidate.as_str() {
            if let Some(normalized) = normalize_effort_level(Some(value)) {
                return Some(normalized);
            }
        }
    }
    None
}

/// 归一化请求中的模型名为 Kiro 内部模型名。
pub fn normalize_kiro_model(model: Option<&str>, default: &str) -> String {
    if let Ok(override_model) = std::env::var("KIRO_MODEL_OVERRIDE") {
        if !override_model.trim().is_empty() {
            return override_model;
        }
    }

    let model = match model {
        Some(model) => model,
        None => return default.to_string(),
    };

    let unprefixed = model.strip_prefix("kiro:").unwrap_or(model);
    let kiro_model = public_model_id_to_kiro_model(unprefixed);

    if is_known_kiro_model(&kiro_model) {
        return kiro_model;
    }

    let lower = unprefixed.to_lowercase();
    if lower.contains("opus") {
        return "claude-opus-5".to_string();
    }
    if lower.contains("haiku") {
        return "claude-haiku-4.5".to_string();
    }
    if lower.contains("sonnet") || lower.starts_with("claude-") {
        return "claude-sonnet-5".to_string();
    }
    default.to_string()
}

/// 粗略 token 估算：字符数 / 4（与 kiro2cli 一致）。
pub fn estimate_tokens(text: &str) -> i64 {
    let chars = text.chars().count() as i64;
    if chars == 0 {
        return 0;
    }
    ((chars + 3) / 4).max(1)
}
