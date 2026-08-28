import { invoke } from '@tauri-apps/api/core';
import type { ExecutePromptResult, PermissionMode } from '../types';

/** execute_prompt 参数：结构化类型，字段拼错在编译期暴露 */
export interface ExecutePromptArgs extends Record<string, unknown> {
  prompt: string;
  messageContent: string;
  conversationId?: string;
  model?: string;
  projectDir?: string;
}

export function executePrompt(args: ExecutePromptArgs): Promise<ExecutePromptResult> {
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

/** 重连 / 刷新会话：强制从磁盘重读该会话并校准运行态，后端会推送 messages-updated / session-ended */
export function reloadSession(conversationId: string, sourcePath?: string | null): Promise<void> {
  return invoke('reload_session', { conversationId, sourcePath });
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
