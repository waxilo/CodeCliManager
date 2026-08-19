use serde::{Deserialize, Serialize};
use std::fs;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::thread;
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter};

use crate::claude::runtime::{apply_cli_runtime_env, resolve_claude_executable};
use crate::session::force_kill_process_tree;

/// 从 `claude -v` 输出中提取版本号，例如 `2.1.138 (Claude Code)` → `2.1.138`
pub(crate) fn parse_claude_version_output(raw: &str) -> Option<String> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return None;
    }
    let token = trimmed
        .split_whitespace()
        .next()
        .unwrap_or(trimmed)
        .trim_matches(|c: char| !c.is_ascii_digit() && c != '.');
    if token.is_empty() || !token.chars().next()?.is_ascii_digit() {
        return None;
    }
    Some(token.to_string())
}

pub(crate) fn parse_semver_parts(version: &str) -> Option<Vec<u64>> {
    let core = version.split('-').next().unwrap_or(version).trim();
    if core.is_empty() {
        return None;
    }
    let mut parts = Vec::new();
    for part in core.split('.') {
        let digits: String = part.chars().take_while(|c| c.is_ascii_digit()).collect();
        if digits.is_empty() {
            return None;
        }
        parts.push(digits.parse::<u64>().ok()?);
    }
    if parts.is_empty() {
        None
    } else {
        Some(parts)
    }
}

pub(crate) fn is_version_newer(latest: &str, installed: &str) -> bool {
    let Some(latest_parts) = parse_semver_parts(latest) else {
        return latest != installed;
    };
    let Some(installed_parts) = parse_semver_parts(installed) else {
        return true;
    };
    let len = latest_parts.len().max(installed_parts.len());
    for i in 0..len {
        let l = latest_parts.get(i).copied().unwrap_or(0);
        let r = installed_parts.get(i).copied().unwrap_or(0);
        if l != r {
            return l > r;
        }
    }
    false
}

pub(crate) const CLAUDE_VERSION_TIMEOUT: Duration = Duration::from_secs(10);
pub(crate) const CLAUDE_UPDATE_TIMEOUT: Duration = Duration::from_secs(300);
pub(crate) const CLAUDE_INSTALL_TIMEOUT: Duration = Duration::from_secs(600);
pub(crate) const CLAUDE_INSTALL_SH_URL: &str = "https://claude.ai/install.sh";
#[cfg(windows)]
pub(crate) const CLAUDE_INSTALL_PS1_URL: &str = "https://claude.ai/install.ps1";
#[cfg(windows)]
pub(crate) const CREATE_NO_WINDOW: u32 = 0x08000000;

/// Windows 下隐藏控制台窗口，避免检查/更新时闪出黑框。
pub(crate) fn apply_create_no_window(cmd: &mut Command) {
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    let _ = cmd;
}

/// 探测路径父目录是否可写（用于判断静默更新是否需要提权）。
pub(crate) fn is_parent_dir_writable(path: &Path) -> bool {
    let Some(parent) = path.parent() else {
        return false;
    };
    if !parent.exists() {
        return false;
    }
    let probe = parent.join(format!(".ccm_write_probe_{}", std::process::id()));
    match fs::OpenOptions::new()
        .create_new(true)
        .write(true)
        .open(&probe)
    {
        Ok(_) => {
            let _ = fs::remove_file(&probe);
            true
        }
        Err(_) => false,
    }
}

pub(crate) fn is_user_home_install(path: &Path) -> bool {
    dirs::home_dir()
        .map(|home| path.starts_with(&home))
        .unwrap_or(false)
}

pub(crate) fn shell_escape_double_quoted(s: &str) -> String {
    s.replace('\\', "\\\\").replace('"', "\\\"")
}

