import { appState } from '../../state';
import type { Message, Conversation, SessionEventPayload } from '../../types';
import { normalizeMessageForCompare } from '../files';
export function normalizeConversation(
  raw: Conversation & { projectDir?: string | null; sourcePath?: string | null }
): Conversation {
  const projectDir = raw.project_dir ?? raw.projectDir ?? null;
  return {
    ...raw,
    project_dir: projectDir?.trim() ? projectDir.trim() : null,
    source_path: raw.source_path ?? raw.sourcePath ?? null,
  };
}

export function normalizeSessionEventPayload(raw: SessionEventPayload): SessionEventPayload {
  const conversationId = raw.conversation_id ?? raw.conversationId ?? '';
  const projectDir = raw.project_dir ?? raw.projectDir ?? null;
  const updatedAt = raw.updated_at ?? raw.updatedAt ?? Math.floor(Date.now() / 1000);
  return {
    conversation_id: conversationId,
    title: raw.title,
    messages: raw.messages,
    project_dir: projectDir?.trim() ? projectDir.trim() : null,
    updated_at: updatedAt,
    context_tokens: raw.context_tokens ?? null,
    last_model: raw.last_model ?? null,
    usage: raw.usage ?? null,
  };
}

export function resolveConversationProjectDir(
  incoming: string | null | undefined,
  existing: string | null | undefined,
): string | null {
  const trimmedIncoming = incoming?.trim();
  if (trimmedIncoming) {
    return trimmedIncoming;
  }
  const trimmedExisting = existing?.trim();
  if (trimmedExisting) {
    return trimmedExisting;
  }
  return null;
}

// 在内存中更新或添加会话
/**
 * 合并远程历史与本地乐观消息，避免切模型重启时的 messages-updated
 * 冲掉「刚插入、尚未写入 JSONL」的用户消息，以及仅存在于本地的助手回复。
 */
export function mergeRemoteAndLocalMessages(remote: Message[], local: Message[] | undefined): Message[] {
  if (!local?.length) return remote;

  const isOptimistic = (m: Message) =>
    typeof m.id === 'string' &&
    (m.id.startsWith('user-') ||
      m.id.startsWith('stream-assistant-') ||
      m.id.startsWith('pending-') ||
      m.id.startsWith('error-'));

  const extractPendingToolId = (id: string): string | null => {
    if (!id.startsWith('pending-tool-')) return null;
    return id.slice('pending-tool-'.length) || null;
  };

  const remoteHasToolUseId = (toolUseId: string) =>
    remote.some((m) => {
      if (m.role !== 'tool_use' && m.role !== 'tool' && m.role !== 'tool_result') return false;
      try {
        const parsed = JSON.parse(m.content) as Record<string, unknown>;
        const id = String(parsed.id || parsed.tool_use_id || parsed.toolUseId || '');
        return id === toolUseId;
      } catch {
        return m.content.includes(toolUseId);
      }
    }) ||
    remote.some((m) => m.toolData?.toolUseId === toolUseId);

  const assistantTextSimilar = (a: string, b: string) => {
    const left = (a || '').trim();
    const right = (b || '').trim();
    if (!left || !right) return false;
    if (left === right) return true;
    if (left.includes(right) || right.includes(left)) return true;
    const head = Math.min(80, left.length, right.length);
    return head > 0 && (left.startsWith(right.slice(0, head)) || right.startsWith(left.slice(0, head)));
  };

  const userKey = (content: string) => normalizeMessageForCompare(content);
  const countUser = (msgs: Message[], content: string) => {
    const key = userKey(content);
    return msgs.filter((m) => m.role === 'user' && userKey(m.content) === key).length;
  };

  // 本地末尾尚未落盘的乐观消息（user-${ts} / stream-assistant-*）
  const trailingOptimistic: Message[] = [];
  for (let i = local.length - 1; i >= 0; i--) {
    if (!isOptimistic(local[i])) break;
    trailingOptimistic.unshift(local[i]);
  }

  if (trailingOptimistic.length > 0) {
    // 按内容计数：远程已覆盖的用户轮次不再追加；已有相似助手则丢掉 stream-assistant
    const keptUserExtra: Record<string, number> = {};
    const filteredTrailing: Message[] = [];

    for (const msg of trailingOptimistic) {
      if (msg.role === 'assistant') {
        const lastRemoteAssistant = [...remote].reverse().find((m) => m.role === 'assistant');
        if (
          lastRemoteAssistant &&
          assistantTextSimilar(lastRemoteAssistant.content || '', msg.content || '')
        ) {
          continue;
        }
        // 远程最后一轮用户之后已有助手，也视为已落盘
        const lastRemoteUserIdx = [...remote].map((m) => m.role).lastIndexOf('user');
        if (lastRemoteUserIdx >= 0) {
          const hasAssistantAfter = remote
            .slice(lastRemoteUserIdx + 1)
            .some((m) => m.role === 'assistant' && (m.content || '').trim());
          if (hasAssistantAfter) continue;
        }
        filteredTrailing.push(msg);
        continue;
      }

      if (msg.role === 'user') {
        const key = userKey(msg.content);
        const remoteCount = countUser(remote, msg.content);
        const optimisticLocalCount = local.filter(
          (m) =>
            m.role === 'user' &&
            isOptimistic(m) &&
            userKey(m.content) === key,
        ).length;
        // 每条远程用户消息可覆盖一条同文案乐观气泡；只追加尚未被覆盖的
        const needExtra = Math.max(0, optimisticLocalCount - remoteCount);
        const kept = keptUserExtra[key] || 0;
        if (kept >= needExtra) {
          continue;
        }
        keptUserExtra[key] = kept + 1;
        filteredTrailing.push(msg);
        continue;
      }

      // pending-tool-*：远程尚未出现同 id 的 Task 时保留，避免 turn-complete 闪断
      if (msg.role === 'tool') {
        const toolId = extractPendingToolId(String(msg.id));
        if (toolId && remoteHasToolUseId(toolId)) {
          continue;
        }
        filteredTrailing.push(msg);
        continue;
      }

      filteredTrailing.push(msg);
    }

    return dedupeAdjacentDuplicateMessages([...remote, ...filteredTrailing]);
  }

  // 无乐观尾部时：补上「远程有用户轮、但缺助手」的本地助手回复
  const merged = [...remote];
  const remoteHasUser = (content: string) =>
    remote.some(
      (m) =>
        m.role === 'user' &&
        normalizeMessageForCompare(m.content) === normalizeMessageForCompare(content),
    );
  const remoteHasAssistantAfterUser = (userContent: string) => {
    for (let i = 0; i < remote.length; i++) {
      const m = remote[i];
      if (
        m.role === 'user' &&
        normalizeMessageForCompare(m.content) === normalizeMessageForCompare(userContent)
      ) {
        for (let j = i + 1; j < remote.length; j++) {
          if (remote[j].role === 'user') break;
          if (remote[j].role === 'assistant' && (remote[j].content || '').trim()) {
            return true;
          }
        }
      }
    }
    return false;
  };

  for (let i = 0; i < local.length; i++) {
    const localMsg = local[i];
    if (localMsg.role !== 'assistant' || !(localMsg.content || '').trim()) continue;
    if (!isOptimistic(localMsg) && !String(localMsg.id).startsWith('stream-assistant-')) {
      continue;
    }
    const prevUser = [...local.slice(0, i)].reverse().find((m) => m.role === 'user');
    if (!prevUser) continue;
    if (!remoteHasUser(prevUser.content)) continue;
    if (remoteHasAssistantAfterUser(prevUser.content)) continue;

    let insertAt = merged.findIndex(
      (m) =>
        m.role === 'user' &&
        normalizeMessageForCompare(m.content) === normalizeMessageForCompare(prevUser.content),
    );
    if (insertAt < 0) continue;
    insertAt += 1;
    while (insertAt < merged.length && merged[insertAt].role !== 'user') {
      insertAt += 1;
    }
    merged.splice(insertAt, 0, localMsg);
  }

  return dedupeAdjacentDuplicateMessages(merged);
}

