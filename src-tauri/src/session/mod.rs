use serde::Serialize;
use std::collections::{HashMap, HashSet, VecDeque};
use std::process::{Child, Command};
use std::sync::{
    atomic::{AtomicBool, AtomicU64, Ordering},
    mpsc,
    Arc, Mutex,
};
use std::thread;
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter};

use crate::claude::{conversation_to_payload, emit_session_error};
use crate::history::{
    find_claude_session_file, invalidate_session_cache, load_claude_conversation,
    message_is_task_tool_use,
    rewrite_session_model,
};

pub(crate) static ACTIVE_PROCESSES: Mutex<Option<HashMap<String, Arc<Mutex<Child>>>>> = Mutex::new(None);
/// 稳定 run ID → 当前进程注册键（pending 键捕获 session_id 后会重映射）。
static ACTIVE_RUN_KEYS: Mutex<Option<HashMap<String, String>>> = Mutex::new(None);

/// 会话 stdin：权限响应 / 后续控制消息写入用（stream-json 双向模式）
pub(crate) static ACTIVE_STDIN: Mutex<Option<HashMap<String, Arc<Mutex<std::process::ChildStdin>>>>> =
    Mutex::new(None);

/// 等待前端权限决策的通道（request_id → 会话绑定的 sender）
pub(crate) static PENDING_PERMISSIONS: Mutex<Option<HashMap<String, PendingPermission>>> =
    Mutex::new(None);

/// 前端「静默授权」：映射到 Claude Code 原生 bypassPermissions
pub(crate) static SILENT_PERMISSION_MODE: AtomicBool = AtomicBool::new(false);
pub(crate) static PERMISSION_MODE_REQUEST_SEQUENCE: AtomicU64 = AtomicU64::new(1);

#[derive(Debug, Clone)]
pub(crate) struct PermissionDecision {
    pub(crate) behavior: String, // "allow" | "deny"
    pub(crate) message: Option<String>,
    pub(crate) updated_input: Option<serde_json::Value>,
}

pub(crate) struct PendingPermission {
    pub(crate) conversation_id: String,
    pub(crate) tool_name: String,
    pub(crate) tx: mpsc::Sender<PermissionDecision>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct QueuedPrompt {
    pub(crate) id: String,
    pub(crate) prompt: String,
    pub(crate) message_content: String,
    pub(crate) model: Option<String>,
    pub(crate) queued_at: i64,
}

pub(crate) static PENDING_PROMPTS: Mutex<Option<HashMap<String, VecDeque<QueuedPrompt>>>> =
    Mutex::new(None);

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct PermissionRequestPayload {
    pub(crate) conversation_id: String,
    pub(crate) request_id: String,
    pub(crate) tool_name: String,
    pub(crate) input: serde_json::Value,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) description: Option<String>,
}

pub(crate) fn new_unique_id(prefix: &str) -> String {
    format!("{prefix}{}", uuid::Uuid::new_v4())
}

pub(crate) fn new_run_id() -> String {
    new_unique_id("run-")
}

pub(crate) fn pending_key_for_run(run_id: &str) -> String {
    format!("pending-{run_id}")
}

pub(crate) fn register_run_key(run_id: &str, key: &str) {
    let mut runs = ACTIVE_RUN_KEYS.lock().unwrap();
    runs.get_or_insert_with(HashMap::new)
        .insert(run_id.to_string(), key.to_string());
}

pub(crate) fn unregister_run_id(run_id: &str) {
    let mut runs = ACTIVE_RUN_KEYS.lock().unwrap();
    if let Some(map) = runs.as_mut() {
        map.remove(run_id);
    }
}

pub(crate) fn resolve_run_key(run_id: &str) -> Option<String> {
    let runs = ACTIVE_RUN_KEYS.lock().unwrap();
    runs.as_ref().and_then(|map| map.get(run_id).cloned())
}

fn rekey_run_key(old_key: &str, new_key: &str) {
    let mut runs = ACTIVE_RUN_KEYS.lock().unwrap();
    if let Some(map) = runs.as_mut() {
        for key in map.values_mut() {
            if key == old_key {
                *key = new_key.to_string();
            }
        }
    }
}

fn unregister_runs_for_key(key: &str) {
    let mut runs = ACTIVE_RUN_KEYS.lock().unwrap();
    if let Some(map) = runs.as_mut() {
        map.retain(|_, mapped_key| mapped_key != key);
    }
}

pub(crate) fn pending_process_keys() -> Vec<String> {
    let mut keys = HashSet::new();
    {
        let runs = ACTIVE_RUN_KEYS.lock().unwrap();
        if let Some(map) = runs.as_ref() {
            keys.extend(
                map.values()
                    .filter(|key| key.starts_with("pending-"))
                    .cloned(),
            );
        }
    }
    {
        let processes = ACTIVE_PROCESSES.lock().unwrap();
        if let Some(map) = processes.as_ref() {
            keys.extend(
                map.keys()
                    .filter(|key| key.starts_with("pending-"))
                    .cloned(),
            );
        }
    }
    keys.into_iter().collect()
}

