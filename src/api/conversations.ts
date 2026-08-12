import { invoke } from '@tauri-apps/api/core';
import type { Conversation } from '../types';

export type ConversationRaw = Conversation & { projectDir?: string | null };

export function getConversations(): Promise<ConversationRaw[]> {
  return invoke<ConversationRaw[]>('get_conversations');
}

export function getConversation(conversationId: string): Promise<ConversationRaw | null> {
  return invoke<ConversationRaw | null>('get_conversation', { conversationId });
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
