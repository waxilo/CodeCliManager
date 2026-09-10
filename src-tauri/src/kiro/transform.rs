//! Anthropic/OpenAI ↔ Kiro 请求/响应转换。
//! 移植自 kiro2cli/src/transform.js（MIT）。

use serde_json::{json, Map, Value};
use uuid::Uuid;

use crate::kiro::models::{
    estimate_tokens, get_requested_effort, normalize_effort_for_kiro_model, resolve_model_profile,
    EffortPlacement, ModelProfile,
};
use crate::protocol_guard::normalize_stop_reason;

/// Anthropic content 块 → Kiro 的 {text, images}。
///
/// 工具结果不结构化：Kiro 的 GenerateAssistantResponse 不接受 `toolResults`/`toolUses`，
/// 因此 tool_result 直接摊平成文本（`[tool_result:<id>]\n<内容>`）进 text，与 kiro2cli 一致。
pub struct KiroContent {
    pub text: String,
    pub images: Vec<Value>,
}

// ============ 通用声明约束工具恢复 ============

const MAX_TOOL_RECOVERY_BYTES: usize = 512 * 1024;
const MAX_EXACT_NUMBER_DIGITS: usize = 1024;
const MAX_SCALED_NUMBER_DIGITS: usize = 2048;

#[derive(Clone, Debug, Default)]
pub struct ToolRecoverySpec {
    schemas: std::collections::HashMap<String, Value>,
}

impl ToolRecoverySpec {
    pub fn from_body(body: &Value) -> Self {
        let mut schemas = std::collections::HashMap::new();
        let Some(tools) = body.get("tools").and_then(Value::as_array) else {
            return Self { schemas };
        };
        for tool in tools {
            let function = tool.get("function").unwrap_or(tool);
            let Some(name) = function.get("name").and_then(Value::as_str).map(str::trim) else {
                continue;
            };
            if name.is_empty() {
                continue;
            }
            let schema = tool
                .get("input_schema")
                .or_else(|| function.get("parameters"))
                .cloned()
                .unwrap_or_else(|| json!({ "type": "object" }));
            schemas.insert(name.to_string(), schema);
        }
        Self { schemas }
    }

    pub fn is_empty(&self) -> bool {
        self.schemas.is_empty()
    }

    pub fn declares(&self, name: &str) -> bool {
        self.schemas.contains_key(name)
    }

    pub fn validates_input(&self, name: &str, input: &Value) -> bool {
        input.is_object()
            && self.schemas.get(name).is_some_and(|schema| schema_accepts(schema, input))
    }

    fn looks_like_protocol(&self, text: &str) -> bool {
        text.contains("\"tool_use\"")
            || (text.contains("\"id\"") && text.contains("\"input\""))
            || self.schemas.keys().any(|name| {
                text.contains(&format!("\"{name}\""))
                    && (text.contains("\"name\"") || text.contains("\"input\""))
            })
    }

    pub fn input_fingerprint(&self, block: &Value) -> Option<String> {
        let name = block.get("name")?.as_str()?;
        let input = block.get("input")?;
        self.validates_input(name, input)
            .then(|| format!("{name}\n{}", canonical_json(input)))
    }

    pub fn is_generated_recovery_id(block: &Value) -> bool {
        block
            .get("id")
            .and_then(Value::as_str)
            .is_some_and(|id| id.starts_with("call_recovered_"))
    }

    pub fn is_native_mirror(&self, recovered: &Value, native: &Value) -> bool {
        let same_id = recovered.get("id").and_then(Value::as_str)
            == native.get("id").and_then(Value::as_str);
        same_id
            || (Self::is_generated_recovery_id(recovered)
                && self.input_fingerprint(recovered) == self.input_fingerprint(native))
    }
}

fn schema_accepts(schema: &Value, value: &Value) -> bool {
    schema_shape_valid(schema, 0) && schema_accepts_inner(schema, value, schema, 0)
}

fn schema_shape_valid(schema: &Value, depth: usize) -> bool {
    if depth > 64 {
        return false;
    }
    let object = match schema {
        Value::Bool(_) => return true,
        Value::Object(object) => object,
        _ => return false,
    };
    const SUPPORTED: &[&str] = &[
        "$defs", "$id", "$ref", "$schema", "additionalProperties", "allOf", "anyOf",
        "const", "default", "deprecated", "description", "enum", "examples", "exclusiveMaximum",
        "exclusiveMinimum", "format", "items", "maxItems", "maxLength", "maxProperties",
        "maximum", "minItems", "minLength", "minProperties", "minimum", "multipleOf", "not",
        "oneOf", "pattern", "properties", "readOnly", "required", "title", "type", "uniqueItems",
        "writeOnly",
    ];
    if object.keys().any(|key| !SUPPORTED.contains(&key.as_str())) {
        return false;
    }
    for key in ["$id", "$schema", "description", "format", "pattern", "title"] {
        if object.get(key).is_some_and(|value| !value.is_string()) {
            return false;
        }
    }
    if object
        .get("$ref")
        .is_some_and(|value| value.as_str().is_none_or(|reference| !reference.starts_with('#')))
    {
        return false;
    }
    for key in ["deprecated", "readOnly", "uniqueItems", "writeOnly"] {
        if object.get(key).is_some_and(|value| !value.is_boolean()) {
            return false;
        }
    }
    for key in ["maxItems", "maxLength", "maxProperties", "minItems", "minLength", "minProperties"] {
        if object.get(key).is_some_and(|value| value.as_u64().is_none()) {
            return false;
        }
    }
    for key in ["exclusiveMaximum", "exclusiveMinimum", "maximum", "minimum", "multipleOf"] {
        if object.get(key).is_some_and(|value| !value.is_number()) {
            return false;
        }
    }
    if object
        .get("multipleOf")
        .is_some_and(|value| compare_json_numbers(value, &json!(0)) != Some(std::cmp::Ordering::Greater))
    {
        return false;
    }
    if object.get("enum").is_some_and(|value| {
        value.as_array().is_none_or(|values| values.is_empty())
    }) || object.get("examples").is_some_and(|value| !value.is_array()) {
        return false;
    }
    if object.get("required").is_some_and(|value| {
        value.as_array().is_none_or(|values| {
            let names = values.iter().filter_map(Value::as_str).collect::<Vec<_>>();
            names.len() != values.len()
                || names.iter().collect::<std::collections::HashSet<_>>().len() != names.len()
        })
    }) {
        return false;
    }
    if let Some(kind) = object.get("type") {
        let valid = match kind {
            Value::String(kind) => is_json_schema_type(kind),
            Value::Array(kinds) if !kinds.is_empty() => {
                let names = kinds.iter().filter_map(Value::as_str).collect::<Vec<_>>();
                names.len() == kinds.len()
                    && names.iter().all(|kind| is_json_schema_type(kind))
                    && names.iter().collect::<std::collections::HashSet<_>>().len() == names.len()
            }
            _ => false,
        };
        if !valid {
            return false;
        }
    }
    for key in ["allOf", "anyOf", "oneOf"] {
        if object.get(key).is_some_and(|value| {
            value.as_array().is_none_or(|schemas| {
                schemas.is_empty() || schemas.iter().any(|schema| !schema_shape_valid(schema, depth + 1))
            })
        }) {
            return false;
        }
    }
    for key in ["additionalProperties", "items", "not"] {
        if object
            .get(key)
            .is_some_and(|schema| !schema_shape_valid(schema, depth + 1))
        {
            return false;
        }
    }
    for key in ["$defs", "properties"] {
        if object.get(key).is_some_and(|value| {
            value.as_object().is_none_or(|schemas| {
                schemas.values().any(|schema| !schema_shape_valid(schema, depth + 1))
            })
        }) {
            return false;
        }
    }
    object
        .get("pattern")
        .and_then(Value::as_str)
        .is_none_or(|pattern| regex::Regex::new(pattern).is_ok())
}

fn is_json_schema_type(kind: &str) -> bool {
    matches!(kind, "object" | "array" | "string" | "integer" | "number" | "boolean" | "null")
}

fn schema_accepts_inner(schema: &Value, value: &Value, root: &Value, depth: usize) -> bool {
    if depth > 64 {
        return false;
    }
    let object = match schema {
        Value::Bool(allowed) => return *allowed,
        Value::Object(object) => object,
        _ => return false,
    };
    if let Some(reference) = object.get("$ref").and_then(Value::as_str) {
        let Some(target) = resolve_local_schema_ref(root, reference) else {
            return false;
        };
        if !schema_accepts_inner(target, value, root, depth + 1) {
            return false;
        }
    }
    if object
        .get("allOf")
        .and_then(Value::as_array)
        .is_some_and(|schemas| {
            schemas
                .iter()
                .any(|schema| !schema_accepts_inner(schema, value, root, depth + 1))
        })
    {
        return false;
    }
    if object
        .get("anyOf")
        .and_then(Value::as_array)
        .is_some_and(|schemas| {
            !schemas
                .iter()
                .any(|schema| schema_accepts_inner(schema, value, root, depth + 1))
        })
    {
        return false;
    }
    if object
        .get("oneOf")
        .and_then(Value::as_array)
        .is_some_and(|schemas| {
            schemas
                .iter()
                .filter(|schema| schema_accepts_inner(schema, value, root, depth + 1))
                .count()
                != 1
        })
    {
        return false;
    }
    if object
        .get("not")
        .is_some_and(|schema| schema_accepts_inner(schema, value, root, depth + 1))
    {
        return false;
    }
    if object.get("const").is_some_and(|expected| expected != value) {
        return false;
    }
    if let Some(expected) = object.get("type") {
        let matches = match expected {
            Value::String(kind) => value_matches_type(value, kind),
            Value::Array(kinds) => kinds
                .iter()
                .filter_map(Value::as_str)
                .any(|kind| value_matches_type(value, kind)),
            _ => false,
        };
        if !matches {
            return false;
        }
    }
    if object
        .get("enum")
        .and_then(Value::as_array)
        .is_some_and(|values| !values.contains(value))
    {
        return false;
    }
    if let Some(text) = value.as_str() {
        let length = text.chars().count() as u64;
        if object.get("minLength").and_then(Value::as_u64).is_some_and(|min| length < min)
            || object.get("maxLength").and_then(Value::as_u64).is_some_and(|max| length > max)
        {
            return false;
        }
        if let Some(pattern) = object.get("pattern").and_then(Value::as_str) {
            let Ok(regex) = regex::Regex::new(pattern) else {
                return false;
            };
            if !regex.is_match(text) {
                return false;
            }
        }
    }
    if value.is_number() {
        if object.get("minimum").is_some_and(|minimum| {
            !matches!(
                compare_json_numbers(value, minimum),
                Some(std::cmp::Ordering::Equal | std::cmp::Ordering::Greater)
            )
        }) || object.get("maximum").is_some_and(|maximum| {
            !matches!(
                compare_json_numbers(value, maximum),
                Some(std::cmp::Ordering::Equal | std::cmp::Ordering::Less)
            )
        }) || object.get("exclusiveMinimum").is_some_and(|minimum| {
            !matches!(
                compare_json_numbers(value, minimum),
                Some(std::cmp::Ordering::Greater)
            )
        }) || object.get("exclusiveMaximum").is_some_and(|maximum| {
            !matches!(
                compare_json_numbers(value, maximum),
                Some(std::cmp::Ordering::Less)
            )
        }) {
            return false;
        }
        if object
            .get("multipleOf")
            .is_some_and(|multiple| !json_number_is_multiple(value, multiple))
        {
            return false;
        }
    }
    if let Some(map) = value.as_object() {
        let length = map.len() as u64;
        if object
            .get("minProperties")
            .and_then(Value::as_u64)
            .is_some_and(|min| length < min)
            || object
                .get("maxProperties")
                .and_then(Value::as_u64)
                .is_some_and(|max| length > max)
        {
            return false;
        }
        if object
            .get("required")
            .and_then(Value::as_array)
            .is_some_and(|required| {
                required
                    .iter()
                    .filter_map(Value::as_str)
                    .any(|key| !map.contains_key(key))
            })
        {
            return false;
        }
        let properties = object.get("properties").and_then(Value::as_object);
        if let Some(properties) = properties {
            for (key, property_schema) in properties {
                if map.get(key).is_some_and(|property| {
                    !schema_accepts_inner(property_schema, property, root, depth + 1)
                }) {
                    return false;
                }
            }
        }
        if let Some(additional) = object.get("additionalProperties") {
            for (key, property) in map {
                if properties.is_some_and(|properties| properties.contains_key(key)) {
                    continue;
                }
                if !schema_accepts_inner(additional, property, root, depth + 1) {
                    return false;
                }
            }
        }
    }
    if let Some(array) = value.as_array() {
        let length = array.len() as u64;
        if object.get("minItems").and_then(Value::as_u64).is_some_and(|min| length < min)
            || object.get("maxItems").and_then(Value::as_u64).is_some_and(|max| length > max)
        {
            return false;
        }
        if object.get("uniqueItems").and_then(Value::as_bool) == Some(true) {
            let mut seen = std::collections::HashSet::new();
            if array.iter().any(|item| !seen.insert(canonical_json(item))) {
                return false;
            }
        }
        if let Some(items) = object.get("items") {
            if array
                .iter()
                .any(|item| !schema_accepts_inner(items, item, root, depth + 1))
            {
                return false;
            }
        }
    }
    true
}

fn resolve_local_schema_ref<'a>(root: &'a Value, reference: &str) -> Option<&'a Value> {
    let pointer = reference.strip_prefix('#')?;
    if pointer.is_empty() {
        return Some(root);
    }
    root.pointer(pointer)
}

fn value_matches_type(value: &Value, kind: &str) -> bool {
    match kind {
        "object" => value.is_object(),
        "array" => value.is_array(),
        "string" => value.is_string(),
        "integer" => parse_exact_decimal(value)
            .is_some_and(|number| number.digits == "0" || number.scale <= 0),
        "number" => value.is_number(),
        "boolean" => value.is_boolean(),
        "null" => value.is_null(),
        _ => false,
    }
}