pub(crate) fn configure_process_group(command: &mut Command) {
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        command.process_group(0);
    }
    #[cfg(not(unix))]
    let _ = command;
}

pub(crate) fn ensure_process_registry() {
    let mut reg = ACTIVE_PROCESSES.lock().unwrap();
    if reg.is_none() {
        *reg = Some(HashMap::new());
    }
}

pub(crate) fn ensure_stdin_registry() {
    let mut reg = ACTIVE_STDIN.lock().unwrap();
    if reg.is_none() {
        *reg = Some(HashMap::new());
    }
}

pub(crate) fn ensure_permission_registry() {
    let mut reg = PENDING_PERMISSIONS.lock().unwrap();
    if reg.is_none() {
        *reg = Some(HashMap::new());
    }
}

pub(crate) fn is_ask_user_question_tool(tool_name: &str) -> bool {
    tool_name.trim() == "AskUserQuestion"
}

pub(crate) fn set_silent_permission_mode(silent: bool) {
    SILENT_PERMISSION_MODE.store(silent, Ordering::Relaxed);
}

pub(crate) fn is_silent_permission_mode() -> bool {
    SILENT_PERMISSION_MODE.load(Ordering::Relaxed)
}

pub(crate) fn native_permission_mode() -> &'static str {
    if is_silent_permission_mode() {
        "bypassPermissions"
    } else {
        "manual"
    }
}

/// 将权限模式同步给已运行的 Claude Code 进程，无需等到下次重建会话。
pub(crate) fn sync_active_permission_mode() {
    let stdins = {
        let reg = ACTIVE_STDIN.lock().unwrap();
        reg.as_ref()
            .map(|map| map.values().cloned().collect::<Vec<_>>())
            .unwrap_or_default()
    };
    let mode = native_permission_mode();
    for stdin in stdins {
        let request_id = format!(
            "permission_mode_{}",
            PERMISSION_MODE_REQUEST_SEQUENCE.fetch_add(1, Ordering::Relaxed)
        );
        let request = serde_json::json!({
            "type": "control_request",
            "request_id": request_id,
            "request": {
                "subtype": "set_permission_mode",
                "mode": mode,
            }
        });
        if let Err(err) = write_stdin_json(&stdin, &request) {
            eprintln!("[permission] 同步原生权限模式失败: {err}");
        }
    }
}

/// 切换为静默授权时，立即放行已经弹出的普通工具请求。
pub(crate) fn allow_pending_non_question_permissions() {
    let pending = {
        let mut reg = PENDING_PERMISSIONS.lock().unwrap();
        let Some(map) = reg.as_mut() else {
            return;
        };
        let request_ids = map
            .iter()
            .filter(|(_, pending)| !is_ask_user_question_tool(&pending.tool_name))
            .map(|(request_id, _)| request_id.clone())
            .collect::<Vec<_>>();
        request_ids
            .into_iter()
            .filter_map(|request_id| map.remove(&request_id))
            .collect::<Vec<_>>()
    };
    for pending in pending {
        let _ = pending.tx.send(PermissionDecision {
            behavior: "allow".to_string(),
            message: None,
            updated_input: None,
        });
    }
}

pub(crate) fn register_active_process(key: &str, child: Arc<Mutex<Child>>) {
    ensure_process_registry();
    let mut reg = ACTIVE_PROCESSES.lock().unwrap();
    if let Some(map) = reg.as_mut() {
        map.insert(key.to_string(), child);
    }
}

pub(crate) fn register_active_stdin(key: &str, stdin: Arc<Mutex<std::process::ChildStdin>>) {
    ensure_stdin_registry();
    let mut reg = ACTIVE_STDIN.lock().unwrap();
    if let Some(map) = reg.as_mut() {
        map.insert(key.to_string(), stdin);
    }
}

pub(crate) fn unregister_active_process(key: &str) {
    clear_queued_prompts(key);
    unregister_runs_for_key(key);
    let mut reg = ACTIVE_PROCESSES.lock().unwrap();
    if let Some(map) = reg.as_mut() {
        map.remove(key);
    }
    let mut stdin_reg = ACTIVE_STDIN.lock().unwrap();
    if let Some(map) = stdin_reg.as_mut() {
        map.remove(key);
    }
    clear_active_session_model(key);
}

pub(crate) fn rekey_active_session(old_key: &str, new_key: &str, child: Arc<Mutex<Child>>) {
    if old_key == new_key {
        return;
    }
    let session_model = get_active_session_model(old_key);
    let stdin = {
        let mut reg = ACTIVE_STDIN.lock().unwrap();
        reg.as_mut().and_then(|map| map.remove(old_key))
    };
    {
        let mut reg = ACTIVE_PROCESSES.lock().unwrap();
        if let Some(map) = reg.as_mut() {
            map.remove(old_key);
        }
    }
    clear_active_session_model(old_key);
    rekey_run_key(old_key, new_key);

    register_active_process(new_key, child);
    if let Some(stdin) = stdin {
        register_active_stdin(new_key, stdin);
    }
    if let Some(model) = session_model {
        set_active_session_model(new_key, &model);
    }
}

