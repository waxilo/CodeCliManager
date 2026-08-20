use serde::Serialize;
use std::fs;
use std::net::{SocketAddr, TcpStream};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::Mutex;
use std::thread;
use std::time::Duration;
use tauri::{AppHandle, Manager, State};

use crate::claude::runtime::apply_cli_runtime_env;
use crate::claude::updater::{run_update_child_with_progress, CLAUDE_INSTALL_TIMEOUT};
use crate::config::load_api_profiles_store;
use crate::model_fetch::is_deepseek_base_url;

/// DSH Web UI 默认端口（与 dsh web 默认一致）
pub(crate) const DSH_PORT: u16 = 3080;
pub(crate) const DSH_WEB_URL: &str = "http://127.0.0.1:3080";
const DSH_START_WAIT: Duration = Duration::from_secs(20);
const DSH_PROGRESS_EVENT: &str = "dsh-progress";

/// 应用持有的 DSH 服务子进程（由 CCM 启动时记录，退出时兜底清理）
pub struct DshState(pub Mutex<Option<Child>>);

impl Default for DshState {
    fn default() -> Self {
        DshState(Mutex::new(None))
    }
}

#[derive(Serialize, Clone, Default)]
#[serde(rename_all = "camelCase")]
pub(crate) struct DshStatusData {
    pub(crate) installed_version: Option<String>,
    pub(crate) latest_version: Option<String>,
    pub(crate) running: bool,
    pub(crate) port: u16,
    pub(crate) error: Option<String>,
}

fn is_port_open(port: u16) -> bool {
    let addr: SocketAddr = format!("127.0.0.1:{port}").parse().unwrap_or_else(|_| {
        SocketAddr::from(([127, 0, 0, 1], 3080))
    });
    TcpStream::connect_timeout(&addr, Duration::from_millis(300)).is_ok()
}

/// 候选的 CLI 可执行目录（npm / dsh 常见安装位置；与 apply_cli_runtime_env 对齐）
fn cli_bin_dirs() -> Vec<PathBuf> {
    let home = dirs::home_dir().unwrap_or_else(|| PathBuf::from("."));
    let mut dirs: Vec<PathBuf> = vec![
        home.join(".local/bin"),
        home.join(".npm-global/bin"),
        home.join("bin"),
        PathBuf::from("/opt/homebrew/bin"),
        PathBuf::from("/usr/local/bin"),
    ];
    #[cfg(target_os = "windows")]
    dirs.extend([
        home.join("AppData").join("Roaming").join("npm"),
        home.join("AppData").join("Local").join("Programs").join("nodejs"),
        PathBuf::from("C:\\Program Files\\nodejs"),
        PathBuf::from("C:\\Program Files (x86)\\nodejs"),
    ]);
    // 当前进程 PATH 里的目录也纳入（用户自定义安装位置）
    if let Ok(path_var) = std::env::var("PATH") {
        for seg in path_var.split(if cfg!(target_os = "windows") { ";" } else { ":" }) {
            if !seg.is_empty() {
                dirs.push(PathBuf::from(seg));
            }
        }
    }
    dirs
}

/// 解析可执行文件完整路径。
/// - Windows：npm/dsh 是 .cmd 批处理，且 CreateProcess 按调用进程 PATH 搜索（不读子进程 env），
///   必须显式给出完整路径（.cmd 优先，其次 .exe）；
/// - Unix：execvpe 会按子进程修改后的 PATH 搜索，直接返回命令名即可。
fn resolve_executable(cmd_name: &str) -> Option<PathBuf> {
    #[cfg(target_os = "windows")]
    {
        for dir in cli_bin_dirs() {
            for name in [format!("{cmd_name}.cmd"), format!("{cmd_name}.exe"), cmd_name.to_string()] {
                let p = dir.join(&name);
                if p.is_file() {
                    return Some(p);
                }
            }
        }
        None
    }
    #[cfg(not(target_os = "windows"))]
    {
        let _ = cmd_name;
        Some(PathBuf::from(cmd_name))
    }
}

