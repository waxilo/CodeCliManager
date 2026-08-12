use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::fs;
use std::io::{BufRead, BufReader, Write};
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use crate::paths::{get_claude_history_path, get_data_path};

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
    pub(crate) deleted_session_ids: Vec<String>,
    #[serde(default)]
    pub(crate) title_overrides: HashMap<String, String>,
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
        let _ = fs::write(get_overlay_path(), content);
    }
}

pub(crate) fn mark_session_deleted(session_id: &str) {
    let mut overlay = load_overlay();
    if !overlay.deleted_session_ids.iter().any(|id| id == session_id) {
        overlay.deleted_session_ids.push(session_id.to_string());
        save_overlay(&overlay);
    }
}

pub(crate) fn set_title_override(session_id: &str, title: &str) {
    let mut overlay = load_overlay();
    overlay
        .title_overrides
        .insert(session_id.to_string(), title.to_string());
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

/// 会话文件被本地改写后必须失效缓存。
/// mtime 精度只有秒级，同秒内连续写入（发送后立刻撤回）会命中旧缓存，导致 UI 看起来“没撤回”。
pub(crate) fn invalidate_session_cache(path: &Path) {
    let mut cache = SESSION_CACHE.lock().unwrap();
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

/// 判断 JSONL 行是否为真实人类用户消息（排除 meta / compact / 纯 tool_result）
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
    if is_tool_result_only_user_message(message) {
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
            if overlay.deleted_session_ids.iter().any(|id| id == &conv.id) {
                continue;
            }
            if let Some(title) = overlay.title_overrides.get(&conv.id) {
                conv.title = title.clone();
            }
            conversations.push(conv);
        }
    }

    conversations.sort_by(|a, b| b.created_at.cmp(&a.created_at));
    conversations
}

pub(crate) fn collect_jsonl_files(root: &PathBuf, files: &mut Vec<PathBuf>) {
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

pub(crate) fn parse_claude_session(path: &PathBuf) -> Option<Conversation> {
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

        // 将 content 数组展开为独立消息，保留 thinking/text 穿插顺序
        // 参考 claudecodeui: 每个 content part 生成独立的 NormalizedMessage
        // toolUseResult：AskUserQuestion 的答案在 JSONL 行级字段，需一并传入
        let id_prefix = format!("msg_{}", messages.len());
        let expanded = expand_content_parts(
            &role,
            message.get("content"),
            &id_prefix,
            ts.unwrap_or_default(),
            value.get("toolUseResult"),
        );

        // 记录第一条用户消息（用于会话标题）
        if first_user_message.is_none() && role == "user" {
            for msg in &expanded {
                if msg.role == "user" && !msg.content.trim().is_empty() {
                    first_user_message = Some(msg.content.clone());
                    break;
                }
            }
        }

        // 过滤并添加展开的消息
        for msg in expanded {
            let trimmed = msg.content.trim();
            // 跳过内部系统消息
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
pub(crate) fn decode_project_dir_from_jsonl_path(path: &PathBuf) -> Option<String> {
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

/// 将 content（字符串或数组）展开为多条消息，保留 thinking/text 穿插顺序
/// AskUserQuestion 的 tool_use / tool_result 会保留，供前端渲染选项卡片
/// 参考 claudecodeui: 每个 content part 生成独立的 NormalizedMessage
pub(crate) fn expand_content_parts(
    role: &str,
    content: Option<&serde_json::Value>,
    id_prefix: &str,
    timestamp: i64,
    tool_use_result: Option<&serde_json::Value>,
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
                        // 仅保留 AskUserQuestion，供前端展示互动选项卡片
                        if name == "AskUserQuestion" {
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
                        // 搭配 AskUserQuestion：带上 JSONL 行级 toolUseResult（含 answers）
                        let has_answers = tool_use_result
                            .and_then(|v| v.get("answers"))
                            .is_some();
                        let has_questions = tool_use_result
                            .and_then(|v| v.get("questions"))
                            .is_some();
                        if has_answers || has_questions {
                            let payload = serde_json::json!({
                                "content": item.get("content").cloned().unwrap_or(serde_json::Value::Null),
                                "tool_use_id": item.get("tool_use_id").cloned().unwrap_or(serde_json::Value::Null),
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
        let _ = fs::write(path, content);
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
        std::fs::write(&path, new_content)
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
