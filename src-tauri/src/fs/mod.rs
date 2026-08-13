use base64::{engine::general_purpose::STANDARD, Engine as _};
use serde::Serialize;
use std::fs;
use std::io::Write;
use std::path::{Component, Path, PathBuf};
use std::process::Command;

const MAX_PROJECT_FILE_ENTRIES: usize = 20_000;
const MAX_CLIPBOARD_IMAGE_BYTES: usize = 25 * 1024 * 1024;

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
                let mut rel_str = rel.to_string_lossy().to_string();
                if file_type.is_dir() {
                    rel_str.push('/');
                }
                out.push(rel_str);
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
    let mut files = Vec::new();
    collect_files(root, root, &mut files);
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

    let output = Command::new("git")
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
    let head = Command::new("git")
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
#[tauri::command]
pub fn read_file_content(file_path: String) -> Result<String, String> {
    let path = Path::new(&file_path);
    if !path.is_file() {
        return Err(format!("文件不存在: {}", file_path));
    }
    fs::read_to_string(path).map_err(|e| format!("读取文件失败: {}", e))
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

fn validate_clipboard_file_name(file_name: &str) -> Result<&str, String> {
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
    let valid_extension = [".png", ".jpg", ".jpeg", ".gif", ".webp"]
        .iter()
        .any(|extension| lower.ends_with(extension));
    let valid_chars = trimmed
        .chars()
        .all(|ch| ch.is_ascii_alphanumeric() || matches!(ch, '-' | '_' | '.'));
    if !valid_extension || !valid_chars || trimmed.starts_with('.') {
        return Err("仅允许安全的图片文件名".to_string());
    }
    Ok(trimmed)
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

    let destination = canonical_uploads.join(safe_name);
    // 粘贴文件名由前端生成且应唯一；create_new 同时拒绝已存在文件和 symlink，
    // 避免“检查后替换”竞态把写入重定向到项目外。
    let mut file = fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&destination)
        .map_err(|e| format!("安全创建图片失败（文件名可能已存在）: {e}"))?;
    file.write_all(&data)
        .and_then(|_| file.flush())
        .map_err(|e| format!("写入图片失败: {e}"))?;
    Ok(destination.to_string_lossy().into_owned())
}

/// 读取文件为 base64 字符串（用于图片预览）
#[tauri::command]
pub fn read_file_base64(file_path: String) -> Result<String, String> {
    let path = Path::new(&file_path);
    if !path.is_file() {
        return Err(format!("文件不存在: {}", file_path));
    }
    let bytes = fs::read(path).map_err(|e| format!("读取文件失败: {}", e))?;
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
    use super::validate_clipboard_file_name;

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
}