/// 带超时的命令捕获：避免 npm view 等网络命令挂起阻塞状态查询。
/// 超时或失败返回 None（调用方按「未知/未安装」处理）。
fn run_command_capture(program: &str, args: &[&str], timeout: Duration) -> Option<String> {
    let executable = resolve_executable(program)?;
    let mut cmd = Command::new(executable);
    cmd.args(args);
    apply_cli_runtime_env(&mut cmd);
    cmd.stdout(Stdio::piped());
    cmd.stderr(Stdio::piped());
    let mut child = cmd.spawn().ok()?;
    let deadline = std::time::Instant::now() + timeout;
    loop {
        match child.try_wait() {
            Ok(Some(status)) => {
                if !status.success() {
                    return None;
                }
                use std::io::Read;
                let mut out = String::new();
                if let Some(mut stdout) = child.stdout.take() {
                    let _ = stdout.read_to_string(&mut out);
                }
                let text = out.trim().to_string();
                return if text.is_empty() { None } else { Some(text) };
            }
            Ok(None) if std::time::Instant::now() < deadline => {
                thread::sleep(Duration::from_millis(100));
            }
            _ => {
                let _ = child.kill();
                let _ = child.wait();
                return None;
            }
        }
    }
}

/// 当前活跃 API profile 为 DeepSeek 时返回其明文 Key（仅 Rust 侧使用）。
fn active_deepseek_api_key() -> Option<String> {
    let store = load_api_profiles_store();
    let profile = store
        .profiles
        .iter()
        .find(|p| Some(&p.id) == store.active_profile_id.as_ref())?;
    if !is_deepseek_base_url(&profile.base_url) {
        return None;
    }
    let key = profile.api_key.trim();
    if key.is_empty() {
        None
    } else {
        Some(key.to_string())
    }
}

/// 同步快速状态（启动/停止后立即返回用；最新版本由前端随后用 dsh_status 重取）
fn build_quick_status() -> DshStatusData {
    DshStatusData {
        installed_version: detect_installed_dsh_version(),
        latest_version: None,
        running: is_port_open(DSH_PORT),
        port: DSH_PORT,
        error: None,
    }
}

/// 候选的 npm 全局包目录（node_modules 根）。不依赖 npm 命令——
/// dsh/npm 是 node shebang 脚本，GUI 环境 PATH 不含 node 时（nvm/volta/fnm 用户）直接失败。
fn npm_global_node_modules_candidates() -> Vec<PathBuf> {
    let home = dirs::home_dir().unwrap_or_else(|| PathBuf::from("."));
    let mut candidates: Vec<PathBuf> = vec![
        PathBuf::from("/usr/local/lib/node_modules"),
        PathBuf::from("/opt/homebrew/lib/node_modules"),
        home.join(".local/lib/node_modules"),
        home.join(".npm-global/lib/node_modules"),
        home.join("bin/node_modules"),
    ];
    #[cfg(target_os = "windows")]
    candidates.extend([
        dirs::data_local_dir()
            .unwrap_or_default()
            .join("npm/node_modules"),
        dirs::data_dir().unwrap_or_default().join("npm/node_modules"),
    ]);
    candidates
}

/// 从某个全局包目录读取 @deepseek-ai/dsh 的已装版本（纯文件系统）
fn read_dsh_version_from_dir(dir: &Path) -> Option<String> {
    let pkg = dir.join("@deepseek-ai").join("dsh").join("package.json");
    let content = fs::read_to_string(&pkg).ok()?;
    let parsed: serde_json::Value = serde_json::from_str(&content).ok()?;
    let v = parsed.get("version")?.as_str()?.trim();
    if v.is_empty() {
        None
    } else {
        Some(v.to_string())
    }
}

/// 已安装版本：优先直读全局包目录 package.json（纯文件系统，无 shebang/PATH 依赖）；
/// 找不到时回退 `dsh --version` 命令（带补充 PATH 与超时）。
fn detect_installed_dsh_version() -> Option<String> {
    for dir in npm_global_node_modules_candidates() {
        if let Some(v) = read_dsh_version_from_dir(&dir) {
            eprintln!("[dsh] 已装版本从 {} 读取: {v}", dir.display());
            return Some(v);
        }
    }
    let fallback = run_command_capture("dsh", &["--version"], Duration::from_secs(5));
    eprintln!("[dsh] package.json 未找到，命令回退 dsh --version: {:?}", fallback);
    fallback
}

/// 最新版本：直连 npm registry API（不依赖 npm 命令，超时可控）。
async fn fetch_latest_dsh_version() -> Option<String> {
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(8))
        .build()
        .ok()?;
    let url = "https://registry.npmjs.org/@deepseek-ai/dsh/latest";
    let resp = match client.get(url).send().await {
        Ok(r) => r,
        Err(e) => {
            eprintln!("[dsh] registry 请求失败: {e}");
            return None;
        }
    };
    if !resp.status().is_success() {
        eprintln!("[dsh] registry 返回非成功状态: {}", resp.status());
        return None;
    }
    let body = match resp.text().await {
        Ok(b) => b,
        Err(e) => {
            eprintln!("[dsh] registry 响应读取失败: {e}");
            return None;
        }
    };
    let parsed = match serde_json::from_str::<serde_json::Value>(&body) {
        Ok(v) => v,
        Err(e) => {
            eprintln!("[dsh] registry 响应解析失败: {e}");
            return None;
        }
    };
    let version = parsed
        .get("version")
        .and_then(|v| v.as_str())
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty());
    eprintln!("[dsh] registry 最新版本查询结果: {:?}", version);
    version
}

