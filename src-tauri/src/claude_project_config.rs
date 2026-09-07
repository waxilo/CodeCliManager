use serde::Serialize;
use serde_json::{Map, Value};
use std::fs;
use std::path::{Path, PathBuf};

use crate::config::{McpServerConfig, McpServerEntry, McpServersState};
use crate::config_io::{
    atomic_write_project, atomic_write_project_json, lock_project_config,
};

const PROJECT_CONFIG_READ_MAX: u64 = 1024 * 1024;
const MARKDOWN_WRITE_MAX: usize = 1024 * 1024;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ProjectSkillEntry {
    pub(crate) name: String,
    pub(crate) display_name: String,
    pub(crate) description: String,
    pub(crate) path: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ProjectSkillDocument {
    pub(crate) name: String,
    pub(crate) display_name: String,
    pub(crate) description: String,
    pub(crate) content: String,
    pub(crate) path: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ProjectPromptState {
    pub(crate) content: Option<String>,
    pub(crate) path: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ProjectPathResult {
    pub(crate) path: String,
}

fn display_path(path: &Path) -> String {
    path.to_string_lossy().into_owned()
}

fn validate_project_dir(project_dir: &str) -> Result<PathBuf, String> {
    if project_dir.is_empty() {
        return Err("项目目录不能为空".to_string());
    }

    let supplied = Path::new(project_dir);
    let metadata = fs::symlink_metadata(supplied)
        .map_err(|e| format!("项目目录不存在或无法访问 {}: {e}", supplied.display()))?;
    if metadata.file_type().is_symlink() {
        return Err("项目目录是符号链接，已拒绝访问".to_string());
    }
    if !metadata.is_dir() {
        return Err(format!("项目路径不是目录: {}", supplied.display()));
    }

    let canonical = fs::canonicalize(supplied)
        .map_err(|e| format!("无法规范化项目目录 {}: {e}", supplied.display()))?;
    let canonical_metadata = fs::symlink_metadata(&canonical)
        .map_err(|e| format!("无法检查项目目录 {}: {e}", canonical.display()))?;
    if canonical_metadata.file_type().is_symlink() || !canonical_metadata.is_dir() {
        return Err(format!("无效的项目目录: {}", canonical.display()));
    }
    Ok(canonical)
}

fn existing_metadata_no_symlink(
    path: &Path,
    label: &str,
) -> Result<Option<fs::Metadata>, String> {
    match fs::symlink_metadata(path) {
        Ok(metadata) => {
            if metadata.file_type().is_symlink() {
                return Err(format!("{label} 是符号链接，已拒绝访问: {}", path.display()));
            }
            Ok(Some(metadata))
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(format!("无法检查{label} {}: {error}", path.display())),
    }
}

fn existing_directory(path: &Path, label: &str) -> Result<bool, String> {
    let Some(metadata) = existing_metadata_no_symlink(path, label)? else {
        return Ok(false);
    };
    if !metadata.is_dir() {
        return Err(format!("{label}不是目录: {}", path.display()));
    }
    Ok(true)
}

fn existing_file(path: &Path, label: &str) -> Result<bool, String> {
    let Some(metadata) = existing_metadata_no_symlink(path, label)? else {
        return Ok(false);
    };
    if !metadata.is_file() {
        return Err(format!("{label}不是普通文件: {}", path.display()));
    }
    Ok(true)
}

fn ensure_directory(path: &Path, label: &str) -> Result<(), String> {
    if existing_directory(path, label)? {
        return Ok(());
    }
    fs::create_dir(path).map_err(|e| format!("创建{label}失败 {}: {e}", path.display()))?;
    if !existing_directory(path, label)? {
        return Err(format!("创建后的{label}无效: {}", path.display()));
    }
    Ok(())
}

fn validate_skill_name(name: &str) -> Result<(), String> {
    if name.is_empty()
        || name.trim().is_empty()
        || name == "."
        || name == ".."
        || name.contains('/')
        || name.contains('\\')
        || name.contains(':')
        || Path::new(name).is_absolute()
    {
        return Err("非法的 Skill 名称：必须是单个非空路径组件".to_string());
    }

    let mut components = Path::new(name).components();
    if !matches!(components.next(), Some(std::path::Component::Normal(_)))
        || components.next().is_some()
    {
        return Err("非法的 Skill 名称：必须是单个非空路径组件".to_string());
    }
    Ok(())
}

fn check_markdown_size(content: &str) -> Result<(), String> {
    if content.len() > MARKDOWN_WRITE_MAX {
        return Err(format!(
            "Markdown 内容过长（{} 字节），仅支持 {} 字节以内",
            content.len(),
            MARKDOWN_WRITE_MAX
        ));
    }
    Ok(())
}

fn read_markdown_complete(path: &Path, label: &str) -> Result<String, String> {
    let metadata = fs::metadata(path)
        .map_err(|e| format!("读取{label}元数据失败 {}: {e}", path.display()))?;
    if metadata.len() > MARKDOWN_WRITE_MAX as u64 {
        return Err(format!(
            "{label}内容过长（{} 字节），仅支持 {} 字节以内",
            metadata.len(),
            MARKDOWN_WRITE_MAX
        ));
    }
    fs::read_to_string(path).map_err(|e| format!("读取{label}失败 {}: {e}", path.display()))
}

fn unquote_frontmatter_value(value: &str) -> String {
    let trimmed = value.trim();
    let unquoted = trimmed
        .strip_prefix('"')
        .and_then(|value| value.strip_suffix('"'))
        .or_else(|| {
            trimmed
                .strip_prefix('\'')
                .and_then(|value| value.strip_suffix('\''))
        })
        .unwrap_or(trimmed);
    unquoted.trim().to_string()
}

fn parse_skill_frontmatter(content: &str) -> (String, String) {
    let trimmed = content.trim_start().trim_start_matches('\u{feff}');
    let mut lines = trimmed.lines();
    if lines.next().map(str::trim) != Some("---") {
        return (String::new(), String::new());
    }

    let mut name = String::new();
    let mut description_parts = Vec::new();
    let mut in_description_block = false;
    for raw_line in lines {
        if raw_line.trim() == "---" {
            break;
        }
        if in_description_block {
            if raw_line.starts_with(' ') || raw_line.starts_with('\t') {
                description_parts.push(raw_line.trim().to_string());
                continue;
            }
            in_description_block = false;
        }

        let line = raw_line.trim();
        if let Some(value) = line.strip_prefix("name:") {
            name = unquote_frontmatter_value(value);
        } else if let Some(value) = line.strip_prefix("description:") {
            let value = value.trim();
            if value == "|" || value == ">" {
                in_description_block = true;
            } else {
                description_parts.push(unquote_frontmatter_value(value));
            }
        }
    }

    (name, description_parts.join(" ").trim().to_string())
}

fn skill_metadata(content: &str, fallback_name: &str) -> (String, String) {
    let (display_name, description) = parse_skill_frontmatter(content);
    let display_name = if display_name.is_empty() {
        fallback_name.to_string()
    } else {
        display_name
    };
    (display_name, description)
}

fn project_skill_entry(name: String, content: &str, path: &Path) -> ProjectSkillEntry {
    let (display_name, description) = skill_metadata(content, &name);
    ProjectSkillEntry {
        name,
        display_name,
        description,
        path: display_path(path),
    }
}

fn project_skill_document(name: String, content: String, path: &Path) -> ProjectSkillDocument {
    let (display_name, description) = skill_metadata(&content, &name);
    ProjectSkillDocument {
        name,
        display_name,
        description,
        content,
        path: display_path(path),
    }
}

fn project_mcp_path(project: &Path) -> PathBuf {
    project.join(".mcp.json")
}

fn project_skills_path(project: &Path) -> PathBuf {
    project.join(".claude").join("skills")
}

fn project_prompt_path(project: &Path) -> PathBuf {
    project.join("CLAUDE.md")
}

fn read_mcp_value(path: &Path) -> Result<Value, String> {
    if !existing_file(path, "项目 MCP 配置文件")? {
        return Ok(Value::Object(Map::new()));
    }
    let metadata = fs::metadata(path)
        .map_err(|e| format!("读取项目 MCP 配置元数据失败 {}: {e}", path.display()))?;
    if metadata.len() > PROJECT_CONFIG_READ_MAX {
        return Err(format!(
            "项目 MCP 配置过大（{} 字节），仅支持 {} 字节以内",
            metadata.len(),
            PROJECT_CONFIG_READ_MAX
        ));
    }
    let content = fs::read_to_string(path)
        .map_err(|e| format!("读取项目 MCP 配置失败 {}: {e}", path.display()))?;
    serde_json::from_str(&content)
        .map_err(|e| format!("解析项目 MCP 配置失败 {}: {e}", path.display()))
}

fn mcp_state_from_value(path: &Path, value: &Value) -> Result<McpServersState, String> {
    let root = value
        .as_object()
        .ok_or_else(|| "项目 MCP 配置根节点必须是 JSON 对象".to_string())?;
    let mut servers = Vec::new();
    if let Some(raw_servers) = root.get("mcpServers") {
        let map = raw_servers
            .as_object()
            .ok_or_else(|| "项目 MCP 配置的 mcpServers 必须是 JSON 对象".to_string())?;
        for (name, raw_config) in map {
            let entry = match serde_json::from_value::<McpServerConfig>(raw_config.clone()) {
                Ok(config) => McpServerEntry {
                    name: name.clone(),
                    config,
                    parse_error: None,
                },
                Err(error) => McpServerEntry {
                    name: name.clone(),
                    config: McpServerConfig::default(),
                    parse_error: Some(format!("无法解析该服务器配置: {error}")),
                },
            };
            servers.push(entry);
        }
    }
    servers.sort_by(|a, b| a.name.cmp(&b.name));
    Ok(McpServersState {
        servers,
        config_path: display_path(path),
    })
}

fn validate_server_name(name: &str) -> Result<&str, String> {
    let trimmed = name.trim();
    if trimmed.is_empty() {
        return Err("服务器名称不能为空".to_string());
    }
    Ok(trimmed)
}

fn normalize_mcp_config(mut config: McpServerConfig) -> McpServerConfig {
    if config.server_type == "stdio" {
        config.url = None;
        if config.command.as_deref().map(str::trim).unwrap_or("").is_empty() {
            config.command = None;
        }
    } else {
        config.command = None;
        if config.url.as_deref().map(str::trim).unwrap_or("").is_empty() {
            config.url = None;
        }
    }
    config
}

#[tauri::command]
pub fn get_project_mcp_servers(project_dir: String) -> Result<McpServersState, String> {
    let _guard = lock_project_config()?;
    let project = validate_project_dir(&project_dir)?;
    let path = project_mcp_path(&project);
    let value = read_mcp_value(&path)?;
    mcp_state_from_value(&path, &value)
}

#[tauri::command]
pub fn upsert_project_mcp_server(
    project_dir: String,
    name: String,
    config: McpServerConfig,
) -> Result<McpServersState, String> {
    let name = validate_server_name(&name)?.to_string();
    let config = normalize_mcp_config(config);
    let _guard = lock_project_config()?;
    let project = validate_project_dir(&project_dir)?;
    let path = project_mcp_path(&project);
    let mut value = read_mcp_value(&path)?;
    let root = value
        .as_object_mut()
        .ok_or_else(|| "项目 MCP 配置根节点必须是 JSON 对象".to_string())?;
    let servers = root
        .entry("mcpServers")
        .or_insert_with(|| Value::Object(Map::new()))
        .as_object_mut()
        .ok_or_else(|| "项目 MCP 配置的 mcpServers 必须是 JSON 对象".to_string())?;
    let encoded = serde_json::to_value(config).map_err(|e| format!("MCP 配置序列化失败: {e}"))?;
    servers.insert(name, encoded);

    existing_file(&path, "项目 MCP 配置文件")?;
    atomic_write_project_json(&path, &value)?;
    mcp_state_from_value(&path, &value)
}

#[tauri::command]
pub fn delete_project_mcp_server(
    project_dir: String,
    name: String,
) -> Result<McpServersState, String> {
    let name = validate_server_name(&name)?.to_string();
    let _guard = lock_project_config()?;
    let project = validate_project_dir(&project_dir)?;
    let path = project_mcp_path(&project);
    let existed = existing_file(&path, "项目 MCP 配置文件")?;
    let mut value = read_mcp_value(&path)?;
    let root = value
        .as_object_mut()
        .ok_or_else(|| "项目 MCP 配置根节点必须是 JSON 对象".to_string())?;
    let removed = match root.get_mut("mcpServers") {
        Some(raw_servers) => raw_servers
            .as_object_mut()
            .ok_or_else(|| "项目 MCP 配置的 mcpServers 必须是 JSON 对象".to_string())?
            .remove(&name)
            .is_some(),
        None => false,
    };

    if existed && removed {
        existing_file(&path, "项目 MCP 配置文件")?;
        atomic_write_project_json(&path, &value)?;
    }
    mcp_state_from_value(&path, &value)
}

fn project_skills(project: &Path) -> Result<Vec<ProjectSkillEntry>, String> {
    let claude_dir = project.join(".claude");
    let skills_dir = project_skills_path(project);
    let mut skills = Vec::new();

    if !existing_directory(&claude_dir, "项目 .claude 目录")?
        || !existing_directory(&skills_dir, "项目 Skills 目录")?
    {
        return Ok(skills);
    }

    let entries = fs::read_dir(&skills_dir)
        .map_err(|e| format!("读取项目 Skills 目录失败 {}: {e}", skills_dir.display()))?;
    for entry in entries {
        let entry = entry.map_err(|e| format!("读取项目 Skill 条目失败: {e}"))?;
        let skill_dir = entry.path();
        let file_type = entry
            .file_type()
            .map_err(|e| format!("检查项目 Skill 失败 {}: {e}", skill_dir.display()))?;
        if file_type.is_symlink() {
            return Err(format!(
                "项目 Skill 目录是符号链接，已拒绝访问: {}",
                skill_dir.display()
            ));
        }
        if !file_type.is_dir() {
            continue;
        }

        let skill_md = skill_dir.join("SKILL.md");
        if !existing_file(&skill_md, "项目 SKILL.md")? {
            continue;
        }
        let name = entry.file_name().to_string_lossy().into_owned();
        if validate_skill_name(&name).is_err() {
            continue;
        }
        let content = read_markdown_complete(&skill_md, "项目 Skill")?;
        skills.push(project_skill_entry(name, &content, &skill_md));
    }
    skills.sort_by(|a, b| a.name.cmp(&b.name));
    Ok(skills)
}

#[tauri::command]
pub fn get_project_skills(project_dir: String) -> Result<Vec<ProjectSkillEntry>, String> {
    let _guard = lock_project_config()?;
    let project = validate_project_dir(&project_dir)?;
    project_skills(&project)
}

fn checked_skill_paths(project: &Path, name: &str) -> Result<(PathBuf, PathBuf), String> {
    validate_skill_name(name)?;
    let skills_dir = project_skills_path(project);
    let skill_dir = skills_dir.join(name);
    if skill_dir.parent() != Some(skills_dir.as_path()) {
        return Err("非法的 Skill 路径".to_string());
    }
    Ok((skill_dir.clone(), skill_dir.join("SKILL.md")))
}

#[tauri::command]
pub fn read_project_skill(
    project_dir: String,
    name: String,
) -> Result<ProjectSkillDocument, String> {
    let _guard = lock_project_config()?;
    let project = validate_project_dir(&project_dir)?;
    let claude_dir = project.join(".claude");
    if !existing_directory(&claude_dir, "项目 .claude 目录")? {
        return Err(format!("Skill 不存在: {name}"));
    }
    let skills_dir = project_skills_path(&project);
    if !existing_directory(&skills_dir, "项目 Skills 目录")? {
        return Err(format!("Skill 不存在: {name}"));
    }
    let (skill_dir, skill_md) = checked_skill_paths(&project, &name)?;
    if !existing_directory(&skill_dir, "项目 Skill 目录")?
        || !existing_file(&skill_md, "项目 SKILL.md")?
    {
        return Err(format!("Skill 不存在: {name}"));
    }
    let content = read_markdown_complete(&skill_md, "项目 Skill")?;
    Ok(project_skill_document(name, content, &skill_md))
}

#[tauri::command]
pub fn write_project_skill(
    project_dir: String,
    name: String,
    content: String,
) -> Result<ProjectSkillDocument, String> {
    validate_skill_name(&name)?;
    check_markdown_size(&content)?;
    let _guard = lock_project_config()?;
    let project = validate_project_dir(&project_dir)?;
    let claude_dir = project.join(".claude");
    ensure_directory(&claude_dir, "项目 .claude 目录")?;
    let skills_dir = project_skills_path(&project);
    ensure_directory(&skills_dir, "项目 Skills 目录")?;
    let (skill_dir, skill_md) = checked_skill_paths(&project, &name)?;
    let created_skill_dir = if existing_directory(&skill_dir, "项目 Skill 目录")? {
        if !existing_file(&skill_md, "项目 SKILL.md")? {
            return Err(format!(
                "同名 Skill 目录已存在但缺少 SKILL.md，已拒绝接管: {}",
                skill_dir.display()
            ));
        }
        false
    } else {
        fs::create_dir(&skill_dir)
            .map_err(|e| format!("创建项目 Skill 目录失败 {}: {e}", skill_dir.display()))?;
        if !existing_directory(&skill_dir, "项目 Skill 目录")? {
            return Err(format!("创建后的项目 Skill 目录无效: {}", skill_dir.display()));
        }
        true
    };
    if let Err(error) = atomic_write_project(&skill_md, content.as_bytes()) {
        if created_skill_dir {
            let _ = fs::remove_dir(&skill_dir);
        }
        return Err(error);
    }
    Ok(project_skill_document(name, content, &skill_md))
}

#[tauri::command]
pub fn delete_project_skill(
    project_dir: String,
    name: String,
) -> Result<ProjectPathResult, String> {
    validate_skill_name(&name)?;
    let _guard = lock_project_config()?;
    let project = validate_project_dir(&project_dir)?;
    let claude_dir = project.join(".claude");
    if !existing_directory(&claude_dir, "项目 .claude 目录")? {
        return Err(format!("Skill 不存在: {name}"));
    }
    let skills_dir = project_skills_path(&project);
    if !existing_directory(&skills_dir, "项目 Skills 目录")? {
        return Err(format!("Skill 不存在: {name}"));
    }
    let (skill_dir, skill_md) = checked_skill_paths(&project, &name)?;
    if !existing_directory(&skill_dir, "项目 Skill 目录")?
        || !existing_file(&skill_md, "项目 SKILL.md")?
    {
        return Err(format!("Skill 不存在: {name}"));
    }

    let canonical_skills = fs::canonicalize(&skills_dir)
        .map_err(|e| format!("无法规范化项目 Skills 目录 {}: {e}", skills_dir.display()))?;
    let canonical_skill = fs::canonicalize(&skill_dir)
        .map_err(|e| format!("无法规范化项目 Skill 目录 {}: {e}", skill_dir.display()))?;
    if canonical_skill.parent() != Some(canonical_skills.as_path()) {
        return Err("Skill 目录不在项目 Skills 目录内，已拒绝删除".to_string());
    }

    fs::remove_dir_all(&skill_dir)
        .map_err(|e| format!("删除项目 Skill 失败 {}: {e}", skill_dir.display()))?;
    Ok(ProjectPathResult {
        path: display_path(&skill_dir),
    })
}

#[tauri::command]
pub fn get_project_prompt(project_dir: String) -> Result<ProjectPromptState, String> {
    let _guard = lock_project_config()?;
    let project = validate_project_dir(&project_dir)?;
    let path = project_prompt_path(&project);
    let content = if existing_file(&path, "项目 CLAUDE.md")? {
        Some(read_markdown_complete(&path, "项目 CLAUDE.md")?)
    } else {
        None
    };
    Ok(ProjectPromptState {
        content,
        path: display_path(&path),
    })
}

#[tauri::command]
pub fn write_project_claude_md(
    project_dir: String,
    content: String,
) -> Result<ProjectPromptState, String> {
    check_markdown_size(&content)?;
    let _guard = lock_project_config()?;
    let project = validate_project_dir(&project_dir)?;
    let path = project_prompt_path(&project);
    existing_file(&path, "项目 CLAUDE.md")?;
    atomic_write_project(&path, content.as_bytes())?;
    Ok(ProjectPromptState {
        content: Some(content),
        path: display_path(&path),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::collections::HashMap;
    use std::time::{SystemTime, UNIX_EPOCH};

    struct TestDir(PathBuf);

    impl TestDir {
        fn new(name: &str) -> Self {
            let nonce = SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos();
            let path = std::env::temp_dir().join(format!(
                "codecli-project-config-{name}-{}-{nonce}",
                std::process::id()
            ));
            fs::create_dir_all(&path).unwrap();
            Self(fs::canonicalize(path).unwrap())
        }

        fn string(&self) -> String {
            display_path(&self.0)
        }
    }

    impl Drop for TestDir {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    fn stdio_config(command: &str) -> McpServerConfig {
        McpServerConfig {
            server_type: "stdio".to_string(),
            command: Some(command.to_string()),
            args: vec!["--flag".to_string()],
            env: HashMap::from([("TOKEN".to_string(), "value".to_string())]),
            url: Some("https://ignored.example".to_string()),
        }
    }

    #[test]
    fn mcp_upsert_and_delete_preserve_unknown_json() {
        let project = TestDir::new("mcp-preserve");
        let path = project.0.join(".mcp.json");
        fs::write(
            &path,
            serde_json::to_vec_pretty(&json!({
                "unknownTopLevel": { "keep": true },
                "mcpServers": {
                    "broken": { "command": 42, "custom": "keep" },
                    "remove-me": { "type": "stdio", "command": "old" }
                }
            }))
            .unwrap(),
        )
        .unwrap();

        let state = upsert_project_mcp_server(
            project.string(),
            " added ".to_string(),
            stdio_config("runner"),
        )
        .unwrap();
        assert_eq!(state.config_path, display_path(&path));
        assert_eq!(state.servers.len(), 3);
        assert!(state
            .servers
            .iter()
            .find(|entry| entry.name == "broken")
            .unwrap()
            .parse_error
            .is_some());

        let saved: Value = serde_json::from_str(&fs::read_to_string(&path).unwrap()).unwrap();
        assert_eq!(saved["unknownTopLevel"], json!({ "keep": true }));
        assert_eq!(
            saved["mcpServers"]["broken"],
            json!({ "command": 42, "custom": "keep" })
        );
        assert_eq!(saved["mcpServers"]["added"]["command"], "runner");
        assert!(saved["mcpServers"]["added"].get("url").is_none());

        delete_project_mcp_server(project.string(), "remove-me".to_string()).unwrap();
        let saved: Value = serde_json::from_str(&fs::read_to_string(&path).unwrap()).unwrap();
        assert!(saved["mcpServers"].get("remove-me").is_none());
        assert_eq!(saved["unknownTopLevel"], json!({ "keep": true }));
        assert_eq!(saved["mcpServers"]["broken"]["custom"], "keep");
    }

    #[test]
    fn malformed_mcp_json_is_never_overwritten() {
        let project = TestDir::new("mcp-malformed");
        let path = project.0.join(".mcp.json");
        fs::write(&path, "{ definitely-not-json").unwrap();

        assert!(upsert_project_mcp_server(
            project.string(),
            "server".to_string(),
            stdio_config("runner")
        )
        .is_err());
        assert!(delete_project_mcp_server(project.string(), "server".to_string()).is_err());
        assert_eq!(fs::read_to_string(path).unwrap(), "{ definitely-not-json");
    }

    #[test]
    fn oversized_mcp_json_is_never_read_or_overwritten() {
        let project = TestDir::new("mcp-oversized");
        let path = project.0.join(".mcp.json");
        let content = vec![b' '; PROJECT_CONFIG_READ_MAX as usize + 1];
        fs::write(&path, &content).unwrap();

        assert!(get_project_mcp_servers(project.string()).is_err());
        assert!(upsert_project_mcp_server(
            project.string(),
            "server".to_string(),
            stdio_config("runner")
        )
        .is_err());
        assert!(delete_project_mcp_server(project.string(), "server".to_string()).is_err());
        assert_eq!(fs::read(&path).unwrap(), content);
    }

    #[test]
    fn malformed_mcp_servers_shape_is_not_replaced() {
        let project = TestDir::new("mcp-shape");
        let path = project.0.join(".mcp.json");
        fs::write(&path, r#"{"other":true,"mcpServers":[]}"#).unwrap();

        assert!(upsert_project_mcp_server(
            project.string(),
            "server".to_string(),
            stdio_config("runner")
        )
        .is_err());
        assert_eq!(
            fs::read_to_string(path).unwrap(),
            r#"{"other":true,"mcpServers":[]}"#
        );
    }

    #[test]
    fn skills_round_trip_metadata_contract_and_delete_only_target() {
        let project = TestDir::new("skills-roundtrip");
        let first = "---\nname: 'Demo Display'\ndescription: \"First description\"\n---\n完整正文\n"
            .to_string();
        let written =
            write_project_skill(project.string(), "demo".to_string(), first.clone()).unwrap();
        assert_eq!(written.name, "demo");
        assert_eq!(written.display_name, "Demo Display");
        assert_eq!(written.description, "First description");
        assert_eq!(written.content, first);
        assert_eq!(
            written.path,
            display_path(&project.0.join(".claude/skills/demo/SKILL.md"))
        );
        let encoded = serde_json::to_value(&written).unwrap();
        assert_eq!(encoded["displayName"], "Demo Display");
        assert_eq!(encoded["description"], "First description");
        assert!(encoded.get("display_name").is_none());

        let second = "---\ndescription: >\n  block line one\n  block line two\n---\n# replaced\n"
            .to_string();
        let saved =
            write_project_skill(project.string(), "demo".to_string(), second.clone()).unwrap();
        assert_eq!(saved.display_name, "demo");
        assert_eq!(saved.description, "block line one block line two");
        let read = read_project_skill(project.string(), "demo".to_string()).unwrap();
        assert_eq!(read.display_name, "demo");
        assert_eq!(read.description, "block line one block line two");
        assert_eq!(read.content, second);

        let sibling = project.0.join(".claude/skills/keep/SKILL.md");
        fs::create_dir_all(sibling.parent().unwrap()).unwrap();
        fs::write(&sibling, "keep").unwrap();
        let skills = get_project_skills(project.string()).unwrap();
        assert_eq!(
            skills
                .iter()
                .map(|item| item.name.as_str())
                .collect::<Vec<_>>(),
            vec!["demo", "keep"]
        );
        assert_eq!(skills[0].display_name, "demo");
        assert_eq!(skills[0].description, "block line one block line two");
        assert_eq!(skills[1].display_name, "keep");
        assert_eq!(skills[1].description, "");
        let encoded = serde_json::to_value(&skills).unwrap();
        assert!(encoded.is_array());
        assert_eq!(encoded[0]["displayName"], "demo");
        assert_eq!(encoded[1]["description"], "");

        let deleted = delete_project_skill(project.string(), "demo".to_string()).unwrap();
        assert_eq!(
            deleted.path,
            display_path(&project.0.join(".claude/skills/demo"))
        );
        assert!(!project.0.join(".claude/skills/demo").exists());
        assert_eq!(fs::read_to_string(sibling).unwrap(), "keep");
    }

    #[test]
    fn prompt_round_trip_returns_canonical_target_path() {
        let project = TestDir::new("prompt");
        let missing = get_project_prompt(project.string()).unwrap();
        assert!(missing.content.is_none());
        assert_eq!(missing.path, display_path(&project.0.join("CLAUDE.md")));

        let content = "# Project instructions\n原文\n".to_string();
        let written = write_project_claude_md(project.string(), content.clone()).unwrap();
        assert_eq!(written.content.as_deref(), Some(content.as_str()));
        let read = get_project_prompt(project.string()).unwrap();
        assert_eq!(read.content.as_deref(), Some(content.as_str()));
    }

    #[test]
    fn rejects_invalid_skill_names_and_oversized_markdown() {
        let project = TestDir::new("invalid-input");
        for name in ["", ".", "..", "/absolute", "nested/name", "nested\\name", "C:drive"] {
            assert!(write_project_skill(project.string(), name.to_string(), "x".to_string()).is_err());
        }

        let oversized = "x".repeat(MARKDOWN_WRITE_MAX + 1);
        assert!(write_project_skill(
            project.string(),
            "large".to_string(),
            oversized.clone()
        )
        .is_err());
        assert!(write_project_claude_md(project.string(), oversized).is_err());
        assert!(!project.0.join(".claude").exists());
        assert!(!project.0.join("CLAUDE.md").exists());
    }

    #[test]
    fn rejects_oversized_existing_markdown_without_truncation() {
        let project = TestDir::new("oversized-existing");
        let oversized = "x".repeat(MARKDOWN_WRITE_MAX + 1);
        let skill_path = project.0.join(".claude/skills/large/SKILL.md");
        fs::create_dir_all(skill_path.parent().unwrap()).unwrap();
        fs::write(&skill_path, &oversized).unwrap();
        fs::write(project.0.join("CLAUDE.md"), &oversized).unwrap();

        assert!(read_project_skill(project.string(), "large".to_string()).is_err());
        assert!(get_project_skills(project.string()).is_err());
        assert!(get_project_prompt(project.string()).is_err());
        assert_eq!(fs::metadata(skill_path).unwrap().len(), oversized.len() as u64);
        assert_eq!(
            fs::metadata(project.0.join("CLAUDE.md")).unwrap().len(),
            oversized.len() as u64
        );
    }

    #[cfg(unix)]
    #[test]
    fn project_commands_use_repository_friendly_permissions() {
        use std::os::unix::fs::PermissionsExt;

        let project = TestDir::new("project-permissions");
        let prompt_path = project.0.join("CLAUDE.md");
        fs::write(&prompt_path, "old").unwrap();
        fs::set_permissions(&prompt_path, fs::Permissions::from_mode(0o644)).unwrap();

        write_project_claude_md(project.string(), "new".to_string()).unwrap();
        assert_eq!(
            fs::metadata(&prompt_path).unwrap().permissions().mode() & 0o777,
            0o644
        );

        let skill = write_project_skill(
            project.string(),
            "demo".to_string(),
            "# Demo\n".to_string(),
        )
        .unwrap();
        assert_eq!(
            fs::metadata(&skill.path).unwrap().permissions().mode() & 0o777,
            0o644
        );

        let mcp = upsert_project_mcp_server(
            project.string(),
            "demo".to_string(),
            stdio_config("runner"),
        )
        .unwrap();
        assert_eq!(
            fs::metadata(&mcp.config_path)
                .unwrap()
                .permissions()
                .mode()
                & 0o777,
            0o644
        );
    }

    #[test]
    fn project_must_be_an_existing_directory() {
        let project = TestDir::new("project-validation");
        let missing = project.0.join("missing");
        assert!(get_project_prompt(display_path(&missing)).is_err());

        let file = project.0.join("file");
        fs::write(&file, "not a directory").unwrap();
        assert!(get_project_prompt(display_path(&file)).is_err());
    }

    #[test]
    fn rejects_non_directory_skill_path_components_without_overwriting() {
        let claude_file_project = TestDir::new("claude-file");
        let claude_path = claude_file_project.0.join(".claude");
        fs::write(&claude_path, "keep claude file").unwrap();
        assert!(get_project_skills(claude_file_project.string()).is_err());
        assert!(write_project_skill(
            claude_file_project.string(),
            "demo".to_string(),
            "content".to_string()
        )
        .is_err());
        assert_eq!(fs::read_to_string(claude_path).unwrap(), "keep claude file");

        let skills_file_project = TestDir::new("skills-file");
        fs::create_dir(skills_file_project.0.join(".claude")).unwrap();
        let skills_path = skills_file_project.0.join(".claude/skills");
        fs::write(&skills_path, "keep skills file").unwrap();
        assert!(get_project_skills(skills_file_project.string()).is_err());
        assert!(write_project_skill(
            skills_file_project.string(),
            "demo".to_string(),
            "content".to_string()
        )
        .is_err());
        assert_eq!(fs::read_to_string(skills_path).unwrap(), "keep skills file");

        let skill_file_project = TestDir::new("skill-file");
        fs::create_dir_all(skill_file_project.0.join(".claude/skills")).unwrap();
        let skill_path = skill_file_project.0.join(".claude/skills/demo");
        fs::write(&skill_path, "keep skill file").unwrap();
        assert!(write_project_skill(
            skill_file_project.string(),
            "demo".to_string(),
            "content".to_string()
        )
        .is_err());
        assert!(delete_project_skill(skill_file_project.string(), "demo".to_string()).is_err());
        assert_eq!(fs::read_to_string(skill_path).unwrap(), "keep skill file");

        let occupied_dir_project = TestDir::new("occupied-skill-dir");
        let occupied_dir = occupied_dir_project.0.join(".claude/skills/demo");
        fs::create_dir_all(&occupied_dir).unwrap();
        let asset = occupied_dir.join("asset.txt");
        fs::write(&asset, "keep asset").unwrap();
        assert!(write_project_skill(
            occupied_dir_project.string(),
            "demo".to_string(),
            "content".to_string()
        )
        .is_err());
        assert!(!occupied_dir.join("SKILL.md").exists());
        assert_eq!(fs::read_to_string(asset).unwrap(), "keep asset");
    }

    #[cfg(unix)]
    #[test]
    fn rejects_project_intermediate_and_target_symlinks() {
        use std::os::unix::fs::symlink;

        let project = TestDir::new("symlinks");
        let outside = TestDir::new("symlinks-outside");

        let project_link = outside.0.join("project-link");
        symlink(&project.0, &project_link).unwrap();
        assert!(get_project_prompt(display_path(&project_link)).is_err());

        symlink(&outside.0, project.0.join(".claude")).unwrap();
        assert!(write_project_skill(
            project.string(),
            "escape".to_string(),
            "outside".to_string()
        )
        .is_err());
        assert!(!outside.0.join("skills/escape/SKILL.md").exists());
        fs::remove_file(project.0.join(".claude")).unwrap();

        let prompt_outside = outside.0.join("prompt.md");
        fs::write(&prompt_outside, "safe").unwrap();
        symlink(&prompt_outside, project.0.join("CLAUDE.md")).unwrap();
        assert!(write_project_claude_md(project.string(), "changed".to_string()).is_err());
        assert_eq!(fs::read_to_string(prompt_outside).unwrap(), "safe");

        let mcp_outside = outside.0.join("mcp.json");
        fs::write(&mcp_outside, "{}").unwrap();
        symlink(&mcp_outside, project.0.join(".mcp.json")).unwrap();
        assert!(upsert_project_mcp_server(
            project.string(),
            "server".to_string(),
            stdio_config("runner")
        )
        .is_err());
        assert_eq!(fs::read_to_string(mcp_outside).unwrap(), "{}");
    }

    #[cfg(unix)]
    #[test]
    fn delete_rejects_symlinked_skill_directory() {
        use std::os::unix::fs::symlink;

        let project = TestDir::new("delete-symlink");
        let outside = TestDir::new("delete-symlink-outside");
        fs::create_dir_all(project.0.join(".claude/skills")).unwrap();
        fs::write(outside.0.join("SKILL.md"), "outside").unwrap();
        symlink(&outside.0, project.0.join(".claude/skills/escape")).unwrap();

        assert!(delete_project_skill(project.string(), "escape".to_string()).is_err());
        assert_eq!(fs::read_to_string(outside.0.join("SKILL.md")).unwrap(), "outside");
    }
}
