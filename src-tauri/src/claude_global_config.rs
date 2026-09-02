use serde::Serialize;
use std::fs;
use std::io::Read;
use std::path::{Path, PathBuf};

/// 全局 Skills：~/.claude/skills/<name>/SKILL.md（frontmatter 含 name/description）
#[derive(Serialize)]
pub(crate) struct GlobalSkillEntry {
    /// 目录名（skill 标识）
    pub(crate) name: String,
    /// SKILL.md frontmatter 的 name（缺失时回退目录名）
    pub(crate) display_name: String,
    pub(crate) description: String,
    pub(crate) path: String,
}

/// 全局斜杠命令：~/.claude/commands/<name>.md
#[derive(Serialize)]
pub(crate) struct GlobalPromptEntry {
    pub(crate) name: String,
    pub(crate) description: String,
    pub(crate) path: String,
}

#[derive(Serialize)]
pub(crate) struct GlobalPromptsState {
    /// ~/.claude/CLAUDE.md 全文（不存在为 None）
    pub(crate) global_md: Option<String>,
    pub(crate) global_md_path: Option<String>,
    pub(crate) commands: Vec<GlobalPromptEntry>,
}

/// CLAUDE.md 展示上限（截断到安全的 UTF-8 边界）
const CLAUDE_MD_MAX: usize = 100_000;
/// SKILL.md / commands 单文件上限（超过视为异常跳过，避免整读超大文件）
const MARKDOWN_MAX: u64 = 512 * 1024;
/// CLAUDE.md 写入上限（1 MiB），防止前端误提交超大内容撑爆配置
const CLAUDE_MD_WRITE_MAX: usize = 1_048_576;

/// Claude Code 全局配置目录：优先 CLAUDE_CONFIG_DIR 环境变量，缺省 ~/.claude
fn claude_home() -> PathBuf {
    if let Ok(dir) = std::env::var("CLAUDE_CONFIG_DIR") {
        let p = PathBuf::from(dir);
        if !p.as_os_str().is_empty() {
            return p;
        }
    }
    let mut path = dirs::home_dir().unwrap_or_else(|| PathBuf::from("."));
    path.push(".claude");
    path
}

/// 按字节上限读取 Markdown：先查元数据，超限只读前缀（返回是否被截断）。
/// 避免整读超大文件；前缀截断对 frontmatter 解析足够（name/description 都在文件头）。
fn read_markdown_limited(path: &Path, max: usize) -> std::io::Result<(String, bool)> {
    let meta = fs::metadata(path)?;
    if meta.len() > max as u64 {
        let mut file = fs::File::open(path)?;
        let mut buf = vec![0u8; max];
        let n = file.read(&mut buf)?;
        buf.truncate(n);
        Ok((String::from_utf8_lossy(&buf).into_owned(), true))
    } else {
        Ok((fs::read_to_string(path)?, false))
    }
}

/// 递归收集 commands 目录下的 .md 命令；name 为相对根目录的路径（如 security/review）
fn collect_commands(
    dir: &Path,
    root: &Path,
    out: &mut Vec<GlobalPromptEntry>,
) -> std::io::Result<()> {
    for item in fs::read_dir(dir)? {
        let path = item?.path();
        if path.is_dir() {
            collect_commands(&path, root, out)?;
            continue;
        }
        if path.extension().and_then(|e| e.to_str()) != Some("md") {
            continue;
        }
        let rel = path
            .strip_prefix(root)
            .unwrap_or(&path)
            .with_extension("");
        let name = rel.to_string_lossy().replace('\\', "/");
        let Ok((content, _truncated)) = read_markdown_limited(&path, MARKDOWN_MAX as usize) else {
            continue;
        };
        let (_fm_name, description) = parse_frontmatter(&content);
        out.push(GlobalPromptEntry {
            name,
            description: if description.is_empty() {
                "（无描述）".to_string()
            } else {
                description
            },
            path: path.to_string_lossy().to_string(),
        });
    }
    Ok(())
}

/// 把字符串安全截断到 max 字节（保持 UTF-8 字符边界，绝不 panic）
fn truncate_utf8_safe(mut s: String, max: usize) -> String {
    if s.len() <= max {
        return s;
    }
    let mut end = max;
    while end > 0 && !s.is_char_boundary(end) {
        end -= 1;
    }
    s.truncate(end);
    s.push_str("\n…（内容过长已截断）");
    s
}

