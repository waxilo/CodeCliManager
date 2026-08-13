use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use std::fs;
use std::io::{BufRead, BufReader, Write};
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use crate::config_io::atomic_write;
use crate::paths::{get_claude_history_path, get_data_path};
use crate::usage::SessionUsage;

pub(crate) const INTERNAL_RECOVERY_PROMPT: &str = "<ccm-internal-recovery>\n上一轮输出因达到长度限制或包含异常工具协议而被截断。请从中断处继续完成原任务，不要复述已完成内容，也不要输出内部工具路由协议。\n</ccm-internal-recovery>";
const INTERNAL_RECOVERY_PREFIX: &str = "<ccm-internal-recovery>";

#[derive(Debug, Serialize, Deserialize, Clone)]
pub(crate) struct Message {
    pub(crate) id: String,
    pub(crate) role: String,
    pub(crate) content: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) thinking: Option<String>,
    pub(crate) timestamp: i64,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub(crate) struct Conversation {
    pub(crate) id: String,
    pub(crate) title: String,
    pub(crate) messages: Vec<Message>,
    pub(crate) platform: String,
    #[serde(default)]
    pub(crate) project_dir: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) source_path: Option<String>,
    pub(crate) created_at: i64,
    pub(crate) updated_at: i64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) context_tokens: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) last_model: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) usage: Option<SessionUsage>,
}

#[derive(Debug, Serialize, Deserialize)]
pub(crate) struct PlatformConfig {
    pub(crate) name: String,
    pub(crate) command: String,
    pub(crate) args: Vec<String>,
    pub(crate) env_vars: HashMap<String, String>,
}

#[derive(Debug, Serialize, Deserialize, Default)]
pub(crate) struct AppState {
    pub(crate) conversations: Vec<Conversation>,
    pub(crate) platforms: HashMap<String, PlatformConfig>,
    pub(crate) active_platform: String,
    pub(crate) current_platform: String,
}

#[derive(Debug, Serialize, Deserialize, Default)]
pub(crate) struct AppOverlay {
    /// Legacy overlays created before conversations had a source path.
    #[serde(default)]
    pub(crate) deleted_session_ids: Vec<String>,
    #[serde(default)]
    pub(crate) deleted_session_paths: Vec<String>,
    #[serde(default)]
    pub(crate) title_overrides: HashMap<String, String>,
    #[serde(default)]
    pub(crate) path_title_overrides: HashMap<String, String>,
}

pub(crate) fn get_overlay_path() -> PathBuf {
    get_data_path().join("overlay.json")
}

pub(crate) fn load_overlay() -> AppOverlay {
    let path = get_overlay_path();
    if !path.exists() {
        return AppOverlay::default();
    }
    fs::read_to_string(&path)
        .ok()
        .and_then(|content| serde_json::from_str(&content).ok())
        .unwrap_or_default()
}

pub(crate) fn save_overlay(overlay: &AppOverlay) {
    let data_path = get_data_path();
    if !data_path.exists() {
        let _ = fs::create_dir_all(&data_path);
    }
    if let Ok(content) = serde_json::to_string_pretty(overlay) {
        let _ = atomic_write(&get_overlay_path(), content.as_bytes());
    }
}

pub(crate) fn conversation_overlay_key(source_path: &Path) -> String {
    source_path.to_string_lossy().to_string()
}

pub(crate) fn is_session_deleted(
    overlay: &AppOverlay,
    session_id: &str,
    source_path: Option<&str>,
) -> bool {
    source_path.is_some_and(|path| overlay.deleted_session_paths.iter().any(|p| p == path))
        || overlay.deleted_session_ids.iter().any(|id| id == session_id)
}

pub(crate) fn mark_session_deleted(session_id: &str, source_path: Option<&Path>) {
    let mut overlay = load_overlay();
    if let Some(path) = source_path {
        let key = conversation_overlay_key(path);
        if !overlay.deleted_session_paths.iter().any(|p| p == &key) {
            overlay.deleted_session_paths.push(key);
            save_overlay(&overlay);
        }
    } else if !overlay.deleted_session_ids.iter().any(|id| id == session_id) {
        overlay.deleted_session_ids.push(session_id.to_string());
        save_overlay(&overlay);
    }
}

pub(crate) fn title_override<'a>(
    overlay: &'a AppOverlay,
    session_id: &str,
    source_path: Option<&str>,
) -> Option<&'a String> {
    source_path
        .and_then(|path| overlay.path_title_overrides.get(path))
        .or_else(|| overlay.title_overrides.get(session_id))
}

pub(crate) fn set_title_override(session_id: &str, source_path: Option<&Path>, title: &str) {
    let mut overlay = load_overlay();
    if let Some(path) = source_path {
        overlay
            .path_title_overrides
            .insert(conversation_overlay_key(path), title.to_string());
    } else {
        overlay
            .title_overrides
            .insert(session_id.to_string(), title.to_string());
    }
    save_overlay(&overlay);
}

