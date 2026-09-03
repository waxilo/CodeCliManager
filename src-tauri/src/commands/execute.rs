use serde::Serialize;
use std::path::PathBuf;
use tauri::{AppHandle, Emitter};

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExecutePromptResult {
    status: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    item: Option<QueuedPrompt>,
    #[serde(skip_serializing_if = "Option::is_none")]
    run_id: Option<String>,
}

impl ExecutePromptResult {
    fn sent(run_id: Option<String>) -> Self {
        Self {
            status: "sent",
            item: None,
            run_id,
        }
    }

    fn queued(item: QueuedPrompt) -> Self {
        Self {
            status: "queued",
            item: Some(item),
            run_id: None,
        }
    }
}

use crate::claude::spawn_claude_stream;
use crate::claude::stream_events::*;
use crate::config_io::atomic_write;
use crate::history::*;
use crate::session::*;

#[tauri::command]
pub async fn execute_prompt(
    app: AppHandle,
    prompt: String,
    conversation_id: Option<String>,
    model: Option<String>,
    project_dir: Option<String>,
    message_content: Option<String>,
    run_id: Option<String>,
) -> Result<ExecutePromptResult, String> {
    let active_cid = conversation_id.clone();
    let active_model = model.filter(|value| !value.trim().is_empty());
    let explicit_project_dir = project_dir.filter(|value| !value.trim().is_empty());
    eprintln!(
        "[execute_prompt] received: prompt='{}', conversation_id={:?}, model={:?}, project_dir={:?}",
        prompt, active_cid, active_model, explicit_project_dir
    );

    // 常驻进程仍在：同模型则 stdin 追问；换模型则重启进程（--resume + 新 --model）
    if let Some(ref cid) = active_cid {
        if is_process_registered(cid) && get_active_stdin(cid).is_some() {
            let requested_model = normalize_process_model(active_model.as_deref());
            let running_model = get_active_session_model(cid).unwrap_or_default();
            if requested_model == running_model && is_turn_active(cid) {
                let queued = QueuedPrompt {
                    id: uuid::Uuid::new_v4().to_string(),
                    prompt: prompt.clone(),
                    message_content: message_content.clone().unwrap_or_else(|| prompt.clone()),
                    model: active_model.clone(),
                    queued_at: chrono::Utc::now().timestamp_millis(),
                };
                let count = enqueue_prompt(cid, queued.clone());
                emit_queued_prompts(&app, cid);
                eprintln!("[execute_prompt] turn active; queued followup for {} (count={})", cid, count);
                return Ok(ExecutePromptResult::queued(queued));
            }

            if requested_model != running_model {
                let cleared = clear_queued_prompts(cid);
                if cleared > 0 {
                    emit_queued_prompts(&app, cid);
                }
                eprintln!(
                    "[execute_prompt] 模型切换 '{}' → '{}'，重启常驻会话 {}",
                    if running_model.is_empty() {
                        "default"
                    } else {
                        running_model.as_str()
                    },
                    if requested_model.is_empty() {
                        "default"
                    } else {
                        requested_model.as_str()
                    },
                    cid
                );
                let _ = session_restart_graceful_async(cid.clone(), true).await;
                // 落入下方 spawn/--resume
            } else {
                if let Some(ref new_model) = active_model {
                    match rewrite_session_model(cid, new_model) {
                        Ok(true) => {
                            eprintln!(
                                "[execute_prompt] followup JSONL model rewritten to '{}' for {}",
                                new_model, cid
                            );
                        }
                        Ok(false) => {}
                        Err(e) => {
                            eprintln!(
                                "[execute_prompt] Warning: followup rewrite model failed: {}",
                                e
                            );
                        }
                    }
                }
                match try_send_followup_prompt(cid, &prompt) {
                    Ok(()) => {
                        eprintln!("[execute_prompt] followup via stdin for {}", cid);
                        return Ok(ExecutePromptResult::sent(None));
                    }
                    Err(e) => {
                        eprintln!(
                            "[execute_prompt] followup 失败，将优雅退出后重新 spawn: {} ({})",
                            cid, e
                        );
                        let _ = session_restart_graceful_async(cid.clone(), false).await;
                    }
                }
            }
        }
    }

    let run_id = match run_id {
        Some(value) => {
            let trimmed = value.trim();
            let valid = trimmed
                .strip_prefix("run-")
                .and_then(|value| uuid::Uuid::parse_str(value).ok())
                .is_some();
            if !valid {
                return Err("runId 格式无效".to_string());
            }
            trimmed.to_string()
        }
        None => new_run_id(),
    };
    let initial_run_key = active_cid
        .clone()
        .unwrap_or_else(|| pending_key_for_run(&run_id));
    if !register_run_key_if_absent(&run_id, &initial_run_key) {
        return Err("runId 已在使用中".to_string());
    }
    let fallback_session_key = initial_run_key.clone();
    let run_id_for_task = run_id.clone();
    tauri::async_runtime::spawn(async move {
        let before_conversations = tauri::async_runtime::spawn_blocking(load_claude_history)
            .await
            .unwrap_or_default();
        let before_ids: std::collections::HashSet<String> =
            before_conversations.iter().map(|c| c.id.clone()).collect();

        let project_dir = active_cid
            .as_ref()
            .and_then(|cid| {
                before_conversations
                    .iter()
                    .find(|c| c.id == *cid)
                    .and_then(|c| c.project_dir.as_ref())
                    .cloned()
            })
            .or(explicit_project_dir);

        let app_handle = app.clone();
        let prompt_clone = prompt.clone();
        let cid_clone = active_cid.clone();
        let model_clone = active_model.clone();
        let stream_run_id = run_id_for_task.clone();

        // resume 已有会话时，先修改 JSONL 文件中历史 assistant 消息的 model 字段，
        // 使 CLI 恢复会话时看到的对话历史与当前选择的模型一致，
        // 避免模型因看到旧模型名而自我认知混乱。
        if let (Some(ref cid), Some(ref new_model)) = (&active_cid, &active_model) {
            match rewrite_session_model(cid, new_model) {
                Ok(true) => {
                    eprintln!(
                        "[execute_prompt] JSONL model rewritten to '{}' for session {}",
                        new_model, cid
                    );
                }
                Ok(false) => {
                    // 模型未变或文件中无需修改
                }
                Err(e) => {
                    eprintln!(
                        "[execute_prompt] Warning: failed to rewrite session model: {}",
                        e
                    );
                }
            }
        }

        let stream_result = tauri::async_runtime::spawn_blocking(move || {
            spawn_claude_stream(
                app_handle,
                &prompt_clone,
                cid_clone.as_ref(),
                project_dir.as_ref(),
                model_clone.as_deref(),
                &stream_run_id,
            )
        })
        .await;

        match stream_result {
            Ok(Ok(outcome)) => match outcome {
                StreamOutcome::Success(final_session_id) => {
                    let after_conversations =
                        tauri::async_runtime::spawn_blocking(load_claude_history)
                            .await
                            .unwrap_or_default();
                    let resolved_id = final_session_id.or(active_cid.clone());

                    if let Some(sid) = resolved_id {
                        clear_turn_active(&sid);
                        if take_model_restart(&sid)
                            || active_cid
                                .as_ref()
                                .is_some_and(|cid| take_model_restart(cid))
                        {
                            // 切模型重启：绝不发 session-ended / messages-updated。
                            // 此时新提问只在前端本地，JSONL 尚未写入；一刷新就会短暂「消息消失」。
                            eprintln!(
                                "[execute_prompt] 模型重启：跳过 messages-updated 与 session-ended ({})",
                                sid
                            );
                            return;
                        }
                        if let Some(conv) = after_conversations.iter().find(|c| c.id == sid) {
                            let is_existing = before_ids.contains(&conv.id);
                            let event_name = if is_existing {
                                "messages-updated"
                            } else {
                                "session-created"
                            };

                            let payload = conversation_to_payload(conv);
                            eprintln!("[execute_prompt] emit {} for session {}", event_name, conv.id);
                            let _ = app.emit(event_name, &payload);
                            // 进程已退出（空闲超时/被杀）；本轮完成已由 turn-complete 处理
                            let _ = app.emit("session-ended", Some(conv.id.clone()));
                            return;
                        }
                    }

                    eprintln!("[execute_prompt] 未找到更新的会话");
                    if active_cid
                        .as_ref()
                        .is_some_and(|cid| take_model_restart(cid))
                    {
                        return;
                    }
                    let _ = app.emit("session-ended", Some(fallback_session_key.clone()));
                }
                StreamOutcome::Cancelled(session_id) => {
                    if let Some(ref sid) = session_id {
                        clear_turn_active(sid);
                    }
                    if let Some(ref cid) = active_cid {
                        clear_turn_active(cid);
                    }
                    let _ = app.emit("session-ended", session_id.or(active_cid.clone()));
                }
                StreamOutcome::Failed { session_id, error } => {
                    eprintln!(
                        "[execute_prompt] claude 执行失败 (session={:?}): {}",
                        session_id, error
                    );
                    if let Some(ref sid) = session_id {
                        clear_turn_active(sid);
                    }
                    if let Some(ref cid) = active_cid {
                        clear_turn_active(cid);
                    }
                    let restart = session_id
                        .as_ref()
                        .is_some_and(|sid| take_model_restart(sid))
                        || active_cid
                            .as_ref()
                            .is_some_and(|cid| take_model_restart(cid));
                    if restart {
                        eprintln!("[execute_prompt] 模型重启导致旧进程退出，跳过失败 session-ended");
                        return;
                    }
                    let _ = app.emit(
                        "session-ended",
                        Some(session_id.unwrap_or_else(|| fallback_session_key.clone())),
                    );
                }
            },
            Ok(Err(e)) => {
                unregister_run_id(&run_id_for_task);
                let restart = active_cid
                    .as_ref()
                    .is_some_and(|cid| take_model_restart(cid));
                if restart {
                    eprintln!(
                        "[execute_prompt] 模型重启导致旧进程异常退出，跳过 session-ended: {e}"
                    );
                    return;
                }
                let error = format!("Claude 执行失败: {e}");
                eprintln!("[execute_prompt] {error}");
                emit_session_error(&app, Some(&fallback_session_key), &error);
                let _ = app.emit("session-ended", Some(fallback_session_key.clone()));
            }
            Err(e) => {
                unregister_run_id(&run_id_for_task);
                let restart = active_cid
                    .as_ref()
                    .is_some_and(|cid| take_model_restart(cid));
                if restart {
                    eprintln!(
                        "[execute_prompt] 模型重启导致旧进程启动失败回调，跳过 session-ended: {e}"
                    );
                    return;
                }
                let error = format!("启动 Claude 进程失败: {e}");
                eprintln!("[execute_prompt] {error}");
                emit_session_error(&app, Some(&fallback_session_key), &error);
                let _ = app.emit("session-ended", Some(fallback_session_key.clone()));
            }
        }
    });

    Ok(ExecutePromptResult::sent(Some(run_id)))
}