/// 常驻会话启动时使用的模型（用于检测切换模型后需重启进程）
pub(crate) static ACTIVE_SESSION_MODELS: Mutex<Option<HashMap<String, String>>> = Mutex::new(None);
/// 因切换模型而主动结束的旧进程：退出时跳过 session-ended，避免打断新进程 UI
pub(crate) static MODEL_RESTART_SESSIONS: Mutex<Option<HashSet<String>>> = Mutex::new(None);
/// 请求 stream 循环优雅退出：interrupt 本轮后关闭 stdin，让 CLI 自行结束
pub(crate) static GRACEFUL_SHUTDOWN_SESSIONS: Mutex<Option<HashSet<String>>> = Mutex::new(None);

pub(crate) fn normalize_process_model(model: Option<&str>) -> String {
    model
        .map(|value| value.trim())
        .filter(|value| !value.is_empty() && *value != "default")
        .unwrap_or("")
        .to_string()
}

pub(crate) fn set_active_session_model(key: &str, model: &str) {
    let mut reg = ACTIVE_SESSION_MODELS.lock().unwrap();
    if reg.is_none() {
        *reg = Some(HashMap::new());
    }
    if let Some(map) = reg.as_mut() {
        map.insert(key.to_string(), model.to_string());
    }
}

pub(crate) fn get_active_session_model(key: &str) -> Option<String> {
    let reg = ACTIVE_SESSION_MODELS.lock().unwrap();
    reg.as_ref().and_then(|map| map.get(key).cloned())
}

pub(crate) fn clear_active_session_model(key: &str) {
    let mut reg = ACTIVE_SESSION_MODELS.lock().unwrap();
    if let Some(map) = reg.as_mut() {
        map.remove(key);
    }
}

pub(crate) fn mark_model_restart(key: &str) {
    let mut set = MODEL_RESTART_SESSIONS.lock().unwrap();
    if set.is_none() {
        *set = Some(HashSet::new());
    }
    if let Some(s) = set.as_mut() {
        s.insert(key.to_string());
    }
}

pub(crate) fn take_model_restart(key: &str) -> bool {
    let mut set = MODEL_RESTART_SESSIONS.lock().unwrap();
    set.as_mut().is_some_and(|s| s.remove(key))
}

pub(crate) fn is_model_restart(key: &str) -> bool {
    let set = MODEL_RESTART_SESSIONS.lock().unwrap();
    set.as_ref().is_some_and(|s| s.contains(key))
}

pub(crate) fn is_stream_model_restart(registry_key: &str, session_id: &Option<String>) -> bool {
    is_model_restart(registry_key)
        || session_id
            .as_ref()
            .is_some_and(|sid| is_model_restart(sid))
}

pub(crate) fn mark_graceful_shutdown(key: &str) {
    let mut set = GRACEFUL_SHUTDOWN_SESSIONS.lock().unwrap();
    if set.is_none() {
        *set = Some(HashSet::new());
    }
    if let Some(s) = set.as_mut() {
        s.insert(key.to_string());
    }
}

pub(crate) fn take_graceful_shutdown(key: &str) -> bool {
    let mut set = GRACEFUL_SHUTDOWN_SESSIONS.lock().unwrap();
    set.as_mut().is_some_and(|s| s.remove(key))
}

pub(crate) fn is_graceful_shutdown(registry_key: &str, session_id: &Option<String>) -> bool {
    let set = GRACEFUL_SHUTDOWN_SESSIONS.lock().unwrap();
    let Some(s) = set.as_ref() else {
        return false;
    };
    s.contains(registry_key) || session_id.as_ref().is_some_and(|sid| s.contains(sid))
}

pub(crate) fn clear_graceful_shutdown(registry_key: &str, session_id: &Option<String>) {
    let mut set = GRACEFUL_SHUTDOWN_SESSIONS.lock().unwrap();
    if let Some(s) = set.as_mut() {
        s.remove(registry_key);
        if let Some(sid) = session_id {
            s.remove(sid);
        }
    }
}

pub(crate) fn queued_prompts_snapshot(session_key: &str) -> Vec<QueuedPrompt> {
    let queues = PENDING_PROMPTS.lock().unwrap();
    queues
        .as_ref()
        .and_then(|map| map.get(session_key))
        .map(|queue| queue.iter().cloned().collect())
        .unwrap_or_default()
}

pub(crate) fn emit_queued_prompts(app: &AppHandle, session_key: &str) {
    let payload = serde_json::json!({
        "conversationId": session_key,
        "items": queued_prompts_snapshot(session_key),
    });
    let _ = app.emit("queued-prompts-updated", &payload);
}