pub(crate) fn is_agent_session(path: &Path) -> bool {
    path.file_name()
        .and_then(|name| name.to_str())
        .map(|name| name.starts_with("agent-"))
        .unwrap_or(false)
}

// ── 会话解析缓存：按文件 mtime 缓存解析结果，避免每次点击全量重解析 ──────
pub(crate) static SESSION_CACHE: Mutex<Option<HashMap<PathBuf, (i64, Conversation)>>> = Mutex::new(None);

pub(crate) fn file_mtime_secs(path: &Path) -> i64 {
    fs::metadata(path)
        .and_then(|m| m.modified())
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

/// 解析会话文件，命中（路径 + mtime 未变）则直接复用缓存，避免重复读盘 + JSON 解析
pub(crate) fn parse_claude_session_cached(path: &PathBuf) -> Option<Conversation> {
    let mtime = file_mtime_secs(path);
    {
        let cache = SESSION_CACHE.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
        if let Some(map) = cache.as_ref() {
            if let Some((cached_mtime, conv)) = map.get(path) {
                if *cached_mtime == mtime {
                    return Some(conv.clone());
                }
            }
        }
    }
    let conv = parse_claude_session(path)?;
    let mut cache = SESSION_CACHE.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    let map = cache.get_or_insert_with(HashMap::new);
    map.insert(path.clone(), (mtime, conv.clone()));
    Some(conv)
}

/// 会话文件被本地改写后必须失效缓存。
/// mtime 精度只有秒级，同秒内连续写入（发送后立刻撤回）会命中旧缓存，导致 UI 看起来“没撤回”。
pub(crate) fn invalidate_session_cache(path: &Path) {
    let mut cache = SESSION_CACHE.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    if let Some(map) = cache.as_mut() {
        map.remove(path);
    }
}

/// Claude JSONL 里工具回执也常写成 type=user / role=user，且 content 全是 tool_result。
/// 这类行不能当作可撤回/可重试的「人类用户消息」。
pub(crate) fn is_tool_result_only_user_message(message: &serde_json::Value) -> bool {
    match message.get("content") {
        Some(serde_json::Value::Array(blocks)) => {
            !blocks.is_empty()
                && blocks.iter().all(|block| {
                    block.get("type").and_then(|t| t.as_str()) == Some("tool_result")
                })
        }
        _ => false,
    }
}

pub(crate) fn is_internal_recovery_message(message: &serde_json::Value) -> bool {
    match message.get("content") {
        Some(serde_json::Value::String(text)) => {
            text.trim_start().starts_with(INTERNAL_RECOVERY_PREFIX)
        }
        Some(serde_json::Value::Array(blocks)) => blocks.iter().any(|block| {
            block.get("type").and_then(|value| value.as_str()) == Some("text")
                && block
                    .get("text")
                    .and_then(|value| value.as_str())
                    .is_some_and(|text| text.trim_start().starts_with(INTERNAL_RECOVERY_PREFIX))
        }),
        _ => false,
    }
}

/// 判断 JSONL 行是否为真实人类用户消息（排除 meta / compact / 内部恢复 / 纯 tool_result）
pub(crate) fn is_human_user_message_line(value: &serde_json::Value) -> bool {
    if value.get("isMeta").and_then(|m| m.as_bool()) == Some(true) {
        return false;
    }
    if value.get("isCompactSummary").and_then(|v| v.as_bool()) == Some(true) {
        return false;
    }
    if value.get("type").and_then(|t| t.as_str()) != Some("user") {
        return false;
    }

    let message = match value.get("message") {
        Some(m) => m,
        None => return false,
    };
    if message.get("role").and_then(|r| r.as_str()) != Some("user") {
        return false;
    }
    if is_internal_recovery_message(message) || is_tool_result_only_user_message(message) {
        return false;
    }

    match message.get("content") {
        Some(serde_json::Value::String(s)) => !s.trim().is_empty(),
        Some(serde_json::Value::Array(blocks)) => blocks.iter().any(|block| {
            matches!(
                block.get("type").and_then(|t| t.as_str()),
                Some("text") | Some("image") | Some("document") | Some("file")
            )
        }),
        _ => false,
    }
}

/// 从人类用户消息中提取可用于 regenerate 的文本 prompt
pub(crate) fn extract_human_user_prompt(message: &serde_json::Value) -> Option<String> {
    match message.get("content") {
        Some(serde_json::Value::String(s)) => {
            let trimmed = s.trim();
            if trimmed.is_empty() {
                None
            } else {
                Some(s.clone())
            }
        }
        Some(serde_json::Value::Array(blocks)) => {
            let texts: Vec<&str> = blocks
                .iter()
                .filter_map(|block| {
                    if block.get("type").and_then(|t| t.as_str()) == Some("text") {
                        block.get("text").and_then(|t| t.as_str())
                    } else {
                        None
                    }
                })
                .collect();
            let joined = texts.join("\n");
            if joined.trim().is_empty() {
                None
            } else {
                Some(joined)
            }
        }
        _ => None,
    }
}

pub(crate) fn sort_conversations(conversations: &mut [Conversation]) {
    conversations.sort_by(|a, b| {
        b.updated_at
            .cmp(&a.updated_at)
            .then_with(|| b.created_at.cmp(&a.created_at))
            .then_with(|| a.source_path.cmp(&b.source_path))
            .then_with(|| a.id.cmp(&b.id))
    });
}

pub(crate) fn merge_conversations(
    claude_history: Vec<Conversation>,
    persisted: Vec<Conversation>,
) -> Vec<Conversation> {
    let mut merged = claude_history;
    let mut seen: HashSet<(String, Option<String>)> = merged
        .iter()
        .map(|conversation| (conversation.id.clone(), conversation.source_path.clone()))
        .collect();

    for conversation in persisted {
        if conversation.source_path.is_none()
            && merged.iter().any(|existing| existing.id == conversation.id)
        {
            continue;
        }
        let key = (conversation.id.clone(), conversation.source_path.clone());
        if seen.insert(key) {
            merged.push(conversation);
        }
    }
    sort_conversations(&mut merged);
    merged
}

pub(crate) fn load_claude_history() -> Vec<Conversation> {
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
            if is_session_deleted(&overlay, &conv.id, conv.source_path.as_deref()) {
                continue;
            }
            if let Some(title) = title_override(&overlay, &conv.id, conv.source_path.as_deref()) {
                conv.title = title.clone();
            }
            conversations.push(conv);
        }
    }

    sort_conversations(&mut conversations);
    conversations
}