pub(crate) fn read_installed_claude_version() -> Result<(String, String), String> {
    let claude_bin = resolve_claude_executable();
    let mut cmd = Command::new(&claude_bin);
    apply_cli_runtime_env(&mut cmd);
    apply_create_no_window(&mut cmd);
    cmd.arg("-v");
    cmd.stdout(Stdio::piped());
    cmd.stderr(Stdio::piped());

    let mut child = cmd
        .spawn()
        .map_err(|e| format!("无法执行 Claude Code（{}）: {}", claude_bin.display(), e))?;
    let started_at = Instant::now();
    loop {
        match child.try_wait() {
            Ok(Some(_)) => break,
            Ok(None) if started_at.elapsed() < CLAUDE_VERSION_TIMEOUT => {
                thread::sleep(Duration::from_millis(50));
            }
            Ok(None) => {
                force_kill_process_tree(&mut child);
                let _ = child.wait();
                return Err(format!(
                    "读取 Claude Code 版本超时（{} 秒）",
                    CLAUDE_VERSION_TIMEOUT.as_secs()
                ));
            }
            Err(e) => {
                force_kill_process_tree(&mut child);
                let _ = child.wait();
                return Err(format!("等待 Claude Code 版本命令失败: {e}"));
            }
        }
    }

    let output = child
        .wait_with_output()
        .map_err(|e| format!("读取 Claude Code 版本输出失败: {e}"))?;
    let stdout = String::from_utf8_lossy(&output.stdout);
    let stderr = String::from_utf8_lossy(&output.stderr);
    let combined = format!("{}\n{}", stdout, stderr);
    let version = parse_claude_version_output(&combined).ok_or_else(|| {
        if combined.trim().is_empty() {
            format!(
                "无法读取 Claude Code 版本（退出码 {}）",
                output.status.code().unwrap_or(-1)
            )
        } else {
            format!("无法解析 Claude Code 版本输出: {}", combined.trim())
        }
    })?;

    Ok((version, claude_bin.display().to_string()))
}

/// npm registry 版本查询源：官方 registry 优先，npmmirror 兜底（国内直连 npmjs 常超时）。
const NPM_LATEST_CANDIDATES: &[&str] = &[
    "https://registry.npmjs.org/@anthropic-ai/claude-code/latest",
    "https://registry.npmmirror.com/@anthropic-ai/claude-code/latest",
];

pub(crate) fn fetch_latest_claude_version() -> Result<String, String> {
    let client = reqwest::blocking::Client::builder()
        .timeout(Duration::from_secs(10))
        .connect_timeout(Duration::from_secs(5))
        .user_agent("CodeCliManager")
        .build()
        .map_err(|e| format!("创建 HTTP 客户端失败: {}", e))?;

    let mut last_err: Option<String> = None;
    for url in NPM_LATEST_CANDIDATES {
        match fetch_npm_latest(&client, url) {
            Ok(version) => return Ok(version),
            Err(e) => {
                last_err = Some(format!("{url}: {e}"));
            }
        }
    }
    Err(last_err.unwrap_or_else(|| "查询 npm 最新版本失败".to_string()))
}

