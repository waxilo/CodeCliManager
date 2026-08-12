import { appState } from '../../state';
import * as api from '../../api';
import { normalizeConversation, updateOrAddConversation } from './normalize';
import { mergeRemoteAndLocalMessages } from './normalize';
export async function refreshConversationFromBackend(conversationId: string) {
  if (!conversationId) {
    return;
  }
  try {
    const raw = await api.getConversation(conversationId);
    if (raw) {
      const existing = appState.conversations.find((c) => c.id === conversationId);
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
  try {
    const raw = await api.getConversations();
    appState.conversations = raw.map(normalizeConversation);
    appState.currentPlatform = await api.getCurrentPlatform();
    console.log('Current platform:', appState.currentPlatform);
  } catch (e) {
    console.error('Failed to load data:', e);
  }
}