/// 只刷新单个会话，避免 turn-complete 重试时反复扫描并解析全部历史。
pub(crate) fn load_claude_conversation(path: &PathBuf) -> Option<Conversation> {
    let mut conversation = parse_claude_session_cached(path)?;
    let overlay = load_overlay();
    if is_session_deleted(
        &overlay,
        &conversation.id,
        conversation.source_path.as_deref(),
    ) {
        return None;
    }
    if let Some(title) = title_override(
        &overlay,
        &conversation.id,
        conversation.source_path.as_deref(),
    ) {
        conversation.title = title.clone();
    }
    Some(conversation)
}

pub(crate) fn collect_jsonl_files(root: &PathBuf, files: &mut Vec<PathBuf>) {
    let entries = match std::fs::read_dir(root) {
        Ok(entries) => entries,
        Err(_) => return,
    };
    
    for entry in entries.flatten() {
        let Ok(file_type) = entry.file_type() else {
            continue;
        };
        if file_type.is_symlink() {
            continue;
        }
        let path = entry.path();
        if file_type.is_dir() {
            collect_jsonl_files(&path, files);
        } else if path.extension().and_then(|ext| ext.to_str()) == Some("jsonl") {
            files.push(path);
        }
    }
}

pub(crate) fn effective_message_uuids(lines: &[serde_json::Value]) -> Option<HashSet<String>> {
    let mut has_linked_message = false;
    let mut has_legacy_message = false;
    for value in lines {
        if value.get("message").is_none()
            || value.get("type").and_then(|kind| kind.as_str()) == Some("system")
        {
            continue;
        }
        if value.get("uuid").and_then(|uuid| uuid.as_str()).is_some() {
            has_linked_message = true;
        } else {
            has_legacy_message = true;
        }
    }
    // Mixed formats cannot be reconstructed without risking loss of legacy entries.
    if !has_linked_message || has_legacy_message {
        return None;
    }

    let linked: Vec<&serde_json::Value> = lines
        .iter()
        .filter(|value| value.get("uuid").and_then(|uuid| uuid.as_str()).is_some())
        .collect();
    if linked.is_empty() {
        return None;
    }

    let current_uuid = linked
        .iter()
        .rev()
        .find(|value| {
            value.get("isSidechain").and_then(|flag| flag.as_bool()) != Some(true)
                && value.get("type").and_then(|kind| kind.as_str()) != Some("system")
        })?
        .get("uuid")
        .and_then(|uuid| uuid.as_str())
        .map(str::to_string)?;
    let mut parents = HashMap::new();
    for value in linked {
        if let Some(uuid) = value.get("uuid").and_then(|uuid| uuid.as_str()) {
            parents.insert(
                uuid.to_string(),
                value
                    .get("parentUuid")
                    .and_then(|parent| parent.as_str())
                    .map(str::to_string),
            );
        }
    }

    let mut active = HashSet::new();
    let mut cursor = Some(current_uuid);
    while let Some(uuid) = cursor {
        if !active.insert(uuid.clone()) {
            break;
        }
        cursor = parents.get(&uuid).cloned().flatten();
    }
    Some(active)
}

