use std::collections::HashSet;
use std::path::Path;

use crate::history::*;

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
pub fn delete_conversation(
    conversation_id: String,
    source_path: Option<String>,
) -> Result<bool, String> {
    let explicit_source = source_path.filter(|path| !path.trim().is_empty());
    let resolved_path = match explicit_source {
        Some(path) => Some(validate_claude_source_path(Path::new(&path))?),
        None => find_claude_session_file(&conversation_id),
    };

    if let Some(path) = resolved_path.as_deref() {
        delete_claude_session_file(path, &conversation_id)?;
        invalidate_session_cache(path);
        mark_session_deleted(&conversation_id, Some(path));
    }

    let mut state = load_persisted_state();
    let before = state.conversations.len();
    state.conversations.retain(|conversation| {
        if conversation.id != conversation_id {
            return true;
        }
        match resolved_path.as_deref() {
            Some(path) => conversation.source_path.as_deref() != Some(path.to_string_lossy().as_ref()),
            None => false,
        }
    });
    let removed_persisted = state.conversations.len() != before;
    if removed_persisted {
        save_app_state(&state);
    }

    if resolved_path.is_none() && !removed_persisted {
        return Ok(false);
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
    let conversations_to_delete: Vec<Conversation> = app_state
        .conversations
        .iter()
        .filter(|conversation| {
            conversation
                .project_dir
                .as_deref()
                .is_some_and(|directory| directory.trim() == project_dir_trimmed)
        })
        .cloned()
        .collect();

    if conversations_to_delete.is_empty() {
        return Ok(0);
    }

    let mut deleted_keys: HashSet<(String, Option<String>)> = HashSet::new();
    let mut errors = Vec::new();

    for conversation in &conversations_to_delete {
        let resolved_path = match conversation.source_path.as_deref() {
            Some(path) => validate_claude_source_path(Path::new(path)).map(Some),
            None => Ok(find_claude_session_file(&conversation.id)),
        };
        match resolved_path {
            Ok(Some(path)) => match delete_claude_session_file(&path, &conversation.id) {
                Ok(()) => {
                    invalidate_session_cache(&path);
                    mark_session_deleted(&conversation.id, Some(&path));
                    deleted_keys.insert((
                        conversation.id.clone(),
                        Some(path.to_string_lossy().to_string()),
                    ));
                }
                Err(err) => errors.push(err),
            },
            Ok(None) => {
                // A state-only conversation has no backing file; removing it from state is success.
                deleted_keys.insert((conversation.id.clone(), None));
            }
            Err(err) => errors.push(err),
        }
    }

    let mut persisted = load_persisted_state();
    let before = persisted.conversations.len();
    persisted.conversations.retain(|conversation| {
        !deleted_keys.contains(&(conversation.id.clone(), conversation.source_path.clone()))
    });
    if persisted.conversations.len() != before {
        save_app_state(&persisted);
    }

    if !errors.is_empty() {
        return Err(format!(
            "Deleted {} conversation(s); {} failed: {}",
            deleted_keys.len(),
            errors.len(),
            errors.join("; ")
        ));
    }

    Ok(deleted_keys.len() as u32)
}

#[tauri::command]
pub fn get_conversation(
    conversation_id: String,
    source_path: Option<String>,
) -> Option<Conversation> {
    let explicit_source = source_path.filter(|path| !path.trim().is_empty());
    let path = match explicit_source.as_deref() {
        Some(path) => validate_claude_source_path(Path::new(path)).ok(),
        None => find_claude_session_file(&conversation_id),
    };
    if let Some(path) = path {
        if !session_id_matches_path(&conversation_id, &path) {
            return None;
        }
        if let Some(mut conversation) = parse_claude_session_cached(&path) {
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
            return Some(conversation);
        }
    }
    load_persisted_state()
        .conversations
        .into_iter()
        .find(|conversation| {
            conversation.id == conversation_id
                && source_path_matches(conversation.source_path.as_deref(), explicit_source.as_deref())
        })
}

fn source_path_matches(stored: Option<&str>, requested: Option<&str>) -> bool {
    requested.map_or(true, |path| stored == Some(path))
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

    let resolved_path = match source_path.filter(|path| !path.trim().is_empty()) {
        Some(path) => Some(validate_claude_source_path(Path::new(&path))?),
        None => find_claude_session_file(&conversation_id),
    };

    if let Some(path) = &resolved_path {
        write_claude_custom_title(path, &conversation_id, &trimmed)?;
        invalidate_session_cache(path);
    }

    set_title_override(&conversation_id, resolved_path.as_deref(), &trimmed);

    if let Some(path) = resolved_path.clone() {
        if let Some(mut conv) = parse_claude_session(&path) {
            conv.title = trimmed.clone();
            return Ok(conv);
        }
    }

    let mut state = load_persisted_state();
    let requested_path = resolved_path
        .as_deref()
        .map(|path| path.to_string_lossy().to_string());
    if let Some(conversation) = state.conversations.iter_mut().find(|conversation| {
        conversation.id == conversation_id
            && source_path_matches(conversation.source_path.as_deref(), requested_path.as_deref())
    }) {
        conversation.title = trimmed.clone();
        conversation.updated_at = chrono::Utc::now().timestamp();
        let result = conversation.clone();
        save_app_state(&state);
        return Ok(result);
    }

    Ok(Conversation {
        id: conversation_id,
        title: trimmed.clone(),
        messages: Vec::new(),
        platform: "claude".to_string(),
        project_dir: None,
        source_path: resolved_path.map(|p| p.to_string_lossy().to_string()),
        created_at: chrono::Utc::now().timestamp(),
        updated_at: chrono::Utc::now().timestamp(),
        context_tokens: None,
        last_model: None,
    })
}