/** 只替换明确对应的临时气泡；真实的重复消息必须保留。 */
export function dedupeAdjacentDuplicateMessages(messages: Message[]): Message[] {
  if (messages.length < 2) return messages;
  const result: Message[] = [];
  for (const msg of messages) {
    const prev = result[result.length - 1];
    if (prev && prev.role === 'user' && msg.role === 'user') {
      const prevTemporary = String(prev.id).startsWith('user-') || String(prev.id).startsWith('pending-user-');
      const msgTemporary = String(msg.id).startsWith('user-') || String(msg.id).startsWith('pending-user-');
      if (
        prevTemporary !== msgTemporary &&
        normalizeMessageForCompare(prev.content) === normalizeMessageForCompare(msg.content)
      ) {
        result[result.length - 1] = prevTemporary ? msg : prev;
        continue;
      }
    }
    if (prev && prev.role === 'assistant' && msg.role === 'assistant') {
      const prevTemporary = String(prev.id).startsWith('stream-assistant-');
      const msgTemporary = String(msg.id).startsWith('stream-assistant-');
      if (
        prevTemporary !== msgTemporary &&
        (prev.content || '').trim() === (msg.content || '').trim()
      ) {
        result[result.length - 1] = prevTemporary ? msg : prev;
        continue;
      }
    }
    result.push(msg);
  }
  return result;
}

export function conversationInstanceKey(id: string, sourcePath?: string | null): string {
  return `${id}\u0000${sourcePath || ''}`;
}

export function isConversationInstance(
  conversation: Conversation,
  id: string,
  sourcePath?: string | null,
): boolean {
  return conversationInstanceKey(conversation.id, conversation.source_path) === conversationInstanceKey(id, sourcePath);
}

export function getActiveConversation(): Conversation | undefined {
  if (!appState.activeConversationId) return undefined;
  return appState.conversations.find((conversation) =>
    isConversationInstance(
      conversation,
      appState.activeConversationId,
      appState.activeConversationSourcePath,
    ),
  );
}

export function updateOrAddConversation(conv: Conversation) {
  const normalized = normalizeConversation(conv as Conversation & { projectDir?: string | null });
  const idx = appState.conversations.findIndex((candidate) =>
    isConversationInstance(candidate, normalized.id, normalized.source_path),
  );
  if (idx >= 0) {
    const existing = appState.conversations[idx];
    appState.conversations[idx] = {
      ...normalized,
      project_dir: resolveConversationProjectDir(normalized.project_dir, existing.project_dir),
      source_path: normalized.source_path ?? existing.source_path,
      created_at: existing.created_at,
    };
  } else {
    appState.conversations.unshift(normalized);
    // 标记为新增，下一次渲染时播放淡入动画
    appState.newConversationIds.add(normalized.id);
  }
  appState.conversations.sort(
    (a, b) => (b.updated_at || b.created_at) - (a.updated_at || a.created_at),
  );
}

