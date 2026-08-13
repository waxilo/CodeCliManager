use std::collections::{HashMap, HashSet};
use std::io::{BufRead, BufReader};
use std::process::{Command, Stdio};
use std::sync::{mpsc::{self, RecvTimeoutError}, Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter};

use crate::claude::runtime::{apply_cli_runtime_env, resolve_claude_executable};
use crate::claude::stream_events::*;
use crate::config::{apply_model_override_env, has_custom_api_base};
use crate::fs::resolve_or_create_dir;
use crate::history::INTERNAL_RECOVERY_PROMPT;
use crate::session::*;

fn should_auto_recover(was_aborted: bool, recovery_needed: bool, recovery_attempts: u8) -> bool {
    !was_aborted && recovery_needed && recovery_attempts < 1
}

/// 使用 stream-json 模式启动 claude，实时推送 thinking / answer 增量
pub(crate) fn spawn_claude_stream(
    app: AppHandle,
    prompt: &str,
    conversation_id: Option<&String>,
    project_dir: Option<&String>,
    model: Option<&str>,
    run_id: &str,
) -> std::io::Result<StreamOutcome> {
    // 本轮无输出超时；空闲常驻会话超时后优雅退出（下次发消息会 --resume 重建）
    let turn_idle_timeout = Duration::from_secs(600); // 10 分钟
    let session_idle_timeout = Duration::from_secs(3600); // 60 分钟
    const PERMISSION_TIMEOUT: Duration = Duration::from_secs(600); // 权限确认等待

    #[cfg(target_os = "windows")]
    use std::os::windows::process::CommandExt;

    let mut args = vec![
        "-p".to_string(),
        "--verbose".to_string(),
        "--output-format".to_string(),
        "stream-json".to_string(),
        "--input-format".to_string(),
        "stream-json".to_string(),
        "--include-partial-messages".to_string(),
        // 保留 stdio 权限回调供 manual 模式及 AskUserQuestion 交互使用。
        // 静默授权直接使用原生 bypassPermissions，普通工具不会发起权限确认。
        "--permission-prompt-tool".to_string(),
        "stdio".to_string(),
        "--permission-mode".to_string(),
        native_permission_mode().to_string(),
    ];

    if let Some(cid) = conversation_id.filter(|c| !c.is_empty()) {
        args.push("--resume".to_string());
        args.push(cid.clone());
    }
    // "default" 视为订阅默认（不显式指定模型）；其余通过原生 --model 传递
    let effective_model = model
        .map(|value| value.trim())
        .filter(|value| !value.is_empty() && *value != "default");
    if let Some(model) = effective_model {
        args.push("--model".to_string());
        args.push(model.to_string());
    }

    let effective_cwd = project_dir.and_then(|cwd| resolve_or_create_dir(cwd));

    let claude_bin = resolve_claude_executable();
    let mut cmd = Command::new(&claude_bin);
    configure_process_group(&mut cmd);
    cmd.args(&args);
    apply_cli_runtime_env(&mut cmd);
    // env 覆盖仅用于第三方中转（强制各档模型一致）；官方订阅靠 --model，避免污染后台任务模型
    if let Some(model) = effective_model {
        if has_custom_api_base() {
            apply_model_override_env(&mut cmd, model);
        }
    }
    #[cfg(target_os = "windows")]
    {
        cmd.creation_flags(0x08000000);
    }
    if let Some(ref cwd) = effective_cwd {
        cmd.current_dir(cwd);
    }
    cmd.stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());

    eprintln!(
        "[spawn_stream] {:?} {} (prompt via stream-json stdin, {} bytes)",
        claude_bin,
        args.join(" "),
        prompt.len()
    );
    eprintln!("[spawn_stream] cwd: {:?}", effective_cwd);

    let mut child = cmd.spawn()?;

    let stdin_raw = child
        .stdin
        .take()
        .ok_or_else(|| std::io::Error::new(std::io::ErrorKind::Other, "无法打开 Claude stdin"))?;
    let stdin = Arc::new(Mutex::new(stdin_raw));

    // 初始化控制握手（注册 SDK 控制通道）；用户消息等 initialize 成功后再发
    let init_id = new_unique_id("init_");
    let init_msg = serde_json::json!({
        "type": "control_request",
        "request_id": init_id,
        "request": { "subtype": "initialize", "hooks": {} }
    });
    if let Err(e) = write_stdin_json(&stdin, &init_msg) {
        eprintln!("[spawn_stream] initialize 写入失败: {e}");
    }
    let user_msg = serde_json::json!({
        "type": "user",
        "message": { "role": "user", "content": prompt },
        "parent_tool_use_id": null,
        "session_id": conversation_id.cloned().unwrap_or_default(),
    });
    let mut user_prompt_sent = false;

    let stdout = child.stdout.take().expect("stdout should be piped");
    let stderr = child.stderr.take();

    // 将子进程注册到全局注册表，支持外部 abort
    let child_arc = Arc::new(Mutex::new(child));
    let registry_key = conversation_id
        .filter(|c| !c.is_empty())
        .cloned()
        .unwrap_or_else(|| pending_key_for_run(run_id));
    register_run_key(run_id, &registry_key);
    register_active_process(&registry_key, Arc::clone(&child_arc));
    register_active_stdin(&registry_key, Arc::clone(&stdin));
    set_active_session_model(
        &registry_key,
        &normalize_process_model(model),
    );
    // execute_prompt 返回 runId 后可能立刻收到取消；进程注册完成时兑现该取消。
    if is_session_aborted(&registry_key) {
        if let Ok(mut child) = child_arc.lock() {
            force_kill_process_tree(&mut child);
        }
        unregister_active_process(&registry_key);
        clear_session_aborted(&registry_key);
        drop(stdin);
        return Ok(StreamOutcome::Cancelled(conversation_id.cloned()));
    }

    let mut captured_session_id = conversation_id.filter(|c| !c.is_empty()).cloned();
    let mut captured_registry_key = registry_key.clone();
    let mut block_types: HashMap<usize, String> = HashMap::new();
    let mut tool_use_blocks: HashMap<usize, ToolUseBlockState> = HashMap::new();
    let mut known_task_ids: HashSet<String> = HashSet::new();
    let mut protocol_guard = ProtocolLeakGuard::default();
    let mut recovery_attempts = 0u8;
    let mut stream_error: Option<String> = None;

    let stderr_buffer = Arc::new(Mutex::new(String::new()));
    if let Some(stderr) = stderr {
        let stderr_buffer = Arc::clone(&stderr_buffer);
        thread::spawn(move || {
            let content = BufReader::new(stderr)
                .lines()
                .filter_map(|line| line.ok())
                .collect::<Vec<_>>()
                .join("\n");
            if let Ok(mut guard) = stderr_buffer.lock() {
                *guard = content;
            }
        });
    }

    let (line_tx, line_rx) = mpsc::channel();
    thread::spawn(move || {
        for line in BufReader::new(stdout).lines() {
            match line {
                Ok(value) => {
                    if line_tx.send(Ok(value)).is_err() {
                        break;
                    }
                }
                Err(err) => {
                    let _ = line_tx.send(Err(err));
                    break;
                }
            }
        }
    });

    let started = Instant::now();
    let mut last_activity = Instant::now();
    let mut stdout_finished = false;
    let mut turn_active = false;
    let mut turns_completed: u32 = 0;
    let mut graceful_since: Option<Instant> = None;

    while !stdout_finished {
        match line_rx.recv_timeout(Duration::from_secs(1)) {
            Ok(Ok(line)) => {
                last_activity = Instant::now();
                if line.trim().is_empty() {
                    continue;
                }

                // initialize 完成后发送用户消息
                if !user_prompt_sent {
                    if let Ok(value) = serde_json::from_str::<serde_json::Value>(&line) {
                        let is_init_ok = value.get("type").and_then(|t| t.as_str())
                            == Some("control_response")
                            && value
                                .pointer("/response/request_id")
                                .and_then(|v| v.as_str())
                            == Some(init_id.as_str());
                        let is_system_init = value.get("type").and_then(|t| t.as_str())
                            == Some("system")
                            && value.get("subtype").and_then(|s| s.as_str()) == Some("init");
                        if is_init_ok || is_system_init {
                            if let Err(e) = write_stdin_json(&stdin, &user_msg) {
                                // 不 kill：走出循环后由统一收尾关闭 stdin
                                stream_error = Some(e);
                                stdout_finished = true;
                                continue;
                            }
                            user_prompt_sent = true;
                            turn_active = true;
                            mark_turn_active(&captured_registry_key);
                            // system/init 仍交给后续解析；control_response 可跳过
                            if is_init_ok {
                                continue;
                            }
                        }
                    }
                }

                // manual 模式首次允许后，将会话级规则回写给 Claude Code；
                // 后续同类型工具由 Claude Code 自己放行，CCM 不维护授权状态。
                if let Some(perm) = try_parse_permission_request(&line) {
                    let sid = captured_session_id
                        .clone()
                        .unwrap_or_else(|| captured_registry_key.clone());
                    let request_id = perm.request_id.clone();
                    let tool_input = perm.input.clone();
                    let tool_name = perm.tool_name.clone();

                    let auto_decision = if !is_ask_user_question_tool(&tool_name)
                        && is_silent_permission_mode()
                    {
                        Some(PermissionDecision {
                            behavior: "allow".to_string(),
                            message: None,
                            updated_input: Some(tool_input.clone()),
                        })
                    } else {
                        None
                    };

                    let decision = if let Some(d) = auto_decision {
                        eprintln!(
                            "[permission] 静默模式兼容放行: {} ({})",
                            tool_name, request_id
                        );
                        d
                    } else {
                        let (tx, rx) = mpsc::channel::<PermissionDecision>();
                        ensure_permission_registry();
                        if let Ok(mut reg) = PENDING_PERMISSIONS.lock() {
                            if let Some(map) = reg.as_mut() {
                                map.insert(
                                    request_id.clone(),
                                    PendingPermission {
                                        conversation_id: sid.clone(),
                                        tool_name: tool_name.clone(),
                                        tx,
                                    },
                                );
                            }
                        }

                        let payload = PermissionRequestPayload {
                            conversation_id: sid.clone(),
                            request_id: request_id.clone(),
                            tool_name: tool_name.clone(),
                            input: tool_input.clone(),
                            description: perm.description,
                        };
                        let _ = app.emit("permission-request", &payload);
                        eprintln!(
                            "[permission] 等待确认: {} ({})",
                            payload.tool_name, request_id
                        );

                        match rx.recv_timeout(PERMISSION_TIMEOUT) {
                            Ok(d) => d,
                            Err(_) => {
                                if let Ok(mut reg) = PENDING_PERMISSIONS.lock() {
                                    if let Some(map) = reg.as_mut() {
                                        map.remove(&request_id);
                                    }
                                }
                                PermissionDecision {
                                    behavior: "deny".to_string(),
                                    message: Some("权限确认超时".to_string()),
                                    updated_input: None,
                                }
                            }
                        }
                    };

                    let mut response_body = if decision.behavior == "allow" {
                        serde_json::json!({
                            "behavior": "allow",
                            "updatedInput": decision.updated_input.unwrap_or(tool_input),
                        })
                    } else {
                        serde_json::json!({
                            "behavior": "deny",
                            "message": decision.message.unwrap_or_else(|| "用户拒绝".to_string()),
                        })
                    };
                    if decision.behavior == "allow"
                        && !is_silent_permission_mode()
                        && !is_ask_user_question_tool(&tool_name)
                    {
                        response_body["updatedPermissions"] = serde_json::json!([{
                            "type": "addRules",
                            "rules": [{
                                "toolName": tool_name,
                            }],
                            "behavior": "allow",
                            "destination": "session",
                        }]);
                    }
                    let response = serde_json::json!({
                        "type": "control_response",
                        "response": {
                            "subtype": "success",
                            "request_id": request_id,
                            "response": response_body,
                        }
                    });
                    if let Err(e) = write_stdin_json(&stdin, &response) {
                        eprintln!("[permission] 写入响应失败: {e}");
                        stream_error = Some(e);
                        stdout_finished = true;
                        continue;
                    }
                    last_activity = Instant::now();
                    continue;
                }

                process_claude_stream_line(
                    &line,
                    &app,
                    &mut captured_session_id,
                    &mut block_types,
                    &mut tool_use_blocks,
                    &mut known_task_ids,
                    &mut protocol_guard,
                    &mut stream_error,
                );
                // 首次捕获到 session_id 时，用 session_id 重新注册进程（方便按 session_id abort）
                if let Some(ref sid) = captured_session_id {
                    if *sid != captured_registry_key {
                        let old_key = captured_registry_key.clone();
                        rekey_active_session(
                            &captured_registry_key,
                            sid,
                            Arc::clone(&child_arc),
                        );
                        if turn_active {
                            clear_turn_active(&old_key);
                            mark_turn_active(sid);
                        }
                        captured_registry_key = sid.clone();
                    }
                }
                if stream_error.is_some() {
                    reject_pending_permissions_for_session(
                        &captured_registry_key,
                        "会话出错，权限请求已取消",
                    );
                    if let Some(ref sid) = captured_session_id {
                        if sid != &captured_registry_key {
                            reject_pending_permissions_for_session(
                                sid,
                                "会话出错，权限请求已取消",
                            );
                        }
                    }
                    if let Ok(mut c) = child_arc.lock() {
                        // stream 已出错：不 kill，交由收尾关 stdin
                        let _ = c.try_wait();
                    }
                    stdout_finished = true;
                    continue;
                }
                // 本轮 result：通知前端解除忙碌，但保持进程与 stdin，等待追问
                if is_stream_turn_complete(&line) {
                    turns_completed += 1;
                    turn_active = false;
                    block_types.clear();
                    tool_use_blocks.clear();
                    known_task_ids.clear();

                    // 切模型 / 优雅退出过程中的 result 是过期事件：
                    // 若再发 turn-complete / messages-updated，前端会冲掉刚插入的新提问。
                    let shutting_down = is_graceful_shutdown(
                        &captured_registry_key,
                        &captured_session_id,
                    ) || is_stream_model_restart(&captured_registry_key, &captured_session_id);
                    if shutting_down {
                        eprintln!(
                            "[claude] 本轮结束（退出中），抑制 turn-complete（累计 {} 轮）",
                            turns_completed
                        );
                        clear_turn_active(&captured_registry_key);
                        if let Some(ref sid) = captured_session_id {
                            clear_turn_active(sid);
                        }
                        if is_graceful_shutdown(&captured_registry_key, &captured_session_id) {
                            stdout_finished = true;
                        }
                        continue;
                    }

                    let was_aborted =
                        is_stream_aborted(&captured_registry_key, &captured_session_id);
                    if was_aborted {
                        clear_stream_aborted(&captured_registry_key, &captured_session_id);
                        eprintln!("[claude] 本轮被用户 interrupt，跳过自动恢复");
                    }
                    let recovery_needed = protocol_guard.recovery_needed();
                    if should_auto_recover(was_aborted, recovery_needed, recovery_attempts) {
                        if let Some(ref sid) = captured_session_id {
                            match try_send_followup_prompt(sid, INTERNAL_RECOVERY_PROMPT) {
                                Ok(()) => {
                                    let _ = protocol_guard.take_recovery_needed();
                                    recovery_attempts += 1;
                                    turn_active = true;
                                    // 不发 complete：前端保持 streaming，等待续跑增量
                                    emit_turn_continued(&app, sid);
                                    eprintln!(
                                        "[claude] 检测到可恢复中断，已自动续跑一次: {}",
                                        sid
                                    );
                                    last_activity = Instant::now();
                                    continue;
                                }
                                Err(error) => {
                                    let _ = protocol_guard.take_recovery_needed();
                                    eprintln!("[claude] 自动恢复失败: {error}");
                                    emit_session_error(
                                        &app,
                                        Some(sid),
                                        &format!("自动续写失败：{error}"),
                                    );
                                }
                            }
                        } else {
                            let _ = protocol_guard.take_recovery_needed();
                        }
                    } else {
                        let _ = protocol_guard.take_recovery_needed();
                    }
                    recovery_attempts = 0;
                    if let Some(ref sid) = captured_session_id {
                        emit_message_chunk(&app, sid, "complete", "");
                        emit_turn_complete(&app, sid);
                    } else {
                        clear_turn_active(&captured_registry_key);
                        let _ = app.emit("turn-complete", Some(captured_registry_key.clone()));
                    }
                    last_activity = Instant::now();
                    eprintln!(
                        "[claude] 收到 result，本轮结束（累计 {} 轮），进程常驻等待追问",
                        turns_completed
                    );
                    continue;
                }

                // 空闲态收到新输出 → 说明追问已开始新一轮
                if !turn_active && user_prompt_sent {
                    turn_active = true;
                    mark_turn_active(
                        captured_session_id
                            .as_deref()
                            .unwrap_or(captured_registry_key.as_str()),
                    );
                }
            }
            Ok(Err(_err)) => {
                // stdout 管道断裂（可能是进程被 abort kill），检查是否为用户终止
                if is_stream_aborted(&captured_registry_key, &captured_session_id) {
                    eprintln!("[claude] stdout 管道断裂（用户 abort），正常退出");
                    stdout_finished = true;
                    continue;
                }
                // 非 abort 情况，让后续 child.wait() 处理
                stdout_finished = true;
                continue;
            }
            Err(RecvTimeoutError::Timeout) => {
                // initialize 迟迟无回时，兜底发送用户消息，避免整轮卡死
                if !user_prompt_sent && started.elapsed() >= Duration::from_secs(3) {
                    if let Err(e) = write_stdin_json(&stdin, &user_msg) {
                        stream_error = Some(e);
                        stdout_finished = true;
                        continue;
                    }
                    user_prompt_sent = true;
                    turn_active = true;
                    mark_turn_active(&captured_registry_key);
                    last_activity = Instant::now();
                }

                let child_exited = child_arc
                    .lock()
                    .ok()
                    .and_then(|mut c| c.try_wait().ok().flatten())
                    .is_some();
                if child_exited {
                    stdout_finished = true;
                    continue;
                }

                // 外部请求优雅退出：关 stdin 让 CLI 自行结束（不 SIGTERM）
                if is_graceful_shutdown(&captured_registry_key, &captured_session_id) {
                    let since = *graceful_since.get_or_insert_with(Instant::now);
                    if turn_active && since.elapsed() < Duration::from_secs(3) {
                        let key = captured_session_id
                            .as_deref()
                            .unwrap_or(captured_registry_key.as_str());
                        let _ = try_send_interrupt(key);
                        eprintln!(
                            "[claude] 优雅退出：本轮仍在进行，已补发 interrupt，等待 result（已 {}ms）",
                            since.elapsed().as_millis()
                        );
                        continue;
                    }
                    eprintln!("[claude] 优雅退出：关闭 stdin 结束常驻进程");
                    stdout_finished = true;
                    continue;
                }

                let idle = last_activity.elapsed();
                let timed_out = if turn_active {
                    idle >= turn_idle_timeout
                } else if user_prompt_sent {
                    // 常驻空闲过久：优雅退出，前端下次发消息会 --resume
                    idle >= session_idle_timeout
                } else {
                    idle >= turn_idle_timeout
                };

                if timed_out {
                    reject_pending_permissions_for_session(
                        &captured_registry_key,
                        "请求超时，权限请求已取消",
                    );
                    if let Some(ref sid) = captured_session_id {
                        if sid != &captured_registry_key {
                            reject_pending_permissions_for_session(
                                sid,
                                "请求超时，权限请求已取消",
                            );
                        }
                    }

                    if turn_active {
                        let timeout_msg = format!(
                            "请求超时：{} 秒内未收到任何响应，请检查 API 地址、密钥和网络连接",
                            turn_idle_timeout.as_secs()
                        );
                        emit_session_error(
                            &app,
                            captured_session_id.as_deref(),
                            &timeout_msg,
                        );
                        // 不 kill：关 stdin 优雅退出，错误已推送前端
                        stream_error = Some(timeout_msg);
                        stdout_finished = true;
                        continue;
                    }

                    eprintln!(
                        "[claude] 常驻会话空闲 {} 秒，优雅退出",
                        session_idle_timeout.as_secs()
                    );
                    stdout_finished = true;
                    continue;
                }
            }
            Err(RecvTimeoutError::Disconnected) => {
                stdout_finished = true;
            }
        }
    }

    while let Ok(Ok(line)) = line_rx.try_recv() {
        if line.trim().is_empty() {
            continue;
        }
        process_claude_stream_line(
            &line,
            &app,
            &mut captured_session_id,
            &mut block_types,
            &mut tool_use_blocks,
            &mut known_task_ids,
            &mut protocol_guard,
            &mut stream_error,
        );
    }

    reject_pending_permissions_for_session(&captured_registry_key, "会话已结束");
    if let Some(ref sid) = captured_session_id {
        if sid != &captured_registry_key {
            reject_pending_permissions_for_session(sid, "会话已结束");
        }
        clear_turn_active(sid);
    }
    clear_turn_active(&captured_registry_key);
    // 先从注册表移除并 drop stdin，关闭写入端让 CLI 优雅退出
    unregister_active_process(&captured_registry_key);
    drop(stdin);

    let stderr_content = stderr_buffer
        .lock()
        .map(|guard| guard.clone())
        .unwrap_or_default();
    if !stderr_content.trim().is_empty() {
        eprintln!("[claude stderr]\n{}", stderr_content);
    }

    let status = match child_arc.lock() {
        Ok(mut c) => wait_child_after_stdin_close(&mut c)?,
        Err(poisoned) => {
            eprintln!("[claude] mutex poisoned, recovering...");
            let mut c = poisoned.into_inner();
            wait_child_after_stdin_close(&mut c)?
        }
    };
    eprintln!("[claude] 退出码: {}", status);

    if let Some(error) = stream_error {
        // 用户主动终止时，stream 解析错误不视为失败
        if is_stream_aborted(&captured_registry_key, &captured_session_id) {
            clear_stream_aborted(&captured_registry_key, &captured_session_id);
            eprintln!("[claude] 用户主动终止，忽略 stream error: {}", error);
            return Ok(StreamOutcome::Cancelled(captured_session_id));
        }
        return Ok(StreamOutcome::Failed {
            session_id: captured_session_id,
            error,
        });
    }

    if !status.success() {
        // 用户主动终止 / 切模型重启 / 优雅关 stdin：非成功退出码不视为失败
        let was_aborted = is_stream_aborted(&captured_registry_key, &captured_session_id);
        clear_stream_aborted(&captured_registry_key, &captured_session_id);
        let was_model_restart = is_stream_model_restart(&captured_registry_key, &captured_session_id);
        let was_graceful = take_graceful_shutdown(&captured_registry_key)
            || captured_session_id
                .as_ref()
                .is_some_and(|sid| take_graceful_shutdown(sid));
        clear_graceful_shutdown(&captured_registry_key, &captured_session_id);

        if was_aborted || was_model_restart || was_graceful {
            eprintln!(
                "[claude] 预期内退出（abort={}, model_restart={}, graceful={}, code={}），不视为错误",
                was_aborted, was_model_restart, was_graceful, status
            );
            // 注意：不要在这里 take_model_restart，留给外层 execute_prompt 跳过 session-ended
            return Ok(if was_aborted {
                StreamOutcome::Cancelled(captured_session_id)
            } else {
                StreamOutcome::Success(captured_session_id)
            });
        }

        let error_msg = if !stderr_content.trim().is_empty() {
            stderr_content.trim().to_string()
        } else {
            format!("Claude 通用异常退出（收到 exit code: {}）", status)
        };
        emit_session_error(
            &app,
            captured_session_id.as_deref(),
            &error_msg,
        );
        return Ok(StreamOutcome::Failed {
            session_id: captured_session_id,
            error: error_msg,
        });
    }

    clear_stream_aborted(&captured_registry_key, &captured_session_id);
    clear_graceful_shutdown(&captured_registry_key, &captured_session_id);
    Ok(StreamOutcome::Success(captured_session_id))
}

#[cfg(test)]
mod tests {
    use super::should_auto_recover;

    #[test]
    fn user_abort_always_prevents_auto_recovery() {
        assert!(!should_auto_recover(true, true, 0));
    }

    #[test]
    fn recovery_runs_only_once_when_needed() {
        assert!(should_auto_recover(false, true, 0));
        assert!(!should_auto_recover(false, true, 1));
        assert!(!should_auto_recover(false, false, 0));
    }
}
