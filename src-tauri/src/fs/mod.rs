use base64::{engine::general_purpose::STANDARD, Engine as _};
use serde::Serialize;
use std::fs;
use std::io::Write;
use std::path::{Component, Path, PathBuf};
use std::process::Command;

const MAX_PROJECT_FILE_ENTRIES: usize = 20_000;
const MAX_CLIPBOARD_IMAGE_BYTES: usize = 25 * 1024 * 1024;
const MAX_CLIPBOARD_TEXT_BYTES: usize = 25 * 1024 * 1024;
/// 单次文件读取的大小上限：防止一次读入超大文件导致整个 Tauri 进程 OOM。
const MAX_READABLE_FILE_BYTES: u64 = 25 * 1024 * 1024;

// 确保目录存在：先验证，不存在则尝试创建
pub(crate) fn resolve_or_create_dir(cwd: &str) -> Option<String> {
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

pub(crate) fn collect_files(root: &Path, dir: &Path, out: &mut Vec<String>) {
    if out.len() >= MAX_PROJECT_FILE_ENTRIES {
        return;
    }
    if let Ok(entries) = fs::read_dir(dir) {
        for entry in entries.flatten() {
            if out.len() >= MAX_PROJECT_FILE_ENTRIES {
                break;
            }
            let Ok(file_type) = entry.file_type() else {
                continue;
            };
            // 不跟随目录 symlink，避免逃逸项目根目录及递归环。
            if file_type.is_symlink() {
                continue;
            }
            let path = entry.path();
            let file_name = path.file_name().and_then(|n| n.to_str()).unwrap_or("");
            // 跳过隐藏文件和常见忽略目录
            if file_name.starts_with('.') {
                continue;
            }
            if file_name == "node_modules" || file_name == "target" || file_name == "dist"
                || file_name == ".next" || file_name == "__pycache__" || file_name == "vendor"
                || file_name == "build" || file_name == ".turbo" || file_name == ".cache"
            {
                continue;
            }
            if let Ok(rel) = path.strip_prefix(root) {
                let mut abs_str = root.join(rel).to_string_lossy().to_string();
                if file_type.is_dir() {
                    abs_str.push('/');
                }
                out.push(abs_str);
                if file_type.is_dir() {
                    collect_files(root, &path, out);
                }
            }
        }
    }
}

// ── 文件引用功能：列出项目文件 ─────────────────────────────────────
/// 递归列出项目目录下的所有文件和目录（排除隐藏目录、node_modules 等）
#[tauri::command]
pub fn list_project_files(project_dir: String) -> Result<Vec<String>, String> {
    let root = Path::new(&project_dir);
    if !root.is_dir() {
        return Err(format!("目录不存在: {}", project_dir));
    }
    // 统一为规范化绝对路径，保证前端收到的文件引用是可读取的绝对路径。
    let root = root
        .canonicalize()
        .map_err(|e| format!("无法解析目录: {project_dir} ({e})"))?;
    let mut files = Vec::new();
    collect_files(&root, &root, &mut files);
    // 排序：目录在前，文件在后，各自按字母序
    files.sort_by(|a, b| {
        let a_is_dir = a.ends_with('/');
        let b_is_dir = b.ends_with('/');
        b_is_dir.cmp(&a_is_dir).then_with(|| a.cmp(b))
    });
    Ok(files)
}

/// 查询项目目录当前 git 分支；非仓库或不在 git 中时返回 None。
#[tauri::command]
pub fn get_git_branch(project_dir: String) -> Result<Option<String>, String> {
    let dir = project_dir.trim();
    if dir.is_empty() {
        return Ok(None);
    }
    let root = Path::new(dir);
    if !root.is_dir() {
        return Ok(None);
    }

    let mut branch_cmd = Command::new("git");
    crate::proc_guard::suppress_console_window(&mut branch_cmd);
    let output = branch_cmd
        .args(["-C", dir, "branch", "--show-current"])
        .output()
        .map_err(|e| format!("执行 git 失败: {}", e))?;

    if !output.status.success() {
        return Ok(None);
    }

    let branch = String::from_utf8_lossy(&output.stdout).trim().to_string();
    if !branch.is_empty() {
        return Ok(Some(branch));
    }

    // detached HEAD：展示短 commit
    let mut head_cmd = Command::new("git");
    crate::proc_guard::suppress_console_window(&mut head_cmd);
    let head = head_cmd
        .args(["-C", dir, "rev-parse", "--short", "HEAD"])
        .output()
        .map_err(|e| format!("执行 git 失败: {}", e))?;
    if !head.status.success() {
        return Ok(None);
    }
    let sha = String::from_utf8_lossy(&head.stdout).trim().to_string();
    if sha.is_empty() {
        return Ok(None);
    }
    Ok(Some(format!("detached@{sha}")))
}

// ── 文件引用功能：读取文件内容 ──────────────────────────────────────
/// 校验可读路径：canonicalize 解析符号链接/`..`，并限制在用户主目录内，
/// 作为 CSP 之外的纵深防御，避免前端被注入时读取系统级文件。
fn validate_readable_path(file_path: &str) -> Result<PathBuf, String> {
    let canonical = Path::new(file_path)
        .canonicalize()
        .map_err(|e| format!("文件不存在: {file_path} ({e})"))?;
    if !canonical.is_file() {
        return Err(format!("文件不存在: {}", file_path));
    }
    let metadata = std::fs::metadata(&canonical)
        .map_err(|e| format!("读取文件信息失败: {file_path} ({e})"))?;
    if metadata.len() > MAX_READABLE_FILE_BYTES {
        return Err(format!(
            "文件过大（{} 字节），仅支持读取 {} 字节以内的文件",
            metadata.len(),
            MAX_READABLE_FILE_BYTES
        ));
    }
    if let Some(home) = dirs::home_dir() {
        // Windows 上 canonicalize() 会加上 `\\?\` 扩展长度前缀，而 dirs::home_dir()
        // 从不带这个前缀，导致 canonical.starts_with(&home) 在 Windows 上永远为 false
        // （所有文件预览请求都被误判为「不在用户目录内」而拒绝）。把 home 也 canonicalize
        // 一次，让两边前缀口径一致；home 目录本身不存在/无法解析时才回退用原始 home 比较。
        let canonical_home = home.canonicalize().unwrap_or(home);
        if !canonical.starts_with(&canonical_home) {
            return Err(format!("仅允许读取用户目录内的文件: {}", file_path));
        }
    }
    Ok(canonical)
}

#[tauri::command]
pub fn read_file_content(file_path: String) -> Result<String, String> {
    let path = validate_readable_path(&file_path)?;
    fs::read_to_string(&path).map_err(|e| format!("读取文件失败: {}", e))
}

#[tauri::command]
pub async fn export_markdown(
    app: tauri::AppHandle,
    suggested_file_name: String,
    content: String,
) -> Result<bool, String> {
    let suggested = Path::new(suggested_file_name.trim());
    if suggested.components().count() != 1
        || !matches!(suggested.components().next(), Some(Component::Normal(_)))
        || suggested.extension().and_then(|ext| ext.to_str()) != Some("md")
    {
        return Err("导出文件名无效".to_string());
    }
    if content.len() > 50 * 1024 * 1024 {
        return Err("导出内容过大".to_string());
    }
    let file_name = suggested_file_name.trim().to_string();
    let selected = tauri::async_runtime::spawn_blocking(move || {
        use tauri_plugin_dialog::DialogExt;
        app.dialog()
            .file()
            .set_file_name(file_name)
            .add_filter("Markdown", &["md"])
            .blocking_save_file()
    })
    .await
    .map_err(|e| format!("打开保存对话框失败: {e}"))?;
    let Some(selected) = selected else {
        return Ok(false);
    };
    let path = selected
        .into_path()
        .map_err(|e| format!("保存路径无效: {e}"))?;
    fs::write(&path, content).map_err(|e| format!("导出 {} 失败: {e}", path.display()))?;
    Ok(true)
}

fn validate_clipboard_upload_name<'a>(
    file_name: &'a str,
    extensions: &[&str],
    kind: &str,
) -> Result<&'a str, String> {
    let trimmed = file_name.trim();
    if trimmed.is_empty() || trimmed != file_name {
        return Err("文件名无效".to_string());
    }
    let path = Path::new(trimmed);
    if path.components().count() != 1
        || !matches!(path.components().next(), Some(Component::Normal(_)))
    {
        return Err("文件名必须是单一安全路径组件".to_string());
    }
    let lower = trimmed.to_ascii_lowercase();
    let valid_extension = extensions
        .iter()
        .any(|extension| lower.ends_with(extension));
    let valid_chars = trimmed
        .chars()
        .all(|ch| ch.is_ascii_alphanumeric() || matches!(ch, '-' | '_' | '.'));
    if !valid_extension || !valid_chars || trimmed.starts_with('.') {
        return Err(format!("仅允许安全的{kind}文件名"));
    }
    Ok(trimmed)
}