fn restore_queued_prompt_front(session_key: &str, prompt: QueuedPrompt) -> usize {
    let mut queues = PENDING_PROMPTS.lock().unwrap();
    let map = queues.get_or_insert_with(HashMap::new);
    let queue = map.entry(session_key.to_string()).or_default();
    queue.push_front(prompt);
    queue.len()
}

fn dispatch_queued_prompt_with<F>(session_key: &str, send: F) -> Result<Option<QueuedPrompt>, String>
where
    F: FnOnce(&QueuedPrompt) -> Result<(), String>,
{
    let Some(queued) = take_queued_prompt(session_key) else {
        return Ok(None);
    };
    if let Err(error) = send(&queued) {
        restore_queued_prompt_front(session_key, queued);
        return Err(error);
    }
    Ok(Some(queued))
}

pub(crate) fn dispatch_next_queued_prompt(app: &AppHandle, session_key: &str) -> bool {
    let result = dispatch_queued_prompt_with(session_key, |queued| {
        try_send_followup_prompt_with_model(session_key, &queued.prompt, queued.model.as_deref())
    });
    match result {
        Ok(Some(queued)) => {
            emit_queued_prompts(app, session_key);
            let payload = serde_json::json!({
                "conversationId": session_key,
                "item": queued,
            });
            let _ = app.emit("queued-prompt-dispatched", &payload);
            true
        }
        Ok(None) => false,
        Err(error) => {
            emit_queued_prompts(app, session_key);
            emit_session_error(app, Some(session_key), &format!("排队追问发送失败：{error}"));
            eprintln!("[queue] dispatch failed for {session_key}, restored item to front");
            false
        }
    }
}
pub(crate) fn queued_prompt_count(session_key: &str) -> usize {
    let queues = PENDING_PROMPTS.lock().unwrap();
    queues
        .as_ref()
        .and_then(|map| map.get(session_key))
        .map(VecDeque::len)
        .unwrap_or(0)
}

pub(crate) fn enqueue_prompt(session_key: &str, prompt: QueuedPrompt) -> usize {
    let mut queues = PENDING_PROMPTS.lock().unwrap();
    let map = queues.get_or_insert_with(HashMap::new);
    let queue = map.entry(session_key.to_string()).or_default();
    queue.push_back(prompt);
    queue.len()
}

pub(crate) fn take_queued_prompt(session_key: &str) -> Option<QueuedPrompt> {
    let mut queues = PENDING_PROMPTS.lock().unwrap();
    let map = queues.as_mut()?;
    let queue = map.get_mut(session_key)?;
    let prompt = queue.pop_front();
    if queue.is_empty() {
        map.remove(session_key);
    }
    prompt
}

pub(crate) fn remove_queued_prompt(session_key: &str, prompt_id: &str) -> bool {
    let mut queues = PENDING_PROMPTS.lock().unwrap();
    let Some(map) = queues.as_mut() else {
        return false;
    };
    let Some(queue) = map.get_mut(session_key) else {
        return false;
    };
    let before = queue.len();
    queue.retain(|item| item.id != prompt_id);
    let removed = queue.len() != before;
    if queue.is_empty() {
        map.remove(session_key);
    }
    removed
}
pub(crate) fn clear_queued_prompts(session_key: &str) -> usize {
    let mut queues = PENDING_PROMPTS.lock().unwrap();
    queues
        .as_mut()
        .and_then(|map| map.remove(session_key))
        .map(|queue| queue.len())
        .unwrap_or(0)
}

pub(crate) fn write_stdin_json(
    stdin: &Arc<Mutex<std::process::ChildStdin>>,
    value: &serde_json::Value,
) -> Result<(), String> {
    use std::io::Write;
    let line = serde_json::to_string(value).map_err(|e| e.to_string())?;
    let mut guard = stdin
        .lock()
        .map_err(|_| "stdin 锁异常".to_string())?;
    guard
        .write_all(line.as_bytes())
        .and_then(|_| guard.write_all(b"\n"))
        .and_then(|_| guard.flush())
        .map_err(|e| format!("写入 Claude stdin 失败: {e}"))
}

pub(crate) fn reject_pending_permissions_for_session(session_key: &str, reason: &str) {
    let pending = {
        let mut reg = PENDING_PERMISSIONS.lock().unwrap();
        let Some(map) = reg.as_mut() else {
            return;
        };
        let keys: Vec<String> = map
            .iter()
            .filter(|(_, p)| p.conversation_id == session_key)
            .map(|(id, _)| id.clone())
            .collect();
        keys.into_iter()
            .filter_map(|id| map.remove(&id).map(|p| (id, p)))
            .collect::<Vec<_>>()
    };
    for (_id, pending) in pending {
        let _ = pending.tx.send(PermissionDecision {
            behavior: "deny".to_string(),
            message: Some(reason.to_string()),
            updated_input: None,
        });
    }
}