#[tauri::command]
pub fn remove_queued_prompt_command(
    app: AppHandle,
    conversation_id: String,
    prompt_id: String,
) -> Result<bool, String> {
    let removed = remove_queued_prompt(&conversation_id, &prompt_id);
    emit_queued_prompts(&app, &conversation_id);
    Ok(removed)
}

#[tauri::command]
pub fn clear_queued_prompts_command(
    app: AppHandle,
    conversation_id: String,
) -> Result<usize, String> {
    let cleared = clear_queued_prompts(&conversation_id);
    emit_queued_prompts(&app, &conversation_id);
    Ok(cleared)
}

/// 终止正在运行的 Claude 会话（用户主动取消）
/// 默认友好 interrupt；`force=true` 时结束常驻进程（删会话等）
#[tauri::command]
pub async fn abort_session(
    app: AppHandle,
    conversation_id: Option<String>,
    force: Option<bool>,
    run_id: Option<String>,
) -> Result<bool, String> {
    let force_kill = force.unwrap_or(false);
    let requested_run_id = run_id.filter(|id| !id.trim().is_empty());
    let run_key = requested_run_id
        .as_deref()
        .and_then(resolve_run_key);
    if requested_run_id.is_some() && run_key.is_none() {
        return Err("找不到指定的运行请求，拒绝取消其他会话".to_string());
    }
    if let (Some(cid), Some(key)) = (conversation_id.as_deref(), run_key.as_deref()) {
        if cid != key && !key.starts_with("pending-") {
            return Err("runId 与 conversationId 不匹配，拒绝取消".to_string());
        }
    }
    let mut aborted = false;

    let target_key = run_key.as_ref().or(conversation_id.as_ref());
    if let Some(key) = target_key {
        let cleared = clear_queued_prompts(key);
        if cleared > 0 {
            emit_queued_prompts(&app, key);
            eprintln!("[abort] cleared {} queued prompts for {}", cleared, key);
        }
    }

    // 确定要取消的目标：runId 优先（可精确指向 pending），其次 conversationId，
    // 最后回退到「唯一 pending」。确定后再把阻塞轮询移到 blocking 线程。
    let abort_target: Option<String> = if let Some(ref key) = run_key {
        Some(key.clone())
    } else if let Some(ref cid) = conversation_id {
        Some(cid.clone())
    } else if requested_run_id.is_none() && conversation_id.is_none() {
        let pending_keys = pending_process_keys();
        match pending_keys.as_slice() {
            [key] => Some(key.clone()),
            [] => None,
            _ => return Err("存在多个待启动会话，请提供 runId 以精确取消".to_string()),
        }
    } else {
        None
    };

    if let Some(key) = abort_target {
        let _ = app.emit("session-aborting", Some(key.clone()));
        // 即使进程尚未注册，也先标记；spawn 注册后会兑现取消。
        mark_session_aborted(&key);
        let was_pending = key.starts_with("pending-");
        let force = force_kill;
        // soft_abort_session 内部有最长 3s 的轮询，移到 spawn_blocking 避免卡住 async worker。
        let aborted_by_session = tauri::async_runtime::spawn_blocking(move || {
            soft_abort_session(&key, force)
        })
        .await
        .map_err(|e| format!("取消会话失败: {e}"))?;
        aborted = aborted_by_session || was_pending;
    }

    if !aborted {
        eprintln!("[abort] no active process found for {:?}", conversation_id);
    }
    Ok(aborted)
}