fn validate_clipboard_file_name(file_name: &str) -> Result<&str, String> {
    validate_clipboard_upload_name(
        file_name,
        &[".png", ".jpg", ".jpeg", ".gif", ".webp"],
        "图片",
    )
}

fn validate_clipboard_text_file_name(file_name: &str) -> Result<&str, String> {
    validate_clipboard_upload_name(file_name, &[".txt"], "文本")
}

fn resolve_clipboard_uploads(project_dir: &str) -> Result<PathBuf, String> {
    let root = Path::new(project_dir.trim())
        .canonicalize()
        .map_err(|e| format!("无法解析项目目录: {e}"))?;
    if !root.is_dir() {
        return Err("项目目录不存在".to_string());
    }

    let uploads = root.join(".clipboard-uploads");
    match fs::symlink_metadata(&uploads) {
        Ok(metadata) => {
            if metadata.file_type().is_symlink() || !metadata.is_dir() {
                return Err(".clipboard-uploads 必须是项目内的真实目录".to_string());
            }
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            fs::create_dir(&uploads).map_err(|e| format!("创建上传目录失败: {e}"))?;
        }
        Err(error) => return Err(format!("检查上传目录失败: {error}")),
    }
    let canonical_uploads = uploads
        .canonicalize()
        .map_err(|e| format!("无法解析上传目录: {e}"))?;
    if canonical_uploads.parent() != Some(root.as_path()) {
        return Err("上传目录不在项目根目录内".to_string());
    }
    Ok(canonical_uploads)
}

