use crate::claude::runtime::resolve_claude_executable;

/// 在新终端窗口中打开指定目录（仅 cd，不执行额外命令）
#[tauri::command]
pub fn open_terminal(project_dir: String) -> Result<(), String> {
    let dir = project_dir.trim();
    if dir.is_empty() {
        return Err("项目目录为空".to_string());
    }

    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NEW_CONSOLE: u32 = 0x00000010;

        // 通过 current_dir 设置工作目录，避免把 Windows 路径拼进 cmd 命令后
        // 被 &, 括号等特殊字符重新解析，导致终端落到错误目录。
        std::process::Command::new("cmd")
            .arg("/k")
            .current_dir(dir)
            .creation_flags(CREATE_NEW_CONSOLE)
            .spawn()
            .map_err(|e| format!("启动终端失败: {}", e))?;
    }

    #[cfg(target_os = "macos")]
    {
        // do script 会开新窗口，但默认不一定把 Terminal 提到前台，需显式 activate
        let script = format!(
            "tell application \"Terminal\"\n  do script \"cd '{}'\"\n  activate\nend tell",
            dir.replace('\'', "'\\''")
        );
        std::process::Command::new("osascript")
            .args(["-e", &script])
            .spawn()
            .map_err(|e| format!("启动终端失败: {}", e))?;
    }

    #[cfg(target_os = "linux")]
    {
        let cmd_str = format!("cd \"{}\"; exec bash", dir);
        let terminals = [
            ("gnome-terminal", vec!["--working-directory", dir]),
            ("konsole", vec!["--workdir", dir]),
            ("xfce4-terminal", vec!["--working-directory", dir]),
            ("x-terminal-emulator", vec!["-e", "bash", "-c", &cmd_str]),
            ("xterm", vec!["-e", "bash", "-c", &cmd_str]),
        ];

        let mut launched = false;
        for (term, args) in &terminals {
            if std::process::Command::new(term).args(args).spawn().is_ok() {
                launched = true;
                break;
            }
        }

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
    let sid = session_id.trim();

    if dir.is_empty() {
        return Err("项目目录为空".to_string());
    }
    if sid.is_empty() {
        return Err("Session ID 为空".to_string());
    }

    // 使用实际解析的 claude 路径，确保终端能正确执行
    let claude_path = resolve_claude_executable();
    let claude_cmd = if claude_path.exists() {
        #[cfg(target_os = "windows")]
        { format!("\"{}\"", claude_path.display()) }
        #[cfg(not(target_os = "windows"))]
        { format!("{}", claude_path.display()) }
    } else {
        "claude".to_string()
    };

    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        use std::io::Write;
        const CREATE_NEW_CONSOLE: u32 = 0x00000010;

        // 将命令写入临时 .bat 文件，避免命令行参数转义问题
        let bat_content = format!(
            "@echo off\r\ncd /d \"{}\"\r\nif errorlevel 1 (\r\n  echo [错误] 无法切换到目录: {}\r\n  pause\r\n  exit /b 1\r\n)\r\necho [工作目录] %CD%\r\necho [执行] {} --resume {}\r\necho.\r\n{} --resume {}\r\n",
            dir, dir, claude_cmd, sid, claude_cmd, sid
        );
        let tmp_dir = std::env::temp_dir();
        let bat_path = tmp_dir.join(format!("ccm_resume_{}.bat", sid));
        let mut file = std::fs::File::create(&bat_path)
            .map_err(|e| format!("创建临时脚本失败: {}", e))?;
        file.write_all(bat_content.as_bytes())
            .map_err(|e| format!("写入临时脚本失败: {}", e))?;
        // 确保数据落盘后再执行
        file.flush().map_err(|e| format!("写入临时脚本失败: {}", e))?;
        drop(file);

        let bat_path_str = bat_path.to_string_lossy().to_string();
        std::process::Command::new("cmd")
            .arg("/k")
            .arg(&bat_path_str)
            .creation_flags(CREATE_NEW_CONSOLE)
            .spawn()
            .map_err(|e| format!("启动终端失败: {}", e))?;

        // 延迟清理临时脚本（终端已启动，不再需要该文件）
        let _cleanup_path = bat_path.clone();
        std::thread::spawn(move || {
            std::thread::sleep(std::time::Duration::from_secs(5));
            let _ = std::fs::remove_file(&_cleanup_path);
        });
    }

    #[cfg(target_os = "macos")]
    {
        // do script 会开新窗口，但默认不一定把 Terminal 提到前台，需显式 activate
        let script = format!(
            "tell application \"Terminal\"\n  do script \"cd '{}' && {} --resume {}\"\n  activate\nend tell",
            dir.replace('\'', "'\\''"),
            claude_cmd,
            sid
        );
        std::process::Command::new("osascript")
            .args(["-e", &script])
            .spawn()
            .map_err(|e| format!("启动终端失败: {}", e))?;
    }

    #[cfg(target_os = "linux")]
    {
        let cmd_str = format!(
            "cd \"{}\" && {} --resume {}; exec bash",
            dir, claude_cmd, sid
        );
        // 尝试多种终端模拟器
        let terminals = [
            ("gnome-terminal", vec!["--", "bash", "-c", &cmd_str]),
            ("konsole", vec!["-e", "bash", "-c", &cmd_str]),
            ("xfce4-terminal", vec!["-e", &format!("bash -c '{}'", cmd_str)]),
            ("x-terminal-emulator", vec!["-e", "bash", "-c", &cmd_str]),
            ("xterm", vec!["-e", "bash", "-c", &cmd_str]),
        ];

        let mut launched = false;
        for (term, args) in &terminals {
            if let Ok(_child) = std::process::Command::new(term)
                .args(args)
                .spawn()
            {
                launched = true;
                break;
            }
        }

        if !launched {
            return Err("未找到可用的终端模拟器（gnome-terminal/konsole/xfce4-terminal/xterm）".to_string());
        }
    }

    Ok(())
}
