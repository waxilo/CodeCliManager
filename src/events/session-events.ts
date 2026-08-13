import { appState } from '../state';
import { shellApi } from '../app/shell/api';
import { listen } from '@tauri-apps/api/event';
import type { Message, SessionErrorPayload, SessionEventPayload, MessageChunkPayload, QueuedPromptItem } from '../types';
import { handleMessageChunk, handleSessionError, clearStreamingState, commitStreamingAssistantToConversation, ensureAssistantPresent, refreshStreamingUI } from '../features/chat/streaming';
import { updateOrAddConversation, normalizeSessionEventPayload, mergeRemoteAndLocalMessages } from '../features/conversations';
import { handlePermissionRequest, closePermissionDialogs } from '../features/permissions';
import { setAbortingUi, setSendButtonLoading, isSendButtonLoading } from '../features/chat/session-context';
import { hideSendingState } from '../features/chat/retry';
import { updateConversationListSpinner } from '../features/sidebar';
import { updateContextIndicator } from '../features/chat/context-indicator';
import { abortSession } from '../features/chat/send';
import { captureScrollState, getStreamingAssistantText, restoreScrollState } from '../features/chat/streaming';
import { loadData } from '../features/conversations/load';
import { normalizeMessageForCompare } from '../features/files/index';
import type { PermissionRequestPayload } from '../types';
import { showCopyToastMsg } from '../ui';
import { syncQueuedPromptsUI } from '../features/chat/input-composer';

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
const chatRefreshTimers = new Map<string, ReturnType<typeof setTimeout>>();

/** 合并同一轮 messages-updated / turn-complete / queue 触发的重复全列表重建。 */
function scheduleChatRefresh(sessionId: string, delay = 32): void {
  const existing = chatRefreshTimers.get(sessionId);
  if (existing) clearTimeout(existing);
  chatRefreshTimers.set(sessionId, setTimeout(() => {
    chatRefreshTimers.delete(sessionId);
    if (appState.activeConversationId === sessionId) {
      shellApi.refreshChatContent();
      updateContextIndicator();
    }
  }, delay));
}

