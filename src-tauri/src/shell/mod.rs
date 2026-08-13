use crate::claude::runtime::resolve_claude_executable;
use std::path::Path;

fn validate_session_id(session_id: &str) -> Result<String, String> {
    let trimmed = session_id.trim();
    let parsed = uuid::Uuid::parse_str(trimmed).map_err(|_| "Session ID 必须是有效 UUID".to_string())?;
    if parsed.hyphenated().to_string() != trimmed.to_ascii_lowercase() {
        return Err("Session ID 必须是标准连字符 UUID".to_string());
    }
    Ok(parsed.hyphenated().to_string())
}

fn resolved_claude_command() -> String {
    let path = resolve_claude_executable();
    if path.is_file() {
        path.to_string_lossy().into_owned()
    } else {
        "claude".to_string()
    }
}

/// 在新终端窗口中打开指定目录（仅 cd，不执行额外命令）
#[tauri::command]
pub fn open_terminal(project_dir: String) -> Result<(), String> {
    let dir = project_dir.trim();
    if dir.is_empty() {
        return Err("项目目录为空".to_string());
    }
    if !Path::new(dir).is_dir() {
        return Err("项目目录不存在".to_string());
    }

    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NEW_CONSOLE: u32 = 0x00000010;

        std::process::Command::new("cmd.exe")
            .arg("/k")
            .current_dir(dir)
            .creation_flags(CREATE_NEW_CONSOLE)
            .spawn()
            .map_err(|e| format!("启动终端失败: {e}"))?;
    }

    #[cfg(target_os = "macos")]
    {
        const SCRIPT: &str = r#"on run argv
set projectDir to item 1 of argv
set shellCommand to "cd -- " & quoted form of projectDir & "; exec " & quoted form of (system attribute "SHELL") & " -l"
tell application "Terminal"
  do script shellCommand
  activate
end tell
end run"#;
        std::process::Command::new("osascript")
            .args(["-e", SCRIPT, "--", dir])
            .spawn()
            .map_err(|e| format!("启动终端失败: {e}"))?;
    }

    #[cfg(target_os = "linux")]
    {
        const SCRIPT: &str = "cd -- \"$1\" && exec \"${SHELL:-/bin/bash}\" -l";
        let launched = [
            ("gnome-terminal", vec!["--", "sh", "-c", SCRIPT, "sh", dir]),
            ("konsole", vec!["-e", "sh", "-c", SCRIPT, "sh", dir]),
            ("xfce4-terminal", vec!["-x", "sh", "-c", SCRIPT, "sh", dir]),
            ("x-terminal-emulator", vec!["-e", "sh", "-c", SCRIPT, "sh", dir]),
            ("xterm", vec!["-e", "sh", "-c", SCRIPT, "sh", dir]),
        ]
        .into_iter()
        .any(|(terminal, args)| std::process::Command::new(terminal).args(args).spawn().is_ok());

        if !launched {
            return Err("未找到可用的终端模拟器（gnome-terminal/konsole/xfce4-terminal/xterm）".to_string());
        }
    }

    Ok(())
}

/// 在新终端窗口中 cd 到项目目录并执行 claude --resume <session_id>
#[tauri::command]
pub fn open_terminal_resume(project_dir: String, session_id: String) -> Result<(), String> {
    let dir = project_dir.trim();
    if dir.is_empty() {
        return Err("项目目录为空".to_string());
    }
    if !Path::new(dir).is_dir() {
        return Err("项目目录不存在".to_string());
    }
    let sid = validate_session_id(&session_id)?;
    let claude_command = resolved_claude_command();

    #[cfg(target_os = "windows")]
    {
        use std::io::Write;
        use std::os::windows::process::CommandExt;
        const CREATE_NEW_CONSOLE: u32 = 0x00000010;

        // 脚本本身不包含用户输入；路径和 UUID 仅作为参数传入。
        // 临时文件名使用独立随机 UUID，不使用会话 ID。
        let bat_path = std::env::temp_dir().join(format!("ccm_resume_{}.bat", uuid::Uuid::new_v4()));
        let mut file = std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&bat_path)
            .map_err(|e| format!("创建临时脚本失败: {e}"))?;
        file.write_all(b"@echo off\r\n\"%~1\" --resume \"%~2\"\r\n")
            .and_then(|_| file.flush())
            .map_err(|e| format!("写入临时脚本失败: {e}"))?;
        drop(file);

        let spawn_result = std::process::Command::new("cmd.exe")
            .arg("/k")
            .arg(&bat_path)
            .arg(&claude_command)
            .arg(&sid)
            .current_dir(dir)
            .creation_flags(CREATE_NEW_CONSOLE)
            .spawn();
        if let Err(error) = spawn_result {
            let _ = std::fs::remove_file(&bat_path);
            return Err(format!("启动终端失败: {error}"));
        }

        std::thread::spawn(move || {
            std::thread::sleep(std::time::Duration::from_secs(5));
            let _ = std::fs::remove_file(bat_path);
        });
    }

    #[cfg(target_os = "macos")]
    {
        const SCRIPT: &str = r#"on run argv
set projectDir to item 1 of argv
set claudeExecutable to item 2 of argv
set sessionId to item 3 of argv
set shellCommand to "cd -- " & quoted form of projectDir & " && exec " & quoted form of claudeExecutable & " --resume " & quoted form of sessionId
tell application "Terminal"
  do script shellCommand
  activate
end tell
end run"#;
        std::process::Command::new("osascript")
            .args(["-e", SCRIPT, "--", dir, &claude_command, &sid])
            .spawn()
            .map_err(|e| format!("启动终端失败: {e}"))?;
    }

    #[cfg(target_os = "linux")]
    {
        // 所有动态值均经位置参数传入，绝不拼接到 shell 源码。
        const SCRIPT: &str = "cd -- \"$1\" && \"$2\" --resume \"$3\"; exec \"${SHELL:-/bin/bash}\" -l";
        let launched = [
            ("gnome-terminal", vec!["--", "sh", "-c", SCRIPT, "sh", dir, &claude_command, &sid]),
            ("konsole", vec!["-e", "sh", "-c", SCRIPT, "sh", dir, &claude_command, &sid]),
            ("xfce4-terminal", vec!["-x", "sh", "-c", SCRIPT, "sh", dir, &claude_command, &sid]),
            ("x-terminal-emulator", vec!["-e", "sh", "-c", SCRIPT, "sh", dir, &claude_command, &sid]),
            ("xterm", vec!["-e", "sh", "-c", SCRIPT, "sh", dir, &claude_command, &sid]),
        ]
        .into_iter()
        .any(|(terminal, args)| std::process::Command::new(terminal).args(args).spawn().is_ok());

        if !launched {
            return Err("未找到可用的终端模拟器（gnome-terminal/konsole/xfce4-terminal/xterm）".to_string());
        }
    }

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::validate_session_id;

    #[test]
    fn accepts_canonical_uuid_session_id() {
        let value = "550e8400-e29b-41d4-a716-446655440000";
        assert_eq!(validate_session_id(value).unwrap(), value);
    }

    #[test]
    fn rejects_non_uuid_and_non_canonical_session_ids() {
        assert!(validate_session_id("../../run-me").is_err());
        assert!(validate_session_id("550e8400e29b41d4a716446655440000").is_err());
        assert!(validate_session_id("{550e8400-e29b-41d4-a716-446655440000}").is_err());
    }
}
