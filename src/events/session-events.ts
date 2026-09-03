import { appState } from '../state';
import { shellApi } from '../app/shell/api';
import { listen } from '@tauri-apps/api/event';
import type { Message, SessionErrorPayload, SessionEventPayload, MessageChunkPayload, QueuedPromptItem, SessionUsage, SessionUsageUpdatedPayload } from '../types';
import { handleMessageChunk, handleSessionError, clearStreamingState, commitStreamingAssistantToConversation, ensureAssistantPresent, refreshStreamingUI, reconcileActiveToolsWithHistory, purgeTerminalTools, clearSessionTools } from '../features/chat/streaming';
import { updateOrAddConversation, normalizeSessionEventPayload, mergeRemoteAndLocalMessages, findConversationById, assistantTextCovers } from '../features/conversations';
import { handlePermissionRequest, closePermissionDialogs } from '../features/permissions';
import { getActiveSessionKey, isActiveSessionAborting, isPendingSessionKey, setAbortingUi, setSendButtonLoading } from '../features/chat/session-context';
import { hideSendingState } from '../features/chat/session-context';
import { updateConversationListSpinner, refreshActiveTabContent } from '../features/sidebar';
import { updateContextIndicator } from '../features/chat/context-indicator';
import { updateCostIndicator } from '../features/chat/cost-indicator';
import { syncRunningSubagentsUI } from '../features/chat/subagent-progress';
import { syncTodoPanelUI, extractLatestTodos } from '../features/chat/todo-panel';
import { getStreamingAssistantText } from '../features/chat/streaming';
import { refreshConversationFromBackend } from '../features/conversations/load';
import { refreshChatContent } from '../features/chat/refresh';
import { normalizeMessageForCompare } from '../features/files/index';
import type { PermissionRequestPayload } from '../types';
import { showCopyToastMsg, scheduleUiRefresh } from '../ui';
import { syncQueuedPromptsUI } from '../features/chat/input-composer';
import {
  markSessionRunStart,
  startRunStatusTicker,
} from '../features/chat/run-status';

interface QueuedPromptsUpdatedPayload {
  conversationId: string;
  items: QueuedPromptItem[];
}

interface QueuedPromptDispatchedPayload {
  conversationId: string;
  item: QueuedPromptItem;
}

/** 防止 init 被重复调用时重复注册，导致 text_delta 字字双份 */
let eventListenersReady = false;

/** 合并同一轮 messages-updated / turn-complete / queue 触发的重复全列表重建（走中央调度器）。 */
function scheduleChatRefresh(sessionId: string): void {
  if (appState.activeConversationId !== sessionId) return;
  updateContextIndicator();
  scheduleUiRefresh({ chat: true, subagent: true, todo: true });
}

/** 从历史 payload 重建用量基线 + TodoList（进程增量在其上叠加；无数据时不动既有累计） */
function seedUsageAndTodos(payload: SessionEventPayload): void {
  const sid = payload.conversation_id;
  if (!sid) return;
  if (payload.usage) {
    appState.usageBySession.set(sid, payload.usage);
  }
  const latestTodos = extractLatestTodos(payload.messages);
  if (latestTodos.length > 0) {
    appState.todosBySession.set(sid, latestTodos);
  } else {
    appState.todosBySession.delete(sid);
  }
}

function clearPersistedPendingUserMessage(payload: SessionEventPayload): void {
  const pending = appState.pendingUserMessagesBySession.get(payload.conversation_id);
  if (!pending) return;
  const persisted = payload.messages.some(
    (message: Message) =>
      message.role === 'user' &&
      normalizeMessageForCompare(message.content) ===
        normalizeMessageForCompare(pending.content),
  );
  if (persisted) appState.pendingUserMessagesBySession.delete(payload.conversation_id);
}