/// 全量优雅关闭所有常驻 claude 进程（应用更新 / 退出前调用）。
/// 每个会话走 interrupt → 关 stdin → 等待退出的优雅路径，并行执行。
#[tauri::command]
pub async fn stop_all_sessions(reason: Option<String>) -> Result<usize, String> {
    let keys = active_session_keys();
    if keys.is_empty() {
        return Ok(0);
    }
    let reason: &'static str = match reason.as_deref() {
        Some("update") => "应用更新",
        Some("quit") => "应用退出",
        _ => "应用关闭",
    };
    eprintln!(
        "[stop_all_sessions] 优雅关闭 {} 个活跃会话 ({})",
        keys.len(),
        reason
    );

    let handles: Vec<_> = keys
        .into_iter()
        .map(|key| {
            tauri::async_runtime::spawn_blocking(move || session_stop_graceful(&key, reason))
        })
        .collect();

    let mut stopped = 0usize;
    for handle in handles {
        if handle.await.unwrap_or(false) {
            stopped += 1;
        }
    }
    Ok(stopped)
}

/// 响应当前会话的工具权限请求（允许 / 拒绝）
#[tauri::command]
pub fn respond_tool_permission(
    request_id: String,
    behavior: String,
    message: Option<String>,
    updated_input: Option<serde_json::Value>,
) -> Result<(), String> {
    let trimmed_id = request_id.trim();
    if trimmed_id.is_empty() {
        return Err("request_id 不能为空".to_string());
    }
    let normalized = behavior.trim().to_lowercase();
    if normalized != "allow" && normalized != "deny" {
        return Err("behavior 必须是 allow 或 deny".to_string());
    }

    let pending = {
        let mut reg = PENDING_PERMISSIONS.lock().map_err(|_| "权限通道锁异常".to_string())?;
        let map = reg
            .as_mut()
            .ok_or_else(|| "没有等待中的权限请求".to_string())?;
        map.remove(trimmed_id)
            .ok_or_else(|| format!("找不到权限请求: {trimmed_id}"))?
    };

    pending
        .tx
        .send(PermissionDecision {
            behavior: normalized,
            message,
            updated_input,
        })
        .map_err(|_| "权限等待端已关闭".to_string())?;
    Ok(())
}