#[derive(Clone)]
struct ExactDecimal {
    negative: bool,
    digits: String,
    scale: i64,
}

fn parse_exact_decimal(value: &Value) -> Option<ExactDecimal> {
    let source = value.as_number()?.to_string();
    let (negative, source) = source
        .strip_prefix('-')
        .map_or((false, source.as_str()), |rest| (true, rest));
    let (mantissa, exponent) = if let Some((mantissa, exponent)) = source.split_once(['e', 'E']) {
        (mantissa, exponent.parse::<i64>().ok()?)
    } else {
        (source, 0)
    };
    if exponent.unsigned_abs() > MAX_SCALED_NUMBER_DIGITS as u64 {
        return None;
    }
    let mut digits = String::new();
    let mut fraction = 0i64;
    let mut seen_dot = false;
    for ch in mantissa.chars() {
        match ch {
            '0'..='9' => {
                digits.push(ch);
                if seen_dot {
                    fraction += 1;
                }
            }
            '.' if !seen_dot => seen_dot = true,
            _ => return None,
        }
    }
    if digits.is_empty() || digits.len() > MAX_EXACT_NUMBER_DIGITS {
        return None;
    }
    let first_nonzero = digits.find(|ch| ch != '0').unwrap_or(digits.len());
    digits.drain(..first_nonzero);
    if digits.is_empty() {
        return Some(ExactDecimal {
            negative: false,
            digits: "0".to_string(),
            scale: 0,
        });
    }
    let mut scale = fraction.checked_sub(exponent)?;
    while digits.ends_with('0') {
        digits.pop();
        scale = scale.checked_sub(1)?;
    }
    Some(ExactDecimal {
        negative,
        digits,
        scale,
    })
}

fn compare_decimal_magnitude(left: &ExactDecimal, right: &ExactDecimal) -> std::cmp::Ordering {
    if left.digits == "0" || right.digits == "0" {
        return match (left.digits == "0", right.digits == "0") {
            (true, true) => std::cmp::Ordering::Equal,
            (true, false) => std::cmp::Ordering::Less,
            (false, true) => std::cmp::Ordering::Greater,
            (false, false) => unreachable!(),
        };
    }
    let left_integer_digits = left.digits.len() as i64 - left.scale;
    let right_integer_digits = right.digits.len() as i64 - right.scale;
    match left_integer_digits.cmp(&right_integer_digits) {
        std::cmp::Ordering::Equal => {
            let length = left.digits.len().max(right.digits.len());
            for index in 0..length {
                let left_digit = left.digits.as_bytes().get(index).copied().unwrap_or(b'0');
                let right_digit = right.digits.as_bytes().get(index).copied().unwrap_or(b'0');
                match left_digit.cmp(&right_digit) {
                    std::cmp::Ordering::Equal => {}
                    ordering => return ordering,
                }
            }
            std::cmp::Ordering::Equal
        }
        ordering => ordering,
    }
}

fn compare_json_numbers(left: &Value, right: &Value) -> Option<std::cmp::Ordering> {
    let left = parse_exact_decimal(left)?;
    let right = parse_exact_decimal(right)?;
    if left.digits == "0" && right.digits == "0" {
        return Some(std::cmp::Ordering::Equal);
    }
    if left.negative != right.negative {
        return Some(if left.negative {
            std::cmp::Ordering::Less
        } else {
            std::cmp::Ordering::Greater
        });
    }
    let ordering = compare_decimal_magnitude(&left, &right);
    Some(if left.negative { ordering.reverse() } else { ordering })
}

fn scaled_integer_string(decimal: &ExactDecimal, common_scale: i64) -> Option<String> {
    if common_scale < decimal.scale {
        return None;
    }
    let zeros = usize::try_from(common_scale - decimal.scale).ok()?;
    if decimal.digits.len().checked_add(zeros)? > MAX_SCALED_NUMBER_DIGITS {
        return None;
    }
    let mut value = decimal.digits.clone();
    value.extend(std::iter::repeat_n('0', zeros));
    Some(value)
}

fn trim_decimal_integer(value: &str) -> &str {
    let trimmed = value.trim_start_matches('0');
    if trimmed.is_empty() { "0" } else { trimmed }
}

fn compare_decimal_integers(left: &str, right: &str) -> std::cmp::Ordering {
    let left = trim_decimal_integer(left);
    let right = trim_decimal_integer(right);
    left.len().cmp(&right.len()).then_with(|| left.cmp(right))
}

fn subtract_decimal_integers(left: &str, right: &str) -> String {
    let mut result = Vec::with_capacity(left.len());
    let mut borrow = 0i16;
    let mut right_digits = right.as_bytes().iter().rev();
    for left_digit in left.as_bytes().iter().rev() {
        let mut digit = i16::from(*left_digit - b'0') - borrow;
        let subtrahend = right_digits
            .next()
            .map_or(0, |right_digit| i16::from(*right_digit - b'0'));
        if digit < subtrahend {
            digit += 10;
            borrow = 1;
        } else {
            borrow = 0;
        }
        result.push((digit - subtrahend) as u8 + b'0');
    }
    while result.len() > 1 && result.last() == Some(&b'0') {
        result.pop();
    }
    result.reverse();
    String::from_utf8(result).unwrap_or_else(|_| "0".to_string())
}

fn decimal_integer_is_multiple(dividend: &str, divisor: &str) -> bool {
    let divisor = trim_decimal_integer(divisor);
    if divisor == "0" {
        return false;
    }
    let mut remainder = "0".to_string();
    for digit in trim_decimal_integer(dividend).bytes() {
        if remainder == "0" {
            remainder.clear();
        }
        remainder.push(char::from(digit));
        remainder = trim_decimal_integer(&remainder).to_string();
        while compare_decimal_integers(&remainder, divisor) != std::cmp::Ordering::Less {
            remainder = subtract_decimal_integers(&remainder, divisor);
        }
    }
    remainder == "0"
}

fn json_number_is_multiple(value: &Value, multiple: &Value) -> bool {
    let Some(value) = parse_exact_decimal(value) else {
        return false;
    };
    let Some(multiple) = parse_exact_decimal(multiple) else {
        return false;
    };
    if multiple.negative || multiple.digits == "0" {
        return false;
    }
    let common_scale = value.scale.max(multiple.scale);
    let Some(value) = scaled_integer_string(&value, common_scale) else {
        return false;
    };
    let Some(multiple) = scaled_integer_string(&multiple, common_scale) else {
        return false;
    };
    decimal_integer_is_multiple(&value, &multiple)
}

fn canonical_json(value: &Value) -> String {
    match value {
        Value::Object(object) => {
            let mut keys = object.keys().collect::<Vec<_>>();
            keys.sort_unstable();
            let fields = keys
                .into_iter()
                .map(|key| format!(
                    "{}:{}",
                    serde_json::to_string(key).unwrap_or_default(),
                    canonical_json(&object[key])
                ))
                .collect::<Vec<_>>()
                .join(",");
            format!("{{{fields}}}")
        }
        Value::Array(array) => format!(
            "[{}]",
            array.iter().map(canonical_json).collect::<Vec<_>>().join(",")
        ),
        _ => serde_json::to_string(value).unwrap_or_else(|_| "null".to_string()),
    }
}

fn stable_hash(text: &str, seed: u64) -> u64 {
    text.as_bytes().iter().fold(seed, |hash, byte| {
        (hash ^ u64::from(*byte)).wrapping_mul(0x100000001b3)
    })
}

fn stable_tool_id(span: usize, ordinal: usize, name: &str, input: &Value) -> String {
    let material = format!("{span}:{ordinal}:{name}:{}", canonical_json(input));
    let first = stable_hash(&material, 0xcbf29ce484222325);
    let second = stable_hash(&material, 0x84222325cbf29ce4);
    format!("call_recovered_{first:016x}{:08x}", second as u32)
}

#[derive(Clone, Debug)]
pub enum RecoveredContent {
    Text(String),
    Tool(Value),
}

#[derive(Clone, Debug, Default)]
pub struct ToolRecoveryResult {
    pub parts: Vec<RecoveredContent>,
    pub incomplete_tool: bool,
}

impl ToolRecoveryResult {
    #[cfg(test)]
    pub fn tool_blocks(&self) -> Vec<Value> {
        self.parts
            .iter()
            .filter_map(|part| match part {
                RecoveredContent::Tool(block) => Some(block.clone()),
                RecoveredContent::Text(_) => None,
            })
            .collect()
    }

    #[cfg(test)]
    pub fn visible_text(&self) -> String {
        self.parts
            .iter()
            .filter_map(|part| match part {
                RecoveredContent::Text(text) => Some(text.as_str()),
                RecoveredContent::Tool(_) => None,
            })
            .collect()
    }
}

fn push_text(parts: &mut Vec<RecoveredContent>, text: &str) {
    if text.is_empty() {
        return;
    }
    if let Some(RecoveredContent::Text(previous)) = parts.last_mut() {
        previous.push_str(text);
    } else {
        parts.push(RecoveredContent::Text(text.to_string()));
    }
}

fn balanced_json_end(text: &str, start: usize) -> Option<usize> {
    let mut stack = Vec::new();
    let mut in_string = false;
    let mut escaping = false;
    for (relative, ch) in text[start..].char_indices() {
        if in_string {
            if escaping {
                escaping = false;
            } else if ch == '\\' {
                escaping = true;
            } else if ch == '"' {
                in_string = false;
            }
            continue;
        }
        match ch {
            '"' => in_string = true,
            '{' => stack.push('}'),
            '[' => stack.push(']'),
            '}' | ']' => {
                if stack.pop() != Some(ch) {
                    return None;
                }
                if stack.is_empty() {
                    return Some(start + relative + ch.len_utf8());
                }
            }
            _ => {}
        }
    }
    None
}

fn skip_whitespace(text: &str, mut offset: usize) -> usize {
    while let Some(ch) = text[offset..].chars().next() {
        if !ch.is_whitespace() {
            break;
        }
        offset += ch.len_utf8();
    }
    offset
}

fn normalize_tool(value: &Value, spec: &ToolRecoverySpec, span: usize, ordinal: usize) -> Option<Value> {
    let object = value.as_object()?;
    let name = object.get("name")?.as_str()?.trim();
    if name.is_empty() || !spec.declares(name) {
        return None;
    }
    if object
        .get("type")
        .and_then(Value::as_str)
        .is_some_and(|kind| kind != "tool_use")
    {
        return None;
    }
    let input = if let Some(input) = object.get("input") {
        input.as_object()?;
        input.clone()
    } else {
        let mut flat = object.clone();
        flat.remove("type");
        flat.remove("id");
        flat.remove("name");
        if flat.is_empty() {
            return None;
        }
        Value::Object(flat)
    };
    if !spec.validates_input(name, &input) {
        return None;
    }
    let id = object
        .get("id")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|id| !id.is_empty())
        .map(str::to_string)
        .unwrap_or_else(|| stable_tool_id(span, ordinal, name, &input));
    Some(json!({ "type": "tool_use", "id": id, "name": name, "input": input }))
}

fn normalize_candidate(value: &Value, spec: &ToolRecoverySpec, span: usize) -> Option<Vec<Value>> {
    match value {
        Value::Array(values) if !values.is_empty() => values
            .iter()
            .enumerate()
            .map(|(index, value)| normalize_tool(value, spec, span, index))
            .collect(),
        Value::Object(_) => normalize_tool(value, spec, span, 0).map(|block| vec![block]),
        _ => None,
    }
}

enum MalformedRecovery {
    Complete { end: usize, block: Value },
    Incomplete,
    None,
}

fn recover_extra_brace(
    text: &str,
    object_start: usize,
    object_end: usize,
    input: &Value,
    spec: &ToolRecoverySpec,
    base: usize,
) -> MalformedRecovery {
    if !input.is_object() {
        return MalformedRecovery::None;
    }
    let mut suffix_start = skip_whitespace(text, object_end);
    if text.as_bytes().get(suffix_start) != Some(&b',') {
        return MalformedRecovery::None;
    }
    suffix_start = skip_whitespace(text, suffix_start + 1);
    if !text[suffix_start..].starts_with('"') {
        return MalformedRecovery::None;
    }
    let repaired_tail = format!("{{{}", &text[suffix_start..]);
    let Some(repaired_end) = balanced_json_end(&repaired_tail, 0) else {
        let suffix = text[suffix_start..].trim();
        return if suffix.contains("\"name\"") || "\"name\"".starts_with(suffix) {
            MalformedRecovery::Incomplete
        } else {
            MalformedRecovery::None
        };
    };
    let suffix_end = suffix_start + repaired_end.saturating_sub(1);
    let repaired = format!("{{{}", &text[suffix_start..suffix_end]);
    let Ok(metadata) = serde_json::from_str::<Value>(&repaired) else {
        return MalformedRecovery::None;
    };
    let Some(metadata) = metadata.as_object() else {
        return MalformedRecovery::None;
    };
    if metadata.keys().any(|key| key != "name" && key != "id" && key != "type") {
        return MalformedRecovery::None;
    }
    let Some(name) = metadata.get("name").and_then(Value::as_str).map(str::trim) else {
        return MalformedRecovery::None;
    };
    if !spec.declares(name) || !spec.validates_input(name, input) {
        return MalformedRecovery::None;
    }
    if metadata
        .get("type")
        .and_then(Value::as_str)
        .is_some_and(|kind| kind != "tool_use")
    {
        return MalformedRecovery::None;
    }
    let id = metadata
        .get("id")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|id| !id.is_empty())
        .map(str::to_string)
        .unwrap_or_else(|| stable_tool_id(base + object_start, 0, name, input));
    MalformedRecovery::Complete {
        end: suffix_end,
        block: json!({ "type": "tool_use", "id": id, "name": name, "input": input }),
    }
}

