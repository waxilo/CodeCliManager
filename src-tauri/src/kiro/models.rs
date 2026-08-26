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
        "claude-sonnet-5"
        | "claude-opus-5"
        | "claude-opus-4.8"
        | "claude-opus-4.7"
        | "claude-opus-4.5"
        | "claude-sonnet-4.5"
        | "claude-sonnet-4"
        | "claude-haiku-4.5" => &["low", "medium", "high", "xhigh", "max"],
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

// ============ 模型能力抽象（schema 驱动） ============
//
// 目标：把「按模型名硬编码 is_claude / is_gpt 分支」替换成「按模型 schema /
// 能力配置决定哪些字段能发、怎么写」。当拿到 Kiro 的 additionalModelRequestFieldsSchema
// 时以其为唯一事实源；拿不到（或单元测试）时回退到按模型族的内置默认，保证既有行为不变。

/// 模型族。仅用于 schema 缺失时的回退默认与可读性；运行时以 schema 为准。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ModelFamily {
    Claude,
    Gpt,
    Deepseek,
    Other,
}

impl ModelFamily {
    pub fn classify(model: &str) -> ModelFamily {
        let model = model.trim();
        if model.starts_with("claude-") {
            ModelFamily::Claude
        } else if model.starts_with("gpt-") {
            ModelFamily::Gpt
        } else if model.starts_with("deepseek-") {
            ModelFamily::Deepseek
        } else {
            ModelFamily::Other
        }
    }
}

/// effort 该落到哪个字段：Claude 走 output_config.effort，GPT 走 reasoning.effort。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum EffortPlacement {
    OutputConfigEffort,
    ReasoningEffort,
    Unsupported,
}

/// 一个模型在 additionalModelRequestFields 方面的「已解析能力」。
/// schema 可用时由 schema 派生（唯一事实源）；否则回退到模型族默认。
#[derive(Debug, Clone)]
pub struct ModelProfile {
    pub family: ModelFamily,
    /// 是否接受顶层 max_tokens
    pub allow_max_tokens: bool,
    /// 是否接受顶层 thinking（adaptive/disabled）
    pub supports_thinking: bool,
    /// 是否接受顶层 output_config
    pub supports_output_config: bool,
    /// 是否接受顶层 reasoning
    pub supports_reasoning: bool,
    /// effort 的落位字段
    pub effort_placement: EffortPlacement,
    /// schema 顶层允许的字段白名单；None 表示 schema 未知，不做白名单过滤。
    pub allowed_fields: Option<Vec<String>>,
}

fn schema_has_property(schema: &Value, key: &str) -> bool {
    schema
        .get("properties")
        .and_then(|p| p.get(key))
        .is_some()
}

/// 从 schema 推断 effort 应放哪个字段（优先 output_config，其次 reasoning）。
fn schema_effort_placement(schema: &Value) -> EffortPlacement {
    let has_effort = |top: &str| {
        schema
            .get("properties")
            .and_then(|p| p.get(top))
            .and_then(|v| v.get("properties"))
            .and_then(|p| p.get("effort"))
            .is_some()
    };
    if has_effort("output_config") {
        EffortPlacement::OutputConfigEffort
    } else if has_effort("reasoning") {
        EffortPlacement::ReasoningEffort
    } else {
        EffortPlacement::Unsupported
    }
}

fn schema_allowed_fields(schema: &Value) -> Option<Vec<String>> {
    schema
        .get("properties")
        .and_then(|p| p.as_object())
        .map(|map| map.keys().cloned().collect())
}

