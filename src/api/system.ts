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
