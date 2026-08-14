import { invoke } from '@tauri-apps/api/core';
import type { Conversation } from '../types';

export type ConversationRaw = Conversation & { projectDir?: string | null };

/** get_conversation 响应：conversation 为 null 表示版本未变（跳过重传，保留本地消息） */
export interface ConversationFetchRaw {
  conversation: ConversationRaw | null;
  version: string;
}

export function getConversations(): Promise<ConversationRaw[]> {
  return invoke<ConversationRaw[]>('get_conversations');
}

export function getConversation(
  conversationId: string,
  sourcePath?: string | null,
  knownVersion?: string | null,
): Promise<ConversationFetchRaw | null> {
  return invoke<ConversationFetchRaw | null>('get_conversation', {
    conversationId,
    sourcePath,
    knownVersion,
  });
}

export function deleteConversation(args: {
  conversationId: string;
  sourcePath?: string | null;
}): Promise<void> {
  return invoke('delete_conversation', args);
}

export function deleteWorkspaceConversations(args: {
  projectDir: string;
}): Promise<number> {
  return invoke<number>('delete_workspace_conversations', args);
}

export function updateConversationTitle(args: {
  conversationId: string;
  title: string;
  sourcePath?: string | null;
}): Promise<void> {
  return invoke('update_conversation_title', args);
}