/// 查询 DSH 状态：已装版本 / 最新版本 / 服务是否在运行
#[tauri::command]
pub async fn dsh_status() -> DshStatusData {
    eprintln!("[dsh] dsh_status 被调用（版本/状态查询）");
    let installed = detect_installed_dsh_version();
    let latest = fetch_latest_dsh_version().await;
    let running = is_port_open(DSH_PORT);
    eprintln!(
        "[dsh] 已装版本={:?} 最新版本={:?} 运行中={}",
        installed, latest, running
    );
    DshStatusData {
        installed_version: installed,
        latest_version: latest,
        running,
        port: DSH_PORT,
        error: None,
    }
}

/// 一键安装 / 更新 DSH（npm 全局包，逐行进度转发给前端）
#[tauri::command]
pub async fn dsh_install(app: AppHandle) -> Result<String, String> {
    run_npm_dsh_install(&app).await
}

async fn run_npm_dsh_install(app: &AppHandle) -> Result<String, String> {
    let npm = resolve_executable("npm")
        .ok_or_else(|| "未找到 npm：请先安装 Node.js/npm（或确认其已在 PATH 中）".to_string())?;
    let mut cmd = Command::new(npm);
    apply_cli_runtime_env(&mut cmd);
    cmd.args(["install", "-g", "@deepseek-ai/dsh"]);
    cmd.stdout(Stdio::piped());
    cmd.stderr(Stdio::piped());
    let child = cmd
        .spawn()
        .map_err(|e| format!("启动 npm 安装失败: {e}（请确认已安装 Node.js/npm）"))?;
    let (status, combined) = run_update_child_with_progress(
        app,
        "DSH 安装",
        CLAUDE_INSTALL_TIMEOUT,
        child,
        DSH_PROGRESS_EVENT,
    )?;
    if status.success() {
        Ok(if combined.is_empty() {
            "DSH 已安装/更新".to_string()
        } else {
            combined
        })
    } else {
        Err(if combined.is_empty() {
            format!("DSH 安装失败（退出码 {}）", status.code().unwrap_or(-1))
        } else {
            combined
        })
    }
}

/// 启动 DSH Web 服务（已运行则直接复用），等待端口就绪后返回状态
#[tauri::command]
pub fn dsh_start(state: State<DshState>) -> Result<DshStatusData, String> {
    if is_port_open(DSH_PORT) {
        // 已有实例（可能是外部启动的 dsh）：直接复用
        return Ok(build_quick_status());
    }
    let dsh_bin = resolve_executable("dsh")
        .ok_or_else(|| "未找到 dsh 命令：请先在「设置 → DSH 更新」中安装".to_string())?;
    let mut cmd = Command::new(dsh_bin);
    apply_cli_runtime_env(&mut cmd);
    // 自动填充 API Key：当前活跃配置为 DeepSeek 时注入 DEEPSEEK_API_KEY，
    // DSH 凭据层优先继承环境变量（dsh-credentials-local），首次进入无需手动填写。
    // 明文 Key 只在 Rust 侧读取，不经过前端。
    if let Some(key) = active_deepseek_api_key() {
        cmd.env("DEEPSEEK_API_KEY", key);
    }
    cmd.args(["web", "--port", &DSH_PORT.to_string(), "--no-open"]);
    // 服务日志不转发（避免与进度事件混淆），直接丢弃
    cmd.stdout(Stdio::null());
    cmd.stderr(Stdio::null());
    let child = cmd
        .spawn()
        .map_err(|e| format!("启动 DSH 失败: {e}（请先在设置中安装 DSH）"))?;
    *state.0.lock().unwrap() = Some(child);

    // 轮询端口就绪（最长 20 秒）
    let deadline = std::time::Instant::now() + DSH_START_WAIT;
    while std::time::Instant::now() < deadline {
        if is_port_open(DSH_PORT) {
            return Ok(build_quick_status());
        }
        thread::sleep(Duration::from_millis(300));
    }
    // 启动超时：kill 自起进程，避免残留
    if let Some(mut child) = state.0.lock().unwrap().take() {
        let _ = child.kill();
        let _ = child.wait();
    }
    Err("DSH 服务启动超时（20 秒内端口未就绪），请查看 dsh web 输出".to_string())
}