pub(crate) fn get_active_stdin(key: &str) -> Option<Arc<Mutex<std::process::ChildStdin>>> {
    let reg = ACTIVE_STDIN.lock().unwrap();
    reg.as_ref().and_then(|map| map.get(key).cloned())
}

pub(crate) fn is_process_registered(key: &str) -> bool {
    let reg = ACTIVE_PROCESSES.lock().unwrap();
    reg.as_ref().is_some_and(|map| map.contains_key(key))
}

pub(crate) fn try_send_interrupt(session_key: &str) -> bool {
    let Some(stdin) = get_active_stdin(session_key) else {
        return false;
    };
    let request_id = new_unique_id("interrupt_");
    let msg = serde_json::json!({
        "type": "control_request",
        "request_id": request_id,
        "request": {
            "subtype": "interrupt"
        }
    });
    match write_stdin_json(&stdin, &msg) {
        Ok(()) => {
            eprintln!("[abort] 已向会话 {} 发送 interrupt", session_key);
            true
        }
        Err(e) => {
            eprintln!("[abort] interrupt 写入失败 ({session_key}): {e}");
            false
        }
    }
}

/// 会话本轮是否正在输出（result 前为 true；常驻进程空闲时为 false）
pub(crate) static TURN_ACTIVE: Mutex<Option<HashSet<String>>> = Mutex::new(None);

pub(crate) fn mark_turn_active(key: &str) {
    let mut set = TURN_ACTIVE.lock().unwrap();
    if set.is_none() {
        *set = Some(HashSet::new());
    }
    if let Some(s) = set.as_mut() {
        s.insert(key.to_string());
    }
}

pub(crate) fn clear_turn_active(key: &str) {
    let mut set = TURN_ACTIVE.lock().unwrap();
    if let Some(s) = set.as_mut() {
        s.remove(key);
    }
}

pub(crate) fn is_turn_active(key: &str) -> bool {
    let set = TURN_ACTIVE.lock().unwrap();
    set.as_ref().is_some_and(|s| s.contains(key))
}

pub(crate) fn try_send_followup_prompt_with_model(
    session_id: &str,
    prompt: &str,
    model: Option<&str>,
) -> Result<(), String> {
    let stdin = get_active_stdin(session_id).ok_or_else(|| "会话进程未就绪".to_string())?;
    let user_msg = serde_json::json!({
        "type": "user",
        "message": { "role": "user", "content": prompt },
        "parent_tool_use_id": null,
        "session_id": session_id,
    });
    if let Some(model) = model.filter(|value| !value.trim().is_empty()) {
        if let Err(error) = rewrite_session_model(session_id, model) {
            eprintln!("[followup] 更新会话模型失败: {error}");
        }
    }
    write_stdin_json(&stdin, &user_msg)?;
    mark_turn_active(session_id);
    eprintln!(
        "[followup] 已向常驻会话 {} 写入追问 ({} bytes)",
        session_id,
        prompt.len()
    );
    Ok(())
}

pub(crate) fn try_send_followup_prompt(session_id: &str, prompt: &str) -> Result<(), String> {
    try_send_followup_prompt_with_model(session_id, prompt, None)
}

pub(crate) fn emit_turn_continued(app: &AppHandle, session_id: &str) {
    let _ = app.emit("turn-continued", Some(session_id.to_string()));
}

static TURN_COMPLETE_GENERATIONS: Mutex<Option<HashMap<String, u64>>> = Mutex::new(None);

fn next_turn_complete_generation(session_id: &str) -> u64 {
    let mut generations = TURN_COMPLETE_GENERATIONS.lock().unwrap();
    let map = generations.get_or_insert_with(HashMap::new);
    let generation = map.entry(session_id.to_string()).or_insert(0);
    *generation += 1;
    *generation
}

fn is_latest_turn_complete_generation(session_id: &str, generation: u64) -> bool {
    let generations = TURN_COMPLETE_GENERATIONS.lock().unwrap();
    generations
        .as_ref()
        .and_then(|map| map.get(session_id))
        .is_some_and(|current| *current == generation)
}

fn clear_turn_complete_generation_if_latest(session_id: &str, generation: u64) {
    let mut generations = TURN_COMPLETE_GENERATIONS.lock().unwrap();
    if let Some(map) = generations.as_mut() {
        if map.get(session_id).is_some_and(|current| *current == generation) {
            map.remove(session_id);
        }
    }
}

pub(crate) fn emit_turn_complete(app: &AppHandle, session_id: &str) {
    clear_turn_active(session_id);
    let generation = next_turn_complete_generation(session_id);
    let app = app.clone();
    let session_id = session_id.to_string();
    thread::spawn(move || finish_turn_complete(&app, &session_id, generation));
}