fn write_clipboard_upload(
    uploads: &Path,
    file_name: &str,
    data: &[u8],
    kind: &str,
) -> Result<String, String> {
    let destination = uploads.join(file_name);
    let mut file = fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&destination)
        .map_err(|e| format!("安全创建{kind}失败（文件名可能已存在）: {e}"))?;
    file.write_all(data)
        .and_then(|_| file.flush())
        .map_err(|e| format!("写入{kind}失败: {e}"))?;
    Ok(destination.to_string_lossy().into_owned())
}

/// 将粘贴图片严格写入项目根目录的 `.clipboard-uploads`。
#[tauri::command]
pub fn write_clipboard_image(
    project_dir: String,
    file_name: String,
    data: Vec<u8>,
) -> Result<String, String> {
    if data.is_empty() || data.len() > MAX_CLIPBOARD_IMAGE_BYTES {
        return Err(format!(
            "图片大小必须在 1 到 {} 字节之间",
            MAX_CLIPBOARD_IMAGE_BYTES
        ));
    }
    let safe_name = validate_clipboard_file_name(&file_name)?;
    let uploads = resolve_clipboard_uploads(&project_dir)?;
    write_clipboard_upload(&uploads, safe_name, &data, "图片")
}

fn validate_clipboard_text_size(byte_len: usize) -> Result<(), String> {
    if byte_len == 0 || byte_len > MAX_CLIPBOARD_TEXT_BYTES {
        return Err(format!(
            "文本大小必须在 1 到 {} 字节之间",
            MAX_CLIPBOARD_TEXT_BYTES
        ));
    }
    Ok(())
}

