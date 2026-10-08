import { invoke } from '@tauri-apps/api/core';

export function openTerminal(projectDir: string): Promise<void> {
  return invoke('open_terminal', { projectDir });
}

export function openTerminalResume(projectDir: string, sessionId: string): Promise<void> {
  return invoke('open_terminal_resume', { projectDir, sessionId });
}

export function getGitBranch(projectDir: string): Promise<string | null> {
  return invoke<string | null>('get_git_branch', { projectDir });
}

export function getCurrentPlatform(): Promise<string> {
  return invoke<string>('get_current_platform');
}

/** 关闭窗口时的行为：每次询问 / 最小化到托盘 / 直接退出 */
export type CloseBehavior = 'ask' | 'tray' | 'exit';

/** 把持久化的关闭行为同步给后端（后端持有权威副本，并据此标记「前端已就绪」） */
export function setCloseBehavior(behavior: CloseBehavior): Promise<void> {
  return invoke('resident_set_close_behavior', { behavior });
}

/** 隐藏主窗口到托盘，进程继续常驻 */
export function hideToTray(): Promise<void> {
  return invoke('resident_hide_to_tray');
}

/** 结束进程（后端会先跑一遍退出清理） */
export function quitApp(): Promise<void> {
  return invoke('resident_quit_app');
}
