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

/// 子代理完成通知（transcript 里 <task-notification> 用户行）。
/// 解析后合并进对应 Agent/Task tool_use 消息，供前端「子代理」tab 展示报告。
/// 仅手工构造 + 序列化，无反序列化需求，故不派生 Deserialize。
#[derive(Debug, Serialize, Clone, Default)]
pub(crate) struct TaskNotificationData {
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub(crate) tool_use_id: String,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub(crate) status: String,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub(crate) summary: String,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub(crate) result: String,
    #[serde(default, skip_serializing_if = "is_zero")]
    pub(crate) total_tokens: u64,
    #[serde(default, skip_serializing_if = "is_zero")]
    pub(crate) tool_uses: u64,
    #[serde(default, skip_serializing_if = "is_zero")]
    pub(crate) duration_ms: u64,
}

fn is_zero(v: &u64) -> bool {
    *v == 0
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
// 容量上限防无限增长：条目含完整 Conversation（全部消息），长期运行会累积内存。
pub(crate) static SESSION_CACHE: Mutex<Option<HashMap<PathBuf, (i64, Conversation)>>> = Mutex::new(None);
const SESSION_CACHE_MAX: usize = 256;

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
    // 容量上限：超过时整体重建为仅含当前条目的缓存。
    // 简单策略即可——会话文件数远小于上限，命中率损失可忽略，换取内存有界。
    if map.len() >= SESSION_CACHE_MAX {
        map.clear();
    }
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

/// 会话数据版本号：文件 mtime + overlay mtime 组合。
/// 任一变化（新消息写入 / 标题覆盖 / 删除标记）都视为内容变更；
/// 前端回传 known_version 时据此跳过未变更会话的整条克隆 + IPC 搬运。
pub(crate) fn conversation_version(path: &Path) -> String {
    format!(
        "{}:{}",
        file_mtime_secs(path),
        file_mtime_secs(&get_overlay_path())
    )
}

/// 无会话文件的持久化状态兜底版本：以 state.json 的 mtime 为变更信号。
pub(crate) fn persisted_state_version() -> String {
    format!("p:{}", file_mtime_secs(&get_data_path().join("state.json")))
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
    let mut compact_uuids = HashSet::new();
    let mut system_uuids = HashSet::new();
    let mut positions: HashMap<String, usize> = HashMap::new();
    for (idx, value) in lines.iter().enumerate() {
        if let Some(uuid) = value.get("uuid").and_then(|uuid| uuid.as_str()) {
            parents.insert(
                uuid.to_string(),
                value
                    .get("parentUuid")
                    .and_then(|parent| parent.as_str())
                    .map(str::to_string),
            );
            positions.insert(uuid.to_string(), idx);
            if value.get("isCompactSummary").and_then(|flag| flag.as_bool()) == Some(true) {
                compact_uuids.insert(uuid.to_string());
            }
            if value.get("type").and_then(|kind| kind.as_str()) == Some("system") {
                system_uuids.insert(uuid.to_string());
            }
        }
    }

    // 主链后向遍历。会话被压缩（isCompactSummary）时，Claude 会插入一条 system 行并重挂根，
    // 压缩点之前的所有消息（含首条用户消息）都会从主链断开。遇到 compact summary 时，
    // 把压缩点之前那段历史的末尾重新并入，否则整段旧历史会在 CCM 里消失。
    let mut active = HashSet::new();
    let mut stack: Vec<String> = vec![current_uuid];
    while let Some(uuid) = stack.pop() {
        if !active.insert(uuid.clone()) {
            continue;
        }
        if compact_uuids.contains(&uuid) {
            if let Some(compact_pos) = positions.get(&uuid) {
                if let Some(prev_uuid) = lines[..*compact_pos]
                    .iter()
                    .rev()
                    .filter_map(|value| value.get("uuid").and_then(|uuid| uuid.as_str()))
                    .find(|candidate| {
                        let candidate = *candidate;
                        !active.contains(candidate)
                            && !compact_uuids.contains(candidate)
                            && !system_uuids.contains(candidate)
                    })
                {
                    stack.push(prev_uuid.to_string());
                }
            }
        }
        if let Some(parent) = parents.get(&uuid).cloned().flatten() {
            stack.push(parent);
        }
    }
    Some(active)
}

/// 一行可能包含多个顶层 JSON 值。Claude/Kiro 会话里偶发「拼接记录」：
/// 两个合法 JSON 对象被写在同一物理行且未换行（如 `}{` 相邻）。严格逐行
/// `serde_json::from_str` 会把这种行判为 `Extra data` 而丢弃整行，导致其中
/// 消息（常是后续 parentUuid 引用的桥接节点）从索引消失，父链断裂、更早历史
/// 被误判为废弃分支过滤。这里逐个提取顶层值，尽量保留已成功解析的部分。
fn parse_jsonl_line_values(line: &str) -> Vec<serde_json::Value> {
    let mut values = Vec::new();
    for item in serde_json::Deserializer::from_str(line).into_iter::<serde_json::Value>() {
        match item {
            Ok(value) => values.push(value),
            // 遇到真正损坏的尾巴：保留前面已解析的对象，避免静默丢数据
            Err(_) => break,
        }
    }
    values
}

pub(crate) fn parse_claude_session(path: &PathBuf) -> Option<Conversation> {
    let content = match std::fs::read_to_string(path) {
        Ok(c) => c,
        Err(_) => return None,
    };
    let lines: Vec<serde_json::Value> = content
        .lines()
        .filter(|line| !line.trim().is_empty())
        .flat_map(parse_jsonl_line_values)
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
    // 子代理完成通知：tool_use_id -> 通知（循环结束后合并进对应 tool_use 消息）
    let mut task_notifications: HashMap<String, TaskNotificationData> = HashMap::new();
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

        // 新版 CLI 把子代理完成通知写在 queue-operation / attachment 等非消息行：
        // 顶层 content 以 <task-notification> 开头时同样解析合并进对应 tool_use，
        // 否则通知丢失，历史 Agent/Task 卡只剩「运行中」空横线。
        if let Some(content) = value.get("content").and_then(|c| c.as_str()) {
            if content.trim_start().starts_with("<task-notification>") {
                if let Some(notif) = parse_task_notification(content) {
                    if !notif.tool_use_id.is_empty() {
                        task_notifications.insert(notif.tool_use_id.clone(), notif);
                    }
                }
                continue;
            }
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
            // 子代理完成通知：CLI 以 user 角色写进 transcript 的 <task-notification>，
            // 是内部进度回执而非用户消息，不进消息流；解析结果合并进对应 tool_use
            if trimmed.starts_with("<task-notification>") {
                if let Some(notif) = parse_task_notification(trimmed) {
                    if !notif.tool_use_id.is_empty() {
                        task_notifications.insert(notif.tool_use_id.clone(), notif);
                    }
                }
                continue;
            }
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

    // 把 <task-notification>（状态 / 摘要 / 完整报告）合并进对应 Agent/Task tool_use 消息，
    // 前端「子代理」tab 与工具卡据此展示执行结果与报告
    if !task_notifications.is_empty() {
        for msg in messages.iter_mut() {
            if msg.role != "tool_use" {
                continue;
            }
            let Ok(mut payload) = serde_json::from_str::<serde_json::Value>(&msg.content) else {
                continue;
            };
            let Some(id) = payload.get("id").and_then(|v| v.as_str()) else {
                continue;
            };
            if let Some(notif) = task_notifications.get(id) {
                payload["taskNotification"] =
                    serde_json::to_value(notif).unwrap_or(serde_json::Value::Null);
                msg.content = payload.to_string();
            }
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

/// 历史主链可见工具白名单：AskUserQuestion（互动卡片）+ Agent / Task（Subagent 状态）
/// + TodoWrite / TaskCreate / TaskUpdate（TodoList 清单与任务管理卡）。
/// 脚本工具（Bash/Read/Edit…）不进历史，避免会话界面被大量收起卡横线占满；
/// 运行中的脚本由实时工具卡展示（activeToolsBySession）。
const VISIBLE_TOOL_NAMES: &[&str] = &["AskUserQuestion", "Agent", "Task", "TodoWrite", "TaskCreate", "TaskUpdate"];

fn is_visible_tool_name(name: &str) -> bool {
    VISIBLE_TOOL_NAMES.contains(&name)
}

/// 提取 `<tag>...</tag>` 块内容（CLI 的 task-notification 是简单自闭合 tag 结构）
fn extract_tag<'a>(text: &'a str, tag: &str) -> Option<&'a str> {
    let open = format!("<{tag}>");
    let close = format!("</{tag}>");
    let start = text.find(&open)? + open.len();
    let end = text[start..].find(&close)? + start;
    Some(&text[start..end])
}

/// 解析子代理完成通知：status/summary/result/usage，按 tool-use-id 与 Agent tool_use 关联
fn parse_task_notification(content: &str) -> Option<TaskNotificationData> {
    let mut data = TaskNotificationData {
        tool_use_id: extract_tag(content, "tool-use-id")
            .unwrap_or("")
            .trim()
            .to_string(),
        status: extract_tag(content, "status")
            .unwrap_or("")
            .trim()
            .to_string(),
        summary: extract_tag(content, "summary")
            .unwrap_or("")
            .trim()
            .to_string(),
        result: extract_tag(content, "result")
            .unwrap_or("")
            .trim()
            .to_string(),
        ..Default::default()
    };
    if let Some(usage) = extract_tag(content, "usage") {
        let parse = |tag: &str| {
            extract_tag(usage, tag)
                .and_then(|s| s.trim().parse::<u64>().ok())
                .unwrap_or(0)
        };
        data.total_tokens = parse("subagent_tokens");
        data.tool_uses = parse("tool_uses");
        data.duration_ms = parse("duration_ms");
    }
    if data.tool_use_id.is_empty() && data.status.is_empty() {
        None
    } else {
        Some(data)
    }
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
                        // 历史只保留主链可见工具（子代理 / 问答 / Todo 卡）：
                        // 脚本工具（Bash/Read/Edit…）不进历史，避免会话界面被大量收起卡横线占满；
                        // 运行中的脚本仍由实时卡展示。Task/Agent 额外收集进可见集合，
                        // 供 tool_result 判定子代理结果。
                        if is_visible_tool_name(name) {
                            if let Some(id) = item.get("id").and_then(|v| v.as_str()) {
                                if (name == "Task" || name == "Agent") && !id.is_empty() {
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
                        // 子代理「启动成功」元数据结果（Async agent launched…）不保留：
                        // 它不是子代理的完成结果，保留会让历史卡误显完成态
                        let is_launch_metadata = !has_answers
                            && !has_questions
                            && is_subagent_launch_metadata_content(item.get("content"));
                        // 保留：问答结果 / 子代理（Task/Agent）真结果（脚本结果不保留，
                        // 与 tool_use 白名单一致）。启动元数据过滤优先于 is_task_result。
                        if !is_launch_metadata && (has_answers || has_questions || is_task_result) {
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

/// 子代理「启动成功」元数据结果（新版 Claude Code 的 Task/Agent 异步启动时，
/// 主链立即收到 "Async agent launched successfully" 这类 tool_result）。
/// 它不是子代理的完成结果：历史里不保留，避免误显完成态。
fn is_subagent_launch_metadata_content(content: Option<&serde_json::Value>) -> bool {
    let Some(content) = content else {
        return false;
    };
    let text = match content {
        serde_json::Value::String(s) => s.clone(),
        serde_json::Value::Array(items) => items
            .iter()
            .filter_map(|it| it.get("text").and_then(|t| t.as_str()))
            .collect::<Vec<_>>()
            .join("\n"),
        other => other.to_string(),
    };
    let t = text.trim();
    t.contains("Async agent launched successfully")
        || t.contains("launched successfully")
        || t.contains("internal metadata")
        || t.contains("agentId:")
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
        // 用 mtime 缓存版解析：热路径（turn-complete 重试等）反复调用时，
        // 已解析且未变更的文件直接命中缓存，避免每次全量读盘 + JSON 解析 O(全部历史)。
        if let Some(conv) = parse_claude_session_cached(&path) {
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
///
/// 并发安全：CLI 进程可能在常驻会话中持续 append JSONL。
/// 采用「读 → 改 → 重读校验未变 → 原子替换」的乐观循环：写入前若发现
/// 文件被并发追加（长度/mtime 变化），丢弃本次结果重试，绝不覆盖新行。
/// 最多重试 5 次，仍不稳定则放弃（返回 Err，调用方仅记录警告，不影响主流程）。
pub(crate) fn rewrite_session_model(session_id: &str, new_model: &str) -> Result<bool, String> {
    let path = find_claude_session_file(session_id)
        .ok_or_else(|| format!("Session file not found for {}", session_id))?;

    for _attempt in 0..5 {
        // 1) 读取并记录 (长度, mtime) 快照
        let content = std::fs::read_to_string(&path)
            .map_err(|e| format!("Failed to read session file: {}", e))?;
        let len_before = content.len();
        let mtime_before = file_mtime_secs(&path);

        // 2) 内存中改写 model 字段
        let mut modified = false;
        let mut new_lines = Vec::with_capacity(content.lines().count());

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
                                if let Some(current_model) =
                                    obj.get("model").and_then(|m| m.as_str())
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

                    new_lines.push(
                        serde_json::to_string(&value).unwrap_or_else(|_| line.to_string()),
                    );
                }
                Err(_) => {
                    // 无法解析的行保持原样
                    new_lines.push(line.to_string());
                }
            }
        }

        if !modified {
            return Ok(false);
        }

        // 3) 写前重读校验：期间 CLI 若追加了新行，放弃本次结果重试，
        //    避免原子替换把并发 append 的行覆盖掉（丢行竞态）。
        let recheck = std::fs::read_to_string(&path)
            .map_err(|e| format!("Failed to re-read session file: {}", e))?;
        let len_after = recheck.len();
        let mtime_after = file_mtime_secs(&path);
        if len_before != len_after || mtime_before != mtime_after {
            continue; // 文件被并发修改，重试
        }

        // 4) 文件未变：原子替换 + 失效缓存
        let new_content = new_lines.join("\n");
        atomic_write(&path, new_content.as_bytes())
            .map_err(|e| format!("Failed to write session file: {}", e))?;
        invalidate_session_cache(&path);
        eprintln!(
            "[rewrite_session_model] Updated model to '{}' in {}",
            new_model,
            path.display()
        );
        return Ok(true);
    }

    Err(format!(
        "Session file {} kept changing while rewriting model; giving up",
        path.display()
    ))
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
        parse_claude_session, sort_conversations, Conversation,
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
                {"type":"tool_use","id":"toolu_agent","name":"Agent","input":{"description":"audit"}},
                {"type":"tool_use","id":"toolu_bash","name":"Bash","input":{"command":"ls"}}
            ])),
            "a",
            1,
            None,
            &mut task_ids,
        );
        assert!(task_ids.contains("toolu_task1"));
        assert!(task_ids.contains("toolu_agent"));
        // 历史只保留主链可见工具（Task/Agent）：脚本 Bash 不进历史，避免界面被横线占满
        assert_eq!(tool_use.iter().filter(|m| m.role == "tool_use").count(), 2);
        assert!(tool_use.iter().any(|m| m.content.contains("Task")));
        assert!(tool_use.iter().any(|m| m.content.contains("Agent")));
        assert!(!tool_use.iter().any(|m| m.content.contains("Bash")));

        let tool_result = expand_content_parts(
            "user",
            Some(&serde_json::json!([
                {"type":"tool_result","tool_use_id":"toolu_task1","content":"done summary"},
                {"type":"tool_result","tool_use_id":"toolu_bash","content":"file.txt"},
                {"type":"tool_result","tool_use_id":"toolu_agent","content":[{"type":"text","text":"Async agent launched successfully.\nagentId: abc (internal ID)"}]}
            ])),
            "u",
            2,
            None,
            &mut task_ids,
        );
        // Task 真结果保留；Bash 脚本结果不保留；子代理「启动成功」元数据不保留
        assert_eq!(tool_result.len(), 1);
        assert_eq!(tool_result[0].role, "tool_result");
        assert!(tool_result[0].content.contains("done summary"));
        assert!(!tool_result.iter().any(|m| m.content.contains("file.txt")));
        assert!(!tool_result.iter().any(|m| m.content.contains("launched successfully")));
        assert_eq!(tool_use.iter().filter(|m| m.role == "tool_use").count(), 2);
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

    #[test]
    fn compacted_session_keeps_pre_compaction_history() {
        // 会话被压缩后，Claude 以 system 行重挂根，压缩前消息从主链断开。
        // 它们必须仍保留在 CCM 视图里（首条用户消息尤其不能丢）。
        let contents = concat!(
            r#"{"sessionId":"compact","uuid":"root","parentUuid":null,"type":"user","timestamp":"2026-01-01T00:00:00Z","message":{"role":"user","content":"first question"}}"#,
            "\n",
            r#"{"sessionId":"compact","uuid":"a1","parentUuid":"root","type":"assistant","timestamp":"2026-01-01T00:00:01Z","message":{"role":"assistant","content":"first answer"}}"#,
            "\n",
            r#"{"sessionId":"compact","uuid":"sys","parentUuid":null,"type":"system","timestamp":"2026-01-01T00:00:02Z"}"#,
            "\n",
            r#"{"sessionId":"compact","uuid":"summary","parentUuid":"sys","type":"user","isCompactSummary":true,"timestamp":"2026-01-01T00:00:03Z","message":{"role":"user","content":"Summary of prior context"}}"#,
            "\n",
            r#"{"sessionId":"compact","uuid":"a2","parentUuid":"summary","type":"assistant","timestamp":"2026-01-01T00:00:04Z","message":{"role":"assistant","content":"continued answer"}}"#,
        );
        let path = temp_jsonl("compact.jsonl", contents);
        let conversation = parse_claude_session(&path).unwrap();
        let content: Vec<&str> = conversation.messages.iter().map(|message| message.content.as_str()).collect();
        assert_eq!(content, vec!["first question", "first answer", "continued answer"]);
        assert_eq!(conversation.messages[0].id, "msg_root_0");
        assert_eq!(conversation.messages[2].id, "msg_a2_0");
        fs::remove_dir_all(path.parent().unwrap()).unwrap();
    }

    #[test]
    fn concatenated_jsonl_line_keeps_chain_and_pre_history() {
        // Claude 偶发把两个 JSON 对象写进同一物理行且未换行（`}{` 相邻）。严格逐行
        // 解析会判 Extra data 并丢弃整行；若该行含后续 parentUuid 引用的桥接消息，
        // 父链会在原地断裂、更早历史被误判为废弃分支过滤。容错解析须保留桥接节点，
        // 使父链一路回溯到首条用户消息。
        let contents = concat!(
            r#"{"sessionId":"concat","uuid":"root","parentUuid":null,"type":"user","timestamp":"2026-01-01T00:00:00Z","message":{"role":"user","content":"first question"}}"#,
            "\n",
            r#"{"sessionId":"concat","uuid":"a1","parentUuid":"root","type":"assistant","timestamp":"2026-01-01T00:00:01Z","message":{"role":"assistant","content":"first answer"}}"#,
            "\n",
            // 同一物理行拼接两个对象（无换行）：桥接 assistant + last-prompt
            r#"{"sessionId":"concat","uuid":"bridge","parentUuid":"a1","type":"assistant","timestamp":"2026-01-01T00:00:02Z","message":{"role":"assistant","content":"bridge answer"}}"#,
            r#"{"sessionId":"concat","type":"last-prompt","lastPrompt":"x","leafUuid":"bridge"}"#,
            "\n",
            r#"{"sessionId":"concat","uuid":"q2","parentUuid":"bridge","type":"user","timestamp":"2026-01-01T00:00:03Z","message":{"role":"user","content":"second question"}}"#,
        );
        let path = temp_jsonl("concat.jsonl", contents);
        let conversation = parse_claude_session(&path).unwrap();
        let content: Vec<&str> = conversation
            .messages
            .iter()
            .map(|message| message.content.as_str())
            .collect();
        assert_eq!(
            content,
            vec!["first question", "first answer", "bridge answer", "second question"]
        );
        assert_eq!(conversation.messages[0].id, "msg_root_0");
        assert_eq!(conversation.messages[2].id, "msg_bridge_0");
        assert_eq!(conversation.messages[3].id, "msg_q2_0");
        fs::remove_dir_all(path.parent().unwrap()).unwrap();
    }

    #[test]
    fn task_notification_user_message_is_filtered_from_history() {
        // CLI 把子代理完成通知（<task-notification>，含完整 <result>）以 user 角色写进
        // transcript，属内部进度回执，不应作为用户消息出现在会话里。
        let contents = concat!(
            r#"{"sessionId":"tn","uuid":"q","parentUuid":null,"type":"user","timestamp":"2026-01-01T00:00:00Z","message":{"role":"user","content":"问题"}}"#,
            "\n",
            r#"{"sessionId":"tn","uuid":"a1","parentUuid":"q","type":"assistant","timestamp":"2026-01-01T00:00:01Z","message":{"role":"assistant","content":"答复"}}"#,
            "\n",
            r#"{"sessionId":"tn","uuid":"tn1","parentUuid":"a1","type":"user","timestamp":"2026-01-01T00:00:02Z","message":{"role":"user","content":"<task-notification>\n<task-id>abc</task-id>\n<tool-use-id>call_1</tool-use-id>\n<status>completed</status>\n<summary>Agent \"审查\" finished</summary>\n<result>report body</result>\n</task-notification>"}}"#,
        );
        let path = temp_jsonl("task-notification.jsonl", contents);
        let conversation = parse_claude_session(&path).unwrap();
        let content: Vec<&str> = conversation.messages.iter().map(|m| m.content.as_str()).collect();
        assert_eq!(content, vec!["问题", "答复"]);
        fs::remove_dir_all(path.parent().unwrap()).unwrap();
    }

    #[test]
    fn task_notification_merges_report_into_agent_tool_use() {
        // Agent tool_use 保留（可展示子代理），<task-notification> 不进消息流，
        // 但 status/summary/result/usage 合并进对应 tool_use，供「子代理」tab 展示报告。
        let contents = concat!(
            r#"{"sessionId":"tnm","uuid":"q","parentUuid":null,"type":"user","timestamp":"2026-01-01T00:00:00Z","message":{"role":"user","content":"审查代码"}}"#,
            "\n",
            r#"{"sessionId":"tnm","uuid":"a1","parentUuid":"q","type":"assistant","timestamp":"2026-01-01T00:00:01Z","message":{"role":"assistant","content":[{"type":"tool_use","id":"call_04_1","name":"Agent","input":{"description":"审查 UI"}}]}}"#,
            "\n",
            r#"{"sessionId":"tnm","uuid":"tn","parentUuid":"a1","type":"user","timestamp":"2026-01-01T00:00:02Z","message":{"role":"user","content":"<task-notification>\n<task-id>abc</task-id>\n<tool-use-id>call_04_1</tool-use-id>\n<status>completed</status>\n<summary>Agent \"审查 UI\" finished</summary>\n<result>报告正文</result>\n<usage><subagent_tokens>100</subagent_tokens><tool_uses>3</tool_uses><duration_ms>5000</duration_ms></usage>\n</task-notification>"}}"#,
        );
        let path = temp_jsonl("task-notification-merge.jsonl", contents);
        let conversation = parse_claude_session(&path).unwrap();
        assert_eq!(conversation.messages.len(), 2);
        assert_eq!(conversation.messages[0].content, "审查代码");
        let tool_msg = &conversation.messages[1];
        assert_eq!(tool_msg.role, "tool_use");
        let payload: serde_json::Value = serde_json::from_str(&tool_msg.content).unwrap();
        assert_eq!(payload["name"], "Agent");
        let tn = &payload["taskNotification"];
        assert_eq!(tn["status"], "completed");
        assert_eq!(tn["result"], "报告正文");
        assert_eq!(tn["summary"], "Agent \"审查 UI\" finished");
        assert_eq!(tn["total_tokens"], 100);
        assert_eq!(tn["tool_uses"], 3);
        assert_eq!(tn["duration_ms"], 5000);
        fs::remove_dir_all(path.parent().unwrap()).unwrap();
    }

    #[test]
    fn queue_operation_notification_merges_into_agent_tool_use() {
        // 新版 CLI（984dd8cc 实测）：子代理完成通知写在 queue-operation / attachment
        // 等非消息行（顶层 content，无 message 字段）。若不解析，通知丢失，
        // 历史 Agent/Task 卡只剩「运行中」空横线。
        let contents = concat!(
            r#"{"sessionId":"qnotif","uuid":"q","parentUuid":null,"type":"user","timestamp":"2026-01-01T00:00:00Z","message":{"role":"user","content":"审查代码"}}"#,
            "\n",
            r#"{"sessionId":"qnotif","uuid":"a1","parentUuid":"q","type":"assistant","timestamp":"2026-01-01T00:00:01Z","message":{"role":"assistant","content":[{"type":"tool_use","id":"call_09_1","name":"Agent","input":{"description":"审查 UI"}}]}}"#,
            "\n",
            r#"{"sessionId":"qnotif","uuid":"tn1","parentUuid":"a1","type":"queue-operation","operation":"enqueue","timestamp":"2026-01-01T00:00:02Z","content":"<task-notification>\n<task-id>xyz</task-id>\n<tool-use-id>call_09_1</tool-use-id>\n<status>completed</status>\n<summary>Agent \"审查 UI\" finished</summary>\n<result>队列行报告</result>\n<usage><subagent_tokens>50</subagent_tokens><tool_uses>2</tool_uses><duration_ms>3000</duration_ms></usage>\n</task-notification>"}"#,
        );
        let path = temp_jsonl("queue-notification-merge.jsonl", contents);
        let conversation = parse_claude_session(&path).unwrap();
        assert_eq!(conversation.messages.len(), 2);
        let tool_msg = &conversation.messages[1];
        assert_eq!(tool_msg.role, "tool_use");
        let payload: serde_json::Value = serde_json::from_str(&tool_msg.content).unwrap();
        let tn = &payload["taskNotification"];
        assert_eq!(tn["status"], "completed");
        assert_eq!(tn["result"], "队列行报告");
        assert_eq!(tn["summary"], "Agent \"审查 UI\" finished");
        fs::remove_dir_all(path.parent().unwrap()).unwrap();
    }
}
