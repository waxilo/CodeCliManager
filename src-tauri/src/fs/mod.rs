use base64::{engine::general_purpose::STANDARD, Engine as _};
use serde::{Deserialize, Serialize};
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;

use crate::claude::runtime::apply_cli_runtime_env;

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
    if let Ok(entries) = fs::read_dir(dir) {
        for entry in entries.flatten() {
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
                if path.is_dir() {
                    rel_str.push('/');
                }
                out.push(rel_str);
                if path.is_dir() {
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

/// 写入二进制文件（用于保存粘贴的图片）
#[tauri::command]
pub fn write_file_bytes(file_path: String, data: Vec<u8>) -> Result<(), String> {
    let path = Path::new(&file_path);
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| format!("创建目录失败: {}", e))?;
    }
    fs::write(path, &data).map_err(|e| format!("写入文件失败: {}", e))
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