/// 同步前端权限模式到后端，并更新所有已运行的 Claude Code 进程。
/// auto（全部跳过）= silent + 前端自动回答互动问答：后端同样按静默授权处理。
#[tauri::command]
pub fn set_permission_mode(mode: String) -> Result<(), String> {
    match mode.trim().to_lowercase().as_str() {
        "silent" | "auto" => {
            set_silent_permission_mode(true);
            allow_pending_non_question_permissions();
        }
        "ask" => {
            set_silent_permission_mode(false);
        }
        other => return Err(format!("未知权限模式: {other}（应为 ask / silent / auto）")),
    }
    sync_active_permission_mode();
    Ok(())
}

/// 截断会话 JSONL 并触发"重新生成"或"撤回"
/// mode: "regenerate" — 删除最后一条 AI 回复，用相同用户消息重发
/// mode: "undo" — 删除最后一轮对话（最后一条人类用户消息及其后续），仅更新 UI 不回发
#[tauri::command]
pub async fn retry_message(
    app: AppHandle,
    conversation_id: String,
    mode: String,
) -> Result<(), String> {
    // 1. 如果正在运行，先优雅结束常驻进程
    let _ = session_stop_graceful_async(conversation_id.clone(), "重新生成/撤回").await;

    // 2-5. 找文件、读、解析、截断并写回：全部在 blocking 线程执行，避免卡住 async worker。
    let cid_for_truncate = conversation_id.clone();
    let mode_for_truncate = mode.clone();
    let (last_user_prompt, path): (Option<String>, PathBuf) =
        tauri::async_runtime::spawn_blocking(move || {
        let path = find_claude_session_file(&cid_for_truncate)
            .ok_or_else(|| format!("找不到会话文件: {}", cid_for_truncate))?;

        let content = std::fs::read_to_string(&path)
            .map_err(|e| format!("读取会话文件失败: {}", e))?;

        // 解析所有行，找到截断点；用户消息必须是「人类消息」，不能把 tool_result 当成用户提问
        let mut last_user_prompt: Option<String> = None;
        let mut last_user_line_idx: i64 = -1;
        let mut last_assistant_line_idx: i64 = -1;
        let lines: Vec<&str> = content.lines().collect();

        for (i, line) in lines.iter().enumerate() {
            if line.trim().is_empty() {
                continue;
            }
            let value: serde_json::Value = match serde_json::from_str(line) {
                Ok(v) => v,
                Err(_) => continue,
            };

            if is_human_user_message_line(&value) {
                last_user_line_idx = i as i64;
                if let Some(message) = value.get("message") {
                    last_user_prompt = extract_human_user_prompt(message);
                }
                continue;
            }

            let role = value
                .get("message")
                .and_then(|m| m.get("role"))
                .and_then(|r| r.as_str())
                .unwrap_or("");
            if role == "assistant" {
                last_assistant_line_idx = i as i64;
            }
        }

        // 确定截断位置
        let truncate_idx: usize = match mode_for_truncate.as_str() {
            "regenerate" => {
                if last_user_prompt.is_none() {
                    return Err("未找到可重试的用户消息".to_string());
                }
                if last_assistant_line_idx < 0 {
                    return Err("未找到可重试的 AI 回复".to_string());
                }
                if last_assistant_line_idx <= last_user_line_idx {
                    return Err("数据异常：AI 回复在用户消息之前，无法重试".to_string());
                }
                // 删除最后一轮中「最后一条人类消息之后」的全部内容，避免留下半截 tool 回合
                (last_user_line_idx as usize) + 1
            }
            "undo" => {
                if last_user_line_idx < 0 {
                    return Err("未找到可撤回的用户消息".to_string());
                }
                last_user_line_idx as usize
            }
            _ => return Err(format!("未知模式: {}", mode_for_truncate)),
        };

        // 截断并写回 JSONL（保留末尾换行，符合 JSONL 习惯）
        let new_content = if truncate_idx == 0 {
            String::new()
        } else {
            format!("{}\n", lines[..truncate_idx].join("\n"))
        };
        atomic_write(&path, new_content.as_bytes())
            .map_err(|e| format!("写入会话文件失败: {}", e))?;
        invalidate_session_cache(&path);

        eprintln!(
            "[retry_message] 截断会话 {}（模式={}），保留 {} 行，删除了 {} 行",
            cid_for_truncate,
            mode_for_truncate,
            truncate_idx,
            lines.len().saturating_sub(truncate_idx),
        );

        Ok::<(Option<String>, PathBuf), String>((last_user_prompt, path))
    })
    .await
    .map_err(|e| format!("重试处理失败: {e}"))??;

    // 6. 通知前端更新消息列表（从截断后的 JSONL 重新加载）
    let after_conv = tauri::async_runtime::spawn_blocking(load_claude_history)
        .await
        .unwrap_or_default()
        .into_iter()
        .find(|c| c.id == conversation_id);
    if let Some(conv) = after_conv {
        let payload = conversation_to_payload(&conv);
        let _ = app.emit("messages-updated", payload);
    } else {
        // 文件被截空或暂无法解析时，仍推送空消息列表，避免前端残留旧气泡
        let _ = app.emit(
            "messages-updated",
            SessionEventPayload {
                conversation_id: conversation_id.clone(),
                title: "Untitled".to_string(),
                messages: Vec::new(),
                project_dir: None,
                source_path: Some(path.to_string_lossy().to_string()),
                updated_at: chrono::Utc::now().timestamp(),
                context_tokens: None,
                last_model: None,
                usage: None,
            },
        );
    }

    // 7. "regenerate" 模式：用原用户消息重新发送
    if mode == "regenerate" {
        if let Some(prompt) = last_user_prompt {
            let app_clone = app.clone();
            let cid = conversation_id.clone();

            // 获取会话当前的模型和项目目录（同步于 execute_prompt 的行为）
            let regen_info = tauri::async_runtime::spawn_blocking(load_claude_history)
                .await
                .unwrap_or_default()
                .iter()
                .find(|c| c.id == cid)
                .map(|c| (c.last_model.clone(), c.project_dir.clone()))
                .unwrap_or((None, None));
            let (regenerate_model, regenerate_project_dir) = regen_info;

            // 异步执行，与 execute_prompt 保持一致
            tauri::async_runtime::spawn(async move {
                // Drop guard: 确保任务异常退出时前端不会卡在 loading 状态
                struct SessionEndedGuard {
                    app: AppHandle,
                    cid: String,
                }
                impl Drop for SessionEndedGuard {
                    fn drop(&mut self) {
                        let _ = self.app.emit("session-ended", Some(self.cid.clone()));
                    }
                }
                let _guard = SessionEndedGuard {
                    app: app_clone.clone(),
                    cid: cid.clone(),
                };

                eprintln!("[retry_message] 重新发送用户消息到会话 {}", cid);
                let app_handle = app_clone.clone();
                let cid_for_stream = cid.clone();
                let prompt_for_stream = prompt.clone();
                // 克隆以满足 spawn_blocking 的 'static 要求
                let model_owned = regenerate_model.clone();
                let project_dir_owned = regenerate_project_dir.clone();

                let retry_run_id = new_run_id();
                let stream_result = tauri::async_runtime::spawn_blocking(move || {
                    spawn_claude_stream(
                        app_handle,
                        &prompt_for_stream,
                        Some(&cid_for_stream),
                        project_dir_owned.as_ref(),
                        model_owned.as_deref(),
                        &retry_run_id,
                    )
                }).await;

                match stream_result {
                    Ok(Ok(outcome)) => match outcome {
                        StreamOutcome::Success(_final_session_id) => {
                            let after_conversations =
                                tauri::async_runtime::spawn_blocking(load_claude_history)
                                    .await
                                    .unwrap_or_default();
                            if let Some(conv) = after_conversations.iter().find(|c| c.id == cid) {
                                let payload = conversation_to_payload(conv);
                                let _ = app_clone.emit("messages-updated", &payload);
                            }
                            let _ = app_clone.emit("session-ended", Some(cid.clone()));
                        }
                        StreamOutcome::Cancelled(session_id) => {
                            let _ = app_clone.emit("session-ended", session_id.or(Some(cid.clone())));
                        }
                        StreamOutcome::Failed { session_id, error } => {
                            eprintln!(
                                "[retry_message] claude 执行失败 (session={:?}): {}",
                                session_id, error
                            );
                            let _ = app_clone.emit("session-ended", Some(cid.clone()));
                        }
                    },
                    Ok(Err(e)) => {
                        let err_msg = format!("重新生成失败: {}", e);
                        emit_session_error(&app_clone, Some(&cid), &err_msg);
                        let _ = app_clone.emit("session-ended", Some(cid.clone()));
                    }
                    Err(e) => {
                        let err_msg = format!("启动进程失败: {}", e);
                        emit_session_error(&app_clone, Some(&cid), &err_msg);
                        let _ = app_clone.emit("session-ended", Some(cid.clone()));
                    }
                }
            });
        }
    }

    Ok(())
}

