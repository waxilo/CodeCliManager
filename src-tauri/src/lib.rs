use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::fs;
use std::io::Write;
use std::path::PathBuf;
use std::process::{Command, Stdio};
use tauri::{AppHandle, Emitter};

#[derive(Debug, Serialize, Deserialize, Clone)]
struct Message {
    id: String,
    role: String,
    content: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    thinking: Option<String>,
    timestamp: i64,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
struct Conversation {
    id: String,
    title: String,
    messages: Vec<Message>,
    platform: String,
    #[serde(default)]
    project_dir: Option<String>,
    created_at: i64,
    updated_at: i64,
}

#[derive(Debug, Serialize, Deserialize)]
struct PlatformConfig {
    name: String,
    command: String,
    args: Vec<String>,
    env_vars: HashMap<String, String>,
}

#[derive(Debug, Serialize, Deserialize, Default)]
struct AppState {
    conversations: Vec<Conversation>,
    platforms: HashMap<String, PlatformConfig>,
    active_platform: String,
    current_platform: String,
}

fn get_data_path() -> PathBuf {
    let mut path = dirs::data_dir().unwrap_or_else(|| PathBuf::from("."));
    path.push("CodeCliManager");
    path
}

fn get_claude_history_path() -> PathBuf {
    let mut path = dirs::home_dir().unwrap_or_else(|| PathBuf::from("."));
    path.push(".claude");
    path.push("projects");
    path
}

fn load_claude_history() -> Vec<Conversation> {
    let root = get_claude_history_path();
    if !root.exists() {
        return Vec::new();
    }
    
    let mut files = Vec::new();
    collect_jsonl_files(&root, &mut files);
    
    let mut conversations = Vec::new();
    for path in files {
        if let Some(conv) = parse_claude_session(&path) {
            conversations.push(conv);
        }
    }
    
    conversations.sort_by(|a, b| b.updated_at.cmp(&a.updated_at));
    conversations
}

fn collect_jsonl_files(root: &PathBuf, files: &mut Vec<PathBuf>) {
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

fn parse_claude_session(path: &PathBuf) -> Option<Conversation> {
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

    for line in content.lines() {
        if line.trim().is_empty() {
            continue;
        }

        let value: serde_json::Value = match serde_json::from_str(line) {
            Ok(v) => v,
            Err(_) => continue,
        };

        if value.get("type").and_then(|t| t.as_str()) == Some("custom-title") {
            custom_title = value.get("customTitle").and_then(|t| t.as_str()).map(|s| s.to_string());
            continue;
        }

        if value.get("isMeta").and_then(|m| m.as_bool()) == Some(true) {
            continue;
        }

        if session_id.is_none() {
            session_id = value.get("sessionId").and_then(|s| s.as_str()).map(|s| s.to_string());
        }

        // 从 JSONL 行中提取 cwd（项目工作目录）
        if project_dir.is_none() {
            project_dir = value.get("cwd").and_then(|c| c.as_str()).map(|s| s.to_string());
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
        let role = message.get("role").and_then(|r| r.as_str()).unwrap_or("unknown").to_string();
        let (content, thinking) = extract_text_and_thinking(message.get("content"));

        // 空消息跳过（但保留纯 thinking 的消息）
        if content.trim().is_empty() && thinking.is_none() {
            continue;
        }

        // 如果只有 thinking 没有文本，归类为 thinking 角色
        let effective_role = if content.trim().is_empty() && thinking.is_some() {
            "thinking".to_string()
        } else {
            role.clone()
        };

        if first_user_message.is_none() && role == "user" {
            if !content.contains("<local-command-caveat>") && !content.starts_with("<command-name>") {
                first_user_message = Some(content.clone());
            }
        }

        messages.push(Message {
            id: uuid::Uuid::new_v4().to_string(),
            role: effective_role,
            content,
            thinking,
            timestamp: ts.unwrap_or_default(),
        });
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
    
    Some(Conversation {
        id: session_id,
        title,
        messages,
        platform: "claude".to_string(),
        project_dir,
        created_at: created_at.unwrap_or_default(),
        updated_at: updated_at.unwrap_or_default(),
    })
}

// 从 content 中提取文本和思考内容
// 返回 (纯文本, 思考内容)
fn extract_text_and_thinking(content: Option<&serde_json::Value>) -> (String, Option<String>) {
    match content {
        Some(serde_json::Value::String(s)) => (s.clone(), None),
        Some(serde_json::Value::Array(items)) => {
            let mut texts = Vec::new();
            let mut thinking_parts = Vec::new();
            for item in items {
                let t = item.get("type").and_then(|t| t.as_str());
                match t {
                    Some("text") => {
                        if let Some(text) = item.get("text").and_then(|t| t.as_str()) {
                            texts.push(text.to_string());
                        }
                    }
                    Some("thinking") => {
                        if let Some(th) = item.get("thinking").and_then(|t| t.as_str()) {
                            thinking_parts.push(th.to_string());
                        }
                    }
                    Some("tool_result") => {
                        if let Some(c) = item.get("content").and_then(|c| c.as_str()) {
                            texts.push(c.to_string());
                        }
                    }
                    Some("tool_use") => {
                        let name = item.get("name").and_then(|n| n.as_str()).unwrap_or("unknown");
                        texts.push(format!("[Tool: {}]", name));
                    }
                    _ => {}
                }
            }
            let text = texts.join("\n");
            let thinking = if thinking_parts.is_empty() {
                None
            } else {
                Some(thinking_parts.join("\n"))
            };
            (text, thinking)
        }
        _ => (String::new(), None),
    }
}

// 兼容旧代码：只提取纯文本
#[allow(dead_code)]
fn extract_text(content: Option<&serde_json::Value>) -> String {
    extract_text_and_thinking(content).0
}

fn parse_timestamp(iso_string: &str) -> Option<i64> {
    if let Ok(dt) = chrono::DateTime::parse_from_rfc3339(iso_string) {
        Some(dt.timestamp())
    } else {
        None
    }
}

fn detect_os() -> String {
    std::env::consts::OS.to_string()
}

fn load_app_state() -> AppState {
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
        let path = get_data_path().join("state.json");
        if path.exists() {
            match fs::read_to_string(&path) {
                Ok(content) => {
                    let mut state: AppState = serde_json::from_str(&content).unwrap_or_else(|_| get_default_state());
                    state.current_platform = os;
                    state
                },
                Err(_) => get_default_state(),
            }
        } else {
            get_default_state()
        }
    }
}

fn get_default_state() -> AppState {
    let mut conversations = Vec::new();
    
    let now = chrono::Utc::now().timestamp();
    let hour_ago = now - 3600;
    let two_hours_ago = now - 7200;
    
    conversations.push(Conversation {
        id: "session-1".to_string(),
        title: "如何学习 Rust".to_string(),
        messages: vec![
            Message {
                id: "msg-1".to_string(),
                role: "user".to_string(),
                content: "告诉我如何学习 Rust 编程语言".to_string(),
                thinking: None,
                timestamp: two_hours_ago,
            },
            Message {
                id: "msg-2".to_string(),
                role: "assistant".to_string(),
                content: "学习 Rust 的最佳方式：\n1. 阅读官方文档 \"The Rust Programming Language\"\n2. 完成 Rustlings 练习\n3. 构建小项目\n4. 参与开源项目".to_string(),
                thinking: None,
                timestamp: two_hours_ago + 1,
            },
        ],
        platform: "claude".to_string(),
        project_dir: None,
        created_at: two_hours_ago,
        updated_at: two_hours_ago + 1,
    });
    
    conversations.push(Conversation {
        id: "session-2".to_string(),
        title: "前端性能优化".to_string(),
        messages: vec![
            Message {
                id: "msg-3".to_string(),
                role: "user".to_string(),
                content: "前端性能优化有哪些方法？".to_string(),
                thinking: None,
                timestamp: hour_ago,
            },
            Message {
                id: "msg-4".to_string(),
                role: "assistant".to_string(),
                content: "前端性能优化技巧：\n- 代码分割和懒加载\n- 图片优化（WebP/AVIF）\n- 缓存策略\n- CDN 加速\n- 减少重绘重排".to_string(),
                thinking: None,
                timestamp: hour_ago + 1,
            },
        ],
        platform: "claude".to_string(),
        project_dir: None,
        created_at: hour_ago,
        updated_at: hour_ago + 1,
    });
    
    conversations.push(Conversation {
        id: "session-3".to_string(),
        title: "Tauri 框架介绍".to_string(),
        messages: vec![
            Message {
                id: "msg-5".to_string(),
                role: "user".to_string(),
                content: "什么是 Tauri 框架？".to_string(),
                thinking: None,
                timestamp: now - 300,
            },
            Message {
                id: "msg-6".to_string(),
                role: "assistant".to_string(),
                content: "Tauri 是一个用于构建跨平台桌面应用的框架，使用 Rust 作为后端，前端可以使用任何 Web 技术。相比 Electron，Tauri 应用体积更小、性能更好。".to_string(),
                thinking: None,
                timestamp: now - 299,
            },
        ],
        platform: "claude".to_string(),
        project_dir: None,
        created_at: now - 300,
        updated_at: now - 299,
    });
    
    AppState {
        conversations,
        platforms: get_default_platforms(),
        active_platform: "claude".to_string(),
        current_platform: detect_os(),
    }
}

fn save_app_state(state: &AppState) {
    let data_path = get_data_path();
    if !data_path.exists() {
        let _ = fs::create_dir_all(&data_path);
    }
    let path = data_path.join("state.json");
    if let Ok(content) = serde_json::to_string_pretty(state) {
        let _ = fs::write(path, content);
    }
}

fn get_default_platforms() -> HashMap<String, PlatformConfig> {
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

#[derive(Debug, Serialize, Deserialize, Clone)]
struct SessionEventPayload {
    conversation_id: String,
    title: String,
    messages: Vec<Message>,
    updated_at: i64,
}

#[tauri::command]
fn get_conversations() -> Vec<Conversation> {
    let state = load_app_state();
    state.conversations
}

#[tauri::command]
fn get_platforms() -> HashMap<String, PlatformConfig> {
    let state = load_app_state();
    state.platforms
}

#[tauri::command]
fn get_active_platform() -> String {
    let state = load_app_state();
    state.active_platform
}

#[tauri::command]
fn get_current_platform() -> String {
    let state = load_app_state();
    state.current_platform
}

#[tauri::command]
fn set_active_platform(platform_id: String) {
    let mut state = load_app_state();
    if state.platforms.contains_key(&platform_id) {
        state.active_platform = platform_id;
        save_app_state(&state);
    }
}

#[tauri::command]
fn add_platform(id: String, name: String, command: String, args: Vec<String>) {
    let mut state = load_app_state();
    state.platforms.insert(
        id,
        PlatformConfig {
            name,
            command,
            args,
            env_vars: HashMap::new(),
        },
    );
    save_app_state(&state);
}

#[tauri::command]
fn delete_conversation(conversation_id: String) {
    let mut state = load_app_state();
    state.conversations.retain(|c| c.id != conversation_id);
    save_app_state(&state);
}

#[tauri::command]
fn get_conversation(conversation_id: String) -> Option<Conversation> {
    let state = load_app_state();
    state.conversations.into_iter().find(|c| c.id == conversation_id)
}

#[tauri::command]
fn update_conversation_title(conversation_id: String, title: String) -> Result<Conversation, String> {
    let mut state = load_app_state();
    
    if let Some(c) = state.conversations.iter_mut().find(|c| c.id == conversation_id) {
        c.title = title;
        c.updated_at = chrono::Utc::now().timestamp();
        let result = c.clone();
        save_app_state(&state);
        Ok(result)
    } else {
        Err("Conversation not found".to_string())
    }
}

#[tauri::command]
async fn send_message(conversation_id: String, content: String) -> Result<Conversation, String> {
    let mut state = load_app_state();
    let now = chrono::Utc::now().timestamp();
    
    let user_message = Message {
        id: uuid::Uuid::new_v4().to_string(),
        role: "user".to_string(),
        content: content.clone(),
        thinking: None,
        timestamp: now,
    };
    
    let conversation_id = if conversation_id.is_empty() {
        let new_conv = Conversation {
            id: uuid::Uuid::new_v4().to_string(),
            title: content.chars().take(30).collect(),
            messages: vec![user_message],
            platform: state.active_platform.clone(),
            project_dir: None,
            created_at: now,
            updated_at: now,
        };
        let id = new_conv.id.clone();
        state.conversations.push(new_conv);
        save_app_state(&state);
        id
    } else {
        if let Some(c) = state.conversations.iter_mut().find(|c| c.id == conversation_id) {
            c.messages.push(user_message);
            c.updated_at = now;
        }
        save_app_state(&state);
        conversation_id
    };
    
    let response_result = run_claude_command(&content).await;
    
    let response_content = if !response_result.success {
        format!(
            "Error: {}\n{}",
            response_result.error.as_deref().unwrap_or("Unknown error"),
            response_result.output
        )
    } else {
        response_result.output
    };
    
    let mut state3 = load_app_state();
    if let Some(c) = state3.conversations.iter_mut().find(|c| c.id == conversation_id) {
        let assistant_message = Message {
            id: uuid::Uuid::new_v4().to_string(),
            role: "assistant".to_string(),
            content: response_content,
            thinking: None,
            timestamp: chrono::Utc::now().timestamp(),
        };
        c.messages.push(assistant_message);
        c.updated_at = chrono::Utc::now().timestamp();
        save_app_state(&state3);
    }
    
    let state4 = load_app_state();
    state4.conversations.into_iter().find(|c| c.id == conversation_id)
        .ok_or_else(|| "Conversation not found".to_string())
}

// 转义 Windows PowerShell 单引号字符串（' → ''）
#[cfg(target_os = "windows")]
fn escape_ps_single_quoted(s: &str) -> String {
    s.replace('\'', "''")
}

// 转义 Unix shell 单引号字符串（' → '\''）
#[cfg(not(target_os = "windows"))]
fn escape_sh_single_quoted(s: &str) -> String {
    s.replace('\'', "'\\''")
}

// 确保目录存在：先验证，不存在则尝试创建
fn resolve_or_create_dir(cwd: &str) -> Option<String> {
    let path = std::path::Path::new(cwd);
    if path.exists() && path.is_dir() {
        return Some(cwd.to_string());
    }
    match std::fs::create_dir_all(path) {
        Ok(()) => {
            eprintln!("[spawn] 已创建目录: {}", cwd);
            Some(cwd.to_string())
        }
        Err(e) => {
            eprintln!("[spawn] 创建目录失败 '{}': {}", cwd, e);
            None
        }
    }
}

// 构建平台相关的 shell 命令
fn build_shell_command(input: &str, claude_part: &str, cwd: Option<&str>) -> (&'static str, Vec<String>, String) {
    #[cfg(target_os = "windows")]
    {
        let escaped = escape_ps_single_quoted(input);
        let cmd = if let Some(cwd) = cwd {
            format!("Set-Location '{}'; '{}' | {}", cwd, escaped, claude_part)
        } else {
            format!("'{}' | {}", escaped, claude_part)
        };
        ("powershell", vec!["-NoProfile".into(), "-Command".into()], cmd)
    }
    #[cfg(not(target_os = "windows"))]
    {
        let escaped = escape_sh_single_quoted(input);
        let cmd = if let Some(cwd) = cwd {
            format!("cd '{}' && echo '{}' | {}", cwd, escaped, claude_part)
        } else {
            format!("echo '{}' | {}", escaped, claude_part)
        };
        ("sh", vec!["-c".into()], cmd)
    }
}

// 启动 shell 执行 claude 命令
// Win: PowerShell 'prompt' | claude --resume
// Mac: sh echo 'prompt' | claude --resume
// project_dir: 从 JSONL 会话文件中提取的 cwd，用于设置正确的工作目录
fn spawn_claude_shell(input: &str, conversation_id: Option<&String>, project_dir: Option<&String>) -> std::io::Result<std::process::Output> {
    #[cfg(target_os = "windows")]
    use std::os::windows::process::CommandExt;

    let cid_opt = conversation_id.filter(|c| !c.is_empty());

    let claude_part = if let Some(cid) = cid_opt {
        format!("claude --resume {}", cid)
    } else {
        "claude".to_string()
    };

    let effective_cwd = project_dir.and_then(|cwd| resolve_or_create_dir(cwd));
    let (shell, shell_args, shell_cmd) = build_shell_command(input, &claude_part, effective_cwd.as_deref());

    eprintln!("============================================================");
    eprintln!("[spawn] 平台     : {}", if cfg!(target_os = "windows") { "Windows" } else { "Unix" });
    eprintln!("[spawn] 工作目录 : {:?}", effective_cwd);
    eprintln!("[spawn] 执行命令 : {}", shell_cmd);
    eprintln!("[spawn] 原始提示词: {}", input);
    eprintln!("============================================================");

    let mut cmd = Command::new(shell);
    #[cfg(target_os = "windows")]
    {
        cmd.creation_flags(0x08000000);
    }
    if let Some(ref cwd) = effective_cwd {
        cmd.current_dir(cwd);
    }
    for arg in &shell_args {
        cmd.arg(arg);
    }
    cmd.arg(&shell_cmd);

    let output = cmd
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .stdin(Stdio::null())
        .output()?;

    let stdout_s = String::from_utf8_lossy(&output.stdout);
    let stderr_s = String::from_utf8_lossy(&output.stderr);
    eprintln!("[claude] 退出码: {}", output.status);
    if !stdout_s.trim().is_empty() {
        eprintln!("[claude stdout]\n{}", stdout_s);
    }
    if !stderr_s.trim().is_empty() {
        eprintln!("[claude stderr]\n{}", stderr_s);
    }

    Ok(output)
}

#[tauri::command]
async fn execute_prompt(app: AppHandle, prompt: String, conversation_id: Option<String>) -> Result<(), String> {
    let active_cid = conversation_id.clone();
    eprintln!("[execute_prompt] received: prompt='{}', conversation_id={:?}", prompt, active_cid);

    tauri::async_runtime::spawn(async move {
        // 记录发送前的会话状态
        let before_conversations = load_claude_history();
        let before_ids: std::collections::HashSet<String> =
            before_conversations.iter().map(|c| c.id.clone()).collect();

        // 查找目标会话的 project_dir（从 JSONL 中提取的 cwd）
        let project_dir = active_cid.as_ref().and_then(|cid| {
            before_conversations.iter()
                .find(|c| c.id == *cid)
                .and_then(|c| c.project_dir.as_ref())
        });

        // 阻塞执行 claude，等待完成
        if let Err(e) = spawn_claude_shell(&prompt, active_cid.as_ref(), project_dir) {
            eprintln!("[execute_prompt] claude 执行失败: {}", e);
            let _ = app.emit("session-ended", active_cid.clone());
            return;
        }

        // Claude 执行完毕，重新加载会话列表
        let after_conversations = load_claude_history();

        // 查找发生变化的会话：优先查找目标会话，其次查找最新会话
        let updated_conv = active_cid.as_ref()
            .and_then(|cid| after_conversations.iter().find(|c| c.id == *cid))
            .or_else(|| after_conversations.iter().max_by_key(|c| c.updated_at));

        if let Some(conv) = updated_conv {
            let is_existing = before_ids.contains(&conv.id);
            let event_name = if is_existing { "messages-updated" } else { "session-created" };

            let payload = SessionEventPayload {
                conversation_id: conv.id.clone(),
                title: conv.title.clone(),
                messages: conv.messages.clone(),
                updated_at: conv.updated_at,
            };
            eprintln!("[execute_prompt] emit {} for session {}", event_name, conv.id);
            let _ = app.emit(event_name, &payload);
        } else {
            eprintln!("[execute_prompt] 未找到更新的会话");
            let _ = app.emit("session-ended", active_cid.clone());
        }
    });

    Ok(())
}

#[derive(Debug, Serialize, Deserialize, Default)]
struct SimpleConversation {
    id: String,
    title: String,
    updated_at: i64,
}

#[tauri::command]
fn get_conversation_list() -> Vec<SimpleConversation> {
    let state = load_app_state();
    state.conversations.iter()
        .map(|c| SimpleConversation {
            id: c.id.clone(),
            title: c.title.clone(),
            updated_at: c.updated_at,
        })
        .collect()
}

#[tauri::command]
fn get_conversation_messages(conversation_id: String) -> Vec<Message> {
    let state = load_app_state();
    state.conversations.iter()
        .find(|c| c.id == conversation_id)
        .map(|c| c.messages.clone())
        .unwrap_or_default()
}

#[derive(Debug, Serialize, Deserialize)]
struct CommandResult {
    success: bool,
    output: String,
    error: Option<String>,
}

#[tauri::command]
async fn execute_cli_command(platform_id: String, input: String) -> Result<CommandResult, String> {
    let _state = load_app_state();
    let _ = platform_id;
    
    let result = run_claude_command(&input).await;
    
    Ok(result)
}

async fn run_claude_command(input: &str) -> CommandResult {
    #[cfg(target_os = "windows")]
    use std::os::windows::process::CommandExt;

    #[cfg(target_os = "windows")]
    {
        let mut cmd = Command::new("cmd");
        cmd.args(["/C", "claude"]);
        cmd.creation_flags(0x08000000);
        
        run_command_with_input(cmd, input).await
    }
    
    #[cfg(not(target_os = "windows"))]
    {
        let mut cmd = Command::new("sh");
        cmd.args(["-c", "claude"]);
        
        run_command_with_input(cmd, input).await
    }
}

#[allow(dead_code)]
async fn run_claude_command_with_resume(input: &str, conversation_id: &str) -> CommandResult {
    #[cfg(target_os = "windows")]
    use std::os::windows::process::CommandExt;

    #[cfg(target_os = "windows")]
    {
        let mut cmd = Command::new("cmd");
        let home = dirs::home_dir().unwrap_or_else(|| PathBuf::from("."));
        let home_str = home.to_string_lossy().to_string();
        let full_cmd = format!("cd /d {} && claude --resume {}", home_str, conversation_id);
        cmd.args(["/C", &full_cmd]);
        cmd.creation_flags(0x08000000);
        
        run_command_with_input(cmd, input).await
    }
    
    #[cfg(not(target_os = "windows"))]
    {
        let mut cmd = Command::new("sh");
        let cmd_str = format!("claude --resume {}", conversation_id);
        cmd.args(["-c", &cmd_str]);
        
        run_command_with_input(cmd, input).await
    }
}

async fn run_command_with_input(mut cmd: Command, input: &str) -> CommandResult {
    let mut child = match cmd
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
    {
        Ok(c) => c,
        Err(e) => return CommandResult {
            success: false,
            output: String::new(),
            error: Some(format!("Failed to start claude: {}", e)),
        },
    };
    
    if let Some(mut stdin) = child.stdin.take() {
        if let Err(e) = stdin.write_all(input.as_bytes()) {
            return CommandResult {
                success: false,
                output: String::new(),
                error: Some(format!("Failed to write input to claude: {}", e)),
            };
        }
    }
    
    let output = match child.wait_with_output() {
        Ok(o) => o,
        Err(e) => return CommandResult {
            success: false,
            output: String::new(),
            error: Some(format!("Claude execution failed: {}", e)),
        },
    };
    
    let stdout = String::from_utf8_lossy(&output.stdout).to_string();
    let stderr = String::from_utf8_lossy(&output.stderr).to_string();
    
    CommandResult {
        success: output.status.success(),
        output: stdout,
        error: if stderr.is_empty() { None } else { Some(stderr) },
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![
            get_conversations,
            get_platforms,
            get_active_platform,
            get_current_platform,
            set_active_platform,
            add_platform,
            delete_conversation,
            get_conversation,
            update_conversation_title,
            send_message,
            execute_cli_command,
            execute_prompt,
            get_conversation_list,
            get_conversation_messages,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application")
}