/// 解析 Markdown 文件头 YAML frontmatter 的 name/description 键。
/// 不引入 yaml 依赖：逐行匹配 `key: value`，容忍引号、BOM、CRLF；
/// description 支持单行与块标量（`|` / `>`，收集后续缩进行）。
fn parse_frontmatter(content: &str) -> (String, String) {
    let trimmed = content.trim_start().trim_start_matches('\u{feff}');
    let Some(rest) = trimmed.strip_prefix("---") else {
        // 无 frontmatter：用首行非空文本作描述
        let first = trimmed
            .lines()
            .find(|l| !l.trim().is_empty())
            .unwrap_or("")
            .trim()
            .trim_start_matches('#')
            .trim()
            .to_string();
        return (String::new(), first);
    };

    // 逐行扫描 frontmatter，`---` 独立行作为结束标记
    let mut front_lines: Vec<&str> = Vec::new();
    let mut closed = false;
    for line in rest.lines() {
        if line.trim() == "---" {
            closed = true;
            break;
        }
        front_lines.push(line);
    }
    let _ = closed;

    let mut name = String::new();
    let mut desc_parts: Vec<String> = Vec::new();
    let mut in_block = false;
    for raw_line in front_lines {
        if in_block {
            if raw_line.starts_with(' ') || raw_line.starts_with('\t') {
                desc_parts.push(raw_line.trim().to_string());
                continue;
            }
            in_block = false;
            if raw_line.trim().is_empty() {
                continue;
            }
        }
        let t = raw_line.trim();
        if let Some(v) = t.strip_prefix("name:") {
            name = unquote(v.trim());
        } else if let Some(v) = t.strip_prefix("description:") {
            let v = v.trim();
            if v.ends_with('|') || v.ends_with('>') {
                in_block = true;
                let head = v[..v.len() - 1].trim();
                if !head.is_empty() {
                    desc_parts.push(unquote(head));
                }
            } else {
                desc_parts.push(unquote(v));
            }
        }
    }
    let description = desc_parts.join(" ").trim().to_string();
    (name, description)
}

fn unquote(v: &str) -> String {
    let t = v.trim();
    let t = t.strip_prefix('"').and_then(|s| s.strip_suffix('"')).unwrap_or(t);
    let t = t.strip_prefix('\'').and_then(|s| s.strip_suffix('\'')).unwrap_or(t);
    t.trim().to_string()
}

/// 查询全局安装的 Skills（~/.claude/skills/*/SKILL.md）
#[tauri::command]
pub fn get_global_skills() -> Result<Vec<GlobalSkillEntry>, String> {
    let skills_dir = claude_home().join("skills");
    if !skills_dir.is_dir() {
        return Ok(Vec::new());
    }
    let mut entries: Vec<GlobalSkillEntry> = Vec::new();
    let read_dir = fs::read_dir(&skills_dir).map_err(|e| format!("读取 Skills 目录失败: {e}"))?;
    for item in read_dir.flatten() {
        if !item.path().is_dir() {
            continue;
        }
        let skill_md = item.path().join("SKILL.md");
        if !skill_md.is_file() {
            continue;
        }
        let name = item.file_name().to_string_lossy().to_string();
        let Ok((content, _truncated)) = read_markdown_limited(&skill_md, MARKDOWN_MAX as usize) else {
            continue;
        };
        let (display_name, description) = parse_frontmatter(&content);
        entries.push(GlobalSkillEntry {
            name,
            display_name: if display_name.is_empty() {
                item.file_name().to_string_lossy().to_string()
            } else {
                display_name
            },
            description,
            path: skill_md.to_string_lossy().to_string(),
        });
    }
    entries.sort_by(|a, b| a.name.cmp(&b.name));
    Ok(entries)
}

/// 校验 Skill 名称只允许纯目录名，避免路径穿越到 skills 目录之外。
/// 拒绝路径分隔符、`..`/`.`，以及 `:`（Windows 下 "C:foo"/"C:\Windows" 这类
/// drive-relative/drive-absolute 名称会让 `PathBuf::join` 完全脱离 base 路径）。
fn validate_skill_name(trimmed: &str) -> Result<(), String> {
    if trimmed.is_empty() {
        return Err("Skill 名称不能为空".to_string());
    }
    if trimmed.contains('/')
        || trimmed.contains('\\')
        || trimmed.contains(':')
        || trimmed == ".."
        || trimmed == "."
    {
        return Err("非法的 Skill 名称".to_string());
    }
    Ok(())
}

/// 删除全局 Skill：整目录移除 <skills_dir>/<name>/
fn delete_skill_dir(skills_dir: &Path, name: &str) -> Result<(), String> {
    let trimmed = name.trim();
    validate_skill_name(trimmed)?;
    let dir = skills_dir.join(trimmed);
    // 纵深防御：即便上面的名称校验被绕过，也拒绝任何跳出 skills_dir 的结果路径
    if dir.parent() != Some(skills_dir) {
        return Err("非法的 Skill 名称".to_string());
    }
    if dir.is_symlink() {
        return Err("该 Skill 目录是符号链接，已拒绝删除".to_string());
    }
    if !dir.is_dir() {
        return Err(format!("Skill 「{trimmed}」不存在"));
    }
    fs::remove_dir_all(&dir).map_err(|e| format!("删除失败: {e}"))?;
    Ok(())
}