#[tauri::command]
pub fn write_clipboard_text(
    project_dir: String,
    file_name: String,
    content: String,
) -> Result<String, String> {
    let data = content.as_bytes();
    validate_clipboard_text_size(data.len())?;
    let safe_name = validate_clipboard_text_file_name(&file_name)?;
    let uploads = resolve_clipboard_uploads(&project_dir)?;
    write_clipboard_upload(&uploads, safe_name, data, "文本")
}

/// 读取文件为 base64 字符串（用于图片预览）
#[tauri::command]
pub fn read_file_base64(file_path: String) -> Result<String, String> {
    let path = validate_readable_path(&file_path)?;
    let bytes = fs::read(&path).map_err(|e| format!("读取文件失败: {}", e))?;
    Ok(STANDARD.encode(&bytes))
}

/// 导入外部文件/文件夹：验证路径存在后直接返回绝对路径（不复制到项目目录）
/// 前端会把绝对路径作为 @引用 插入输入框，由 Claude Code CLI 自行读取
#[derive(Serialize)]
pub(crate) struct ImportResult {
    pub(crate) absolute_path: String,
    pub(crate) is_dir: bool,
}

#[tauri::command]
pub fn import_external_path(source: String, _project_dir: String) -> Result<ImportResult, String> {
    let source_path = PathBuf::from(&source);
    if !source_path.exists() {
        return Err(format!("源路径不存在: {}", source));
    }

    let is_dir = source_path.is_dir();
    // 转为规范化的绝对路径（消除 .. 和 .）
    let absolute = source_path
        .canonicalize()
        .map_err(|e| format!("无法解析路径 '{}': {}", source, e))?
        .to_string_lossy()
        .to_string();

    eprintln!(
        "[import_external_path] resolved '{}' -> '{}' (is_dir={})",
        source, absolute, is_dir
    );
    Ok(ImportResult { absolute_path: absolute, is_dir })
}

#[cfg(test)]
mod tests {
    use super::{
        validate_clipboard_file_name, validate_clipboard_text_file_name,
        validate_clipboard_text_size, validate_readable_path, write_clipboard_text,
        MAX_CLIPBOARD_TEXT_BYTES, MAX_READABLE_FILE_BYTES,
    };

    #[test]
    fn accepts_safe_clipboard_image_names() {
        assert_eq!(
            validate_clipboard_file_name("pasted-123_0.png").unwrap(),
            "pasted-123_0.png"
        );
        assert!(validate_clipboard_file_name("photo.JPEG").is_ok());
    }

    #[test]
    fn rejects_unsafe_clipboard_image_names() {
        for name in [
            "../escape.png",
            "folder/image.png",
            "folder\\image.png",
            ".hidden.png",
            "image.svg",
            "image.png;cmd",
            " image.png",
        ] {
            assert!(validate_clipboard_file_name(name).is_err(), "accepted {name}");
        }
    }

    #[test]
    fn validates_clipboard_text_names_and_size() {
        assert_eq!(
            validate_clipboard_text_file_name("pasted-text-123.txt").unwrap(),
            "pasted-text-123.txt"
        );
        for name in ["../escape.txt", "nested/file.txt", ".hidden.txt", "paste.md"] {
            assert!(
                validate_clipboard_text_file_name(name).is_err(),
                "accepted {name}"
            );
        }
        assert!(validate_clipboard_text_size(0).is_err());
        assert!(validate_clipboard_text_size(MAX_CLIPBOARD_TEXT_BYTES).is_ok());
        assert!(validate_clipboard_text_size(MAX_CLIPBOARD_TEXT_BYTES + 1).is_err());
    }