pub(crate) fn parse_claude_session(path: &PathBuf) -> Option<Conversation> {
    let content = match std::fs::read_to_string(path) {
        Ok(c) => c,
        Err(_) => return None,
    };
    let lines: Vec<serde_json::Value> = content
        .lines()
        .filter(|line| !line.trim().is_empty())
        .filter_map(|line| serde_json::from_str(line).ok())
        .collect();
    let active_uuids = effective_message_uuids(&lines);

    let mut session_id: Option<String> = None;
    let mut messages = Vec::new();
    let mut first_user_message: Option<String> = None;
    let mut created_at: Option<i64> = None;
    let mut updated_at: Option<i64> = None;
    let mut custom_title: Option<String> = None;
    let mut project_dir: Option<String> = None;
    let mut last_context_tokens: Option<i64> = None;
    let mut last_model: Option<String> = None;
    // 主链上已保留的 Task tool_use id，用于配对保留对应 tool_result
    let mut visible_task_tool_ids: HashSet<String> = HashSet::new();
    // 历史聚合用量：逐条 message.usage 累加 + result 行 total_cost_usd 累加
    let mut usage_agg = SessionUsage::default();

    for (line_idx, value) in lines.iter().enumerate() {
        if project_dir.is_none() {
            project_dir = value
                .get("cwd")
                .and_then(|c| c.as_str())
                .map(str::trim)
                .filter(|cwd| !cwd.is_empty())
                .map(str::to_string);
        }

        if value.get("type").and_then(|t| t.as_str()) == Some("custom-title") {
            custom_title = value
                .get("customTitle")
                .and_then(|t| t.as_str())
                .map(str::to_string);
            continue;
        }

        if value.get("isMeta").and_then(|m| m.as_bool()) == Some(true) {
            continue;
        }

        // Skip compact summaries and system metadata before selecting visible messages.
        if value.get("isCompactSummary").and_then(|v| v.as_bool()) == Some(true) {
            continue;
        }
        if value.get("type").and_then(|t| t.as_str()) == Some("system") {
            continue;
        }
        if let (Some(active), Some(uuid)) = (
            active_uuids.as_ref(),
            value.get("uuid").and_then(|uuid| uuid.as_str()),
        ) {
            if !active.contains(uuid) {
                continue;
            }
        }

        if session_id.is_none() {
            session_id = value
                .get("sessionId")
                .and_then(|s| s.as_str())
                .map(str::to_string);
        }

        let ts = value
            .get("timestamp")
            .and_then(|t| t.as_str())
            .and_then(parse_timestamp);
        if let Some(timestamp) = ts {
            created_at = Some(created_at.map_or(timestamp, |current| current.min(timestamp)));
            updated_at = Some(updated_at.map_or(timestamp, |current| current.max(timestamp)));
        }

        let source_uuid = value.get("uuid").and_then(|uuid| uuid.as_str());
        if value.get("type").and_then(|t| t.as_str()) == Some("thinking") {
            if let Some(msg) = value.get("message") {
                let th_content = msg
                    .get("content")
                    .and_then(|c| c.as_str())
                    .unwrap_or("")
                    .to_string();
                if !th_content.trim().is_empty() {
                    messages.push(Message {
                        id: source_uuid
                            .map(|uuid| format!("{uuid}_0"))
                            .unwrap_or_else(|| format!("thinking_line_{line_idx}")),
                        role: "thinking".to_string(),
                        content: th_content,
                        thinking: None,
                        timestamp: ts.unwrap_or_default(),
                    });
                }
            }
            continue;
        }

        // result 行携带 total_cost_usd（单次模型调用成本，含子代理），逐次累加
        if let Some(cost) = value.get("total_cost_usd").and_then(|v| v.as_f64()) {
            *usage_agg.cost_usd.get_or_insert(0.0) += cost;
        }

        let Some(message) = value.get("message") else {
            continue;
        };
        if is_internal_recovery_message(message) {
            continue;
        }

        if let Some(usage) = message.get("usage") {
            let field = |k: &str| usage.get(k).and_then(|v| v.as_u64()).unwrap_or(0);
            let input = field("input_tokens");
            let output = field("output_tokens");
            let cache_read = field("cache_read_input_tokens");
            let cache_creation = field("cache_creation_input_tokens");
            let ctx = (input + cache_creation + cache_read) as i64;
            if ctx > 0 {
                last_context_tokens = Some(ctx);
            }
            if input + output + cache_read + cache_creation > 0 {
                usage_agg.input_tokens += input;
                usage_agg.output_tokens += output;
                usage_agg.cache_read += cache_read;
                usage_agg.cache_creation += cache_creation;
            }
        }
        if let Some(model) = message.get("model").and_then(|m| m.as_str()) {
            if !model.trim().is_empty() {
                last_model = Some(model.to_string());
            }
        }

        let role = message
            .get("role")
            .and_then(|r| r.as_str())
            .unwrap_or("unknown")
            .to_string();
        let id_prefix = source_uuid
            .map(|uuid| format!("msg_{uuid}"))
            .unwrap_or_else(|| format!("msg_line_{line_idx}"));
        let expanded = expand_content_parts(
            &role,
            message.get("content"),
            &id_prefix,
            ts.unwrap_or_default(),
            value.get("toolUseResult"),
            &mut visible_task_tool_ids,
        );

        if first_user_message.is_none() && role == "user" {
            for msg in &expanded {
                if msg.role == "user" && !msg.content.trim().is_empty() {
                    first_user_message = Some(msg.content.clone());
                    break;
                }
            }
        }

        for msg in expanded {
            let trimmed = msg.content.trim();
            if trimmed.starts_with("<system-reminder>")
                || trimmed.starts_with("<local-command-caveat>")
                || trimmed.starts_with("<command-name>")
                || trimmed.starts_with("<local-command-stdout>")
            {
                continue;
            }
            messages.push(msg);
        }
    }

    let session_id = session_id.or_else(|| {
        path.file_stem()
            .and_then(|s| s.to_str())
            .map(str::to_string)
    })?;

    let title = custom_title
        .or_else(|| {
            first_user_message.map(|t| {
                if t.len() > 50 {
                    t.chars().take(50).collect::<String>() + "..."
                } else {
                    t
                }
            })
        })
        .unwrap_or_else(|| "Untitled".to_string());

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
        usage: if usage_agg.is_empty() {
            None
        } else {
            Some(usage_agg)
        },
    })
}