// ============ antml 参数块泄漏恢复 ============
//
// 观测到的真实泄漏形态（2026-09-10，claude-sonnet-5 经 Kiro 上游）：
//   {"id":"toolu_bdrk_01Ryn6exXNJ3RVfxYA2j6akD">
//   <parameter name="output_mode">content</parameter>
//   <parameter name="path">C:\...\file.java</parameter>
//   <parameter name="pattern">initContractNote\(</parameter>
//   <parameter name="-n">true</parameter>
//   </invoke>
// 即 `<invoke name="X">` 开标签退化为只带 toolu_ id 的伪 JSON，工具名完全丢失；
// 参数值可跨多行，以 `</invoke>` 收尾。工具名按请求声明的工具 schema 推断：
// 必填字段齐全且属性命中数最高者当选，推断不出则保持原文不恢复。

enum AntmlRecovery {
    Complete { end: usize, block: Value },
    Incomplete,
    None,
}

/// 读取 `start` 处的双引号字符串，返回 (内容, 结束偏移)。转义按字符宽度推进，避免切进多字节字符。
fn read_quoted(text: &str, start: usize) -> Option<(String, usize)> {
    if text.as_bytes().get(start) != Some(&b'"') {
        return None;
    }
    let mut pos = start + 1;
    while let Some(ch) = text[pos..].chars().next() {
        match ch {
            '"' => return Some((text[start + 1..pos].to_string(), pos + 1)),
            '\\' => pos += 1 + ch.len_utf8(),
            _ => pos += ch.len_utf8(),
        }
    }
    None
}

/// 解析开标签，返回 (开标签结束偏移, toolu id, 显式工具名)。
/// 两种形态：`{"id":"toolu_xxx">`（id 必须以 toolu_ 开头）与 `<invoke name="X">`。
fn parse_antml_opener(text: &str, start: usize) -> Option<(usize, Option<String>, Option<String>)> {
    let rest = &text[start..];
    if rest.starts_with("<invoke") {
        let mut pos = start + "<invoke".len();
        pos = skip_whitespace(text, pos);
        let mut name = None;
        if text[pos..].starts_with("name=") {
            let (parsed, next) = read_quoted(text, pos + "name=".len())?;
            name = Some(parsed);
            pos = next;
            pos = skip_whitespace(text, pos);
        }
        if text.as_bytes().get(pos) == Some(&b'>') {
            return Some((pos + 1, None, name.filter(|n| !n.trim().is_empty())));
        }
        return None;
    }
    if rest.starts_with("{\"id\":") {
        let mut pos = start + "{\"id\":".len();
        pos = skip_whitespace(text, pos);
        let (id, next) = read_quoted(text, pos)?;
        if !id.starts_with("toolu_") {
            return None;
        }
        pos = skip_whitespace(text, next);
        if text.as_bytes().get(pos) == Some(&b'>') {
            return Some((pos + 1, Some(id), None));
        }
    }
    None
}

/// 解析 `<parameter name="k">value</parameter>` 序列直到 `</invoke>`，value 保持原文（可跨多行）。
fn parse_antml_params(text: &str, mut pos: usize) -> Option<(Vec<(String, String)>, usize)> {
    let mut params = Vec::new();
    loop {
        pos = skip_whitespace(text, pos);
        if text[pos..].starts_with("</invoke>") {
            return Some((params, pos + "</invoke>".len()));
        }
        if !text[pos..].starts_with("<parameter") {
            return None;
        }
        pos += "<parameter".len();
        pos = skip_whitespace(text, pos);
        if !text[pos..].starts_with("name=") {
            return None;
        }
        let (key, next) = read_quoted(text, pos + "name=".len())?;
        pos = skip_whitespace(text, next);
        if text.as_bytes().get(pos) != Some(&b'>') {
            return None;
        }
        pos += 1;
        let value_end = text[pos..].find("</parameter>")? + pos;
        params.push((key, text[pos..value_end].to_string()));
        pos = value_end + "</parameter>".len();
    }
}

/// 按候选工具 schema 的属性类型对参数值做强转（antml 值全是文本，"true"/"3" 需还原为 bool/number）。
fn antml_input_for_schema(params: &[(String, String)], schema: &Value) -> Value {
    let properties = schema.get("properties").and_then(Value::as_object);
    let mut map = Map::new();
    for (key, raw) in params {
        let expected_type = properties
            .and_then(|p| p.get(key.as_str()))
            .and_then(|s| s.get("type"))
            .and_then(Value::as_str);
        let value = match expected_type {
            Some("boolean") => serde_json::from_str::<Value>(raw)
                .ok()
                .filter(Value::is_boolean)
                .unwrap_or_else(|| json!(raw)),
            Some("integer") | Some("number") => serde_json::from_str::<Value>(raw)
                .ok()
                .filter(Value::is_number)
                .unwrap_or_else(|| json!(raw)),
            _ => json!(raw),
        };
        map.insert(key.clone(), value);
    }
    Value::Object(map)
}

/// 推断工具名与入参：显式名字只校验不推断；否则在声明工具里选「校验通过且属性命中数最高」者。
fn infer_antml_tool(
    params: &[(String, String)],
    explicit_name: Option<&str>,
    spec: &ToolRecoverySpec,
) -> Option<(String, Value)> {
    if let Some(name) = explicit_name.map(str::trim).filter(|n| !n.is_empty()) {
        let schema = spec.schemas.get(name)?;
        let input = antml_input_for_schema(params, schema);
        return spec
            .validates_input(name, &input)
            .then(|| (name.to_string(), input));
    }
    if params.is_empty() {
        return None;
    }
    let mut names = spec.schemas.keys().collect::<Vec<_>>();
    names.sort(); // 确定序，得分相同取字典序最小
    let mut best: Option<(usize, String, Value)> = None;
    for name in names {
        let schema = &spec.schemas[name];
        let input = antml_input_for_schema(params, schema);
        if !spec.validates_input(name, &input) {
            continue;
        }
        let properties = schema.get("properties").and_then(Value::as_object);
        let score = params
            .iter()
            .filter(|(key, _)| properties.is_some_and(|p| p.contains_key(key.as_str())))
            .count();
        if best.as_ref().is_none_or(|(top, _, _)| score > *top) {
            best = Some((score, name.clone(), input));
        }
    }
    // 至少命中一个已声明属性才认，避免纯靠 schema 宽松校验瞎猜
    let (score, name, input) = best?;
    (score > 0).then_some((name, input))
}

fn recover_antml_invoke(text: &str, start: usize, spec: &ToolRecoverySpec, base: usize) -> AntmlRecovery {
    if spec.is_empty() {
        return AntmlRecovery::None;
    }
    let Some((pos, id, name)) = parse_antml_opener(text, start) else {
        return AntmlRecovery::None;
    };
    match parse_antml_params(text, pos) {
        Some((params, end)) => {
            let Some((tool_name, input)) = infer_antml_tool(&params, name.as_deref(), spec) else {
                return AntmlRecovery::None;
            };
            let block_id = id
                .as_deref()
                .map(str::trim)
                .filter(|s| !s.is_empty())
                .map(str::to_string)
                .unwrap_or_else(|| stable_tool_id(base + start, 0, &tool_name, &input));
            AntmlRecovery::Complete {
                end,
                block: json!({ "type": "tool_use", "id": block_id, "name": tool_name, "input": input }),
            }
        }
        None => {
            // opener 之后仍有参数行但没等到 </invoke>：流被截断，按不完整工具处理
            if text[pos..].contains("<parameter") {
                AntmlRecovery::Incomplete
            } else {
                AntmlRecovery::None
            }
        }
    }
}

fn recover_range(text: &str, spec: &ToolRecoverySpec, base: usize) -> ToolRecoveryResult {
    if spec.is_empty() || text.is_empty() {
        return ToolRecoveryResult {
            parts: (!text.is_empty())
                .then(|| RecoveredContent::Text(text.to_string()))
                .into_iter()
                .collect(),
            incomplete_tool: false,
        };
    }
    let mut result = ToolRecoveryResult::default();
    let mut scan = 0usize;
    let mut plain_start = 0usize;
    while scan < text.len() {
        let fence = if text[scan..].starts_with("```") {
            Some("```")
        } else if text[scan..].starts_with("~~~") {
            Some("~~~")
        } else {
            None
        };
        if let Some(fence) = fence {
            if let Some(opening_end) = text[scan + fence.len()..]
                .find('\n')
                .map(|relative| scan + fence.len() + relative + 1)
            {
                if let Some(relative_close) = text[opening_end..].find(fence) {
                    scan = opening_end + relative_close + fence.len();
                    continue;
                }
            }
            break;
        }
        let Some(ch) = text[scan..].chars().next() else {
            break;
        };
        // antml 参数块泄漏（<invoke …> 或 {"id":"toolu_…">）先于 JSON 探测尝试：
        // 参数值里常含配平花括号（如 Java 代码），balanced_json_end 可能误判成功而跳过。
        // antml 解析失败时回落到正常 JSON 路径，两种触发形态互不干扰。
        let antml_candidate = (ch == '<' && text[scan..].starts_with("<invoke"))
            || (ch == '{' && text[scan..].starts_with("{\"id\":"));
        if antml_candidate {
            match recover_antml_invoke(text, scan, spec, base) {
                AntmlRecovery::Complete { end, block } => {
                    push_text(&mut result.parts, &text[plain_start..scan]);
                    result.parts.push(RecoveredContent::Tool(block));
                    scan = end;
                    plain_start = scan;
                    continue;
                }
                AntmlRecovery::Incomplete => {
                    push_text(&mut result.parts, &text[plain_start..scan]);
                    result.incomplete_tool = true;
                    return result;
                }
                AntmlRecovery::None => {}
            }
        }
        if ch != '{' && ch != '[' {
            scan += ch.len_utf8();
            continue;
        }
        let Some(end) = balanced_json_end(text, scan) else {
            if spec.looks_like_protocol(&text[scan..]) {
                push_text(&mut result.parts, &text[plain_start..scan]);
                result.incomplete_tool = true;
                return result;
            }
            break;
        };
        let candidate = &text[scan..end];
        if candidate.len() > MAX_TOOL_RECOVERY_BYTES {
            if spec.looks_like_protocol(candidate) {
                push_text(&mut result.parts, &text[plain_start..scan]);
                result.incomplete_tool = true;
                return result;
            }
            scan = end;
            continue;
        }
        let Ok(value) = serde_json::from_str::<Value>(candidate) else {
            scan += ch.len_utf8();
            continue;
        };
        let protocol_position = scan == 0
            || plain_start == scan
            || result
                .parts
                .iter()
                .any(|part| matches!(part, RecoveredContent::Tool(_)))
            || text[..scan]
                .chars()
                .next_back()
                .is_some_and(|ch| ch == '\n' || ch == '\r');
        if protocol_position {
            if let Some(blocks) = normalize_candidate(&value, spec, base + scan) {
                push_text(&mut result.parts, &text[plain_start..scan]);
                result.parts.extend(blocks.into_iter().map(RecoveredContent::Tool));
                scan = end;
                plain_start = scan;
                continue;
            }
        }
        match if protocol_position {
            recover_extra_brace(text, scan, end, &value, spec, base)
        } else {
            MalformedRecovery::None
        } {
            MalformedRecovery::Complete { end, block } => {
                push_text(&mut result.parts, &text[plain_start..scan]);
                result.parts.push(RecoveredContent::Tool(block));
                scan = end;
                plain_start = scan;
            }
            MalformedRecovery::Incomplete => {
                push_text(&mut result.parts, &text[plain_start..scan]);
                result.incomplete_tool = true;
                return result;
            }
            MalformedRecovery::None => scan = end,
        }
    }
    push_text(&mut result.parts, &text[plain_start..]);
    result
}

pub fn ensure_tool_id_unique(
    tool: &mut Value,
    seen: &mut std::collections::HashSet<String>,
    salt: usize,
) {
    let id = tool.get("id").and_then(Value::as_str).unwrap_or("");
    if seen.insert(id.to_string()) {
        return;
    }
    let name = tool.get("name").and_then(Value::as_str).unwrap_or("");
    let input = tool.get("input").cloned().unwrap_or_else(|| json!({}));
    let mut attempt = salt;
    let replacement = loop {
        let candidate = stable_tool_id(salt, attempt, name, &input);
        if seen.insert(candidate.clone()) {
            break candidate;
        }
        attempt += 1;
    };
    tool.as_object_mut()
        .unwrap()
        .insert("id".to_string(), Value::String(replacement));
}

fn ensure_unique_tool_ids(result: &mut ToolRecoveryResult) {
    let mut seen = std::collections::HashSet::new();
    for (index, part) in result.parts.iter_mut().enumerate() {
        if let RecoveredContent::Tool(tool) = part {
            ensure_tool_id_unique(tool, &mut seen, index);
        }
    }
}

pub fn recover_tool_calls_from_text(text: &str, spec: &ToolRecoverySpec) -> ToolRecoveryResult {
    let mut result = recover_range(text, spec, 0);
    ensure_unique_tool_ids(&mut result);
    result
}

#[derive(Default)]
pub struct TextToolRecoveryFinish {
    pub parts: Vec<RecoveredContent>,
    pub incomplete_tool: bool,
}

pub struct TextToolRecoveryGuard {
    spec: ToolRecoverySpec,
    prefix_hold: String,
    pending: String,
    buffering: bool,
    overflowed_tool: bool,
    passthrough: bool,
}

impl TextToolRecoveryGuard {
    pub fn new(spec: ToolRecoverySpec) -> Self {
        Self {
            spec,
            prefix_hold: String::new(),
            pending: String::new(),
            buffering: false,
            overflowed_tool: false,
            passthrough: false,
        }
    }

    pub fn push(&mut self, chunk: &str) -> String {
        if self.spec.is_empty() || chunk.is_empty() || self.passthrough {
            return chunk.to_string();
        }
        if self.overflowed_tool {
            return String::new();
        }
        if self.buffering {
            return self.append_pending(chunk);
        }
        let combined = format!("{}{}", self.prefix_hold, chunk);
        self.prefix_hold.clear();
        let candidate = ['{', '[']
            .into_iter()
            .filter_map(|needle| combined.find(needle))
            .chain(combined.find("```"))
            .chain(combined.find("<invoke"))
            .min();
        if let Some(start) = candidate {
            self.buffering = true;
            let mut visible = combined[..start].to_string();
            visible.push_str(&self.append_pending(&combined[start..]));
            return visible;
        }
        let split = combined
            .char_indices()
            .rev()
            .nth(2)
            .map(|(index, _)| index)
            .unwrap_or(0);
        self.prefix_hold.push_str(&combined[split..]);
        combined[..split].to_string()
    }