export async function setupEventListeners() {
  if (eventListenersReady) return;
  eventListenersReady = true;

  // 输入框下方状态条：定时刷新执行时长与状态
  startRunStatusTicker();

  // 监听流式消息块（thinking / answer 实时分离）
  await listen<MessageChunkPayload>('message-chunk', (event) => {
    handleMessageChunk(event.payload);
  });

  await listen<PermissionRequestPayload>('permission-request', (event) => {
    void handlePermissionRequest(event.payload);
  });

  await listen<string | null>('session-aborting', (event) => {
    const sid = event.payload || getActiveSessionKey();
    if (!sid) return;
    appState.abortingSessions.add(sid);
    closePermissionDialogs(sid);
    if (sid === getActiveSessionKey()) setAbortingUi(true);
  });

  // 监听会话创建事件（后端在流完成后首次写入会话时触发）
  await listen<SessionEventPayload>('session-created', (event) => {
    const payload = normalizeSessionEventPayload(event.payload);
    appState.runningSessions.delete(payload.conversation_id);
    appState.transientSessionErrorsBySession.delete(payload.conversation_id);

    // 判断用户当前是否正在查看此会话（不要强制切换视图）
    const isViewingThis = appState.activeConversationId === payload.conversation_id;

    if (isViewingThis) {
      appState.pendingProjectDir = null;
    }

    const added = updateOrAddConversation({
      id: payload.conversation_id,
      title: payload.title,
      messages: (() => {
        const existing = findConversationById(payload.conversation_id, payload.source_path);
        reconcileActiveToolsWithHistory(payload.conversation_id, payload.messages);
        return mergeRemoteAndLocalMessages(payload.messages, existing?.messages);
      })(),
      platform: 'claude',
      project_dir: payload.project_dir,
      source_path: payload.source_path ?? null,
      created_at: payload.updated_at,
      updated_at: payload.updated_at,
      context_tokens: payload.context_tokens ?? null,
      last_model: payload.last_model ?? null,
    });
    // 新会话首落盘时重建侧边栏当前 tab，否则左侧列表不出现新条目
    if (added) refreshActiveTabContent();

    clearPersistedPendingUserMessage(payload);

    clearStreamingState(payload.conversation_id);

    seedUsageAndTodos(payload);
    if (isViewingThis) {
      syncTodoPanelUI();
      syncRunningSubagentsUI();
      updateCostIndicator();
      hideSendingState();
      // 输出结束只提交一次最终 render plan；cursor reconcile、流式落盘和滚动恢复同事务完成。
      refreshChatContent();
      updateConversationListSpinner();
    } else {
      // 用户在看别的会话或新聊天页，只更新侧边栏
      updateConversationListSpinner();
    }
  });
  
  // 监听消息更新事件
  await listen<SessionEventPayload>('messages-updated', (event) => {
    const payload = normalizeSessionEventPayload(event.payload);
    clearPersistedPendingUserMessage(payload);
    appState.transientSessionErrorsBySession.delete(payload.conversation_id);

    const streamedText = getStreamingAssistantText(payload.conversation_id);
    commitStreamingAssistantToConversation(payload.conversation_id);

    // 进行中的问答保留；已结束的 pending 残留清掉
    {
      const pending = appState.pendingAskQuestions.get(payload.conversation_id);
      if (pending && !pending.finish) {
        appState.pendingAskQuestions.delete(payload.conversation_id);
      }
    }

    const existingConv = findConversationById(payload.conversation_id, payload.source_path);
    reconcileActiveToolsWithHistory(payload.conversation_id, payload.messages);
    const mergedMessages = mergeRemoteAndLocalMessages(
      payload.messages,
      existingConv?.messages,
    );

    const added = updateOrAddConversation({
      id: payload.conversation_id,
      title: payload.title,
      messages: mergedMessages,
      platform: 'claude',
      project_dir: payload.project_dir,
      source_path: payload.source_path ?? null,
      created_at: payload.updated_at,
      updated_at: payload.updated_at,
      context_tokens: payload.context_tokens ?? null,
      last_model: payload.last_model ?? null,
      usage: payload.usage ?? null,
    });
    // 兜底：会话仅经 messages-updated 首现（session-created 未触发）时也要刷新侧边栏
    if (added) refreshActiveTabContent();

    // 远程已「内容级」包含当前流式文本（最终报告已落盘）才不再补 stream-assistant。
    // 仅凭「存在任意 assistant 气泡」会漏判「远程只有更早的 progress、最终报告尚未写入」，
    // 导致清掉流式 DOM 时报告消失。
    const remoteCoversStreamed = payload.messages.some(
      (m) =>
        m.role === 'assistant' &&
        (m.content || '').trim() &&
        assistantTextCovers(m.content || '', streamedText),
    );
    if (!remoteCoversStreamed) {
      ensureAssistantPresent(payload.conversation_id, streamedText);
    }
    clearStreamingState(payload.conversation_id);

    seedUsageAndTodos(payload);

    const isViewingThis = appState.activeConversationId === payload.conversation_id;

    if (isViewingThis) {
      // 如果会话仍在运行中（如重试/重新生成），保持 loading 状态
      // session-ended / turn-complete 到达时再调用 hideSendingState
      if (!appState.runningSessions.has(payload.conversation_id)) {
        hideSendingState();
      }
      scheduleChatRefresh(payload.conversation_id);
    } else {
      updateConversationListSpinner();
    }
  });
  
  // 监听会话错误事件
  await listen<SessionErrorPayload>('session-error', (event) => {
    handleSessionError(event.payload);
  });

  await listen<QueuedPromptsUpdatedPayload>('queued-prompts-updated', (event) => {
    const { conversationId, items } = event.payload;
    if (!conversationId) return;
    if (items.length > 0) {
      appState.queuedPromptsBySession.set(conversationId, items);
    } else {
      appState.queuedPromptsBySession.delete(conversationId);
    }
    if (appState.activeConversationId === conversationId) {
      syncQueuedPromptsUI();
      shellApi.updateSendButtonState();
    }
  });

  await listen<QueuedPromptDispatchedPayload>('queued-prompt-dispatched', (event) => {
    const { conversationId, item } = event.payload;
    const conversation = findConversationById(conversationId);
    if (conversation && !conversation.messages.some((message) => message.id === `queued-${item.id}`)) {
      conversation.messages.push({
        id: `queued-${item.id}`,
        role: 'user',
        content: item.messageContent,
        timestamp: Math.floor(Date.now() / 1000),
      });
      conversation.updated_at = Math.floor(Date.now() / 1000);
    }
    appState.runningSessions.add(conversationId);
    markSessionRunStart(conversationId);
    if (appState.activeConversationId === conversationId) {
      scheduleChatRefresh(conversationId);
      setSendButtonLoading(true);
    }
    updateConversationListSpinner();
  });

  // 会话用量增量事件（turn-complete 前由后端下发，叠加到历史基线上）
  await listen<SessionUsageUpdatedPayload>('session-usage-updated', (event) => {
    const { conversationId, inputTokens, outputTokens, cacheRead, cacheCreation, costUsd } = event.payload;
    if (!conversationId) return;
    const current = appState.usageBySession.get(conversationId) || {
      inputTokens: 0,
      outputTokens: 0,
      cacheRead: 0,
      cacheCreation: 0,
    };
    const next: SessionUsage = {
      inputTokens: current.inputTokens + (inputTokens || 0),
      outputTokens: current.outputTokens + (outputTokens || 0),
      cacheRead: current.cacheRead + (cacheRead || 0),
      cacheCreation: current.cacheCreation + (cacheCreation || 0),
      costUsd: (current.costUsd ?? 0) + (costUsd ?? 0),
    };
    appState.usageBySession.set(conversationId, next);
    if (appState.activeConversationId === conversationId) {
      updateCostIndicator();
    }
  });

  await listen<string | null>('turn-continued', (event) => {
    const sid = event.payload;
    if (!sid) return;
    appState.runningSessions.add(sid);
    markSessionRunStart(sid);
    appState.pendingUserMessagesBySession.delete(sid);
    updateConversationListSpinner();
    if (sid !== getActiveSessionKey()) return;
    setSendButtonLoading(true);
    // 自动续跑时仍有流式缓冲：保留 streaming UI，避免全量重建闪断
    if (appState.streamingBySession.has(sid)) {
      refreshStreamingUI(sid);
    } else {
      scheduleChatRefresh(sid);
    }
  });
  await listen<string | null>('turn-complete', (event) => {
    const sid = event.payload;
    // 切模型重启期间旧进程的 turn-complete：不要清 running / 不要用旧历史刷 UI
    if (sid && appState.modelRestartingSessions.has(sid)) {
      console.debug('[turn-complete] 忽略切模型重启期间的过期事件:', sid);
      return;
    }
    const wasUserAbort = Boolean(
      sid &&
      (appState.abortingSessions.has(sid) ||
        (sid === getActiveSessionKey() && isActiveSessionAborting())),
    );

    if (sid) {
      // 轮次结束：先清掉上一轮已终态的 Task，让子代理面板随新一轮重新累计
      purgeTerminalTools(sid);
      const queuedCount = appState.queuedPromptsBySession.get(sid)?.length || 0;
      if (queuedCount > 0) {
        // Rust 已在 turn-complete 前派发下一条；保留 running/loading，等待下一轮。
        updateConversationListSpinner();
        if (sid === appState.activeConversationId) {
          syncRunningSubagentsUI();
        }
        return;
      }
    }
    if (sid) {
      const streamedText = getStreamingAssistantText(sid);
      commitStreamingAssistantToConversation(sid);
      ensureAssistantPresent(sid, streamedText);
      appState.runningSessions.delete(sid);
      appState.abortingSessions.delete(sid);
      appState.pendingUserMessagesBySession.delete(sid);
      clearSessionTools(sid);
      clearStreamingState(sid);
    }

    const isCurrentSession = Boolean(sid && sid === getActiveSessionKey());
    if (isCurrentSession) {
      setAbortingUi(false);
      hideSendingState();
      updateConversationListSpinner();
      if (sid && !isPendingSessionKey(sid)) {
        scheduleChatRefresh(sid);
      } else {
        updateContextIndicator();
        updateCostIndicator();
        scheduleUiRefresh({ chat: true, subagent: true, todo: true });
      }
      if (wasUserAbort) showCopyToastMsg('已停止');
    } else {
      updateConversationListSpinner();
    }
  });

  // 监听会话结束事件（进程真正退出：空闲超时 / 强杀 / 异常）
  await listen<string | null>('session-ended', (event) => {
    const endedSessionId = event.payload;
    const wasUserAbort = Boolean(
      endedSessionId &&
      (appState.abortingSessions.has(endedSessionId) ||
        (endedSessionId === getActiveSessionKey() && isActiveSessionAborting())),
    );

    // 切模型后新进程已标记 running：旧进程的 session-ended 是过期事件，
    // 若再 loadData 会冲掉本地刚插入的用户消息和上一轮回复。
    if (
      endedSessionId &&
      !isPendingSessionKey(endedSessionId) &&
      appState.runningSessions.has(endedSessionId) &&
      !wasUserAbort
    ) {
      console.debug('[session-ended] 忽略过期结束事件（会话仍在运行）:', endedSessionId);
      return;
    }

    const isCurrentSession = Boolean(
      endedSessionId && endedSessionId === getActiveSessionKey(),
    );

    if (endedSessionId) {
      appState.queuedPromptsBySession.delete(endedSessionId);
      appState.runningSessions.delete(endedSessionId);
      appState.abortingSessions.delete(endedSessionId);
      appState.sessionProcessModels.delete(endedSessionId);
      appState.runIdsBySession.delete(endedSessionId);
      appState.pendingUserMessagesBySession.delete(endedSessionId);
      if (!isPendingSessionKey(endedSessionId) || !isCurrentSession) {
        appState.transientSessionErrorsBySession.delete(endedSessionId);
      }
      clearSessionTools(endedSessionId);
      clearStreamingState(endedSessionId);
      closePermissionDialogs(endedSessionId);
    }

    if (isCurrentSession) {
      if (
        endedSessionId &&
        isPendingSessionKey(endedSessionId) &&
        !appState.transientSessionErrorsBySession.has(endedSessionId)
      ) {
        appState.activePendingSessionKey = '';
      }
      syncQueuedPromptsUI();
      setAbortingUi(false);
      hideSendingState();
      if (wasUserAbort) showCopyToastMsg('已停止');
    }

    const refreshPromise =
      endedSessionId && !isPendingSessionKey(endedSessionId)
        ? refreshConversationFromBackend(endedSessionId)
        : Promise.resolve();

    void refreshPromise.then(() => {
      updateConversationListSpinner();
      if (!isCurrentSession) return;
      updateContextIndicator();
      updateCostIndicator();
      scheduleUiRefresh({
        chat: Boolean(getActiveSessionKey()),
        subagent: true,
        todo: true,
      });
    });
  });

}