/// Directory names are not reversibly encoded (`-` may be a separator or a literal hyphen).
/// Only decode the unambiguous root sentinel; otherwise prefer no project directory to a wrong one.
pub(crate) fn decode_project_dir_from_jsonl_path(path: &Path) -> Option<String> {
    let encoded = path
        .parent()
        .and_then(|p| p.file_name())
        .and_then(|name| name.to_str())?;

    (encoded == "-").then(|| "/".to_string())
}

/// 主链可见工具白名单：AskUserQuestion（互动卡片）+ Task（Subagent 状态）
/// + TodoWrite / TaskCreate / TaskUpdate（TodoList 清单与任务管理卡）
const VISIBLE_TOOL_NAMES: &[&str] = &["AskUserQuestion", "Task", "TodoWrite", "TaskCreate", "TaskUpdate"];

fn is_visible_tool_name(name: &str) -> bool {
    VISIBLE_TOOL_NAMES.contains(&name)
}

/// 将 content（字符串或数组）展开为多条消息，保留 thinking/text 穿插顺序
/// AskUserQuestion / Task 的 tool_use / tool_result 会保留，供前端渲染卡片
/// 参考 claudecodeui: 每个 content part 生成独立的 NormalizedMessage
pub(crate) fn expand_content_parts(
    role: &str,
    content: Option<&serde_json::Value>,
    id_prefix: &str,
    timestamp: i64,
    tool_use_result: Option<&serde_json::Value>,
    visible_task_tool_ids: &mut HashSet<String>,
) -> Vec<Message> {
    let content = match content {
        Some(c) => c,
        None => return vec![],
    };

    match content {
        // 纯文本：单条消息
        serde_json::Value::String(s) => {
            let trimmed = s.trim();
            if trimmed.is_empty() {
                return vec![];
            }
            vec![Message {
                id: format!("{}_{}", id_prefix, 0),
                role: role.to_string(),
                content: s.clone(),
                thinking: None,
                timestamp,
            }]
        }
        // 内容数组：每个 part 生成独立消息，保持原始顺序
        serde_json::Value::Array(items) => {
            let mut msgs = Vec::new();
            let mut part_idx = 0u32;
            for item in items {
                let t = item.get("type").and_then(|t| t.as_str());
                match t {
                    Some("text") => {
                        if let Some(text) = item.get("text").and_then(|t| t.as_str()) {
                            let trimmed = text.trim();
                            if !trimmed.is_empty() {
                                msgs.push(Message {
                                    id: format!("{}_{}", id_prefix, part_idx),
                                    role: role.to_string(),
                                    content: text.to_string(),
                                    thinking: None,
                                    timestamp,
                                });
                            }
                        }
                    }
                    Some("thinking") => {
                        if let Some(th) = item.get("thinking").and_then(|t| t.as_str()) {
                            let trimmed = th.trim();
                            if !trimmed.is_empty() {
                                msgs.push(Message {
                                    id: format!("{}_{}", id_prefix, part_idx),
                                    role: "thinking".to_string(),
                                    content: th.to_string(),
                                    thinking: None,
                                    timestamp,
                                });
                            }
                        }
                    }
                    Some("tool_use") => {
                        let name = item
                            .get("name")
                            .and_then(|n| n.as_str())
                            .unwrap_or("");
                        if is_visible_tool_name(name) {
                            if let Some(id) = item.get("id").and_then(|v| v.as_str()) {
                                if name == "Task" && !id.is_empty() {
                                    visible_task_tool_ids.insert(id.to_string());
                                }
                            }
                            let payload = serde_json::json!({
                                "name": name,
                                "tool_name": name,
                                "input": item.get("input").cloned().unwrap_or_else(|| serde_json::json!({})),
                                "id": item.get("id").cloned().unwrap_or(serde_json::Value::Null),
                            });
                            msgs.push(Message {
                                id: format!("{}_{}", id_prefix, part_idx),
                                role: "tool_use".to_string(),
                                content: payload.to_string(),
                                thinking: None,
                                timestamp,
                            });
                        }
                    }
                    Some("tool_result") => {
                        // AskUserQuestion：带上 JSONL 行级 toolUseResult（含 answers）
                        let has_answers = tool_use_result
                            .and_then(|v| v.get("answers"))
                            .is_some();
                        let has_questions = tool_use_result
                            .and_then(|v| v.get("questions"))
                            .is_some();
                        let tool_use_id = item
                            .get("tool_use_id")
                            .and_then(|v| v.as_str())
                            .unwrap_or("");
                        let is_task_result = !tool_use_id.is_empty()
                            && visible_task_tool_ids.contains(tool_use_id);
                        if has_answers || has_questions || is_task_result {
                            let payload = serde_json::json!({
                                "content": item.get("content").cloned().unwrap_or(serde_json::Value::Null),
                                "tool_use_id": item.get("tool_use_id").cloned().unwrap_or(serde_json::Value::Null),
                                "is_error": item.get("is_error").cloned().unwrap_or(serde_json::Value::Bool(false)),
                                "toolUseResult": tool_use_result.cloned().unwrap_or(serde_json::Value::Null),
                            });
                            msgs.push(Message {
                                id: format!("{}_{}", id_prefix, part_idx),
                                role: "tool_result".to_string(),
                                content: payload.to_string(),
                                thinking: None,
                                timestamp,
                            });
                        }
                    }
                    _ => {}
                }
                part_idx += 1;
            }
            msgs
        }
        _ => vec![],
    }
}