fn finish_turn_complete(app: &AppHandle, session_id: &str, generation: u64) {
    // Claude 落盘 JSONL 可能略晚于 result；且 SESSION_CACHE 按秒级 mtime，
    // 需主动失效缓存并短重试，避免前端清掉流式后又读到旧消息。
    let mut session_path = find_claude_session_file(session_id);

    let mut emitted_messages = false;
    for attempt in 0..10 {
        if attempt > 0 {
            thread::sleep(Duration::from_millis(80));
        }
        if session_path.is_none() {
            session_path = find_claude_session_file(session_id);
        }
        if let Some(path) = session_path.as_ref() {
            invalidate_session_cache(path);
        }
        if let Some(conv) = session_path.as_ref().and_then(load_claude_conversation) {
            let last_is_assistant = conv
                .messages
                .last()
                .map(|m| m.role == "assistant")
                .unwrap_or(false);
            // Task 结束后末条常为 tool_use / tool_result，不能只认 assistant
            let has_task_tool = conv.messages.iter().any(message_is_task_tool_use);
            let snapshot_ready = last_is_assistant || has_task_tool;
            if snapshot_ready || attempt == 9 {
                if !is_latest_turn_complete_generation(session_id, generation)
                    || is_turn_active(session_id)
                {
                    eprintln!(
                        "[claude] 忽略过期 turn-complete 刷新: {} generation={}",
                        session_id, generation
                    );
                    clear_turn_complete_generation_if_latest(session_id, generation);
                    return;
                }
                let payload = conversation_to_payload(&conv);
                let _ = app.emit("messages-updated", &payload);
                emitted_messages = true;
                if snapshot_ready {
                    eprintln!(
                        "[claude] turn-complete 消息已刷新 (attempt={}, msgs={}, task={})",
                        attempt + 1,
                        conv.messages.len(),
                        has_task_tool
                    );
                } else {
                    eprintln!(
                        "[claude] turn-complete 重试后仍无 assistant/Task 落盘 (attempt={})",
                        attempt + 1
                    );
                }
                break;
            }
        }
    }
    if !emitted_messages {
        eprintln!("[claude] turn-complete 未找到会话历史: {}", session_id);
    }
    if !is_latest_turn_complete_generation(session_id, generation) || is_turn_active(session_id) {
        eprintln!(
            "[claude] 忽略过期 turn-complete 事件: {} generation={}",
            session_id, generation
        );
        clear_turn_complete_generation_if_latest(session_id, generation);
        return;
    }
    let has_next = queued_prompt_count(session_id) > 0;
    if has_next && dispatch_next_queued_prompt(app, session_id) {
        clear_turn_complete_generation_if_latest(session_id, generation);
        emit_turn_continued(app, session_id);
        eprintln!("[queue] dispatched next prompt for {session_id}");
        return;
    }
    clear_turn_complete_generation_if_latest(session_id, generation);
    let _ = app.emit("turn-complete", Some(session_id.to_string()));
    eprintln!("[claude] turn-complete: {}", session_id);
}

/// 友好停止：先 interrupt 结束本轮；卡住或 force 时走统一优雅结束
/// `force_kill`：删除会话等场景需要结束常驻进程
pub(crate) fn soft_abort_session(session_key: &str, force_kill: bool) -> bool {
    reject_pending_permissions_for_session(session_key, "用户取消了会话");
    clear_queued_prompts(session_key);

    let had_process = is_process_registered(session_key);
    let had_stdin = get_active_stdin(session_key).is_some();
    if !had_process && !had_stdin {
        return false;
    }

    if force_kill {
        return session_stop_graceful(session_key, "强制结束会话");
    }

    mark_session_aborted(session_key);
    let interrupted = try_send_interrupt(session_key);
    if interrupted || is_turn_active(session_key) {
        // 等待本轮结束（result → turn-complete），进程常驻以便继续追问
        for _ in 0..30 {
            if !is_turn_active(session_key) {
                eprintln!("[abort] interrupt 后本轮已结束，保留常驻进程: {}", session_key);
                return true;
            }
            if !is_process_registered(session_key) {
                eprintln!("[abort] interrupt 后进程已退出: {}", session_key);
                return true;
            }
            thread::sleep(Duration::from_millis(100));
        }
        eprintln!("[abort] interrupt 后本轮仍未结束，改为优雅退出进程: {}", session_key);
    } else {
        eprintln!("[abort] 无法 interrupt，改为优雅退出进程: {}", session_key);
    }

    session_stop_graceful(session_key, "停止后降级结束进程")
}

// ── 会话进程生命周期：统一优雅关闭 / 重启 ──────────────────────────
/// 等待 stream 循环响应优雅退出的最长时间
pub(crate) const SESSION_GRACEFUL_WAIT: Duration = Duration::from_secs(8);
/// 关闭 stdin 后等待子进程自行退出的最长时间（超时才强杀）
pub(crate) const CHILD_EXIT_AFTER_STDIN_CLOSE: Duration = Duration::from_secs(5);

