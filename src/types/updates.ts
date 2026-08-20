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

export type SettingsSection = 'app-update' | 'claude-update' | 'global-config' | 'dsh';

export type ThemeMode = 'light' | 'dark';
