//! Windows 子进程控制台窗口抑制。
//!
//! Tauri GUI 进程本身无控制台；在此进程里 spawn 子进程（git / kiro-cli / claude 探测等）
//! 若不指定 `CREATE_NO_WINDOW`，Windows 会为子进程新建一个控制台窗口——表现为
//! 使用中偶尔弹出黑色终端框一闪而过。所有后台子进程都应经 `suppress_console_window`
//! 应用该标志（用户主动「在外部终端打开」的路径除外，那需要可见窗口）。

use std::process::Command;

/// 为 Command 应用「不创建控制台窗口」标志（`CREATE_NO_WINDOW`，0x08000000）。
/// 非 Windows 平台为空操作。
pub(crate) fn suppress_console_window(cmd: &mut Command) {
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x08000000);
    }
    let _ = cmd;
}