/// 删除全局 Skill：整目录移除 ~/.claude/skills/<name>/
#[tauri::command]
pub fn delete_global_skill(name: String) -> Result<(), String> {
    delete_skill_dir(&claude_home().join("skills"), &name)
}

/// 查询全局生效的提示词：~/.claude/CLAUDE.md 与 ~/.claude/commands/*.md
#[tauri::command]
pub fn get_global_prompts() -> Result<GlobalPromptsState, String> {
    let claude = claude_home();

    // 全局 CLAUDE.md
    let global_md_path = claude.join("CLAUDE.md");
    let mut global_md: Option<String> = None;
    let mut global_md_path_str: Option<String> = None;
    if global_md_path.is_file() {
        let content = match read_markdown_limited(&global_md_path, CLAUDE_MD_MAX) {
            Ok((c, truncated)) => {
                let mut c = c;
                if truncated {
                    c.push_str("\n…（内容过长已截断）");
                }
                c
            }
            Err(e) => {
                // 单个文件读取失败不拖垮整个查询：记录为提示文案
                format!("（读取失败：{e}）")
            }
        };
        global_md = Some(truncate_utf8_safe(content, CLAUDE_MD_MAX + 64));
        global_md_path_str = Some(global_md_path.to_string_lossy().to_string());
    }

    // 全局斜杠命令（支持子目录：commands/security/review.md → /security/review）
    let mut commands: Vec<GlobalPromptEntry> = Vec::new();
    let commands_dir = claude.join("commands");
    if commands_dir.is_dir() {
        collect_commands(&commands_dir, &commands_dir, &mut commands)
            .map_err(|e| format!("读取 commands 目录失败: {e}"))?;
        commands.sort_by(|a, b| a.name.cmp(&b.name));
    }

    Ok(GlobalPromptsState {
        global_md,
        global_md_path: global_md_path_str,
        commands,
    })
}

