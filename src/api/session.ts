import { invoke } from '@tauri-apps/api/core';
import type { PermissionMode } from '../types';

export function executePrompt(args: Record<string, unknown>): Promise<void> {
  return invoke('execute_prompt', args);
}

export function retryMessage(args: {
  conversationId: string;
  mode: string;
}): Promise<void> {
  return invoke('retry_message', args);
}

export function abortSession(args?: {
  conversationId?: string;
  force?: boolean;
}): Promise<boolean> {
  return invoke<boolean>('abort_session', args ?? {});
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