fn fetch_npm_latest(client: &reqwest::blocking::Client, url: &str) -> Result<String, String> {
    let response = client
        .get(url)
        .send()
        .map_err(|e| format!("请求失败: {}", e))?;

    if !response.status().is_success() {
        return Err(format!("HTTP {}", response.status()));
    }

    #[derive(Deserialize)]
    struct NpmLatest {
        version: String,
    }

    let payload: NpmLatest = response
        .json()
        .map_err(|e| format!("解析 npm 响应失败: {}", e))?;
    let version = payload.version.trim().to_string();
    if version.is_empty() {
        return Err("npm 未返回有效版本号".to_string());
    }
    Ok(version)
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ClaudeCodeUpdateInfo {
    pub(crate) installed: Option<String>,
    pub(crate) latest: Option<String>,
    pub(crate) update_available: bool,
    pub(crate) executable_path: Option<String>,
    /// 安装目录可写，或位于用户主目录，可尝试完全静默更新。
    pub(crate) can_silent_update: bool,
    pub(crate) error: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ClaudeCodeSilentUpdateResult {
    pub(crate) success: bool,
    pub(crate) message: String,
    pub(crate) installed: Option<String>,
    pub(crate) latest: Option<String>,
    pub(crate) used_elevation: bool,
}

pub(crate) fn claude_install_allows_silent(path: &str) -> bool {
    let p = PathBuf::from(path);
    is_user_home_install(&p) || is_parent_dir_writable(&p)
}

/// 检查本机 Claude Code 版本与 npm 最新版。
/// CLI 探测和阻塞 HTTP 请求分别在线程池执行，避免占用 Tauri 主线程。
#[tauri::command]
pub async fn check_claude_code_update() -> ClaudeCodeUpdateInfo {
    let installed_task = tauri::async_runtime::spawn_blocking(read_installed_claude_version);
    let latest_task = tauri::async_runtime::spawn_blocking(fetch_latest_claude_version);

    let installed_result = installed_task
        .await
        .unwrap_or_else(|e| Err(format!("Claude Code 版本检查任务失败: {e}")));
    let latest_result = latest_task
        .await
        .unwrap_or_else(|e| Err(format!("npm 版本检查任务失败: {e}")));

    match (installed_result, latest_result) {
        (Ok((installed, path)), Ok(latest)) => ClaudeCodeUpdateInfo {
            update_available: is_version_newer(&latest, &installed),
            can_silent_update: claude_install_allows_silent(&path),
            installed: Some(installed),
            latest: Some(latest),
            executable_path: Some(path),
            error: None,
        },
        (Ok((installed, path)), Err(err)) => ClaudeCodeUpdateInfo {
            update_available: false,
            can_silent_update: claude_install_allows_silent(&path),
            installed: Some(installed),
            latest: None,
            executable_path: Some(path),
            error: Some(err),
        },
        (Err(err), Ok(latest)) => ClaudeCodeUpdateInfo {
            update_available: false,
            can_silent_update: false,
            installed: None,
            latest: Some(latest),
            executable_path: None,
            error: Some(err),
        },
        (Err(installed_err), Err(latest_err)) => ClaudeCodeUpdateInfo {
            update_available: false,
            can_silent_update: false,
            installed: None,
            latest: None,
            executable_path: None,
            error: Some(format!("{}; {}", installed_err, latest_err)),
        },
    }
}

/// 等待子进程完成：实时转发 stdout/stderr 每行给前端（claude-update-progress 事件），
/// 附带总超时与「无输出 stall」检测（120 秒无新输出即中断——npm 网络挂起等场景
/// 不必等满 300/600 秒）。返回（退出状态，合并输出文本）。
pub(crate) fn run_update_child_with_progress(
    app: &AppHandle,
    label: &str,
    timeout: Duration,
    mut child: Child,
) -> Result<(std::process::ExitStatus, String), String> {
    let stdout = child.stdout.take();
    let stderr = child.stderr.take();
    let (tx, rx) = std::sync::mpsc::channel::<String>();
    let mut spawn_reader = |stream: Option<Box<dyn std::io::Read + Send>>| {
        if let Some(stream) = stream {
            let tx = tx.clone();
            std::thread::spawn(move || {
                use std::io::BufRead;
                let reader = std::io::BufReader::new(stream);
                for line in reader.lines() {
                    let Ok(line) = line else { break };
                    if tx.send(line).is_err() {
                        break;
                    }
                }
            });
        }
    };
    spawn_reader(stdout.map(|s| Box::new(s) as Box<dyn std::io::Read + Send>));
    spawn_reader(stderr.map(|s| Box::new(s) as Box<dyn std::io::Read + Send>));
    drop(tx);

    let started_at = Instant::now();
    let mut last_output_at = Instant::now();
    let mut combined = String::new();
    loop {
        // 排空当前可用输出行（非阻塞）
        while let Ok(line) = rx.try_recv() {
            last_output_at = Instant::now();
            let _ = app.emit(
                "claude-update-progress",
                serde_json::json!({ "text": line }),
            );
            if !line.trim().is_empty() {
                combined.push_str(&line);
                combined.push('\n');
            }
        }
        match child.try_wait() {
            Ok(Some(_)) => break,
            Ok(None) if started_at.elapsed() < timeout => {
                // stall：启动 15 秒后若 120 秒无新输出 → 提前中断（网络挂起）
                if started_at.elapsed() > Duration::from_secs(15)
                    && last_output_at.elapsed() > Duration::from_secs(120)
                {
                    force_kill_process_tree(&mut child);
                    let _ = child.wait();
                    return Err(format!("{label}超过 120 秒无输出，已中断"));
                }
                thread::sleep(Duration::from_millis(100));
            }
            Ok(None) => {
                force_kill_process_tree(&mut child);
                let _ = child.wait();
                return Err(format!(
                    "{label}超时（{} 秒）",
                    timeout.as_secs()
                ));
            }
            Err(e) => {
                force_kill_process_tree(&mut child);
                let _ = child.wait();
                return Err(format!("等待 {label} 失败: {e}"));
            }
        }
    }
    // 收尾剩余输出
    while let Ok(line) = rx.try_recv() {
        if !line.trim().is_empty() {
            combined.push_str(&line);
            combined.push('\n');
        }
    }
    let status = child.wait().map_err(|e| format!("读取 {label} 状态失败: {e}"))?;
    Ok((status, combined.trim().to_string()))
}

pub(crate) fn wait_child_with_timeout(
    mut child: Child,
    timeout: Duration,
    label: &str,
) -> Result<std::process::Output, String> {
    let started_at = Instant::now();
    loop {
        match child.try_wait() {
            Ok(Some(_)) => break,
            Ok(None) if started_at.elapsed() < timeout => {
                thread::sleep(Duration::from_millis(100));
            }
            Ok(None) => {
                force_kill_process_tree(&mut child);
                let _ = child.wait();
                return Err(format!(
                    "{}超时（{} 秒）",
                    label,
                    timeout.as_secs()
                ));
            }
            Err(e) => {
                force_kill_process_tree(&mut child);
                let _ = child.wait();
                return Err(format!("等待 {} 失败: {e}", label));
            }
        }
    }
    child
        .wait_with_output()
        .map_err(|e| format!("读取 {} 输出失败: {e}", label))
}

pub(crate) fn output_combined_text(output: &std::process::Output) -> String {
    let stdout = String::from_utf8_lossy(&output.stdout);
    let stderr = String::from_utf8_lossy(&output.stderr);
    format!("{}\n{}", stdout, stderr).trim().to_string()
}

fn run_claude_install_process() -> Result<String, String> {
    #[cfg(target_os = "windows")]
    let mut cmd = {
        let powershell = if Command::new("powershell.exe").arg("-NoProfile").arg("-Command").arg("$PSVersionTable.PSVersion").output().is_ok() {
            "powershell.exe"
        } else {
            "pwsh"
        };
        let mut command = Command::new(powershell);
        command.args([
            "-NoProfile",
            "-ExecutionPolicy",
            "Bypass",
            "-Command",
            &format!("irm {} | iex", CLAUDE_INSTALL_PS1_URL),
        ]);
        command
    };

    #[cfg(not(target_os = "windows"))]
    let mut cmd = {
        let mut command = Command::new("/bin/bash");
        command.args(["-c", &format!("curl -fsSL {} | bash", CLAUDE_INSTALL_SH_URL)]);
        command
    };

    apply_cli_runtime_env(&mut cmd);
    apply_create_no_window(&mut cmd);
    cmd.stdout(Stdio::piped());
    cmd.stderr(Stdio::piped());

    let child = cmd
        .spawn()
        .map_err(|e| format!("启动 Claude Code 安装程序失败: {e}"))?;
    let output = wait_child_with_timeout(child, CLAUDE_INSTALL_TIMEOUT, "Claude Code 安装")?;
    let combined = output_combined_text(&output);
    if output.status.success() {
        Ok(if combined.is_empty() {
            "Claude Code 安装脚本执行完成".to_string()
        } else {
            combined
        })
    } else {
        Err(if combined.is_empty() {
            format!(
                "Claude Code 安装失败（退出码 {}）",
                output.status.code().unwrap_or(-1)
            )
        } else {
            combined
        })
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ClaudeCodeInstallResult {
    pub(crate) success: bool,
    pub(crate) message: String,
    pub(crate) installed: Option<String>,
    pub(crate) executable_path: Option<String>,
}

/// 执行 Claude 官方安装脚本，并确认安装后可以读取版本。
#[tauri::command]
pub async fn run_claude_code_install() -> Result<ClaudeCodeInstallResult, String> {
    tauri::async_runtime::spawn_blocking(|| {
        let message = run_claude_install_process()?;
        let (installed, executable_path) = match read_installed_claude_version() {
            Ok((version, path)) => (Some(version), Some(path)),
            Err(err) => {
                return Err(format!("安装脚本已完成，但未检测到可用的 Claude Code: {err}"));
            }
        };
        Ok(ClaudeCodeInstallResult {
            success: true,
            message,
            installed,
            executable_path,
        })
    })
    .await
    .map_err(|e| format!("Claude Code 安装任务失败: {e}"))?
}

pub(crate) fn looks_like_permission_error(text: &str) -> bool {
    let lower = text.to_ascii_lowercase();
    lower.contains("eacces")
        || lower.contains("permission denied")
        || lower.contains("operation not permitted")
        || lower.contains("access is denied")
        || lower.contains("requires elevated")
        || lower.contains("need to be root")
        || lower.contains("sudo")
}

/// `claude update` 走 npm 全局安装失败时的典型文案；应回退到 `claude install` 原生安装。
pub(crate) fn looks_like_global_update_failed(text: &str) -> bool {
    let lower = text.to_ascii_lowercase();
    lower.contains("npm global")
        || lower.contains("isn't writable")
        || lower.contains("is not writable")
        || lower.contains("native install")
        || lower.contains("global install")
        || lower.contains("update installation failed")
        || text.contains("原生安装")
        || text.contains("全局安装")
        || text.contains("更新安装失败")
        || text.contains("使用 claude 工具")
}

pub(crate) fn should_fallback_claude_update(text: &str) -> bool {
    looks_like_permission_error(text) || looks_like_global_update_failed(text)
}

/// 在用户可写目录静默执行 `claude update`。
pub(crate) fn run_claude_update_process(app: &AppHandle, claude_bin: &Path) -> Result<String, String> {
    let mut cmd = Command::new(claude_bin);
    apply_cli_runtime_env(&mut cmd);
    apply_create_no_window(&mut cmd);
    cmd.arg("update");
    cmd.stdout(Stdio::piped());
    cmd.stderr(Stdio::piped());

    let child = cmd
        .spawn()
        .map_err(|e| format!("启动 Claude Code 更新失败（{}）: {}", claude_bin.display(), e))?;
    let (status, combined) =
        run_update_child_with_progress(app, "Claude Code 更新", CLAUDE_UPDATE_TIMEOUT, child)?;
    if status.success() {
        Ok(if combined.is_empty() {
            "Claude Code 已更新".to_string()
        } else {
            combined
        })
    } else {
        Err(if combined.is_empty() {
            format!(
                "Claude Code 更新失败（退出码 {}）",
                status.code().unwrap_or(-1)
            )
        } else {
            combined
        })
    }
}

/// macOS：通过系统授权对话框提权执行更新（不打开 Terminal）。
#[cfg(target_os = "macos")]
pub(crate) fn run_claude_update_elevated_macos(app: &AppHandle, claude_bin: &Path) -> Result<String, String> {
    let bin = shell_escape_double_quoted(&claude_bin.display().to_string());
    let shell = format!(
        "do shell script \"\\\"{}\\\" update\" with administrator privileges",
        bin
    );
    let mut cmd = Command::new("osascript");
    cmd.args(["-e", &shell]);
    cmd.stdout(Stdio::piped());
    cmd.stderr(Stdio::piped());
    let child = cmd
        .spawn()
        .map_err(|e| format!("启动系统授权更新失败: {}", e))?;
    let (status, combined) = run_update_child_with_progress(
        app,
        "系统授权更新",
        CLAUDE_UPDATE_TIMEOUT,
        child,
    )?;
    if status.success() {
        Ok(if combined.is_empty() {
            "Claude Code 已更新（已使用管理员权限）".to_string()
        } else {
            combined
        })
    } else {
        let msg = if combined.is_empty() {
            format!(
                "系统授权更新失败（退出码 {}）",
                status.code().unwrap_or(-1)
            )
        } else {
            combined
        };
        // 用户取消授权
        if msg.to_ascii_lowercase().contains("user canceled")
            || msg.contains("用户已取消")
            || msg.contains("-128")
        {
            Err("已取消管理员授权".to_string())
        } else {
            Err(msg)
        }
    }
}

/// 通过官方原生安装器更新/迁移（无需 sudo；npm 全局目录不可写时的推荐路径）。
pub(crate) fn run_claude_native_install(app: &AppHandle, claude_bin: &Path) -> Result<String, String> {
    let mut cmd = Command::new(claude_bin);
    apply_cli_runtime_env(&mut cmd);
    apply_create_no_window(&mut cmd);
    // latest + --force：即使已有 npm 安装也迁移到原生构建
    cmd.args(["install", "latest", "--force"]);
    cmd.stdout(Stdio::piped());
    cmd.stderr(Stdio::piped());

    let child = cmd.spawn().map_err(|e| {
        format!(
            "启动 Claude Code 原生安装失败（{}）: {}",
            claude_bin.display(),
            e
        )
    })?;
    let (status, combined) = run_update_child_with_progress(
        app,
        "Claude Code 原生安装",
        CLAUDE_INSTALL_TIMEOUT,
        child,
    )?;
    if status.success() {
        Ok(if combined.is_empty() {
            "已通过原生安装器完成更新".to_string()
        } else {
            combined
        })
    } else {
        Err(if combined.is_empty() {
            format!(
                "Claude Code 原生安装失败（退出码 {}）",
                status.code().unwrap_or(-1)
            )
        } else {
            combined
        })
    }
}

/// 当系统目录不可写时，静默安装到用户 `~/.local`（无需 sudo）。
pub(crate) fn run_npm_user_prefix_install(app: &AppHandle) -> Result<String, String> {
    let home = dirs::home_dir().ok_or_else(|| "无法定位用户主目录".to_string())?;
    let prefix = home.join(".local");
    let bin_dir = prefix.join("bin");
    fs::create_dir_all(&bin_dir).map_err(|e| format!("创建 ~/.local/bin 失败: {}", e))?;

    let mut cmd = Command::new("npm");
    apply_cli_runtime_env(&mut cmd);
    apply_create_no_window(&mut cmd);
    cmd.args([
        "install",
        "-g",
        "--prefix",
        prefix.to_string_lossy().as_ref(),
        "@anthropic-ai/claude-code@latest",
    ]);
    cmd.stdout(Stdio::piped());
    cmd.stderr(Stdio::piped());

    let child = cmd
        .spawn()
        .map_err(|e| format!("启动 npm 用户目录安装失败: {}（请确认已安装 Node.js/npm）", e))?;
    let (status, combined) = run_update_child_with_progress(
        app,
        "npm 用户目录安装",
        CLAUDE_INSTALL_TIMEOUT,
        child,
    )?;
    if status.success() {
        Ok(format!(
            "已安装到 {}。若命令行仍指向旧路径，请优先将 ~/.local/bin 加入 PATH。",
            bin_dir.display()
        ))
    } else {
        Err(if combined.is_empty() {
            format!(
                "npm 用户目录安装失败（退出码 {}）",
                status.code().unwrap_or(-1)
            )
        } else {
            combined
        })
    }
}

pub(crate) fn run_claude_code_update_silent_blocking(
    app: &AppHandle,
) -> Result<ClaudeCodeSilentUpdateResult, String> {
    let (installed_before, path) = read_installed_claude_version()?;
    let claude_bin = PathBuf::from(&path);
    let latest = fetch_latest_claude_version().ok();
    let can_silent = claude_install_allows_silent(&path);

    let mut used_elevation = false;
    let mut errors: Vec<String> = Vec::new();
    let mut message: Option<String> = None;

    // 1) 可写安装：先走 `claude update`
    if can_silent {
        match run_claude_update_process(app, &claude_bin) {
            Ok(msg) => message = Some(msg),
            Err(err) if should_fallback_claude_update(&err) => {
                errors.push(format!("原地更新: {err}"));
            }
            Err(err) => return Err(err),
        }
    } else {
        errors.push("当前安装目录不可写，跳过原地更新".to_string());
    }

    // 2) npm 全局更新失败时的官方推荐：原生安装（无需 sudo）
    if message.is_none() {
        match run_claude_native_install(app, &claude_bin) {
            Ok(msg) => message = Some(msg),
            Err(err) => errors.push(format!("原生安装: {err}")),
        }
    }

    // 3) macOS：系统授权再试一次原地更新
    #[cfg(target_os = "macos")]
    if message.is_none() {
        used_elevation = true;
        match run_claude_update_elevated_macos(app, &claude_bin) {
            Ok(msg) => message = Some(msg),
            Err(err) => errors.push(format!("管理员授权: {err}")),
        }
    }

    // 4) 最后回退：npm 安装到 ~/.local
    if message.is_none() {
        match run_npm_user_prefix_install(app) {
            Ok(msg) => message = Some(msg),
            Err(err) => {
                errors.push(format!("用户目录 npm 安装: {err}"));
                return Err(format!("静默更新失败：\n{}", errors.join("\n")));
            }
        }
    }

    let message = message.unwrap_or_else(|| "Claude Code 已更新".to_string());

    // 更新后重新读版本；用户目录新装可能暂时仍解析到旧路径，尽量再探测一次
    let installed_after = read_installed_claude_version()
        .map(|(v, _)| v)
        .unwrap_or(installed_before);

    Ok(ClaudeCodeSilentUpdateResult {
        success: true,
        message,
        installed: Some(installed_after),
        latest,
        used_elevation,
    })
}

/// 静默更新 Claude Code：优先 `claude update`，失败则回退原生安装 / 提权 / 用户目录 npm。
#[tauri::command]
pub async fn run_claude_code_update_silent(
    app: AppHandle,
) -> Result<ClaudeCodeSilentUpdateResult, String> {
    tauri::async_runtime::spawn_blocking(move || run_claude_code_update_silent_blocking(&app))
        .await
        .map_err(|e| format!("静默更新任务失败: {e}"))?
}
