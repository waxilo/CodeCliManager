import { appState } from '../../state';
import * as api from '../../api';
import { normalizeConversation, updateOrAddConversation, conversationInstanceKey } from './normalize';
import { mergeRemoteAndLocalMessages } from './normalize';
import { scheduleUiRefresh } from '../../ui';

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
    const resolvedPath = sourcePath ?? existing?.source_path ?? null;
    const key = conversationInstanceKey(conversationId, resolvedPath);
    // 回传上次版本号：文件/overlay 未变时后端跳过整条克隆 + 搬运
    const knownVersion = appState.conversationVersions.get(key) ?? null;
    const raw = await api.getConversation(conversationId, resolvedPath, knownVersion);
    if (!raw) return;
    appState.conversationVersions.set(key, raw.version);
    if (raw.conversation) {
      const normalized = normalizeConversation(raw.conversation);
      updateOrAddConversation({
        ...normalized,
        messages: mergeRemoteAndLocalMessages(normalized.messages, existing?.messages),
      });
    }
    // conversation 为 null = 版本未变，保留本地已有消息
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
        conversationInstanceKey(conversation.id, conversation.source_path),
        conversation,
      ]),
    );
    const seenKeys = new Set<string>();
    appState.conversations = raw.map((item) => {
      const normalized = normalizeConversation(item);
      const key = conversationInstanceKey(normalized.id, normalized.source_path);
      seenKeys.add(key);
      const local = localByKey.get(key);
      // 摘要（messages 为空）来自后端列表：保留本地已加载的完整消息，避免清空聊天区；
      // 携带完整消息的远程数据才走合并逻辑（保留本地乐观气泡）。
      const messages =
        normalized.messages.length > 0
          ? mergeRemoteAndLocalMessages(normalized.messages, local?.messages)
          : (local?.messages?.length ? local.messages : []);
      return {
        ...normalized,
        messages,
      };
    });
    // 清理已不存在会话的版本号与消息窗口缓存，避免 Map 无限增长
    for (const key of [...appState.conversationVersions.keys()]) {
      if (!seenKeys.has(key)) appState.conversationVersions.delete(key);
    }
    for (const key of [...appState.messageWindowSizeByConversation.keys()]) {
      if (!seenKeys.has(key) && key !== conversationInstanceKey('pending', null)) {
        appState.messageWindowSizeByConversation.delete(key);
      }
    }
    const platform = await api.getCurrentPlatform();
    if (generation !== loadGeneration) return;
    appState.currentPlatform = platform;

    // 列表摘要化后，当前会话需要重新拉取完整消息，否则聊天区会变空
    if (appState.activeConversationId) {
      void refreshConversationFromBackend(
        appState.activeConversationId,
        appState.activeConversationSourcePath,
      ).then(() => scheduleUiRefresh({ chat: true }));
    }
  } catch (e) {
    if (generation !== loadGeneration) return;
    console.error('Failed to load data:', e);
  }
}