/// 停止由 CCM 启动的 DSH 服务（外部实例不受影响）
#[tauri::command]
pub fn dsh_stop(state: State<DshState>) -> Result<DshStatusData, String> {
    if let Some(mut child) = state.0.lock().unwrap().take() {
        let _ = child.kill();
        let _ = child.wait();
    }
    Ok(build_quick_status())
}

/// 应用退出兜底：清理 CCM 启动的 DSH 服务进程
pub fn shutdown_dsh_process(app: &AppHandle) {
    let child = app
        .try_state::<DshState>()
        .and_then(|s| s.0.lock().unwrap().take());
    if let Some(mut child) = child {
        let _ = child.kill();
        let _ = child.wait();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn port_check_returns_bool_without_panicking() {
        // 任意未占用端口应返回 false；已占用（本测试进程内自开）应返回 true
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        assert!(is_port_open(port));
        assert!(!is_port_open(1)); // 保留端口，必然不可连
    }

    #[test]
    fn status_fields_default_safely() {
        let status = DshStatusData::default();
        assert_eq!(status.port, 0);
        assert!(!status.running);
        assert!(status.installed_version.is_none());
    }

    #[test]
    fn status_serializes_with_camel_case_fields() {
        // 前后端字段契约：camelCase（与前端 DshStatusData 类型一致）
        let status = DshStatusData {
            installed_version: Some("1.2.3".to_string()),
            latest_version: None,
            running: true,
            port: 3080,
            error: None,
        };
        let json = serde_json::to_string(&status).unwrap();
        assert!(json.contains("\"installedVersion\""));
        assert!(json.contains("\"latestVersion\""));
        assert!(json.contains("\"running\""));
        assert!(!json.contains("installed_version"));
    }

    #[test]
    fn cli_bin_dirs_include_current_path() {
        let dirs = cli_bin_dirs();
        assert!(dirs.len() >= 5);
        // 当前 PATH 的目录被纳入（自定义安装位置可被解析到）；分隔符按平台（Windows 为 ';'）
        if let Ok(path_var) = std::env::var("PATH") {
            let sep = if cfg!(target_os = "windows") { ";" } else { ":" };
            let first = path_var.split(sep).next().unwrap_or("");
            if !first.is_empty() {
                assert!(
                    dirs.iter().any(|d| d.to_string_lossy().eq_ignore_ascii_case(first)),
                    "PATH 首段 {first} 应被 cli_bin_dirs 纳入"
                );
            }
        }
    }

    #[test]
    fn resolve_executable_unix_returns_name() {
        #[cfg(not(target_os = "windows"))]
        {
            assert_eq!(resolve_executable("dsh").as_deref(), Some(std::path::Path::new("dsh")));
        }
        #[cfg(target_os = "windows")]
        {
            // Windows 上若本机恰好有 npm 则能解析到完整路径
            let _ = resolve_executable("npm");
        }
    }

    #[test]
    fn dsh_port_is_3080() {
        assert_eq!(DSH_PORT, 3080);
        assert_eq!(DSH_WEB_URL, "http://127.0.0.1:3080");
    }

    #[test]
    fn reads_dsh_version_from_package_json() {
        let dir = std::env::temp_dir().join(format!("ccm-dsh-test-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(dir.join("@deepseek-ai/dsh")).unwrap();
        fs::write(
            dir.join("@deepseek-ai/dsh/package.json"),
            r#"{"name":"@deepseek-ai/dsh","version":"9.9.9-test"}"#,
        )
        .unwrap();
        assert_eq!(
            read_dsh_version_from_dir(&dir).as_deref(),
            Some("9.9.9-test")
        );
        // 目录缺失 / 无 version 字段 → None
        assert_eq!(read_dsh_version_from_dir(&dir.join("missing")), None);
        fs::write(dir.join("@deepseek-ai/dsh/package.json"), r#"{"name":"x"}"#).unwrap();
        assert_eq!(read_dsh_version_from_dir(&dir), None);
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn npm_global_candidates_include_common_paths() {
        let candidates = npm_global_node_modules_candidates();
        assert!(candidates.iter().any(|p| p.ends_with("node_modules")));
        assert!(candidates.len() >= 4);
        // 当前机器真实安装位置应被覆盖（集成性质：本机 /usr/local/lib/node_modules）
        #[cfg(target_os = "macos")]
        assert!(candidates.contains(&PathBuf::from("/usr/local/lib/node_modules")));
    }
}