/// 消息是否为可见的 Task tool_use（供 turn-complete 落盘判定）
pub(crate) fn message_is_task_tool_use(message: &Message) -> bool {
    if message.role != "tool_use" {
        return false;
    }
    serde_json::from_str::<serde_json::Value>(&message.content)
        .ok()
        .and_then(|value| {
            value
                .get("name")
                .or_else(|| value.get("tool_name"))
                .and_then(|name| name.as_str())
                .map(|name| name == "Task")
        })
        .unwrap_or(false)
}

pub(crate) fn parse_timestamp(iso_string: &str) -> Option<i64> {
    if let Ok(dt) = chrono::DateTime::parse_from_rfc3339(iso_string) {
        Some(dt.timestamp())
    } else {
        None
    }
}

pub(crate) fn detect_os() -> String {
    std::env::consts::OS.to_string()
}

pub(crate) fn load_persisted_state() -> AppState {
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

pub(crate) fn load_app_state() -> AppState {
    let claude_history = load_claude_history();
    let mut persisted = load_persisted_state();
    persisted.conversations = merge_conversations(claude_history, persisted.conversations);
    persisted.current_platform = detect_os();
    persisted
}

pub(crate) fn get_default_state() -> AppState {
    AppState {
        conversations: Vec::new(),
        platforms: get_default_platforms(),
        active_platform: "claude".to_string(),
        current_platform: detect_os(),
    }
}

pub(crate) fn save_app_state(state: &AppState) {
    let data_path = get_data_path();
    if !data_path.exists() {
        let _ = fs::create_dir_all(&data_path);
    }
    let path = data_path.join("state.json");
    if let Ok(content) = serde_json::to_string_pretty(state) {
        let _ = atomic_write(&path, content.as_bytes());
    }
}

pub(crate) fn get_default_platforms() -> HashMap<String, PlatformConfig> {
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

pub(crate) fn read_claude_session_id_from_file(path: &Path) -> Option<String> {
    let file = fs::File::open(path).ok()?;
    let reader = BufReader::new(file);
    for line in reader.lines().take(20) {
        let line = line.ok()?;
        if line.trim().is_empty() {
            continue;
        }
        let value: serde_json::Value = match serde_json::from_str(&line) {
            Ok(value) => value,
            Err(_) => continue,
        };
        if let Some(session_id) = value.get("sessionId").and_then(|s| s.as_str()) {
            return Some(session_id.to_string());
        }
    }

    path.file_stem()
        .and_then(|stem| stem.to_str())
        .filter(|stem| !stem.is_empty())
        .map(str::to_string)
}

pub(crate) fn session_id_matches_path(session_id: &str, path: &Path) -> bool {
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

pub(crate) fn delete_claude_session_file(path: &Path, session_id: &str) -> Result<(), String> {
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

pub(crate) fn validate_claude_source_path(source_path: &Path) -> Result<PathBuf, String> {
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

pub(crate) fn find_claude_session_file(session_id: &str) -> Option<PathBuf> {
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
pub(crate) fn rewrite_session_model(session_id: &str, new_model: &str) -> Result<bool, String> {
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
        atomic_write(&path, new_content.as_bytes())
            .map_err(|e| format!("Failed to write session file: {}", e))?;
        invalidate_session_cache(&path);
        eprintln!(
            "[rewrite_session_model] Updated model to '{}' in {}",
            new_model,
            path.display()
        );
    }

    Ok(modified)
}

pub(crate) fn remove_path_if_exists(path: &Path) -> std::io::Result<()> {
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

pub(crate) fn write_claude_custom_title(path: &Path, session_id: &str, title: &str) -> Result<(), String> {
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

#[cfg(test)]
mod tests {
    use super::{
        decode_project_dir_from_jsonl_path, effective_message_uuids, expand_content_parts,
        is_human_user_message_line, is_internal_recovery_message, merge_conversations,
        message_is_task_tool_use, parse_claude_session, sort_conversations, Conversation,
        INTERNAL_RECOVERY_PROMPT,
    };
    use std::collections::HashSet;
    use std::fs;
    use std::path::PathBuf;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn conversation(id: &str, source_path: Option<&str>, created_at: i64, updated_at: i64) -> Conversation {
        Conversation {
            id: id.to_string(),
            title: id.to_string(),
            messages: Vec::new(),
            platform: "claude".to_string(),
            project_dir: None,
            source_path: source_path.map(str::to_string),
            created_at,
            updated_at,
            context_tokens: None,
            last_model: None,
            usage: None,
        }
    }

    fn temp_jsonl(name: &str, contents: &str) -> PathBuf {
        let unique = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let directory = std::env::temp_dir().join(format!("ccm-history-{unique}"));
        fs::create_dir_all(&directory).unwrap();
        let path = directory.join(name);
        fs::write(&path, contents).unwrap();
        path
    }

    #[test]
    fn internal_recovery_message_is_not_human_history() {
        let line = serde_json::json!({
            "type": "user",
            "message": {
                "role": "user",
                "content": INTERNAL_RECOVERY_PROMPT,
            }
        });

        assert!(is_internal_recovery_message(&line["message"]));
        assert!(!is_human_user_message_line(&line));
    }

    #[test]
    fn normal_user_message_remains_human_history() {
        let line = serde_json::json!({
            "type": "user",
            "message": {
                "role": "user",
                "content": "请继续分析",
            }
        });

        assert!(!is_internal_recovery_message(&line["message"]));
        assert!(is_human_user_message_line(&line));
    }

    #[test]
    fn expand_keeps_task_tool_use_and_matching_result() {
        let mut task_ids = HashSet::new();
        let tool_use = expand_content_parts(
            "assistant",
            Some(&serde_json::json!([
                {"type":"text","text":"starting"},
                {"type":"tool_use","id":"toolu_task1","name":"Task","input":{"description":"explore"}},
                {"type":"tool_use","id":"toolu_bash","name":"Bash","input":{"command":"ls"}}
            ])),
            "a",
            1,
            None,
            &mut task_ids,
        );
        assert!(task_ids.contains("toolu_task1"));
        assert_eq!(tool_use.iter().filter(|m| m.role == "tool_use").count(), 1);
        assert!(tool_use.iter().any(|m| m.content.contains("Task")));
        assert!(!tool_use.iter().any(|m| m.content.contains("Bash")));

        let tool_result = expand_content_parts(
            "user",
            Some(&serde_json::json!([
                {"type":"tool_result","tool_use_id":"toolu_task1","content":"done summary"},
                {"type":"tool_result","tool_use_id":"toolu_bash","content":"file.txt"}
            ])),
            "u",
            2,
            None,
            &mut task_ids,
        );
        assert_eq!(tool_result.len(), 1);
        assert_eq!(tool_result[0].role, "tool_result");
        assert!(tool_result[0].content.contains("done summary"));
        assert!(message_is_task_tool_use(&tool_use.iter().find(|m| m.role == "tool_use").unwrap()));
    }

    #[test]
    fn active_chain_excludes_abandoned_branch_and_sidechain() {
        let lines = vec![
            serde_json::json!({"uuid":"root", "parentUuid":null, "type":"user", "message":{"role":"user", "content":"question"}}),
            serde_json::json!({"uuid":"old", "parentUuid":"root", "type":"assistant", "message":{"role":"assistant", "content":"old"}}),
            serde_json::json!({"uuid":"new", "parentUuid":"root", "type":"assistant", "message":{"role":"assistant", "content":"new"}}),
            serde_json::json!({"uuid":"agent", "parentUuid":"new", "type":"assistant", "isSidechain":true, "message":{"role":"assistant", "content":"sidechain"}}),
        ];
        let active = effective_message_uuids(&lines).unwrap();
        assert_eq!(active.len(), 2);
        assert!(active.contains("root"));
        assert!(active.contains("new"));
        assert!(!active.contains("old"));
        assert!(!active.contains("agent"));
    }

    #[test]
    fn mixed_legacy_and_linked_jsonl_keeps_legacy_entries() {
        let lines = vec![
            serde_json::json!({"type":"user", "message":{"role":"user", "content":"legacy"}}),
            serde_json::json!({"uuid":"new", "parentUuid":null, "type":"assistant", "message":{"role":"assistant", "content":"new"}}),
        ];
        assert!(effective_message_uuids(&lines).is_none());
    }

    #[test]
    fn legacy_jsonl_keeps_all_messages_and_stable_thinking_id() {
        let contents = concat!(
            r#"{"sessionId":"legacy","type":"user","timestamp":"2026-01-01T00:00:00Z","message":{"role":"user","content":"hello"}}"#,
            "\n",
            r#"{"sessionId":"legacy","type":"thinking","timestamp":"2026-01-01T00:00:01Z","message":{"content":"hmm"}}"#,
            "\n",
            r#"{"sessionId":"legacy","type":"assistant","timestamp":"2026-01-01T00:00:02Z","message":{"role":"assistant","content":"world"}}"#,
        );
        let path = temp_jsonl("legacy.jsonl", contents);
        let first = parse_claude_session(&path).unwrap();
        let second = parse_claude_session(&path).unwrap();
        assert_eq!(first.messages.len(), 3);
        assert_eq!(first.messages[1].role, "thinking");
        assert_eq!(first.messages[1].id, "thinking_line_1");
        assert_eq!(first.messages[1].id, second.messages[1].id);
        fs::remove_dir_all(path.parent().unwrap()).unwrap();
    }

    #[test]
    fn hyphenated_encoded_directory_is_not_guessed() {
        let path = PathBuf::from("/tmp/-Users-jane/my-project/session.jsonl");
        assert_eq!(decode_project_dir_from_jsonl_path(&path), None);
        assert_eq!(
            decode_project_dir_from_jsonl_path(&PathBuf::from("/tmp/-/session.jsonl")),
            Some("/".to_string())
        );
    }

    #[test]
    fn merge_keeps_same_id_from_different_sources() {
        let merged = merge_conversations(
            vec![conversation("same", Some("/a.jsonl"), 1, 2)],
            vec![
                conversation("same", Some("/a.jsonl"), 1, 1),
                conversation("same", Some("/b.jsonl"), 2, 3),
                conversation("state", None, 4, 4),
            ],
        );
        assert_eq!(merged.len(), 3);
        assert!(merged.iter().any(|item| item.source_path.as_deref() == Some("/a.jsonl")));
        assert!(merged.iter().any(|item| item.source_path.as_deref() == Some("/b.jsonl")));
        assert!(merged.iter().any(|item| item.id == "state"));
    }

    #[test]
    fn conversations_sort_by_updated_then_created() {
        let mut conversations = vec![
            conversation("old", None, 100, 10),
            conversation("new-created", None, 200, 20),
            conversation("older-created", None, 150, 20),
            conversation("latest", None, 1, 30),
        ];
        sort_conversations(&mut conversations);
        let ids: Vec<&str> = conversations.iter().map(|item| item.id.as_str()).collect();
        assert_eq!(ids, vec!["latest", "new-created", "older-created", "old"]);
    }

    #[test]
    fn linked_session_renders_only_current_branch() {
        let contents = concat!(
            r#"{"sessionId":"branch","uuid":"root","parentUuid":null,"type":"user","timestamp":"2026-01-01T00:00:00Z","message":{"role":"user","content":"question"}}"#,
            "\n",
            r#"{"sessionId":"branch","uuid":"old","parentUuid":"root","type":"assistant","timestamp":"2026-01-01T00:00:01Z","message":{"role":"assistant","content":"old answer"}}"#,
            "\n",
            r#"{"sessionId":"branch","uuid":"new","parentUuid":"root","type":"assistant","timestamp":"2026-01-01T00:00:02Z","message":{"role":"assistant","content":"new answer"}}"#,
        );
        let path = temp_jsonl("branch.jsonl", contents);
        let conversation = parse_claude_session(&path).unwrap();
        let content: Vec<&str> = conversation.messages.iter().map(|message| message.content.as_str()).collect();
        assert_eq!(content, vec!["question", "new answer"]);
        assert_eq!(conversation.messages[0].id, "msg_root_0");
        assert_eq!(conversation.messages[1].id, "msg_new_0");
        fs::remove_dir_all(path.parent().unwrap()).unwrap();
    }
}
