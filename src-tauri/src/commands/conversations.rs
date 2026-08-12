use std::collections::HashSet;
use std::path::Path;

use crate::history::*;
use crate::session::session_stop_graceful;

#[tauri::command]
pub fn get_conversations() -> Vec<Conversation> {
    let state = load_app_state();
    state.conversations
}

#[tauri::command]
pub fn get_current_platform() -> String {
    detect_os()
}

#[tauri::command]
pub fn delete_conversation(conversation_id: String, source_path: Option<String>) -> Result<bool, String> {
    let mut delete_error: Option<String> = None;

    let resolved_path = if let Some(path) = source_path.filter(|p| !p.trim().is_empty()) {
        match validate_claude_source_path(Path::new(&path)) {
            Ok(path) => Some(path),
            Err(err) => {
                delete_error = Some(err);
                find_claude_session_file(&conversation_id)
            }
        }
    } else {
        find_claude_session_file(&conversation_id)
    };

    if let Some(path) = resolved_path {
        if let Err(err) = delete_claude_session_file(&path, &conversation_id) {
            delete_error = Some(err);
        }
    }

    mark_session_deleted(&conversation_id);

    let mut state = load_persisted_state();
    let before = state.conversations.len();
    state.conversations.retain(|c| c.id != conversation_id);
    if state.conversations.len() != before {
        save_app_state(&state);
    }

    if let Some(err) = delete_error {
        eprintln!("[delete] session hidden but file delete failed: {err}");
    }

    Ok(true)
}

#[tauri::command]
pub fn delete_workspace_conversations(project_dir: String) -> Result<u32, String> {
    let project_dir_trimmed = project_dir.trim();
    if project_dir_trimmed.is_empty() {
        return Err("project_dir is empty".to_string());
    }

    // 使用和前端 get_conversations() 相同的数据源（优先读 Claude JSONL 历史）
    let app_state = load_app_state();
    let ids_to_delete: Vec<String> = app_state
        .conversations
        .iter()
        .filter(|c| {
            c.project_dir
                .as_deref()
                .is_some_and(|d| d.trim() == project_dir_trimmed)
        })
        .map(|c| c.id.clone())
        .collect();

    if ids_to_delete.is_empty() {
        return Ok(0);
    }

    let count = ids_to_delete.len() as u32;
    let mut errors: Vec<String> = Vec::new();

    for conv_id in &ids_to_delete {
        let resolved_path = find_claude_session_file(conv_id);
        if let Some(ref path) = resolved_path {
            if let Err(err) = delete_claude_session_file(path, conv_id) {
                errors.push(err);
            }
        }
        mark_session_deleted(conv_id);
    }

    // 清理 state.json（如果其中也包含被删会话）
    let mut persisted = load_persisted_state();
    let id_set: HashSet<String> = ids_to_delete.iter().cloned().collect();
    let before = persisted.conversations.len();
    persisted.conversations.retain(|c| !id_set.contains(&c.id));
    if persisted.conversations.len() != before {
        save_app_state(&persisted);
    }

    if !errors.is_empty() {
        eprintln!(
            "[delete_workspace] some session files could not be deleted: {:?}",
            errors
        );
    }

    Ok(count)
}

#[tauri::command]
pub fn get_conversation(conversation_id: String) -> Option<Conversation> {
    // 只定位并解析目标会话文件，不再全量扫描解析整个历史目录
    if let Some(path) = find_claude_session_file(&conversation_id) {
        if let Some(mut conv) = parse_claude_session_cached(&path) {
            let overlay = load_overlay();
            if overlay.deleted_session_ids.iter().any(|id| id == &conv.id) {
                return None;
            }
            if let Some(title) = overlay.title_overrides.get(&conv.id) {
                conv.title = title.clone();
            }
            return Some(conv);
        }
    }
    // 回退：非 claude 历史的持久化会话
    load_persisted_state()
        .conversations
        .into_iter()
        .find(|c| c.id == conversation_id)
}

#[tauri::command]
pub fn update_conversation_title(
    conversation_id: String,
    title: String,
    source_path: Option<String>,
) -> Result<Conversation, String> {
    let trimmed = title.trim().to_string();
    if trimmed.is_empty() {
        return Err("Title cannot be empty".to_string());
    }

    let resolved_path = if let Some(path) = source_path.filter(|p| !p.trim().is_empty()) {
        match validate_claude_source_path(Path::new(&path)) {
            Ok(path) => Some(path),
            Err(_) => find_claude_session_file(&conversation_id),
        }
    } else {
        find_claude_session_file(&conversation_id)
    };

    let session_path = resolved_path.or_else(|| find_claude_session_file(&conversation_id));

    if let Some(path) = &session_path {
        if let Err(err) = write_claude_custom_title(path, &conversation_id, &trimmed) {
            eprintln!("[title] failed to write custom-title to {}: {err}", path.display());
        }
    }

    set_title_override(&conversation_id, &trimmed);

    if let Some(path) = session_path.clone() {
        if let Some(mut conv) = parse_claude_session(&path) {
            conv.title = trimmed.clone();
            return Ok(conv);
        }
    }

    let mut state = load_persisted_state();
    if let Some(c) = state.conversations.iter_mut().find(|c| c.id == conversation_id) {
        c.title = trimmed.clone();
        c.updated_at = chrono::Utc::now().timestamp();
        let result = c.clone();
        save_app_state(&state);
        return Ok(result);
    }

    Ok(Conversation {
        id: conversation_id,
        title: trimmed.clone(),
        messages: Vec::new(),
        platform: "claude".to_string(),
        project_dir: None,
        source_path: session_path.map(|p| p.to_string_lossy().to_string()),
        created_at: chrono::Utc::now().timestamp(),
        updated_at: chrono::Utc::now().timestamp(),
        context_tokens: None,
        last_model: None,
    })
}
