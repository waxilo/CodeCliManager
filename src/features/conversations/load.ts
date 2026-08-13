import { appState } from '../../state';
import * as api from '../../api';
import { normalizeConversation, updateOrAddConversation } from './normalize';
import { mergeRemoteAndLocalMessages } from './normalize';

let loadGeneration = 0;

export async function refreshConversationFromBackend(
  conversationId: string,
  sourcePath: string | null = null,
) {
  if (!conversationId) {
    return;
  }
  try {
    const existing = appState.conversations.find(
      (conversation) =>
        conversation.id === conversationId &&
        (sourcePath === null || (conversation.source_path ?? null) === sourcePath),
    );
    const raw = await api.getConversation(conversationId, sourcePath ?? existing?.source_path ?? null);
    if (raw) {
      const normalized = normalizeConversation(raw);
      updateOrAddConversation({
        ...normalized,
        messages: mergeRemoteAndLocalMessages(normalized.messages, existing?.messages),
      });
    }
  } catch (e) {
    console.error('Failed to refresh conversation:', e);
  }
}

export async function loadData() {
  const generation = ++loadGeneration;
  try {
    const raw = await api.getConversations();
    if (generation !== loadGeneration) return;
    const localByKey = new Map(
      appState.conversations.map((conversation) => [
        `${conversation.id}\u0000${conversation.source_path || ''}`,
        conversation,
      ]),
    );
    appState.conversations = raw.map((item) => {
      const normalized = normalizeConversation(item);
      const local = localByKey.get(`${normalized.id}\u0000${normalized.source_path || ''}`);
      return {
        ...normalized,
        messages: mergeRemoteAndLocalMessages(normalized.messages, local?.messages),
      };
    });
    const platform = await api.getCurrentPlatform();
    if (generation !== loadGeneration) return;
    appState.currentPlatform = platform;
    console.log('Current platform:', appState.currentPlatform);
  } catch (e) {
    if (generation !== loadGeneration) return;
    console.error('Failed to load data:', e);
  }
}

