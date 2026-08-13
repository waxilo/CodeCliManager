import { invoke } from '@tauri-apps/api/core';
import type { ExecutePromptResult, PermissionMode } from '../types';

export function executePrompt(args: Record<string, unknown>): Promise<ExecutePromptResult> {
  return invoke<ExecutePromptResult>('execute_prompt', args);
}

export function removeQueuedPrompt(conversationId: string, promptId: string): Promise<boolean> {
  return invoke<boolean>('remove_queued_prompt_command', { conversationId, promptId });
}

export function clearQueuedPrompts(conversationId: string): Promise<number> {
  return invoke<number>('clear_queued_prompts_command', { conversationId });
}

export function retryMessage(args: {
  conversationId: string;
  mode: string;
}): Promise<void> {
  return invoke('retry_message', args);
}

export function abortSession(args?: {
  conversationId?: string;
  runId?: string;
  force?: boolean;
}): Promise<boolean> {
  return invoke<boolean>('abort_session', args ?? {});
}

/** 全量优雅关闭所有常驻 claude 进程（应用更新 / 退出前调用） */
export function stopAllSessions(reason?: 'update' | 'quit'): Promise<number> {
  return invoke<number>('stop_all_sessions', { reason });
}

export function respondToolPermission(args: {
  requestId: string;
  behavior: string;
  message?: string | null;
  updatedInput?: unknown;
}): Promise<void> {
  return invoke('respond_tool_permission', args);
}

export function setPermissionMode(mode: PermissionMode): Promise<void> {
  return invoke('set_permission_mode', { mode });
}