    #[test]
    fn writes_clipboard_text_verbatim_and_refuses_overwrite() {
        let root = std::env::temp_dir().join(format!(
            "codecli-manager-clipboard-text-{}",
            uuid::Uuid::new_v4()
        ));
        std::fs::create_dir(&root).expect("create project dir");
        let content = "第一行\nsecond line\n";
        let file_name = "pasted-text-test.txt";

        let path = write_clipboard_text(
            root.to_string_lossy().into_owned(),
            file_name.to_string(),
            content.to_string(),
        )
        .expect("write pasted text");
        assert_eq!(std::fs::read_to_string(&path).unwrap(), content);
        assert!(write_clipboard_text(
            root.to_string_lossy().into_owned(),
            file_name.to_string(),
            content.to_string(),
        )
        .is_err());

        std::fs::remove_dir_all(&root).expect("cleanup project dir");
    }

    #[cfg(unix)]
    #[test]
    fn rejects_symlinked_clipboard_upload_directory_for_text() {
        use std::os::unix::fs::symlink;

        let root = std::env::temp_dir().join(format!(
            "codecli-manager-clipboard-symlink-{}",
            uuid::Uuid::new_v4()
        ));
        let outside = std::env::temp_dir().join(format!(
            "codecli-manager-clipboard-outside-{}",
            uuid::Uuid::new_v4()
        ));
        std::fs::create_dir(&root).expect("create project dir");
        std::fs::create_dir(&outside).expect("create outside dir");
        symlink(&outside, root.join(".clipboard-uploads")).expect("create symlink");

        let result = write_clipboard_text(
            root.to_string_lossy().into_owned(),
            "pasted-text-test.txt".to_string(),
            "hello".to_string(),
        );
        assert!(result.is_err());

        std::fs::remove_dir_all(&root).expect("cleanup project dir");
        std::fs::remove_dir_all(&outside).expect("cleanup outside dir");
    }

    #[test]
    fn rejects_nonexistent_read_paths() {
        assert!(validate_readable_path("/nonexistent/definitely-missing.txt").is_err());
    }

    #[test]
    fn accepts_normal_files_inside_home() {
        // 回归用例：Windows 上 canonicalize() 会给路径加 `\\?\` 扩展长度前缀，
        // 而 dirs::home_dir() 不带这个前缀。曾经的实现直接用未 canonicalize 的
        // home 去比较，导致用户目录内的正常文件全部被误判为「不在用户目录内」
        // 而拒绝（例如粘贴图片后再次打开预览失败）。
        let Some(home) = dirs::home_dir() else { return; };
        let path = home.join(".codecli-manager-test-normal.txt");
        let _ = std::fs::remove_file(&path);
        std::fs::write(&path, b"hello").expect("create test file");
        let result = validate_readable_path(path.to_str().expect("path is utf-8"));
        let _ = std::fs::remove_file(&path);
        assert!(result.is_ok(), "normal file inside home should be accepted: {result:?}");
    }

    #[test]
    fn rejects_oversized_read_paths() {
        let Some(home) = dirs::home_dir() else { return; };
        let path = home.join(".codecli-manager-test-oversized.bin");
        let _ = std::fs::remove_file(&path);
        let file = std::fs::File::create(&path).expect("create test file");
        file.set_len(MAX_READABLE_FILE_BYTES + 1).expect("sparse extend");
        drop(file);
        let result = validate_readable_path(path.to_str().expect("path is utf-8"));
        let _ = std::fs::remove_file(&path);
        let err = result.expect_err("oversized file should be rejected");
        assert!(err.contains("文件过大"), "unexpected error: {err}");
    }

    #[cfg(unix)]
    #[test]
    fn rejects_system_files_outside_home() {
        // /etc/hosts 存在且在用户主目录之外，应被拒绝
        assert!(validate_readable_path("/etc/hosts").is_err());
    }
}