/// 写入全局 CLAUDE.md（~/.claude/CLAUDE.md）。确保父目录存在；目标若是符号链接则拒绝，
/// 避免把内容写进意外位置；返回写入后的路径供前端展示。
#[tauri::command]
pub fn write_global_claude_md(content: String) -> Result<String, String> {
    if content.len() > CLAUDE_MD_WRITE_MAX {
        return Err(format!(
            "内容过长（{} 字节），仅支持 {} 字节以内",
            content.len(),
            CLAUDE_MD_WRITE_MAX
        ));
    }
    let claude = claude_home();
    fs::create_dir_all(&claude).map_err(|e| format!("创建 ~/.claude 目录失败: {e}"))?;
    let path = claude.join("CLAUDE.md");
    if path.is_symlink() {
        return Err("~/.claude/CLAUDE.md 是符号链接，已拒绝写入".to_string());
    }
    fs::write(&path, content).map_err(|e| format!("写入 CLAUDE.md 失败: {e}"))?;
    Ok(path.to_string_lossy().to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_frontmatter_name_and_description() {
        let (name, desc) = parse_frontmatter(
            "---\nname: my-skill\ndescription: 做某件事的技能\n---\n# 正文\n内容",
        );
        assert_eq!(name, "my-skill");
        assert_eq!(desc, "做某件事的技能");
    }

    #[test]
    fn parses_quoted_frontmatter_values() {
        let (name, desc) = parse_frontmatter(
            "---\nname: \"skill name\"\ndescription: '带引号的描述'\n---\n",
        );
        assert_eq!(name, "skill name");
        assert_eq!(desc, "带引号的描述");
    }

    #[test]
    fn no_frontmatter_uses_first_line_as_description() {
        let (name, desc) = parse_frontmatter("# 标题行\n正文内容");
        assert_eq!(name, "");
        assert_eq!(desc, "标题行");
    }

    #[test]
    fn malformed_frontmatter_is_tolerated() {
        let (name, desc) = parse_frontmatter("---\nname: a\nno closing marker");
        assert_eq!(name, "a");
        assert_eq!(desc, "");
    }

    #[test]
    fn handles_crlf_line_endings() {
        let (name, desc) = parse_frontmatter("---\r\nname: skill\r\ndescription: 描述\r\n---\r\n正文");
        assert_eq!(name, "skill");
        assert_eq!(desc, "描述");
    }

    #[test]
    fn handles_bom_and_no_trailing_newline() {
        let (name, desc) = parse_frontmatter("\u{feff}---\nname: s\ndescription: d\n---");
        assert_eq!(name, "s");
        assert_eq!(desc, "d");
    }

    #[test]
    fn description_block_scalar_joins_indented_lines() {
        let (name, desc) = parse_frontmatter(
            "---\nname: s\ndescription: |\n  第一行\n  第二行\n---\n",
        );
        assert_eq!(name, "s");
        assert_eq!(desc, "第一行 第二行");
    }

    #[test]
    fn dashed_line_inside_description_value_does_not_close_frontmatter() {
        // description 单行值含 `---`（非独立行）不误判结束
        let (name, desc) = parse_frontmatter(
            "---\nname: s\ndescription: a --- b\n---\n正文",
        );
        assert_eq!(name, "s");
        assert_eq!(desc, "a --- b");
    }

    #[test]
    fn name_with_colon_keeps_full_value() {
        let (name, _desc) = parse_frontmatter("---\nname: a: b\ndescription: d\n---\n");
        assert_eq!(name, "a: b");
    }

    #[test]
    fn empty_or_bare_frontmatter_files_are_tolerated() {
        let (n, d) = parse_frontmatter("");
        assert_eq!(n, "");
        assert_eq!(d, "");
        let (n2, d2) = parse_frontmatter("---\n---");
        assert_eq!(n2, "");
        assert_eq!(d2, "");
    }

    #[test]
    fn collect_commands_recurses_subdirectories() {
        let dir = std::env::temp_dir().join(format!("ccm-cmd-test-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(dir.join("security")).unwrap();
        fs::write(dir.join("review.md"), "---\ndescription: 审查\n---\n").unwrap();
        fs::write(dir.join("security").join("scan.md"), "---\ndescription: 扫描\n---\n")
            .unwrap();
        let mut out = Vec::new();
        collect_commands(&dir, &dir, &mut out).unwrap();
        let names: Vec<&str> = out.iter().map(|c| c.name.as_str()).collect();
        assert!(names.contains(&"review"), "names: {names:?}");
        assert!(names.contains(&"security/scan"), "names: {names:?}");
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn truncate_utf8_safe_never_panics_on_multibyte() {
        // 中文 3 字节字符：100 字节边界落在字符中间
        let s = "中".repeat(60); // 180 字节
        let t = truncate_utf8_safe(s, 100);
        assert!(t.is_char_boundary(100) || t.len() <= 103);
        assert!(t.contains("截断"));
        // 全 ASCII 不受影响（省略号 … 为 3 字节，连同换行计入追加长度）
        let a = truncate_utf8_safe("a".repeat(200), 100);
        assert_eq!(a.len(), 100 + "…（内容过长已截断）".len() + 1);
    }

    #[test]
    fn delete_skill_dir_rejects_traversal_names() {
        let dir = std::env::temp_dir().join(format!("ccm-skill-del-test-{}", std::process::id()));
        assert!(delete_skill_dir(&dir, "").is_err());
        assert!(delete_skill_dir(&dir, "  ").is_err());
        assert!(delete_skill_dir(&dir, "..").is_err());
        assert!(delete_skill_dir(&dir, ".").is_err());
        assert!(delete_skill_dir(&dir, "../escape").is_err());
        assert!(delete_skill_dir(&dir, "a/b").is_err());
        assert!(delete_skill_dir(&dir, "a\\b").is_err());
        // Windows drive-relative/drive-absolute 名称：PathBuf::join 会完全脱离 base，
        // 必须被 validate_skill_name 的 `:` 校验 + parent() 纵深防御双重拦截
        assert!(delete_skill_dir(&dir, "C:secrets").is_err());
        assert!(delete_skill_dir(&dir, r"C:\Windows\System32").is_err());
    }

    #[test]
    fn delete_skill_dir_errors_when_missing() {
        let dir = std::env::temp_dir().join(format!("ccm-skill-del-test-missing-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        let err = delete_skill_dir(&dir, "not-there").unwrap_err();
        assert!(err.contains("不存在"), "err: {err}");
    }

    #[test]
    fn delete_skill_dir_removes_existing_directory() {
        let dir = std::env::temp_dir().join(format!("ccm-skill-del-test-ok-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        let target = dir.join("my-skill");
        fs::create_dir_all(&target).unwrap();
        fs::write(target.join("SKILL.md"), "---\nname: my-skill\n---\n").unwrap();
        assert!(target.is_dir());
        delete_skill_dir(&dir, "my-skill").unwrap();
        assert!(!target.exists());
        let _ = fs::remove_dir_all(&dir);
    }
}
