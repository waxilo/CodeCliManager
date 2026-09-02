export interface ClaudeCodeUpdateInfo {
  installed: string | null;
  latest: string | null;
  updateAvailable: boolean;
  executablePath: string | null;
  canSilentUpdate: boolean;
  error: string | null;
}

export interface ClaudeCodeSilentUpdateResult {
  success: boolean;
  message: string;
  installed: string | null;
  latest: string | null;
  usedElevation: boolean;
}

export interface ClaudeCodeInstallResult {
  success: boolean;
  message: string;
  installed: string | null;
  executablePath: string | null;
}

export type ClaudeUpdateCheckStatus = 'idle' | 'checking' | 'installing' | 'updating' | 'ready' | 'error';

export type AppUpdateCheckStatus = 'idle' | 'checking' | 'ready' | 'downloading' | 'error';

export interface AppUpdateInfo {
  currentVersion: string | null;
  latestVersion: string | null;
  updateAvailable: boolean;
  body: string | null;
  error: string | null;
}

export type SettingsSection = 'app-update' | 'claude-update' | 'dsh';

/** 「技能」页三个横向分区：MCP 服务器 / 全局 Skills / 全局提示词 */
export type SkillsSection = 'mcp' | 'skill' | 'prompts';

export type ThemeMode = 'light' | 'dark';