export async function setupEventListeners() {
  if (eventListenersReady) return;
  eventListenersReady = true;

  // 监听流式消息块（thinking / answer 实时分离）
  await listen<MessageChunkPayload>('message-chunk', (event) => {
    handleMessageChunk(event.payload);
  });

  await listen<PermissionRequestPayload>('permission-request', (event) => {
    void handlePermissionRequest(event.payload);
  });

  await listen<string | null>('session-aborting', (event) => {
    const sid = event.payload || appState.activeConversationId || '';
    if (sid) {
      appState.abortingSessions.add(sid);
      closePermissionDialogs(sid);
    }
    if (!sid || sid === appState.activeConversationId || sid.startsWith('pending-')) {
      setAbortingUi(true);
    }
  });

  // 监听会话创建事件（后端在流完成后首次写入会话时触发）
  await listen<SessionEventPayload>('session-created', (event) => {
    const payload = normalizeSessionEventPayload(event.payload);
    appState.runningSessions.delete(payload.conversation_id);
    appState.transientSessionError = null;

    // 判断用户当前是否正在查看此会话（不要强制切换视图）
    const isViewingThis = appState.activeConversationId === payload.conversation_id;

    if (isViewingThis) {
      appState.pendingProjectDir = null;
    }

    updateOrAddConversation({
      id: payload.conversation_id,
      title: payload.title,
      messages: (() => {
        const existing = appState.conversations.find((c) => c.id === payload.conversation_id);
        return mergeRemoteAndLocalMessages(payload.messages, existing?.messages);
      })(),
      platform: 'claude',
      project_dir: payload.project_dir,
      created_at: payload.updated_at,
      updated_at: payload.updated_at,
      context_tokens: payload.context_tokens ?? null,
      last_model: payload.last_model ?? null,
    });

    // 只在会话数据已包含用户消息时才清空 appState.pendingUserMessage
    // 同时确保只清除属于当前会话的 pending 消息（防止串会话）
    if (appState.pendingUserMessage && appState.pendingUserMessageConvId === payload.conversation_id && payload.messages.some(
      (m: Message) => m.role === 'user' && normalizeMessageForCompare(m.content) === normalizeMessageForCompare(appState.pendingUserMessage)
    )) {
      appState.pendingUserMessage = null;
      appState.pendingUserMessageConvId = null;
    }

    clearStreamingState(payload.conversation_id);

    if (isViewingThis) {
      hideSendingState();
      // 输出结束后重建消息列表：若用户此前已上滑阅读上方消息，重建后保持原位
      const scrollSnap = captureScrollState();
      shellApi.render();
      restoreScrollState(scrollSnap);
      setTimeout(() => {
        // 仅在用户仍位于底部时置底，避免打断阅读上方内容
        if (appState.answerScroller?.autoScroll) {
          appState.answerScroller.scrollToBottom();
        }
      }, 100);
    } else {
      // 用户在看别的会话或新聊天页，只更新侧边栏
      updateConversationListSpinner();
    }
  });
  
  // 监听消息更新事件
  await listen<SessionEventPayload>('messages-updated', (event) => {
    const payload = normalizeSessionEventPayload(event.payload);
    // 只在会话数据已包含用户消息时才清空 appState.pendingUserMessage，
    // 否则保留以便 refreshChatContent 补充显示
    // （Claude CLI 仅在完成响应后才写入会话文件，首条用户消息可能不在其中）
    // 同时确保只清除属于当前会话的 pending 消息（防止串会话）
    if (appState.pendingUserMessage && appState.pendingUserMessageConvId === payload.conversation_id && payload.messages.some(
      (m: Message) => m.role === 'user' && normalizeMessageForCompare(m.content) === normalizeMessageForCompare(appState.pendingUserMessage)
    )) {
      appState.pendingUserMessage = null;
      appState.pendingUserMessageConvId = null;
    }
    appState.transientSessionError = null;

    const streamedText = getStreamingAssistantText(payload.conversation_id);
    commitStreamingAssistantToConversation(payload.conversation_id);

    // 进行中的问答保留；已结束的 pending 残留清掉
    {
      const pending =
        appState.pendingAskQuestions.get(payload.conversation_id) ||
        appState.pendingAskQuestions.get('pending');
      if (pending && !pending.finish) {
        appState.pendingAskQuestions.delete(payload.conversation_id);
        appState.pendingAskQuestions.delete('pending');
      }
    }

    const existingConv = appState.conversations.find((c) => c.id === payload.conversation_id);
    const mergedMessages = mergeRemoteAndLocalMessages(
      payload.messages,
      existingConv?.messages,
    );

    updateOrAddConversation({
      id: payload.conversation_id,
      title: payload.title,
      messages: mergedMessages,
      platform: 'claude',
      project_dir: payload.project_dir,
      created_at: payload.updated_at,
      updated_at: payload.updated_at,
      context_tokens: payload.context_tokens ?? null,
      last_model: payload.last_model ?? null,
    });

    // 远程已有助手时不要再塞一条 stream-assistant；先清流式 DOM，避免与历史气泡叠两层
    const remoteHasAssistant = payload.messages.some(
      (m) => m.role === 'assistant' && (m.content || '').trim(),
    );
    if (!remoteHasAssistant) {
      ensureAssistantPresent(payload.conversation_id, streamedText);
    }
    clearStreamingState(payload.conversation_id);

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
    const conversation = appState.conversations.find((entry) => entry.id === conversationId);
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
    if (appState.activeConversationId === conversationId) {
      scheduleChatRefresh(conversationId);
      setSendButtonLoading(true);
    }
    updateConversationListSpinner();
  });

  await listen<string | null>('turn-continued', (event) => {
    const sid = event.payload;
    if (!sid || sid !== appState.activeConversationId) return;
    appState.runningSessions.add(sid);
    appState.pendingUserMessage = null;
    appState.pendingUserMessageConvId = null;
    setSendButtonLoading(true);
    updateConversationListSpinner();
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
      console.log('[turn-complete] 忽略切模型重启期间的过期事件:', sid);
      return;
    }
    const wasUserAbort =
      (sid && appState.abortingSessions.has(sid)) ||
      appState.abortingSessions.has('pending') ||
      (sid === appState.activeConversationId && appState.isAbortingActiveSession);

    if (sid) {
      const queuedCount = appState.queuedPromptsBySession.get(sid)?.length || 0;
      if (queuedCount > 0) {
        // Rust 已在 turn-complete 前派发下一条；保留 running/loading，等待下一轮。
        updateConversationListSpinner();
        return;
      }
    }
    if (sid) {
      const streamedText = getStreamingAssistantText(sid);
      commitStreamingAssistantToConversation(sid);
      ensureAssistantPresent(sid, streamedText);
      appState.runningSessions.delete(sid);
      appState.abortingSessions.delete(sid);
    }
    appState.runningSessions.delete('pending');
    appState.abortingSessions.delete('pending');
    clearStreamingState(sid || '');

    const isCurrentSession = !sid || sid === appState.activeConversationId;
    if (isCurrentSession) {
      setAbortingUi(false);
      hideSendingState();
      appState.pendingUserMessage = null;
      appState.pendingUserMessageConvId = null;
      updateConversationListSpinner();
      const refreshSessionId = sid || appState.activeConversationId;
      if (refreshSessionId) {
        scheduleChatRefresh(refreshSessionId);
      } else {
        shellApi.refreshChatContent();
        updateContextIndicator();
      }
      if (wasUserAbort) {
        showCopyToastMsg('已停止');
      }
    } else {
      updateConversationListSpinner();
    }
  });

  // 监听会话结束事件（进程真正退出：空闲超时 / 强杀 / 异常）
  await listen<string | null>('session-ended', (event) => {
    const endedSessionId = event.payload;
    const wasUserAbort =
      (endedSessionId && appState.abortingSessions.has(endedSessionId)) ||
      appState.abortingSessions.has('pending') ||
      (endedSessionId === appState.activeConversationId && appState.isAbortingActiveSession);

    // 切模型后新进程已标记 running：旧进程的 session-ended 是过期事件，
    // 若再 loadData 会冲掉本地刚插入的用户消息和上一轮回复。
    if (
      endedSessionId &&
      appState.runningSessions.has(endedSessionId) &&
      !wasUserAbort
    ) {
      console.log('[session-ended] 忽略过期结束事件（会话仍在运行）:', endedSessionId);
      return;
    }

    if (endedSessionId) {
      appState.queuedPromptsBySession.delete(endedSessionId);
      appState.runningSessions.delete(endedSessionId);
      appState.abortingSessions.delete(endedSessionId);
      appState.sessionProcessModels.delete(endedSessionId);
    }
    appState.runningSessions.delete('pending');
    appState.abortingSessions.delete('pending');
    appState.sessionProcessModels.delete('pending');
    clearStreamingState(endedSessionId || '');

    const isCurrentSession = !endedSessionId || endedSessionId === appState.activeConversationId;

    if (isCurrentSession) {
      syncQueuedPromptsUI();
      setAbortingUi(false);
      hideSendingState();
      appState.pendingUserMessage = null;
      appState.pendingUserMessageConvId = null;
      if (wasUserAbort) {
        showCopyToastMsg('已停止');
      }
    }

    const preservedErrors = appState.conversations.flatMap((conversation) =>
      conversation.messages
        .filter((message) => message.role === 'error')
        .map((message) => ({ conversationId: conversation.id, message })),
    );

    void loadData().then(() => {
      preservedErrors.forEach(({ conversationId, message }) => {
        const conversation = appState.conversations.find((item) => item.id === conversationId);
        if (
          conversation &&
          !conversation.messages.some(
            (item) => item.role === 'error' && item.content === message.content,
          )
        ) {
          conversation.messages.push(message);
        }
      });

      updateConversationListSpinner();
      updateContextIndicator();

      if (isCurrentSession && (appState.activeConversationId || appState.transientSessionError)) {
        shellApi.refreshChatContent();
      }
    });
  });

  // ESC 键取消正在运行的任务（参考 claudecodeui）
  document.addEventListener('keydown', (e: KeyboardEvent) => {
    if (e.key === 'Escape' && !e.repeat) {
      // 权限面板 / 问答选择卡自行处理 ESC，避免同时 abort
      if (
        document.querySelector('.interaction-panel') ||
        document.querySelector('.ask-card.is-interactive')
      ) {
        return;
      }
      if (appState.isAbortingActiveSession) return;
      if (isSendButtonLoading()) {
        e.preventDefault();
        void abortSession();
      }
    }
  });
}