/// 优雅结束常驻进程：interrupt → 通知 stream 关 stdin → 等待退出。
/// 仅超时仍未退出时才降级强杀。所有「要结束会话进程」的外部入口应走这里。
pub(crate) fn session_stop_graceful(session_key: &str, reason: &str) -> bool {
    clear_queued_prompts(session_key);
    mark_session_aborted(session_key);
    reject_pending_permissions_for_session(session_key, "会话正在结束");
    mark_graceful_shutdown(session_key);

    let had_process = is_process_registered(session_key);
    let had_stdin = get_active_stdin(session_key).is_some();
    if !had_process && !had_stdin {
        clear_graceful_shutdown(session_key, &None);
        return false;
    }

    let _ = try_send_interrupt(session_key);
    eprintln!(
        "[session] 优雅退出: {} ({})",
        session_key, reason
    );

    let steps = (SESSION_GRACEFUL_WAIT.as_millis() / 100) as u32;
    for i in 0..steps {
        if !is_process_registered(session_key) {
            eprintln!(
                "[session] 优雅退出完成: {} (约 {}ms, {})",
                session_key,
                i * 100,
                reason
            );
            clear_turn_active(session_key);
            return true;
        }
        thread::sleep(Duration::from_millis(100));
    }

    eprintln!(
        "[session] 优雅退出超时，降级强杀: {} ({})",
        session_key, reason
    );
    clear_turn_active(session_key);
    let killed = force_kill_registered_process(session_key);
    unregister_active_process(session_key);
    clear_graceful_shutdown(session_key, &None);
    killed || had_process
}

/// 优雅结束当前进程以便重新 spawn（切模型会标记 model_restart，跳过 session-ended）
pub(crate) fn session_restart_graceful(session_key: &str, model_change: bool) -> bool {
    if model_change {
        mark_model_restart(session_key);
    }
    session_stop_graceful(
        session_key,
        if model_change {
            "模型切换重启"
        } else {
            "进程重拉"
        },
    )
}

pub(crate) async fn session_restart_graceful_async(session_key: String, model_change: bool) -> bool {
    tauri::async_runtime::spawn_blocking(move || session_restart_graceful(&session_key, model_change))
        .await
        .unwrap_or(false)
}

pub(crate) async fn session_stop_graceful_async(session_key: String, reason: &'static str) -> bool {
    tauri::async_runtime::spawn_blocking(move || session_stop_graceful(&session_key, reason))
        .await
        .unwrap_or(false)
}

/// 返回当前所有活跃会话的注册键（进程 + stdin 并集，去重）。
/// 供应用更新 / 退出前全量优雅关闭常驻 claude 进程使用。
pub(crate) fn active_session_keys() -> Vec<String> {
    let mut keys: HashSet<String> = HashSet::new();
    if let Ok(processes) = ACTIVE_PROCESSES.lock() {
        if let Some(map) = processes.as_ref() {
            keys.extend(map.keys().cloned());
        }
    }
    if let Ok(stdins) = ACTIVE_STDIN.lock() {
        if let Some(map) = stdins.as_ref() {
            keys.extend(map.keys().cloned());
        }
    }
    keys.into_iter().collect()
}

/// 关闭 stdin 后等待子进程退出；超时才强杀。stream 收尾唯一强杀入口。
pub(crate) fn wait_child_after_stdin_close(child: &mut Child) -> std::io::Result<std::process::ExitStatus> {
    let deadline = Instant::now() + CHILD_EXIT_AFTER_STDIN_CLOSE;
    loop {
        match child.try_wait()? {
            Some(status) => return Ok(status),
            None if Instant::now() < deadline => {
                thread::sleep(Duration::from_millis(50));
            }
            None => {
                eprintln!("[session] 关闭 stdin 后进程未退出，降级强杀");
                force_kill_process_tree(child);
                return child.wait();
            }
        }
    }
}

/// 底层强杀进程树（仅 last resort：优雅退出超时 / 工具子进程超时）
pub(crate) fn force_kill_process_tree(child: &mut Child) {
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        use std::process::Stdio;
        let pid = child.id();
        let _ = std::process::Command::new("taskkill")
            .args(["/T", "/F", "/PID", &pid.to_string()])
            .creation_flags(0x08000000) // CREATE_NO_WINDOW
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status();
        let _ = child.wait();
    }
    #[cfg(unix)]
    {
        signal_process_group(child.id(), "TERM");
        let mut leader_reaped = false;
        for _ in 0..20 {
            if !leader_reaped {
                leader_reaped = child.try_wait().ok().flatten().is_some();
            }
            thread::sleep(Duration::from_millis(100));
        }
        // 组长可能先退出而后代仍存活；宽限期后始终清理整个组。
        signal_process_group(child.id(), "KILL");
        if !leader_reaped {
            let _ = child.wait();
        }
    }
    #[cfg(not(any(unix, target_os = "windows")))]
    {
        let _ = child.kill();
        let _ = child.wait();
    }
}