    fn append_pending(&mut self, chunk: &str) -> String {
        if self.pending.len().saturating_add(chunk.len()) <= MAX_TOOL_RECOVERY_BYTES {
            self.pending.push_str(chunk);
            return String::new();
        }
        let remaining = MAX_TOOL_RECOVERY_BYTES.saturating_sub(self.pending.len());
        let mut split = remaining.min(chunk.len());
        while split > 0 && !chunk.is_char_boundary(split) {
            split -= 1;
        }
        self.pending.push_str(&chunk[..split]);
        if self.spec.looks_like_protocol(&self.pending) {
            self.overflowed_tool = true;
            return String::new();
        }
        let mut visible = std::mem::take(&mut self.pending);
        visible.push_str(&chunk[split..]);
        self.buffering = false;
        self.passthrough = true;
        visible
    }

    pub fn finish(&mut self) -> TextToolRecoveryFinish {
        if self.overflowed_tool {
            self.pending.clear();
            return TextToolRecoveryFinish {
                incomplete_tool: true,
                ..Default::default()
            };
        }
        if !self.buffering {
            let text = std::mem::take(&mut self.prefix_hold);
            return TextToolRecoveryFinish {
                parts: (!text.is_empty())
                    .then(|| RecoveredContent::Text(text))
                    .into_iter()
                    .collect(),
                incomplete_tool: false,
            };
        }
        let recovered = recover_tool_calls_from_text(&std::mem::take(&mut self.pending), &self.spec);
        self.buffering = false;
        TextToolRecoveryFinish {
            parts: recovered.parts,
            incomplete_tool: recovered.incomplete_tool,
        }
    }
}

// ============ Anthropic ↔ Kiro ============

fn system_to_text(system: &Value) -> String {
    if system.is_null() {
        return String::new();
    }
    if let Some(s) = system.as_str() {
        return s.to_string();
    }
    if let Some(blocks) = system.as_array() {
        return blocks
            .iter()
            .filter_map(|block| {
                if let Some(s) = block.as_str() {
                    return Some(s.to_string());
                }
                block.get("type").and_then(|v| v.as_str()).and_then(|t| {
                    if t == "text" {
                        block.get("text").and_then(|v| v.as_str()).map(|s| s.to_string())
                    } else {
                        None
                    }
                })
            })
            .filter(|s| !s.is_empty())
            .collect::<Vec<_>>()
            .join("\n\n");
    }
    system.to_string()
}

fn media_type_to_format(media_type: &str) -> String {
    media_type
        .split('/')
        .nth(1)
        .unwrap_or("png")
        .to_lowercase()
}

fn parse_data_url(url: &str) -> Option<(String, String)> {
    let rest = url.strip_prefix("data:")?;
    let (meta, data) = rest.split_once(';')?;
    let data = data.strip_prefix("base64,")?;
    Some((meta.to_string(), data.to_string()))
}

/// 单条工具结果摊平文本的最大长度。避免大输出（如读大文件 / 命令长输出 / 大 JSON）撑爆模型上下文
/// 触发 Kiro `CONTENT_LENGTH_EXCEEDS_THRESHOLD`。保留开头，超限部分截断并加标记。
const MAX_TOOL_RESULT_TEXT_CHARS: usize = 6000;

fn truncate_to_limit(text: &str, max: usize) -> String {
    let count = text.chars().count();
    if count <= max {
        return text.to_string();
    }
    let head: String = text.chars().take(max).collect();
    format!("{head}\n\u{2026}[tool result truncated: {count} chars]\u{2026}")
}

/// 把 tool_result 的 content 摊平成文本（与 kiro2cli 一致），并按 `MAX_TOOL_RESULT_TEXT_CHARS` 截断。
fn tool_result_to_text(content: &Value) -> String {
    let text = match content {
        Value::String(text) => text.clone(),
        Value::Array(parts) => parts
            .iter()
            .map(|part| {
                if let Some(t) = part.get("text").and_then(|v| v.as_str()) {
                    t.to_string()
                } else if let Some(j) = part.get("json") {
                    j.to_string()
                } else {
                    part.to_string()
                }
            })
            .collect::<Vec<_>>()
            .join("\n"),
        Value::Null => String::new(),
        other => other.to_string(),
    };
    truncate_to_limit(&text, MAX_TOOL_RESULT_TEXT_CHARS)
}

fn anthropic_content_to_kiro(content: &Value) -> Result<KiroContent, String> {
    if let Some(s) = content.as_str() {
        return Ok(KiroContent {
            text: s.to_string(),
            images: Vec::new(),
        });
    }
    let Some(blocks) = content.as_array() else {
        return Ok(KiroContent {
            text: content.as_str().unwrap_or("").to_string(),
            images: Vec::new(),
        });
    };

    let mut text_parts = Vec::new();
    let mut images = Vec::new();

    for block in blocks {
        if block.is_null() {
            continue;
        }
        if let Some(text) = block.get("type").and_then(|v| v.as_str()) {
            match text {
                "text" => {
                    if let Some(text) = block.get("text").and_then(|v| v.as_str()) {
                        text_parts.push(text.to_string());
                    }
                }
                "image" => {
                    let source = block.get("source").unwrap_or(&Value::Null);
                    let source_type = source.get("type").and_then(|v| v.as_str());
                    match source_type {
                        Some("base64") => {
                            let media_type = source.get("media_type").and_then(|v| v.as_str()).unwrap_or("image/png");
                            let data = source.get("data").and_then(|v| v.as_str()).unwrap_or("");
                            images.push(json!({
                                "format": media_type_to_format(media_type),
                                "source": { "bytes": data },
                            }));
                        }
                        Some("url") => {
                            let url = source.get("url").and_then(|v| v.as_str()).unwrap_or("");
                            let (media_type, data) = parse_data_url(url)
                                .ok_or_else(|| "Only base64 image sources and data: URLs are supported.".to_string())?;
                            images.push(json!({
                                "format": media_type_to_format(&media_type),
                                "source": { "bytes": data },
                            }));
                        }
                        _ => {}
                    }
                }
                // 工具结果摊平为文本（Kiro 不接受结构化 toolResults）：
                // `[tool_result:<id>]\n<content>`。与 kiro2cli 一致。
                "tool_result" => {
                    let tool_use_id = block
                        .get("tool_use_id")
                        .and_then(|v| v.as_str())
                        .unwrap_or("")
                        .trim();
                    let id = if tool_use_id.is_empty() {
                        "unknown".to_string()
                    } else {
                        tool_use_id.to_string()
                    };
                    let content_text = tool_result_to_text(
                        block.get("content").unwrap_or(&Value::Null),
                    );
                    text_parts.push(format!("[tool_result:{id}]\n{content_text}"));
                }
                _ => {}
            }
        }
    }

    Ok(KiroContent {
        text: text_parts.join("\n"),
        images,
    })
}

fn anthropic_assistant_to_kiro(content: &Value) -> Value {
    if let Some(s) = content.as_str() {
        return json!({ "content": s });
    }
    let Some(blocks) = content.as_array() else {
        return json!({ "content": content.as_str().unwrap_or("") });
    };

    // 工具调用摊平为文本（Kiro 不接受结构化 toolUses）：
    // assistant 的 tool_use 直接以 JSON 字符串形式进 content，与 kiro2cli 一致。
    let mut text_parts = Vec::new();
    for block in blocks {
        match block.get("type").and_then(|v| v.as_str()) {
            Some("text") => {
                if let Some(text) = block.get("text").and_then(|v| v.as_str()) {
                    text_parts.push(text.to_string());
                }
            }
            Some("tool_use") => {
                text_parts.push(serde_json::to_string(block).unwrap_or_default());
            }
            _ => {}
        }
    }

    let content = text_parts.join("\n");
    // Kiro 不允许空 assistant 消息
    let content = if content.trim().is_empty() {
        ".".to_string()
    } else {
        content
    };
    json!({ "content": content })
}

fn anthropic_tools_to_kiro(tools: &Value) -> Vec<Value> {
    let Some(tools) = tools.as_array() else {
        return Vec::new();
    };
    tools
        .iter()
        .filter_map(|tool| {
            let name = tool
                .get("name")
                .or_else(|| tool.get("function").and_then(|f| f.get("name")))
                .and_then(|v| v.as_str())
                .unwrap_or("");
            if name.is_empty() {
                return None;
            }
            let description = tool
                .get("description")
                .or_else(|| tool.get("function").and_then(|f| f.get("description")))
                .and_then(|v| v.as_str())
                .unwrap_or("");
            let schema = tool
                .get("input_schema")
                .or_else(|| tool.get("function").and_then(|f| f.get("parameters")))
                .cloned()
                .unwrap_or_else(|| json!({ "type": "object", "properties": {} }));
            Some(json!({
                "toolSpecification": {
                    "name": name,
                    "description": description,
                    "inputSchema": { "json": schema },
                }
            }))
        })
        .collect()
}

fn attach_user_context(message: &mut Value, tools: &[Value], tool_results: &[Value]) {
    if tools.is_empty() && tool_results.is_empty() {
        return;
    }
    let mut context = Map::new();
    if !tools.is_empty() {
        context.insert("tools".to_string(), Value::Array(tools.to_vec()));
    }
    if !tool_results.is_empty() {
        context.insert(
            "toolResults".to_string(),
            Value::Array(tool_results.to_vec()),
        );
    }
    message.as_object_mut().unwrap().insert(
        "userInputMessageContext".to_string(),
        Value::Object(context),
    );
}

fn apply_system_prompt(text: &str, system_text: &str) -> String {
    if system_text.is_empty() {
        return text.to_string();
    }
    format!("<system>\n{system_text}\n</system>\n\n{text}")
}

fn merge_object(target: &mut Map<String, Value>, source: &Value) {
    let Some(source_obj) = source.as_object() else {
        return;
    };
    for (key, value) in source_obj {
        if value.is_object() {
            let entry = target
                .entry(key.clone())
                .or_insert_with(|| json!({}));
            if let Some(target_obj) = entry.as_object_mut() {
                merge_object(target_obj, value);
            }
        } else if !value.is_null() {
            target.insert(key.clone(), value.clone());
        }
    }
}

fn apply_thinking_fields(extra: &mut Map<String, Value>, thinking: &Value) {
    if !thinking.is_object() {
        return;
    }
    match thinking.get("type").and_then(|v| v.as_str()) {
        Some("disabled") => {
            extra.insert("thinking".to_string(), json!({ "type": "disabled" }));
        }
        Some("enabled") | Some("adaptive") => {
            let display = if thinking.get("display").and_then(|v| v.as_str()) == Some("omitted") {
                "omitted"
            } else {
                "summarized"
            };
            extra.insert("thinking".to_string(), json!({ "type": "adaptive", "display": display }));
        }
        _ => {}
    }
}

/// 构造发送给 Kiro 的 additionalModelRequestFields。
///
/// 由模型能力配置（`ModelProfile`，schema 可用时以其为唯一事实源）驱动，
/// 不再用 `is_claude`/`is_gpt` 硬编码前缀分支：模型 schema 允许什么就发什么，
/// schema 不认识的字段一律移除，从结构上消灭「property 'X' not defined in the schema」类 502。
fn build_additional_model_request_fields_with_profile(
    body: &Value,
    kiro_model: &str,
    profile: &ModelProfile,
) -> Option<Value> {
    let mut extra = Map::new();

    // 1. 合并入站 additionalModelRequestFields（用户显式塞的）
    if let Some(fields) = body
        .get("additionalModelRequestFields")
        .or_else(|| body.get("additional_model_request_fields"))
    {
        if let Some(obj) = fields.as_object() {
            merge_object(&mut extra, &Value::Object(obj.clone()));
        }
    }

    // 2. body.output_config → extra.output_config（仅当模型 schema 承认 output_config）
    if profile.supports_output_config {
        if let Some(output_config) = body.get("output_config") {
            let existing = extra
                .entry("output_config".to_string())
                .or_insert_with(|| json!({}));
            if let Some(existing_obj) = existing.as_object_mut() {
                merge_object(existing_obj, output_config);
            }
        }
    } else {
        extra.remove("output_config");
    }

    let effort = get_requested_effort(body)
        .and_then(|effort| normalize_effort_for_kiro_model(Some(&effort), kiro_model));

    // 3. max_tokens：仅对 schema/族允许的模型保留（Claude 且一般 ≥1024）
    if profile.allow_max_tokens {
        let requested_max_tokens = body
            .get("max_tokens")
            .or_else(|| body.get("max_completion_tokens"))
            .and_then(|v| v.as_i64());
        if let Some(max_tokens) = requested_max_tokens {
            if max_tokens >= 1024 {
                extra.insert("max_tokens".to_string(), json!(max_tokens));
            }
        }
    } else {
        extra.remove("max_tokens");
    }

    // 4. thinking：仅 schema/族允许的模型保留
    if profile.supports_thinking {
        apply_thinking_fields(&mut extra, body.get("thinking").unwrap_or(&Value::Null));
    } else {
        extra.remove("thinking");
    }

    // 5. effort 落位：Claude 走 output_config.effort，GPT 走 reasoning.effort
    match profile.effort_placement {
        EffortPlacement::OutputConfigEffort => {
            if let Some(effort) = effort {
                if effort != "none" {
                    let existing = extra
                        .entry("output_config".to_string())
                        .or_insert_with(|| json!({}));
                    if let Some(existing_obj) = existing.as_object_mut() {
                        existing_obj.insert("effort".to_string(), json!(effort));
                    }
                }
            }
        }
        EffortPlacement::ReasoningEffort => {
            if profile.supports_reasoning {
                if let Some(reasoning) = body.get("reasoning") {
                    let existing = extra
                        .entry("reasoning".to_string())
                        .or_insert_with(|| json!({}));
                    if let Some(existing_obj) = existing.as_object_mut() {
                        merge_object(existing_obj, reasoning);
                    }
                }
            }
            if let Some(effort) = effort {
                let existing = extra
                    .entry("reasoning".to_string())
                    .or_insert_with(|| json!({}));
                if let Some(existing_obj) = existing.as_object_mut() {
                    existing_obj.insert("effort".to_string(), json!(effort));
                }
            }
        }
        EffortPlacement::Unsupported => {}
    }

    // 6. schema 白名单终检：删掉模型 schema 不认识的顶层字段，避免 502
    if let Some(allowed) = &profile.allowed_fields {
        let allowed_set: std::collections::HashSet<&str> =
            allowed.iter().map(|s| s.as_str()).collect();
        let removed: Vec<String> = extra
            .keys()
            .filter(|key| !allowed_set.contains(key.as_str()))
            .cloned()
            .collect();
        for key in &removed {
            extra.remove(key);
        }
        if !removed.is_empty() {
            eprintln!(
                "[kiro] additionalModelRequestFields[{:?}] removed fields not in schema for {kiro_model}: {removed:?}",
                profile.family
            );
        }
    }

    if extra.is_empty() {
        None
    } else {
        Some(Value::Object(extra))
    }
}

