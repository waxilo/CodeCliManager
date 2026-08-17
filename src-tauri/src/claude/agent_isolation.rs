//! 子代理 worktree 隔离注入。
//!
//! Claude Code 的 Task 子代理默认与主会话共用同一工作区：多个并行子代理同时
//! 改文件时会互相覆盖。`isolation: worktree` 能让子代理跑在临时 git worktree 里，
//! 各自拥有独立副本，互不干扰。
//!
//! 该字段只能通过项目级 `.claude/agents/*.md` frontmatter 生效（`--agents` JSON
//! 不支持 isolation）。因此在启动 CLI 前，向项目注入一个 `general-purpose.md`
//! 覆盖内置通用子代理，为其加上 `isolation: worktree`。幂等、非破坏：
//! - 仅当目录是 git 工作树时注入（worktree 隔离依赖 git）；
//! - 已存在同名 agent 文件时不覆盖（尊重用户自定义 agent）。

use std::fs;
use std::path::Path;

const AGENT_FILENAME: &str = "general-purpose.md";
/// 注入标记：文件中包含该标记即为 CCM 注入产物（当前仅用于排障识别）。
#[cfg(test)]
const MARKER: &str = "ccm:worktree-isolation";

const AGENT_CONTENT: &str = r#"---
name: general-purpose
description: 通用子代理（CCM 注入：worktree 隔离）
isolation: worktree
---

<!-- ccm:worktree-isolation -->
你是 Claude Code 的通用子代理（CCM 注入，启用 worktree 隔离）。

你在一个临时 git worktree 中运行，拥有独立于主工作区的仓库副本，可与其它并行子代理同时执行而互不覆盖彼此的改动。

使用可用工具完成主代理交给你的任务；若需要把文件修改落回主工作区，请提交到独立分支，并在结果中报告分支名与变更摘要，由主代理决定是否合并。
"#;

/// 在 CLI 启动前调用：为项目注入 worktree 隔离的 `general-purpose.md`。
pub(crate) fn ensure_subagent_worktree_isolation(project_dir: &str) {
    let dir = Path::new(project_dir);
    if !is_git_work_tree(dir) {
        return;
    }
    match write_agent_file_if_absent(dir) {
        Ok(true) => eprintln!(
            "[ccm] 已注入 {}（isolation: worktree）",
            dir.join(".claude").join("agents").join(AGENT_FILENAME).display()
        ),
        Ok(false) => {}
        Err(e) => eprintln!("[ccm] 注入子代理隔离失败 {}: {e}", dir.display()),
    }
}

/// 目录下不存在同名 agent 文件时写入；返回是否新写入（存在则不动，返回 false）。
fn write_agent_file_if_absent(project_dir: &Path) -> std::io::Result<bool> {
    let agent_file = project_dir.join(".claude").join("agents").join(AGENT_FILENAME);
    if agent_file.exists() {
        return Ok(false);
    }
    let agents_dir = agent_file.parent().expect("agent file has a parent dir");
    fs::create_dir_all(agents_dir)?;
    fs::write(&agent_file, AGENT_CONTENT)?;
    Ok(true)
}

/// 目录是否处于 git 工作树中（worktree 隔离的前提）。非仓库目录返回 false。
fn is_git_work_tree(dir: &Path) -> bool {
    let mut cmd = std::process::Command::new("git");
    crate::proc_guard::suppress_console_window(&mut cmd);
    let Ok(output) = cmd
        .arg("rev-parse")
        .arg("--is-inside-work-tree")
        .current_dir(dir)
        .stderr(std::process::Stdio::null())
        .output()
    else {
        return false;
    };
    output.status.success() && String::from_utf8_lossy(&output.stdout).trim() == "true"
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn test_dir(name: &str) -> std::path::PathBuf {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let path = std::env::temp_dir().join(format!(
            "ccm-agent-isolation-{name}-{}-{nonce}",
            std::process::id()
        ));
        fs::create_dir_all(&path).unwrap();
        path
    }

    fn git_init(dir: &std::path::Path) {
        let status = std::process::Command::new("git")
            .arg("init")
            .current_dir(dir)
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .status()
            .expect("git should be available for tests");
        assert!(status.success());
    }

    #[test]
    fn creates_agent_file_with_isolation_frontmatter_when_missing() {
        let dir = test_dir("missing");
        let created = write_agent_file_if_absent(&dir).unwrap();
        assert!(created);

        let file = dir.join(".claude").join("agents").join(AGENT_FILENAME);
        let content = fs::read_to_string(&file).unwrap();
        assert!(content.contains("name: general-purpose"));
        assert!(content.contains("isolation: worktree"));
        assert!(content.contains(MARKER));
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn does_not_overwrite_existing_custom_agent_file() {
        let dir = test_dir("existing");
        let agents = dir.join(".claude").join("agents");
        fs::create_dir_all(&agents).unwrap();
        let file = agents.join(AGENT_FILENAME);
        let custom = "---\nname: general-purpose\ndescription: 用户自定义\n---\n\n自定义实现\n";
        fs::write(&file, custom).unwrap();

        let created = write_agent_file_if_absent(&dir).unwrap();
        assert!(!created);
        assert_eq!(fs::read_to_string(&file).unwrap(), custom);
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn ensure_injects_into_git_repo_and_skips_plain_dir() {
        let repo = test_dir("repo");
        git_init(&repo);
        ensure_subagent_worktree_isolation(repo.to_str().unwrap());
        let file = repo.join(".claude").join("agents").join(AGENT_FILENAME);
        assert!(file.exists(), "git 仓库应被注入 agent 文件");
        fs::remove_dir_all(repo).unwrap();

        let plain = test_dir("plain");
        ensure_subagent_worktree_isolation(plain.to_str().unwrap());
        let file = plain.join(".claude").join("agents").join(AGENT_FILENAME);
        assert!(!file.exists(), "非 git 目录不应注入（worktree 隔离依赖 git）");
        fs::remove_dir_all(plain).unwrap();
    }
}