fn default_profile(family: ModelFamily) -> ModelProfile {
    match family {
        ModelFamily::Claude => ModelProfile {
            family,
            allow_max_tokens: true,
            supports_thinking: true,
            supports_output_config: true,
            supports_reasoning: false,
            effort_placement: EffortPlacement::OutputConfigEffort,
            allowed_fields: None,
        },
        ModelFamily::Gpt => ModelProfile {
            family,
            allow_max_tokens: false,
            supports_thinking: false,
            supports_output_config: false,
            supports_reasoning: true,
            effort_placement: EffortPlacement::ReasoningEffort,
            allowed_fields: None,
        },
        ModelFamily::Deepseek | ModelFamily::Other => ModelProfile {
            family,
            allow_max_tokens: false,
            supports_thinking: true,
            supports_output_config: true,
            supports_reasoning: false,
            effort_placement: EffortPlacement::OutputConfigEffort,
            allowed_fields: None,
        },
    }
}

/// 解析模型能力：优先以 Kiro 返回的 additionalModelRequestFieldsSchema 为唯一事实源，
/// 缺省时回退到按模型族的内置默认（保证既有行为 + 单元测试不变）。
pub fn resolve_model_profile(kiro_model: &str, schema: Option<&Value>) -> ModelProfile {
    let family = ModelFamily::classify(kiro_model);
    match schema {
        Some(schema) if schema.is_object() => ModelProfile {
            family,
            allow_max_tokens: schema_has_property(schema, "max_tokens"),
            supports_thinking: schema_has_property(schema, "thinking"),
            supports_output_config: schema_has_property(schema, "output_config"),
            supports_reasoning: schema_has_property(schema, "reasoning"),
            effort_placement: schema_effort_placement(schema),
            allowed_fields: schema_allowed_fields(schema),
        },
        _ => default_profile(family),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn defaults_preserve_legacy_family_behavior() {
        let claude = resolve_model_profile("claude-sonnet-5", None);
        assert!(claude.allow_max_tokens);
        assert!(claude.supports_thinking);
        assert!(claude.supports_output_config);
        assert_eq!(claude.effort_placement, EffortPlacement::OutputConfigEffort);
        assert!(claude.allowed_fields.is_none());

        let gpt = resolve_model_profile("gpt-5.6-sol", None);
        assert!(!gpt.allow_max_tokens);
        assert!(!gpt.supports_thinking);
        assert!(!gpt.supports_output_config);
        assert!(gpt.supports_reasoning);
        assert_eq!(gpt.effort_placement, EffortPlacement::ReasoningEffort);

        let deepseek = resolve_model_profile("deepseek-3.2", None);
        assert!(!deepseek.allow_max_tokens);
        assert!(deepseek.supports_thinking);
        assert!(deepseek.supports_output_config);
    }

    #[test]
    fn schema_is_source_of_truth_for_fields() {
        // 一个「只认识 reasoning + effort」的 schema（类似 GPT）
        let schema = json!({
            "properties": {
                "reasoning": { "properties": { "effort": { "enum": ["none","low","medium","high","xhigh","max"] } } }
            }
        });
        let profile = resolve_model_profile("gpt-5.6-terra", Some(&schema));
        assert!(!profile.allow_max_tokens);
        assert!(!profile.supports_thinking);
        assert!(!profile.supports_output_config);
        assert!(profile.supports_reasoning);
        assert_eq!(profile.effort_placement, EffortPlacement::ReasoningEffort);
        let allowed = profile.allowed_fields.unwrap();
        assert_eq!(allowed, vec!["reasoning".to_string()]);
    }

    #[test]
    fn schema_output_config_effort_placement() {
        let schema = json!({
            "properties": {
                "max_tokens": { "type": "integer" },
                "thinking": { "type": "object" },
                "output_config": { "properties": { "effort": { "enum": ["low","medium","high"] } } }
            }
        });
        let profile = resolve_model_profile("claude-opus-5", Some(&schema));
        assert!(profile.allow_max_tokens);
        assert!(profile.supports_thinking);
        assert!(profile.supports_output_config);
        assert_eq!(profile.effort_placement, EffortPlacement::OutputConfigEffort);
        assert_eq!(profile.allowed_fields.unwrap().len(), 3);
    }
}
