import { invoke } from '@tauri-apps/api/core';
import type {
  ClaudeCodeInstallResult,
  ClaudeCodeSilentUpdateResult,
  ClaudeCodeUpdateInfo,
} from '../types';

export function checkClaudeCodeUpdate(): Promise<ClaudeCodeUpdateInfo> {
  return invoke<ClaudeCodeUpdateInfo>('check_claude_code_update');
}

export function runClaudeCodeInstall(): Promise<ClaudeCodeInstallResult> {
  return invoke<ClaudeCodeInstallResult>('run_claude_code_install');
}

export function runClaudeCodeUpdateSilent(): Promise<ClaudeCodeSilentUpdateResult> {
  return invoke<ClaudeCodeSilentUpdateResult>('run_claude_code_update_silent');
}