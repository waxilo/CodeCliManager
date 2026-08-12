use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::process::Command;

use super::updater::is_user_home_install;

/// macOS GUI 应用从 Finder 启动时 PATH 很窄，通常找不到 /usr/local/bin/claude。
pub(crate) fn extended_path_for_cli() -> String {
    let home = dirs::home_dir().unwrap_or_else(|| PathBuf::from("."));

    #[cfg(target_os = "windows")]
    let separator = ";";
    #[cfg(not(target_os = "windows"))]
    let separator = ":";

    let mut segments: Vec<PathBuf> = if cfg!(target_os = "windows") {
        vec![
            // npm 全局路径（Windows）
            home.join("AppData").join("Roaming").join("npm"),
            home.join(".local").join("bin"),
            home.join("AppData").join("Local").join("Programs").join("nodejs"),
            PathBuf::from("C:\\Program Files\\nodejs"),
        ]
    } else {
        vec![
            // 优先用户目录，配合静默更新到 ~/.local
            home.join(".local/bin"),
            home.join(".npm-global/bin"),
            home.join("bin"),
            PathBuf::from("/opt/homebrew/bin"),
            PathBuf::from("/usr/local/bin"),
        ]
    };

    if let Ok(existing) = std::env::var("PATH") {
        for part in existing.split(separator).filter(|s| !s.is_empty()) {
            segments.push(PathBuf::from(part));
        }
    }

    #[cfg(not(target_os = "windows"))]
    {
        segments.extend([
            PathBuf::from("/usr/bin"),
            PathBuf::from("/bin"),
            PathBuf::from("/usr/sbin"),
            PathBuf::from("/sbin"),
        ]);
    }

    let mut seen = HashSet::new();
    segments
        .into_iter()
        .map(|p| p.to_string_lossy().to_string())
        .filter(|p| seen.insert(p.clone()))
        .collect::<Vec<_>>()
        .join(separator)
}

pub(crate) fn resolve_claude_executable() -> PathBuf {
    let home = dirs::home_dir().unwrap_or_else(|| PathBuf::from("."));
    // 优先用户目录，便于静默更新到 ~/.local 后立即生效，避免仍命中旧的系统安装
    let mut candidates = vec![
        home.join(".local/bin/claude"),
        home.join(".npm-global/bin/claude"),
        home.join("bin/claude"),
        home.join(".claude/bin/claude"),
        PathBuf::from("/opt/homebrew/bin/claude"),
        PathBuf::from("/usr/local/bin/claude"),
    ];

    #[cfg(target_os = "windows")]
    {
        // 优先 .exe，避免经 cmd.exe 解析 .cmd 时弹出控制台窗口
        candidates.extend([
            home.join(".claude/bin/claude.exe"),
            home.join("AppData/Roaming/npm/claude.exe"),
            home.join(".local/bin/claude.exe"),
            home.join("AppData/Roaming/npm/claude.cmd"),
            PathBuf::from("C:\\Program Files\\Claude\\claude.exe"),
            PathBuf::from("C:\\Program Files (x86)\\Claude\\claude.exe"),
            dirs::data_local_dir().unwrap_or_default().join("claude/bin/claude.exe"),
            dirs::data_dir().unwrap_or_default().join("claude/bin/claude.exe"),
        ]);
    }

    #[cfg(unix)]
    {
        if let Ok(output) = Command::new("/bin/zsh")
            .args(["-l", "-c", "command -v claude"])
            .output()
        {
            if output.status.success() {
                let path = String::from_utf8_lossy(&output.stdout).trim().to_string();
                if !path.is_empty() {
                    let found = PathBuf::from(&path);
                    // 用户目录安装插到最前；系统路径仅作为候选补充，避免盖过 ~/.local
                    if is_user_home_install(&found) {
                        candidates.insert(0, found);
                    } else {
                        candidates.push(found);
                    }
                }
            }
        }
    }

    for candidate in candidates {
        if candidate.is_file() {
            return candidate;
        }
    }

    #[cfg(target_os = "windows")]
    {
        // 优先尝试不带扩展名的命令（PowerShell 会自动查找 .ps1）
        PathBuf::from("claude")
    }
    #[cfg(not(target_os = "windows"))]
    {
        PathBuf::from("claude")
    }
}

pub(crate) fn apply_cli_runtime_env(cmd: &mut Command) {
    cmd.env("PATH", extended_path_for_cli());
    if let Some(home) = dirs::home_dir() {
        cmd.env("HOME", home);
    }
    if let Ok(user) = std::env::var("USER") {
        cmd.env("USER", user);
    } else if let Ok(logname) = std::env::var("LOGNAME") {
        cmd.env("USER", logname);
    }
}