/// 重连 / 刷新会话：
/// 1. 强制失效缓存并从磁盘重读该会话，推送 messages-updated 让前端同步最新内容；
/// 2. 校准运行态，并在必要时重启常驻进程，让下次发送 `--resume` 时重新读到会话启动配置
///    （全局/项目 CLAUDE.md、skills、模型等）——这决定了「重新编辑全局提示词后能否生效」。
///
/// **为什么刷新必须重启进程**：全局提示词（`~/.claude/CLAUDE.md`）只在 Claude Code 进程
/// 启动/恢复时被读取，一个仍存活的常驻进程不会重读它。所以重编全局提示词后，若不重启该
/// 常驻进程，下次同进程 followup 仍用旧上下文；只有让进程退出，下次 `execute_prompt` 才会
/// 走 `--resume` 重新 spawn 并读到新提示词。
///
/// **只重启空闲进程**：若正在执行一轮（`is_turn_active`），不打断，保留进程；此时重编的
/// 提示词要到本轮结束、进程回落为空闲后再刷新才生效。
///
/// **aborted 标记清空**：`session_stop_graceful` 优雅停机会在会话键上留下 aborted 标记，
/// 该标记本意是「用户取消 → 杀掉 next spawn」；刷新是要让它重连，因此停下后必须
/// `clear_session_aborted`，否则下次 spawn 会被 `should_kill_new_spawn` 误杀。
#[tauri::command]
pub async fn reload_session(
    app: AppHandle,
    conversation_id: String,
    source_path: Option<String>,
) -> Result<(), String> {
    let explicit_source = source_path.filter(|path| !path.trim().is_empty());
    let resolved_path = match explicit_source.as_deref() {
        Some(path) => validate_claude_source_path(std::path::Path::new(path)).ok(),
        None => find_claude_session_file(&conversation_id),
    };

    // 强制失效缓存：紧接着的 parse_claude_session 是无缓存重读，保证拿到磁盘最新内容
    if let Some(ref path) = resolved_path {
        invalidate_session_cache(path);
    }

    // 重读会话并推送 messages-updated（幂等语义同 retry_message）
    let mut emitted = false;
    if let Some(path) = resolved_path.as_ref() {
        if session_id_matches_path(&conversation_id, path) {
            if let Some(conv) = parse_claude_session(path) {
                let payload = conversation_to_payload(&conv);
                let _ = app.emit("messages-updated", &payload);
                emitted = true;
            }
        }
    }
    if !emitted {
        // 无会话文件或解析失败：退回到持久化状态重读，保证前端仍能同步
        if let Some(conv) = load_claude_history()
            .into_iter()
            .find(|c| c.id == conversation_id)
        {
            let payload = conversation_to_payload(&conv);
            let _ = app.emit("messages-updated", &payload);
        } else {
            let source_path_str = resolved_path.map(|p| p.to_string_lossy().to_string());
            let _ = app.emit(
                "messages-updated",
                SessionEventPayload {
                    conversation_id: conversation_id.clone(),
                    title: "Untitled".to_string(),
                    messages: Vec::new(),
                    project_dir: None,
                    source_path: source_path_str,
                    updated_at: chrono::Utc::now().timestamp(),
                    context_tokens: None,
                    last_model: None,
                    usage: None,
                },
            );
        }
    }

    // 校准运行态 + 按需重启常驻进程以重读会话启动配置（见函数注释）
    if is_process_registered(&conversation_id) {
        if is_turn_active(&conversation_id) {
            // 正在执行一轮：不打断，保留进程。重编的提示词本轮无法生效，等回落空闲再刷新。
        } else {
            // 空闲常驻进程：优雅停下 → 下次发送走 --resume 重新读全局提示词；
            // 停下后清掉 aborted 标记，以免 next spawn 被误判为用户取消而强杀。
            let _ = session_stop_graceful_async(conversation_id.clone(), "刷新重连").await;
            clear_session_aborted(&conversation_id);
            let _ = app.emit("session-ended", Some(conversation_id.clone()));
        }
    } else if pending_process_keys().is_empty() {
        // 无常驻进程，且当前没有正在初始化（pending-key）的会话 → 会话已断开：
        // 推送 session-ended 让前端清掉残留的运行态，下次发送将 --resume 重连。
        // 一并清掉可能残留的 aborted 标记，保证重连 spawn 不被误杀。
        clear_session_aborted(&conversation_id);
        let _ = app.emit("session-ended", Some(conversation_id));
    }

    Ok(())
}