/// 构造发送给 Kiro GenerateAssistantResponse 的请求体（无运行期 schema，回退模型族默认）。
pub fn build_kiro_request(
    body: &Value,
    kiro_model: &str,
    profile_arn: Option<&str>,
) -> Result<Value, String> {
    let profile = resolve_model_profile(kiro_model, None);
    build_kiro_request_with_profile(body, kiro_model, profile_arn, &profile)
}

/// 构造发送给 Kiro GenerateAssistantResponse 的请求体（带运行期模型 schema，以其为事实源）。
pub fn build_kiro_request_with_schema(
    body: &Value,
    kiro_model: &str,
    profile_arn: Option<&str>,
    schema: &Value,
) -> Result<Value, String> {
    let profile = resolve_model_profile(kiro_model, Some(schema));
    build_kiro_request_with_profile(body, kiro_model, profile_arn, &profile)
}

fn build_kiro_request_with_profile(
    body: &Value,
    kiro_model: &str,
    profile_arn: Option<&str>,
    profile: &ModelProfile,
) -> Result<Value, String> {
    let messages = body.get("messages").and_then(|v| v.as_array()).cloned().unwrap_or_default();
    let last_user_index = messages
        .iter()
        .rposition(|m| m.get("role").and_then(|v| v.as_str()) == Some("user"))
        .ok_or_else(|| "messages must contain at least one user message.".to_string())?;

    let system_text = system_to_text(body.get("system").unwrap_or(&Value::Null));
    let kiro_tools = anthropic_tools_to_kiro(body.get("tools").unwrap_or(&Value::Null));

    let mut history: Vec<Value> = Vec::new();
    let mut system_applied = false;

    for message in &messages[..last_user_index] {
        let role = message.get("role").and_then(|v| v.as_str()).unwrap_or("");
        if role == "user" {
            let parsed = anthropic_content_to_kiro(message.get("content").unwrap_or(&Value::Null))?;
            let content = if !system_applied && !system_text.is_empty() {
                let wrapped = apply_system_prompt(&parsed.text, &system_text);
                system_applied = true;
                wrapped
            } else {
                parsed.text
            };
            // 历史里的工具结果已摊平进文本，不再附加 userInputMessageContext
            let mut msg = json!({
                "content": content,
                "origin": "KIRO_CLI",
                "modelId": kiro_model,
            });
            if !parsed.images.is_empty() {
                msg.as_object_mut().unwrap().insert("images".to_string(), Value::Array(parsed.images));
            }
            history.push(json!({ "userInputMessage": msg }));
        } else if role == "assistant" {
            history.push(json!({
                "assistantResponseMessage": anthropic_assistant_to_kiro(
                    message.get("content").unwrap_or(&Value::Null)
                )
            }));
        }
    }

    let current_parsed = anthropic_content_to_kiro(messages[last_user_index].get("content").unwrap_or(&Value::Null))?;
    let current_content = if !system_applied {
        apply_system_prompt(&current_parsed.text, &system_text)
    } else {
        current_parsed.text
    };
    // 空消息兜底：Kiro 不接受空 userInputMessage.content
    let current_content = if current_content.trim().is_empty() {
        ".".to_string()
    } else {
        current_content
    };
    let mut current_message = json!({
        "content": current_content,
        "modelId": kiro_model,
        "origin": "KIRO_CLI",
    });
    if !current_parsed.images.is_empty() {
        current_message
            .as_object_mut()
            .unwrap()
            .insert("images".to_string(), Value::Array(current_parsed.images));
    }
    // 只附加结构化工具定义（Kiro 接受），工具结果/调用已摊平进 content（Kiro 不接受 toolResults/toolUses）
    attach_user_context(&mut current_message, &kiro_tools, &[]);

    let mut body_out = json!({
        "conversationState": {
            "currentMessage": { "userInputMessage": current_message },
            "chatTriggerType": "MANUAL",
            "conversationId": format!("sess_proxy_{}", Uuid::new_v4().to_string().replace('-', "")),
            "history": Value::Array(history),
            "agentContinuationId": Uuid::new_v4().to_string(),
            "agentTaskType": "vibe",
        },
        "profileArn": profile_arn.unwrap_or(""),
        "agentMode": "vibe",
    });

    if let Some(additional) = build_additional_model_request_fields_with_profile(body, kiro_model, profile) {
        body_out
            .as_object_mut()
            .unwrap()
            .insert("additionalModelRequestFields".to_string(), additional);
    }
    if let Some(conversation_id) = body
        .get("metadata")
        .and_then(|m| m.get("conversation_id"))
        .and_then(|v| v.as_str())
    {
        body_out
            .get_mut("conversationState")
            .unwrap()
            .as_object_mut()
            .unwrap()
            .insert("conversationId".to_string(), Value::String(conversation_id.to_string()));
    }

    Ok(body_out)
}

// ============ 响应构造 ============