#[cfg(unix)]
fn signal_process_group(pid: u32, signal: &str) {
    let group = format!("-{pid}");
    let _ = Command::new("kill")
        .args([format!("-{signal}"), "--".to_string(), group])
        .status();
}

#[cfg(test)]
mod tests {
    use super::*;

    fn prompt(text: &str) -> QueuedPrompt {
        QueuedPrompt {
            id: format!("id-{text}"),
            prompt: text.to_string(),
            message_content: text.to_string(),
            model: None,
            queued_at: 0,
        }
    }

    #[test]
    fn queued_prompts_are_fifo_and_clearable() {
        let key = new_unique_id("queue-test-");
        clear_queued_prompts(&key);
        assert_eq!(enqueue_prompt(&key, prompt("first")), 1);
        assert_eq!(enqueue_prompt(&key, prompt("second")), 2);
        assert_eq!(take_queued_prompt(&key).unwrap().prompt, "first");
        assert_eq!(queued_prompt_count(&key), 1);
        assert!(remove_queued_prompt(&key, "id-second"));
        assert_eq!(queued_prompt_count(&key), 0);
        assert_eq!(clear_queued_prompts(&key), 0);
    }

    #[test]
    fn generated_ids_are_unique() {
        let ids = (0..1_000)
            .map(|_| new_unique_id("test-"))
            .collect::<HashSet<_>>();
        assert_eq!(ids.len(), 1_000);
    }

    #[test]
    fn failed_dispatch_restores_item_to_front_and_preserves_tail() {
        let key = new_unique_id("queue-restore-");
        enqueue_prompt(&key, prompt("first"));
        enqueue_prompt(&key, prompt("second"));
        enqueue_prompt(&key, prompt("third"));

        let result = dispatch_queued_prompt_with(&key, |_| Err("closed".to_string()));
        assert!(matches!(result, Err(error) if error == "closed"));
        let prompts = queued_prompts_snapshot(&key)
            .into_iter()
            .map(|item| item.prompt)
            .collect::<Vec<_>>();
        assert_eq!(prompts, ["first", "second", "third"]);
        clear_queued_prompts(&key);
    }

    #[cfg(unix)]
    #[test]
    fn configured_child_uses_own_process_group() {
        let mut command = Command::new("sh");
        command.args(["-c", "sleep 30"]);
        configure_process_group(&mut command);
        let mut child = command.spawn().expect("spawn process-group test child");
        let output = Command::new("ps")
            .args(["-o", "pgid=", "-p", &child.id().to_string()])
            .output()
            .expect("query child process group");
        let pgid = String::from_utf8_lossy(&output.stdout)
            .trim()
            .parse::<u32>()
            .expect("parse pgid");
        assert_eq!(pgid, child.id());
        force_kill_process_tree(&mut child);
        assert!(child.try_wait().expect("wait child").is_some());
    }
}
pub(crate) fn force_kill_registered_process(key: &str) -> bool {
    let reg = ACTIVE_PROCESSES.lock().unwrap();
    if let Some(map) = reg.as_ref() {
        if let Some(child_arc) = map.get(key) {
            let child_arc = Arc::clone(child_arc);
            drop(reg);
            if let Ok(mut child) = child_arc.lock() {
                force_kill_process_tree(&mut child);
            }
            return true;
        }
    }
    false
}

// ── 用户主动终止标记：区分 abort 和异常退出 ──────────────────────────
pub(crate) static ABORTED_SESSIONS: Mutex<Option<HashSet<String>>> = Mutex::new(None);

pub(crate) fn mark_session_aborted(key: &str) {
    let mut set = ABORTED_SESSIONS.lock().unwrap();
    if set.is_none() {
        *set = Some(HashSet::new());
    }
    if let Some(s) = set.as_mut() {
        s.insert(key.to_string());
    }
}

pub(crate) fn is_session_aborted(key: &str) -> bool {
    let set = ABORTED_SESSIONS.lock().unwrap();
    set.as_ref().is_some_and(|s| s.contains(key))
}

pub(crate) fn clear_session_aborted(key: &str) {
    let mut set = ABORTED_SESSIONS.lock().unwrap();
    if let Some(s) = set.as_mut() {
        s.remove(key);
    }
}

/// 检查流任务是否已被用户终止（registry_key 或 session_id 任一被标记即为是）
pub(crate) fn is_stream_aborted(registry_key: &str, session_id: &Option<String>) -> bool {
    is_session_aborted(registry_key)
        || session_id.as_ref().is_some_and(|sid| is_session_aborted(sid))
}

/// 清理流任务的终止标记
pub(crate) fn clear_stream_aborted(registry_key: &str, session_id: &Option<String>) {
    clear_session_aborted(registry_key);
    if let Some(sid) = session_id {
        clear_session_aborted(sid);
    }
}