pub fn anthropic_message_response_with_tools(
    id: &str,
    model: &str,
    text: &str,
    thinking: &str,
    thinking_signature: Option<&str>,
    ordered_content: &[Value],
    native_tool_uses: &[Value],
    stop_reason: &str,
    recovery_spec: &ToolRecoverySpec,
) -> Value {
    let mut content = Vec::new();
    if !thinking.is_empty() || thinking_signature.is_some_and(|s| !s.is_empty()) {
        content.push(json!({
            "type": "thinking",
            "thinking": thinking,
            "signature": thinking_signature.unwrap_or(""),
        }));
    }

    let native_tools = native_tool_uses
        .iter()
        .filter(|tool| {
            let name = tool.get("name").and_then(Value::as_str).unwrap_or("");
            let input = tool.get("input").unwrap_or(&Value::Null);
            recovery_spec.validates_input(name, input)
        })
        .cloned()
        .collect::<Vec<_>>();
    let source_content = if ordered_content.is_empty() {
        let mut source = Vec::new();
        if !text.is_empty() {
            source.push(json!({ "type": "text", "text": text }));
        }
        source.extend(native_tools.iter().cloned());
        source
    } else {
        ordered_content.to_vec()
    };
    let native_tool_ids = native_tools
        .iter()
        .filter_map(|tool| tool.get("id").and_then(Value::as_str).map(str::to_string))
        .collect::<std::collections::HashSet<_>>();
    let mut seen_tool_ids = native_tool_ids;
    let mut recovered_ordinal = 0usize;
    let mut incomplete_tool = false;
    for part in source_content {
        match part.get("type").and_then(Value::as_str) {
            Some("text") => {
                let text = part.get("text").and_then(Value::as_str).unwrap_or("");
                let recovered = recover_tool_calls_from_text(text, recovery_spec);
                incomplete_tool |= recovered.incomplete_tool;
                for recovered_part in recovered.parts {
                    match recovered_part {
                        RecoveredContent::Text(text) if !text.is_empty() => {
                            content.push(json!({ "type": "text", "text": text }));
                        }
                        RecoveredContent::Tool(mut tool)
                            if !native_tools
                                .iter()
                                .any(|native| recovery_spec.is_native_mirror(&tool, native)) =>
                        {
                            ensure_tool_id_unique(
                                &mut tool,
                                &mut seen_tool_ids,
                                recovered_ordinal,
                            );
                            recovered_ordinal += 1;
                            content.push(tool);
                        }
                        _ => {}
                    }
                }
            }
            Some("tool_use") => {
                let name = part.get("name").and_then(Value::as_str).unwrap_or("");
                let input = part.get("input").unwrap_or(&Value::Null);
                if recovery_spec.validates_input(name, input) {
                    content.push(part);
                }
            }
            _ => {}
        }
    }

    let has_tools = content
        .iter()
        .any(|block| block.get("type").and_then(Value::as_str) == Some("tool_use"));
    let final_stop = if has_tools {
        "tool_use"
    } else if incomplete_tool {
        "max_tokens"
    } else {
        normalize_stop_reason(stop_reason, false, false)
    };
    if content.is_empty() {
        content.push(json!({
            "type": "text",
            "text": "API Error: empty assistant response"
        }));
    }
    json!({
        "id": id,
        "type": "message",
        "role": "assistant",
        "model": model,
        "content": content,
        "stop_reason": final_stop,
        "stop_sequence": null,
        "usage": { "input_tokens": 0, "output_tokens": estimate_tokens(text) },
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn builds_kiro_request_basic() {
        let body = json!({
            "model": "claude-sonnet-4-5",
            "messages": [
                { "role": "user", "content": "hi there" }
            ],
            "stream": true
        });
        let built = build_kiro_request(
            &body,
            "claude-sonnet-4.5",
            Some("arn:aws:codewhisperer:us-east-1:123456789012:profile/abc"),
        )
        .unwrap();
        assert_eq!(built["profileArn"], "arn:aws:codewhisperer:us-east-1:123456789012:profile/abc");
        assert_eq!(built["agentMode"], "vibe");
        assert_eq!(built["conversationState"]["chatTriggerType"], "MANUAL");
        let cur = &built["conversationState"]["currentMessage"]["userInputMessage"];
        assert_eq!(cur["modelId"], "claude-sonnet-4.5");
        assert!(cur["content"].as_str().unwrap().contains("hi there"));
    }

    #[test]
    fn history_contains_assistant_message() {
        let body = json!({
            "messages": [
                { "role": "user", "content": "ping" },
                { "role": "assistant", "content": "pong" },
                { "role": "user", "content": "again" }
            ]
        });
        let built = build_kiro_request(&body, "claude-opus-5", Some("arn")).unwrap();
        let history = built["conversationState"]["history"].as_array().unwrap();
        assert_eq!(history.len(), 2);
        assert_eq!(history[1]["assistantResponseMessage"]["content"], "pong");
        assert_eq!(built["conversationState"]["currentMessage"]["userInputMessage"]["content"], "again");
    }

    fn recovery_spec() -> ToolRecoverySpec {
        ToolRecoverySpec::from_body(&json!({
            "tools": [
                {
                    "name": "Bash",
                    "input_schema": {
                        "type": "object",
                        "required": ["command"],
                        "properties": { "command": { "type": "string" } }
                    }
                },
                { "name": "Read", "input_schema": { "type": "object" } },
                { "name": "Edit", "input_schema": { "type": "object" } },
                {
                    "name": "AskUserQuestion",
                    "input_schema": {
                        "type": "object",
                        "required": ["questions"],
                        "properties": { "questions": { "type": "array" } }
                    }
                }
            ]
        }))
    }

    fn parse_tool_use_blocks_from_text(text: &str) -> Option<Vec<Value>> {
        let blocks = recover_tool_calls_from_text(text, &recovery_spec()).tool_blocks();
        (!blocks.is_empty()).then_some(blocks)
    }

    struct MixedTextToolFinish {
        visible_text: String,
        tool_blocks: Vec<Value>,
        incomplete_tool: bool,
    }

    struct MixedTextToolGuard(TextToolRecoveryGuard);

    impl MixedTextToolGuard {
        fn new(enabled: bool) -> Self {
            Self::with_spec(if enabled {
                recovery_spec()
            } else {
                ToolRecoverySpec::default()
            })
        }

        fn with_spec(spec: ToolRecoverySpec) -> Self {
            Self(TextToolRecoveryGuard::new(spec))
        }

        fn push(&mut self, chunk: &str) -> String {
            self.0.push(chunk)
        }

        fn finish(&mut self) -> MixedTextToolFinish {
            let finish = self.0.finish();
            let result = ToolRecoveryResult {
                parts: finish.parts,
                incomplete_tool: finish.incomplete_tool,
            };
            MixedTextToolFinish {
                visible_text: result.visible_text(),
                tool_blocks: result.tool_blocks(),
                incomplete_tool: result.incomplete_tool,
            }
        }
    }

    #[test]
    fn parses_tool_use_from_text() {
        let text = "{\"type\":\"tool_use\",\"id\":\"call_123\",\"name\":\"Bash\",\"input\":{\"command\":\"ls\"}}";
        let blocks = parse_tool_use_blocks_from_text(text).unwrap();
        assert_eq!(blocks.len(), 1);
        assert_eq!(blocks[0]["name"], "Bash");
        assert_eq!(blocks[0]["id"], "call_123");
        assert_eq!(blocks[0]["input"]["command"], "ls");
    }

    #[test]
    fn parses_malformed_flat_ask_user_question_from_text() {
        let text = concat!(
            "{\"questions\":[{\"header\":\"旧 Key\",\"multiSelect\":false,",
            "\"options\":[{\"description\":\"生成替代 Key\",\"label\":\"点击轮换（推荐）\"}],",
            "\"question\":\"数据库中无法还原原文的旧 Key，采用哪种处理方式？\"}]},",
            "\"name\":\"AskUserQuestion\"}"
        );
        let blocks = parse_tool_use_blocks_from_text(text).unwrap();
        assert_eq!(blocks.len(), 1);
        assert_eq!(blocks[0]["type"], "tool_use");
        assert_eq!(blocks[0]["name"], "AskUserQuestion");
        assert_eq!(blocks[0]["input"]["questions"][0]["header"], "旧 Key");
        assert!(blocks[0]["id"].as_str().unwrap().starts_with("call_"));
    }

    #[test]
    fn mixed_guard_recovers_malformed_flat_ask_user_question() {
        let mut guard = MixedTextToolGuard::new(true);
        assert_eq!(
            guard.push("需求明确。\n{\"questions\":[{\"header\":\"旧 Key\","),
            "需求明确。\n"
        );
        assert_eq!(
            guard.push("\"multiSelect\":false,\"options\":[],\"question\":\"如何迁移？\"}]},\"name\":\"AskUserQuestion\"}"),
            ""
        );
        let finish = guard.finish();
        assert!(!finish.incomplete_tool);
        assert_eq!(finish.tool_blocks.len(), 1);
        assert_eq!(finish.tool_blocks[0]["name"], "AskUserQuestion");
        assert_eq!(finish.tool_blocks[0]["input"]["questions"][0]["question"], "如何迁移？");
    }

    #[test]
    fn mixed_guard_releases_plain_questions_json() {
        let input = "说明：\n{\"questions\":[]}\n完成。";
        let mut guard = MixedTextToolGuard::new(true);
        let mut visible = guard.push(input);
        visible.push_str(&guard.finish().visible_text);
        assert_eq!(visible, input);
    }

    #[test]
    fn parses_concatenated_sdk_tool_objects_through_noise() {
        // Kiro 偶发把 SDK tool_use JSON 原样写进 assistant 文本，多个对象之间还会
        // 混入非 JSON 字符；必须按配平对象逐个恢复，而非要求整段是合法 JSON。
        let text = concat!(
            "{\"id\":\"call_edit_1\",\"input\":{\"file_path\":\"a.css\"},\"name\":\"Edit\",\"type\":\"tool_use\"}",
            " 噪声片段 ",
            "{\"id\":\"call_edit_2\",\"input\":{\"file_path\":\"b.css\"},\"name\":\"Edit\",\"type\":\"tool_use\"}"
        );
        let blocks = parse_tool_use_blocks_from_text(text).unwrap();
        assert_eq!(blocks.len(), 2);
        assert_eq!(blocks[0]["id"], "call_edit_1");
        assert_eq!(blocks[1]["id"], "call_edit_2");
        assert_eq!(blocks[0]["name"], "Edit");
        assert_eq!(blocks[1]["input"]["file_path"], "b.css");
    }

    #[test]
    fn mixed_guard_keeps_prose_and_recovers_following_tools() {
        // 真实泄漏形态：先输出说明文字，随后才出现 Bash JSON、hash 噪声和 Read JSON。
        let mut guard = MixedTextToolGuard::new(true);
        let visible = guard.push(concat!(
            "已定位到模型选择器。接下来读取布局。\n",
            "{\"id\":\"call_bash\",\"input\":{\"command\":\"grep model-picker\"},",
            "\"name\":\"Bash\",\"type\":\"tool_use\"}",
            " e3b0c44298fc1c149afbf4c8996fb924\n",
            "{\"id\":\"call_read\",\"input\":{\"file_path\":\"model-picker.ts\"},",
            "\"name\":\"Read\",\"type\":\"tool_use\"}通 ... error"
        ));
        assert_eq!(visible, "已定位到模型选择器。接下来读取布局。\n");

        let finish = guard.finish();
        assert_eq!(
            finish.visible_text,
            " e3b0c44298fc1c149afbf4c8996fb924\n通 ... error"
        );
        assert!(!finish.incomplete_tool);
        assert_eq!(finish.tool_blocks.len(), 2);
        assert_eq!(finish.tool_blocks[0]["name"], "Bash");
        assert_eq!(finish.tool_blocks[1]["name"], "Read");
        assert_eq!(finish.tool_blocks[1]["input"]["file_path"], "model-picker.ts");
    }

    #[test]
    fn mixed_guard_recovers_tool_split_across_chunks_after_prose() {
        let mut guard = MixedTextToolGuard::new(true);
        assert_eq!(guard.push("正文先显示。\n{\"id\":\"call_edit\",\"input\":{\"new_string\":\"a { b }"), "正文先显示。\n");
        assert_eq!(guard.push("\"},\"name\":\"Edit\",\"type\":\"tool_use\"}"), "");
        let finish = guard.finish();
        assert_eq!(finish.tool_blocks.len(), 1);
        assert_eq!(finish.tool_blocks[0]["name"], "Edit");
    }

    #[test]
    fn mixed_guard_releases_plain_json_after_prose() {
        let mut guard = MixedTextToolGuard::new(true);
        let input = "说明：\n{\"example\":{\"value\":1}}\n完成。";
        let mut visible = guard.push(input);
        visible.push_str(&guard.finish().visible_text);
        assert_eq!(visible, input);
    }

    #[test]
    fn mixed_guard_marks_truncated_tool_without_leaking_candidate() {
        let mut guard = MixedTextToolGuard::new(true);
        assert_eq!(
            guard.push("正文\n{\"id\":\"call_edit\",\"input\":{\"new_string\":\"unfinished"),
            "正文\n"
        );
        let finish = guard.finish();
        assert!(finish.visible_text.is_empty());
        assert!(finish.tool_blocks.is_empty());
        assert!(finish.incomplete_tool);
    }

    #[test]
    fn mixed_guard_is_disabled_without_declared_tools() {
        let raw = "正文\n{\"id\":\"call_fake\",\"input\":{},\"name\":\"Bash\",\"type\":\"tool_use\"}";
        let mut guard = MixedTextToolGuard::new(false);
        assert_eq!(guard.push(raw), raw);
        assert!(guard.finish().tool_blocks.is_empty());
    }

    #[test]
    fn preserves_tool_example_inside_code_fence() {
        let text = concat!(
            "Example only:\n```json\n",
            "{\"type\":\"tool_use\",\"id\":\"call_001\",\"name\":\"Bash\",",
            "\"input\":{\"command\":\"find . -name \\\"*.rs\\\"\"}}",
            "\n```\nDo not run it."
        );
        let recovered = recover_tool_calls_from_text(text, &recovery_spec());
        assert!(recovered.tool_blocks().is_empty());
        assert_eq!(recovered.visible_text(), text);
    }

    #[test]
    fn rejects_false_schema_and_additional_properties() {
        let false_spec = ToolRecoverySpec::from_body(&json!({
            "tools": [{ "name": "Denied", "input_schema": false }]
        }));
        let denied = recover_tool_calls_from_text(
            "{\"name\":\"Denied\",\"input\":{}}",
            &false_spec,
        );
        assert!(denied.tool_blocks().is_empty());

        let strict_spec = ToolRecoverySpec::from_body(&json!({
            "tools": [{
                "name": "Strict",
                "input_schema": {
                    "type": "object",
                    "required": ["path"],
                    "properties": { "path": { "type": "string" } },
                    "additionalProperties": false
                }
            }]
        }));
        let extra = recover_tool_calls_from_text(
            "{\"name\":\"Strict\",\"path\":\"a\",\"unexpected\":true}",
            &strict_spec,
        );
        assert!(extra.tool_blocks().is_empty());
    }

    #[test]
    fn malformed_schema_keyword_types_fail_closed() {
        let spec = ToolRecoverySpec::from_body(&json!({
            "tools": [{
                "name": "Run",
                "input_schema": {
                    "type": "object",
                    "required": "command"
                }
            }]
        }));
        let recovered = recover_tool_calls_from_text(
            "{\"name\":\"Run\",\"input\":{}}",
            &spec,
        );
        assert!(recovered.tool_blocks().is_empty());
    }

    #[test]
    fn large_integer_bounds_are_compared_exactly() {
        let spec = ToolRecoverySpec::from_body(&json!({
            "tools": [{
                "name": "Bounded",
                "input_schema": {
                    "type": "object",
                    "required": ["n"],
                    "properties": {
                        "n": {
                            "type": "integer",
                            "maximum": 9007199254740992_u64
                        }
                    }
                }
            }]
        }));
        let valid = recover_tool_calls_from_text(
            "{\"name\":\"Bounded\",\"input\":{\"n\":9007199254740992}}",
            &spec,
        );
        assert_eq!(valid.tool_blocks().len(), 1);
        let invalid = recover_tool_calls_from_text(
            "{\"name\":\"Bounded\",\"input\":{\"n\":9007199254740993}}",
            &spec,
        );
        assert!(invalid.tool_blocks().is_empty());
    }

    #[test]
    fn exact_decimal_constraints_handle_fraction_exponent_and_big_integers() {
        let bounded = ToolRecoverySpec::from_body(&json!({
            "tools": [{
                "name": "Number",
                "input_schema": {
                    "type": "object",
                    "required": ["n"],
                    "properties": { "n": { "type": "number", "minimum": 0.1 } }
                }
            }]
        }));
        assert_eq!(
            recover_tool_calls_from_text(
                "{\"name\":\"Number\",\"input\":{\"n\":0.1}}",
                &bounded,
            )
            .tool_blocks()
            .len(),
            1
        );
        assert!(recover_tool_calls_from_text(
            "{\"name\":\"Number\",\"input\":{\"n\":0}}",
            &bounded,
        )
        .tool_blocks()
        .is_empty());

        let big = ToolRecoverySpec::from_body(&serde_json::from_str::<Value>(r#"{
            "tools":[{"name":"Big","input_schema":{"type":"object","required":["n"],
            "properties":{"n":{"type":"integer","maximum":18446744073709551616}}}}]
        }"#).unwrap());
        assert!(recover_tool_calls_from_text(
            "{\"name\":\"Big\",\"input\":{\"n\":18446744073709551617}}",
            &big,
        )
        .tool_blocks()
        .is_empty());

        let integer = ToolRecoverySpec::from_body(&json!({
            "tools": [{
                "name": "Integer",
                "input_schema": {
                    "type": "object",
                    "properties": { "n": { "type": "integer" } }
                }
            }]
        }));
        assert_eq!(
            recover_tool_calls_from_text(
                "{\"name\":\"Integer\",\"input\":{\"n\":1e2}}",
                &integer,
            )
            .tool_blocks()
            .len(),
            1
        );

        let multiple = ToolRecoverySpec::from_body(&json!({
            "tools": [{
                "name": "Multiple",
                "input_schema": {
                    "type": "object",
                    "properties": { "n": { "type": "number", "multipleOf": 0.1 } }
                }
            }]
        }));
        assert_eq!(
            recover_tool_calls_from_text(
                "{\"name\":\"Multiple\",\"input\":{\"n\":1e100}}",
                &multiple,
            )
            .tool_blocks()
            .len(),
            1
        );
    }

    #[test]
    fn malformed_examples_keyword_fails_closed() {
        let spec = ToolRecoverySpec::from_body(&json!({
            "tools": [{
                "name": "Run",
                "input_schema": { "type": "object", "examples": "not-an-array" }
            }]
        }));
        assert!(recover_tool_calls_from_text(
            "{\"name\":\"Run\",\"input\":{}}",
            &spec,
        )
        .tool_blocks()
        .is_empty());
    }

    #[test]
    fn tilde_fenced_tool_example_remains_text() {
        let text = "~~~json\n{\"name\":\"AskUserQuestion\",\"input\":{\"questions\":[]}}\n~~~";
        let recovered = recover_tool_calls_from_text(text, &recovery_spec());
        assert!(recovered.tool_blocks().is_empty());
        assert_eq!(recovered.visible_text(), text);
    }

    #[test]
    fn oversized_exact_numbers_fail_closed() {
        let huge = format!("1{}", "0".repeat(MAX_EXACT_NUMBER_DIGITS));
        let body_text = r#"{"tools":[{"name":"Huge","input_schema":{"type":"object","properties":{"n":{"type":"number","multipleOf":__HUGE__}}}}]}"#
            .replace("__HUGE__", &huge);
        let body = serde_json::from_str::<Value>(&body_text).unwrap();
        let spec = ToolRecoverySpec::from_body(&body);
        let recovered = recover_tool_calls_from_text(
            "{\"name\":\"Huge\",\"input\":{\"n\":1}}",
            &spec,
        );
        assert!(recovered.tool_blocks().is_empty());
    }

    #[test]
    fn supports_pattern_schema_without_weakening_validation() {
        let spec = ToolRecoverySpec::from_body(&json!({
            "tools": [{
                "name": "Lookup",
                "input_schema": {
                    "type": "object",
                    "required": ["key"],
                    "properties": { "key": { "type": "string", "pattern": "^[a-z]+$" } },
                    "additionalProperties": false
                }
            }]
        }));
        let valid = recover_tool_calls_from_text(
            "{\"name\":\"Lookup\",\"input\":{\"key\":\"valid\"}}",
            &spec,
        );
        assert_eq!(valid.tool_blocks().len(), 1);
        let invalid = recover_tool_calls_from_text(
            "{\"name\":\"Lookup\",\"input\":{\"key\":\"INVALID1\"}}",
            &spec,
        );
        assert!(invalid.tool_blocks().is_empty());
    }

    #[test]
    fn distinct_ids_are_not_mirror_duplicates() {
        let spec = recovery_spec();
        let text = json!({
            "type": "tool_use",
            "id": "text_1",
            "name": "Bash",
            "input": { "command": "same" }
        });
        let native = json!({
            "type": "tool_use",
            "id": "native_1",
            "name": "Bash",
            "input": { "command": "same" }
        });
        assert!(!spec.is_native_mirror(&text, &native));
    }

    #[test]
    fn same_id_native_call_wins_even_when_text_input_differs() {
        let spec = recovery_spec();
        let text = json!({
            "type": "tool_use",
            "id": "call_same",
            "name": "Bash",
            "input": { "command": "one" }
        });
        let native = json!({
            "type": "tool_use",
            "id": "call_same",
            "name": "Bash",
            "input": { "command": "two" }
        });
        assert!(spec.is_native_mirror(&text, &native));
    }

    #[test]
    fn inline_tool_json_example_remains_text() {
        let text = concat!(
            "Example only; do not run: ",
            "{\"type\":\"tool_use\",\"id\":\"example_1\",\"name\":\"Bash\",",
            "\"input\":{\"command\":\"echo example\"}}"
        );
        let recovered = recover_tool_calls_from_text(text, &recovery_spec());
        assert!(recovered.tool_blocks().is_empty());
        assert_eq!(recovered.visible_text(), text);
    }

    #[test]
    fn line_start_tool_after_prose_is_recovered() {
        let text = concat!(
            "I will inspect it now.\n",
            "{\"type\":\"tool_use\",\"id\":\"call_1\",\"name\":\"Bash\",",
            "\"input\":{\"command\":\"ls\"}}"
        );
        let recovered = recover_tool_calls_from_text(text, &recovery_spec());
        assert_eq!(recovered.tool_blocks().len(), 1);
        assert_eq!(recovered.visible_text(), "I will inspect it now.\n");
    }

    #[test]
    fn duplicate_explicit_ids_are_rewritten() {
        let text = concat!(
            "{\"type\":\"tool_use\",\"id\":\"call_dup\",\"name\":\"Bash\",",
            "\"input\":{\"command\":\"one\"}}",
            "{\"type\":\"tool_use\",\"id\":\"call_dup\",\"name\":\"Bash\",",
            "\"input\":{\"command\":\"two\"}}"
        );
        let blocks = recover_tool_calls_from_text(text, &recovery_spec()).tool_blocks();
        assert_eq!(blocks.len(), 2);
        assert_ne!(blocks[0]["id"], blocks[1]["id"]);
    }

    #[test]
    fn duplicate_id_rewrite_avoids_existing_generated_id() {
        let third_input = json!({ "command": "third" });
        let occupied = stable_tool_id(2, 2, "Bash", &third_input);
        let text = format!(
            "{{\"type\":\"tool_use\",\"id\":\"{occupied}\",\"name\":\"Bash\",\"input\":{{\"command\":\"first\"}}}}\
             {{\"type\":\"tool_use\",\"id\":\"dup\",\"name\":\"Bash\",\"input\":{{\"command\":\"second\"}}}}\
             {{\"type\":\"tool_use\",\"id\":\"dup\",\"name\":\"Bash\",\"input\":{{\"command\":\"third\"}}}}"
        );
        let blocks = recover_tool_calls_from_text(&text, &recovery_spec()).tool_blocks();
        assert_eq!(blocks.len(), 3);
        let ids = blocks
            .iter()
            .filter_map(|block| block.get("id").and_then(Value::as_str))
            .collect::<std::collections::HashSet<_>>();
        assert_eq!(ids.len(), 3);
    }

    #[test]
    fn recovery_buffer_has_hard_limit_and_preserves_ordinary_json() {
        let ordinary = format!(
            "{{\"command\":\"not a tool call\"}}{}",
            "x".repeat(MAX_TOOL_RECOVERY_BYTES)
        );
        let mut guard = TextToolRecoveryGuard::new(recovery_spec());
        let visible = guard.push(&ordinary);
        let finish = guard.finish();
        assert_eq!(visible, ordinary);
        assert!(finish.parts.is_empty());
        assert!(!finish.incomplete_tool);

        let protocol = format!(
            "{{\"type\":\"tool_use\",\"id\":\"call_big\",\"input\":{{\"command\":\"{}",
            "x".repeat(MAX_TOOL_RECOVERY_BYTES)
        );
        let mut guard = TextToolRecoveryGuard::new(recovery_spec());
        assert!(guard.push(&protocol).is_empty());
        let finish = guard.finish();
        assert!(finish.parts.is_empty());
        assert!(finish.incomplete_tool);
    }

    #[test]
    fn tools_use_native_kiro_context() {
        let body = json!({
            "system": "You are helpful",
            "messages": [{ "role": "user", "content": "hi" }],
            "tools": [{
                "name": "Bash",
                "description": "run a command",
                "input_schema": {
                    "type": "object",
                    "required": ["command"],
                    "properties": { "command": { "type": "string" } }
                }
            }]
        });
        let built = build_kiro_request(&body, "claude-opus-5", Some("arn")).unwrap();
        let current = &built["conversationState"]["currentMessage"]["userInputMessage"];
        let content = current["content"].as_str().unwrap();
        assert!(content.contains("You are helpful"));
        assert!(!content.contains("Available tools:"));
        let specification = &current["userInputMessageContext"]["tools"][0]["toolSpecification"];
        assert_eq!(specification["name"], "Bash");
        assert_eq!(
            specification["inputSchema"]["json"]["required"][0],
            "command"
        );
    }

    #[test]
    fn converts_native_tool_round_trip() {
        let body = json!({
            "messages": [
                { "role": "user", "content": "list files" },
                {
                    "role": "assistant",
                    "content": [{
                        "type": "tool_use",
                        "id": "call_abc",
                        "name": "Bash",
                        "input": { "command": "ls" }
                    }]
                },
                {
                    "role": "user",
                    "content": [{
                        "type": "tool_result",
                        "tool_use_id": "call_abc",
                        "content": "a.txt\nb.txt"
                    }]
                }
            ],
            "tools": [{
                "name": "Bash",
                "description": "run a command",
                "input_schema": { "type": "object" }
            }]
        });
        let built = build_kiro_request(&body, "gpt-5.6-sol", Some("arn")).unwrap();
        let history = built["conversationState"]["history"].as_array().unwrap();
        let assistant = &history[1]["assistantResponseMessage"];
        // 工具调用摊平为文本（Kiro 不接受结构化 toolUses）
        let assistant_text = assistant["content"].as_str().unwrap();
        assert!(assistant_text.contains("\"type\":\"tool_use\""));
        assert!(assistant_text.contains("\"id\":\"call_abc\""));
        assert!(assistant_text.contains("\"name\":\"Bash\""));
        assert!(assistant.get("toolUses").is_none(), "toolUses must NOT be sent");

        let current = &built["conversationState"]["currentMessage"]["userInputMessage"];
        // 工具结果摊平为文本，而不是 userInputMessageContext.toolResults
        assert_eq!(current["content"], "[tool_result:call_abc]\na.txt\nb.txt");
        assert_eq!(current["origin"], "KIRO_CLI");
        assert_eq!(
            current["userInputMessageContext"]["tools"][0]["toolSpecification"]["name"],
            "Bash"
        );
        assert!(
            current["userInputMessageContext"].get("toolResults").is_none(),
            "toolResults must NOT be sent"
        );
    }

    #[test]
    fn preserves_historical_tool_results_and_error_status() {
        let body = json!({
            "messages": [
                { "role": "user", "content": "run it" },
                {
                    "role": "assistant",
                    "content": [{
                        "type": "tool_use",
                        "id": "call_bad",
                        "name": "Bash",
                        "input": { "command": "false" }
                    }]
                },
                {
                    "role": "user",
                    "content": [{
                        "type": "tool_result",
                        "tool_use_id": "call_bad",
                        "is_error": true,
                        "content": [{ "type": "text", "text": "exit 1" }]
                    }]
                },
                { "role": "assistant", "content": "retrying" },
                { "role": "user", "content": "continue" }
            ]
        });
        let built = build_kiro_request(&body, "deepseek-3.2", Some("arn")).unwrap();
        let history = built["conversationState"]["history"].as_array().unwrap();
        // 历史里的工具结果摊平进 user content，不再有 userInputMessageContext.toolResults
        let content = history[2]["userInputMessage"]["content"].as_str().unwrap();
        assert!(content.starts_with("[tool_result:call_bad]"));
        assert!(content.contains("exit 1"));
        assert!(
            history[2]["userInputMessage"].get("userInputMessageContext").is_none(),
            "tool results flattened; no userInputMessageContext"
        );
    }

    #[test]
    fn drops_orphan_tool_results() {
        let body = json!({
            "messages": [
                { "role": "user", "content": "hi" },
                {
                    "role": "assistant",
                    "content": [{
                        "type": "tool_use",
                        "id": "call_keep",
                        "name": "Bash",
                        "input": { "command": "ls" }
                    }]
                },
                {
                    "role": "user",
                    "content": [
                        {
                            "type": "tool_result",
                            "tool_use_id": "call_keep",
                            "content": "ok"
                        },
                        {
                            "type": "tool_result",
                            "tool_use_id": "call_orphan",
                            "content": "nope"
                        }
                    ]
                }
            ],
            "tools": [{ "name": "Bash", "input_schema": { "type": "object" } }]
        });
        let built = build_kiro_request(&body, "gpt-5.6-sol", Some("arn")).unwrap();
        // 工具结果全部摊平进 currentMessage 文本（不再做孤儿过滤/Kiro 不接受 toolResults）
        let current = &built["conversationState"]["currentMessage"]["userInputMessage"];
        let content = current["content"].as_str().unwrap();
        assert!(content.starts_with("[tool_result:call_keep]\nok"));
        assert!(content.contains("[tool_result:call_orphan]\nnope"));
        assert!(
            current["userInputMessageContext"].get("toolResults").is_none(),
            "toolResults must NOT be sent"
        );
        assert_eq!(
            current["userInputMessageContext"]["tools"][0]["toolSpecification"]["name"],
            "Bash"
        );
    }

    #[test]
    fn large_tool_results_are_truncated_into_current_text() {
        // 大工具结果（如读大文件）会摊平进文本，但按 MAX_TOOL_RESULT_TEXT_CHARS 截断，避免撑爆模型上下文。
        let big = "x".repeat(200_000);
        let body = json!({
            "messages": [
                { "role": "user", "content": "show me the file" },
                {
                    "role": "assistant",
                    "content": [{
                        "type": "tool_use",
                        "id": "call_1",
                        "name": "Read",
                        "input": { "file_path": "/tmp/big.txt" }
                    }]
                },
                {
                    "role": "user",
                    "content": [{
                        "type": "tool_result",
                        "tool_use_id": "call_1",
                        "content": [{ "type": "text", "text": big }]
                    }]
                }
            ],
            "tools": [{ "name": "Read", "input_schema": { "type": "object" } }]
        });
        let built = build_kiro_request(&body, "gpt-5.6-sol", Some("arn")).unwrap();
        let current = &built["conversationState"]["currentMessage"]["userInputMessage"];
        let content = current["content"].as_str().unwrap();
        assert!(content.starts_with("[tool_result:call_1]"));
        // 截断后远小于原始 200_000，且带截断标记
        assert!(content.len() < 10_000, "content should be truncated: len={}", content.len());
        assert!(content.contains("truncated"));
        assert!(content.contains("tool result"));
        assert!(
            current["userInputMessageContext"].get("toolResults").is_none(),
            "toolResults must NOT be sent"
        );
    }

    #[test]
    fn gpt_models_do_not_forward_anthropic_max_tokens() {
        let body = json!({
            "model": "claude-sonnet-5",
            "max_tokens": 32000,
            "messages": [{ "role": "user", "content": "hi" }],
            "thinking": { "type": "enabled" },
        });
        let built = build_kiro_request(&body, "gpt-5.6-sol", Some("arn")).unwrap();
        let additional = &built["additionalModelRequestFields"];
        assert!(additional.get("max_tokens").is_none(), "gpt must not receive max_tokens");
        assert!(additional.get("thinking").is_none(), "gpt must not receive thinking");
        assert!(additional.get("output_config").is_none(), "gpt must not receive output_config");
    }

    #[test]
    fn claude_models_forward_max_tokens_when_large_enough() {
        let body = json!({
            "max_tokens": 32000,
            "messages": [{ "role": "user", "content": "hi" }],
        });
        let built = build_kiro_request(&body, "claude-sonnet-5", Some("arn")).unwrap();
        assert_eq!(built["additionalModelRequestFields"]["max_tokens"], 32000);
    }

    #[test]
    fn claude_models_forward_thinking_enabled() {
        let body = json!({
            "max_tokens": 4096,
            "messages": [{ "role": "user", "content": "hi" }],
            "thinking": { "type": "enabled" },
        });
        let built = build_kiro_request(&body, "claude-opus-4.8", Some("arn")).unwrap();
        let thinking = &built["additionalModelRequestFields"]["thinking"];
        assert_eq!(thinking["type"], "adaptive");
        assert_eq!(thinking["display"], "summarized");
    }

    #[test]
    fn nonstream_response_preserves_text_tool_text_order() {
        let spec = recovery_spec();
        let native = json!({
            "type": "tool_use",
            "id": "call_1",
            "name": "Bash",
            "input": { "command": "ls" }
        });
        let ordered = vec![
            json!({ "type": "text", "text": "before" }),
            native.clone(),
            json!({ "type": "text", "text": "after" }),
        ];
        let response = anthropic_message_response_with_tools(
            "msg_order",
            "claude-opus-4.8",
            "beforeafter",
            "",
            None,
            &ordered,
            &[native],
            "tool_use",
            &spec,
        );
        assert_eq!(response["content"][0]["text"], "before");
        assert_eq!(response["content"][1]["id"], "call_1");
        assert_eq!(response["content"][2]["text"], "after");
    }

    #[test]
    fn nonstream_response_uniquifies_ids_across_text_segments() {
        let spec = recovery_spec();
        let native = json!({
            "type": "tool_use",
            "id": "native",
            "name": "Bash",
            "input": { "command": "middle" }
        });
        let ordered = vec![
            json!({
                "type": "text",
                "text": "{\"type\":\"tool_use\",\"id\":\"dup\",\"name\":\"Bash\",\"input\":{\"command\":\"one\"}}"
            }),
            native.clone(),
            json!({
                "type": "text",
                "text": "{\"type\":\"tool_use\",\"id\":\"dup\",\"name\":\"Bash\",\"input\":{\"command\":\"two\"}}"
            }),
        ];
        let response = anthropic_message_response_with_tools(
            "msg_ids",
            "claude-opus-4.8",
            "",
            "",
            None,
            &ordered,
            &[native],
            "tool_use",
            &spec,
        );
        let ids = response["content"]
            .as_array()
            .unwrap()
            .iter()
            .filter(|block| block["type"] == "tool_use")
            .filter_map(|block| block["id"].as_str())
            .collect::<std::collections::HashSet<_>>();
        assert_eq!(ids.len(), 3);
    }

    #[test]
    fn response_includes_thinking_block_before_text() {
        let response = anthropic_message_response_with_tools(
            "msg_1",
            "claude-opus-4.8",
            "最终答案",
            "先想一步。",
            Some("sig_xyz"),
            &[],
            &[],
            "end_turn",
            &ToolRecoverySpec::default(),
        );
        let content = response["content"].as_array().unwrap();
        assert_eq!(content.len(), 2);
        assert_eq!(content[0]["type"], "thinking");
        assert_eq!(content[0]["thinking"], "先想一步。");
        assert_eq!(content[0]["signature"], "sig_xyz");
        assert_eq!(content[1]["type"], "text");
        assert_eq!(content[1]["text"], "最终答案");
    }

    #[test]
    fn response_downgrades_tool_use_without_tool_blocks() {
        let response = anthropic_message_response_with_tools(
            "msg_2",
            "claude-opus-4.8",
            "只有文本",
            "",
            None,
            &[],
            &[],
            "tool_use",
            &ToolRecoverySpec::default(),
        );
        assert_eq!(response["stop_reason"], "end_turn");
        assert_eq!(response["content"][0]["type"], "text");
        assert_eq!(response["content"][0]["text"], "只有文本");
    }

    #[test]
    fn response_fills_empty_content_with_fallback_text() {
        let response = anthropic_message_response_with_tools(
            "msg_3",
            "claude-opus-4.8",
            "",
            "",
            None,
            &[],
            &[],
            "tool_use",
            &ToolRecoverySpec::default(),
        );
        assert_eq!(response["stop_reason"], "end_turn");
        assert_eq!(response["content"][0]["type"], "text");
        assert!(
            response["content"][0]["text"]
                .as_str()
                .unwrap_or("")
                .contains("empty assistant response")
        );
    }

    #[test]
    fn schema_allowlist_strips_fields_the_model_does_not_accept() {
        // 一个只认识 reasoning 的 schema（典型 GPT）：max_tokens / thinking / output_config 都不在 schema 里。
        let schema = json!({
            "properties": {
                "reasoning": { "properties": { "effort": { "enum": ["none","low","medium","high","xhigh","max"] } } }
            }
        });
        let body = json!({
            "model": "gpt-5.6-sol",
            "max_tokens": 32000,
            "thinking": { "type": "enabled" },
            "output_config": { "effort": "high" },
            "messages": [{ "role": "user", "content": "hi" }],
            "stream": true
        });
        let built = build_kiro_request_with_schema(&body, "gpt-5.6-sol", Some("arn"), &schema).unwrap();
        let additional = &built["additionalModelRequestFields"];
        assert!(additional.get("max_tokens").is_none(), "max_tokens not in schema → must be stripped");
        assert!(additional.get("thinking").is_none(), "thinking not in schema → must be stripped");
        assert!(additional.get("output_config").is_none(), "output_config not in schema → must be stripped");
        assert_eq!(additional["reasoning"]["effort"], "high", "effort lands in reasoning.effort");
    }

    #[test]
    fn schema_source_of_truth_keeps_fields_the_model_accepts() {
        // 一个同时认识 max_tokens / thinking / output_config 的 schema（典型 Claude）。
        let schema = json!({
            "properties": {
                "max_tokens": { "type": "integer" },
                "thinking": { "type": "object" },
                "output_config": { "properties": { "effort": { "enum": ["low","medium","high","xhigh","max"] } } }
            }
        });
        let body = json!({
            "model": "claude-opus-5",
            "max_tokens": 32000,
            "thinking": { "type": "enabled" },
            "output_config": { "effort": "high" },
            "messages": [{ "role": "user", "content": "hi" }],
        });
        let built = build_kiro_request_with_schema(&body, "claude-opus-5", Some("arn"), &schema).unwrap();
        let additional = &built["additionalModelRequestFields"];
        assert_eq!(additional["max_tokens"], 32000);
        assert_eq!(additional["thinking"]["type"], "adaptive");
        assert_eq!(additional["output_config"]["effort"], "high");
    }

    #[test]
    fn schema_effort_low_lands_in_reasoning_for_reasoning_models() {
        // GPT 类 schema：effort 应落在 reasoning.effort，而不是 output_config。
        let schema = json!({
            "properties": {
                "reasoning": { "properties": { "effort": { "enum": ["none","low","medium","high","xhigh","max"] } } }
            }
        });
        let body = json!({
            "model": "gpt-5.6-terra",
            "reasoning": { "effort": "low" },
            "messages": [{ "role": "user", "content": "hi" }],
        });
        let built = build_kiro_request_with_schema(&body, "gpt-5.6-terra", Some("arn"), &schema).unwrap();
        let additional = &built["additionalModelRequestFields"];
        assert_eq!(additional["reasoning"]["effort"], "low");
        assert!(additional.get("output_config").is_none());
    }

    #[test]
    fn schema_without_requested_fields_produces_no_additional() {
        // 请求没带任何 additional 字段时，不应生成 additionalModelRequestFields。
        let schema = json!({
            "properties": { "reasoning": { "properties": { "effort": { "enum": ["none","low","medium","high"] } } } }
        });
        let body = json!({
            "model": "gpt-5.6-luna",
            "messages": [{ "role": "user", "content": "hi" }],
        });
        let built = build_kiro_request_with_schema(&body, "gpt-5.6-luna", Some("arn"), &schema).unwrap();
        assert!(built.get("additionalModelRequestFields").is_none());
    }

    // ============ antml 参数块泄漏恢复 ============

    fn antml_recovery_spec() -> ToolRecoverySpec {
        ToolRecoverySpec::from_body(&json!({
            "tools": [
                {
                    "name": "Grep",
                    "input_schema": {
                        "type": "object",
                        "required": ["pattern"],
                        "properties": {
                            "pattern": { "type": "string" },
                            "path": { "type": "string" },
                            "output_mode": { "type": "string" },
                            "-n": { "type": "boolean" }
                        }
                    }
                },
                {
                    "name": "Read",
                    "input_schema": {
                        "type": "object",
                        "required": ["file_path"],
                        "properties": { "file_path": { "type": "string" } }
                    }
                },
                {
                    "name": "Edit",
                    "input_schema": {
                        "type": "object",
                        "required": ["file_path", "old_string", "new_string"],
                        "properties": {
                            "file_path": { "type": "string" },
                            "old_string": { "type": "string" },
                            "new_string": { "type": "string" }
                        }
                    }
                }
            ]
        }))
    }

    #[test]
    fn recovers_antml_leak_with_id_opener_and_infers_name() {
        // 真实泄漏样本（2026-09-10，claude-sonnet-5 经 Kiro 上游）：
        // <invoke name="Grep"> 退化为 {"id":"toolu_...">，工具名完全丢失，需按 schema 推断。
        let text = concat!(
            "逐一过一遍。\n",
            "{\"id\":\"toolu_bdrk_01Ryn6exXNJ3RVfxYA2j6akD\">\n",
            "<parameter name=\"output_mode\">content</parameter>\n",
            "<parameter name=\"path\">C:\\Users\\dev\\StockAccessRecordServiceImpl.java</parameter>\n",
            "<parameter name=\"pattern\">initContractNote\\(</parameter>\n",
            "<parameter name=\"-n\">true</parameter>\n",
            "</invoke>"
        );
        let recovered = recover_tool_calls_from_text(text, &antml_recovery_spec());
        assert!(!recovered.incomplete_tool);
        assert_eq!(recovered.visible_text(), "逐一过一遍。\n");
        let blocks = recovered.tool_blocks();
        assert_eq!(blocks.len(), 1);
        assert_eq!(blocks[0]["name"], "Grep");
        assert_eq!(blocks[0]["id"], "toolu_bdrk_01Ryn6exXNJ3RVfxYA2j6akD");
        assert_eq!(blocks[0]["input"]["pattern"], "initContractNote\\(");
        assert_eq!(blocks[0]["input"]["-n"], true);
        assert_eq!(blocks[0]["input"]["output_mode"], "content");
    }

    #[test]
    fn recovers_antml_leak_with_multiline_params_and_infers_edit() {
        // 真实泄漏样本 2：多行参数值（old_string/new_string 含换行），工具名按命中数推断为 Edit 而非 Read。
        let text = concat!(
            "需要转换逻辑。\n",
            "{\"id\":\"toolu_bdrk_01Sk9BiVWaZ4dK9GJZAX2dTV\">\n",
            "<parameter name=\"file_path\">C:\\Users\\dev\\ContractNoteNoticeServiceImpl.java</parameter>\n",
            "<parameter name=\"old_string\">    @Override\n    public ContractNoteUrlRespVO view(ContractNoteNoticeReqVO req) {\n        ContractNoteNoticeDO record = contractNoteNoticeManager.view(req.getBizType(), req.getBizId(), req.getFundAccount());</parameter>\n",
            "<parameter name=\"new_string\">    @Override\n    public ContractNoteUrlRespVO view(ContractNoteNoticeReqVO req) {\n        Long bizId = req.getBizId();\n        ContractNoteNoticeDO record = contractNoteNoticeManager.view(req.getBizType(), bizId, req.getFundAccount());</parameter>\n",
            "</invoke>"
        );
        let recovered = recover_tool_calls_from_text(text, &antml_recovery_spec());
        assert!(!recovered.incomplete_tool);
        assert_eq!(recovered.visible_text(), "需要转换逻辑。\n");
        let blocks = recovered.tool_blocks();
        assert_eq!(blocks.len(), 1);
        assert_eq!(blocks[0]["name"], "Edit");
        assert_eq!(blocks[0]["id"], "toolu_bdrk_01Sk9BiVWaZ4dK9GJZAX2dTV");
        assert_eq!(
            blocks[0]["input"]["old_string"],
            "    @Override\n    public ContractNoteUrlRespVO view(ContractNoteNoticeReqVO req) {\n        ContractNoteNoticeDO record = contractNoteNoticeManager.view(req.getBizType(), req.getBizId(), req.getFundAccount());"
        );
    }

    #[test]
    fn antml_leak_with_unmatched_params_stays_text() {
        // 参数与任何声明工具都对不上时不恢复，保持原文可见。
        let text = concat!(
            "{\"id\":\"toolu_bdrk_01Unknown\">\n",
            "<parameter name=\"bogus\">value</parameter>\n",
            "</invoke>"
        );
        let recovered = recover_tool_calls_from_text(text, &antml_recovery_spec());
        assert!(recovered.tool_blocks().is_empty());
        assert!(!recovered.incomplete_tool);
        assert_eq!(recovered.visible_text(), text);
    }

    #[test]
    fn antml_leak_truncated_mid_params_marks_incomplete() {
        // 流在参数值中间被截断：标记 incomplete_tool（stop_reason 落 max_tokens），不虚构工具块。
        let text = concat!(
            "前文。\n",
            "{\"id\":\"toolu_bdrk_01Trunc\">\n",
            "<parameter name=\"pattern\">initContr"
        );
        let recovered = recover_tool_calls_from_text(text, &antml_recovery_spec());
        assert!(recovered.incomplete_tool);
        assert!(recovered.tool_blocks().is_empty());
        assert_eq!(recovered.visible_text(), "前文。\n");
    }

    #[test]
    fn recovers_antml_leak_with_invoke_name_opener() {
        // 变体：开标签保留 <invoke name="X"> 形态，名字直接可用但仍需通过 schema 校验。
        let text = concat!(
            "<invoke name=\"Grep\">\n",
            "<parameter name=\"pattern\">RequiredArgsConstructor</parameter>\n",
            "</invoke>"
        );
        let recovered = recover_tool_calls_from_text(text, &antml_recovery_spec());
        let blocks = recovered.tool_blocks();
        assert_eq!(blocks.len(), 1);
        assert_eq!(blocks[0]["name"], "Grep");
        assert!(blocks[0]["id"].as_str().unwrap().starts_with("call_recovered_"));
    }

    #[test]
    fn mixed_guard_recovers_antml_leak_streaming() {
        // 流式路径：opener 从 `{` 处开始缓冲，finish 时整体恢复。
        let mut guard = MixedTextToolGuard::with_spec(antml_recovery_spec());
        assert_eq!(
            guard.push("需要转换逻辑。\n{\"id\":\"toolu_bdrk_01Sk9BiVWaZ4dK9GJZAX2dTV\">"),
            "需要转换逻辑。\n"
        );
        assert_eq!(
            guard.push(concat!(
                "\n<parameter name=\"file_path\">C:\\dev\\A.java</parameter>",
                "\n<parameter name=\"old_string\">old</parameter>",
                "\n<parameter name=\"new_string\">new</parameter>",
                "\n</invoke>"
            )),
            ""
        );
        let finish = guard.finish();
        assert!(!finish.incomplete_tool);
        // 正文已在首段 push 时吐出，pending 里只剩调用块，finish 侧不再有可见文本
        assert_eq!(finish.visible_text, "");
        assert_eq!(finish.tool_blocks.len(), 1);
        assert_eq!(finish.tool_blocks[0]["name"], "Edit");
        assert_eq!(finish.tool_blocks[0]["input"]["new_string"], "new");
    }

    #[test]
    fn mixed_guard_marks_truncated_antml_leak_incomplete() {
        // 流式路径被截断：正文保留、标记 incomplete_tool，不把半截调用当正文泄漏出去。
        let mut guard = MixedTextToolGuard::with_spec(antml_recovery_spec());
        assert_eq!(guard.push("正文。\n{\"id\":\"toolu_bdrk_01Cut\">"), "正文。\n");
        assert_eq!(guard.push("\n<parameter name=\"old_string\">half"), "");
        let finish = guard.finish();
        assert!(finish.incomplete_tool);
        assert!(finish.tool_blocks.is_empty());
    }

    #[test]
    fn guard_releases_prose_mentioning_invoke_tag() {
        // 正文里只是提到 <invoke> 标签（无参数块结构）时必须原样放行。
        let input = "可以参考 <invoke> 标签的用法，注意配对。完成。";
        let mut guard = MixedTextToolGuard::new(true);
        let mut visible = guard.push(input);
        visible.push_str(&guard.finish().visible_text);
        assert_eq!(visible, input);
    }
}
