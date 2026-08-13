import { appState } from '../../state';
import { shellApi } from '../../app/shell/api';
import type { Message, SessionErrorPayload, MessageChunkPayload, StreamBlock, StreamingState } from '../../types';
import { renderMarkdownCached as renderMarkdown, initCodeCopyButtons } from '../../markdown';
import { getThinkingScroller } from './thinking-scroller';
import { updateSendButtonState, setSendButtonLoading } from './session-context';
import { updateOrAddConversation } from '../conversations';
import { updateConversationListSpinner } from '../sidebar';
import { renderThinkingDetails } from './render-messages';
import { clearPendingRequestState, hideSendingState, removePendingAssistantIndicator, updatePendingStatus } from './retry';
import { ScrollController } from '../../ui';
export function getStreamingState(sessionId: string): StreamingState {
  if (!appState.streamingBySession.has(sessionId)) {
    appState.streamingBySession.set(sessionId, { blocks: [], thinkingDone: false, currentBlockIdx: -1 });
  }
  return appState.streamingBySession.get(sessionId)!;
}

export function clearStreamingState(sessionId: string) {
  appState.streamingBySession.delete(sessionId);
  appState.pendingTextDelta.delete(sessionId);
  removeStreamingElements();
  // 取消待处理的 RAF 刷新
  if (appState.streamRefreshRafId !== null) {
    cancelAnimationFrame(appState.streamRefreshRafId);
    appState.streamRefreshRafId = null;
    appState.streamRefreshPending = false;
  }
}

/** 从流式块提取已生成的助手文本 */
export function getStreamingAssistantText(sessionId: string): string {
  flushPendingTextDelta(sessionId);
  const state = appState.streamingBySession.get(sessionId);
  if (!state) return '';
  return state.blocks
    .filter((block) => block.type === 'text')
    .map((block) => block.content)
    .join('\n\n')
    .trim();
}

/**
 * 在清掉流式 UI 前，把已生成的助手文本写入会话，避免 JSONL 尚未落盘时刷新导致“消息消失”。
 */
export function commitStreamingAssistantToConversation(sessionId: string): void {
  if (!sessionId) return;
  const text = getStreamingAssistantText(sessionId);
  if (!text) return;

  const conversation = appState.conversations.find((item) => item.id === sessionId);
  if (!conversation) return;

  const last = conversation.messages[conversation.messages.length - 1];
  if (last?.role === 'assistant') {
    const prev = last.content || '';
    if (
      prev === text ||
      text.startsWith(prev) ||
      prev.startsWith(text.slice(0, Math.min(80, text.length)))
    ) {
      if (text.length >= prev.length) {
        last.content = text;
      }
      conversation.updated_at = Math.floor(Date.now() / 1000);
      return;
    }
  }

  if (last?.role === 'user' || last?.role === 'assistant' || !last) {
    conversation.messages.push({
      id: `stream-assistant-${Date.now()}`,
      role: 'assistant',
      content: text,
      timestamp: Math.floor(Date.now() / 1000),
    });
    conversation.updated_at = Math.floor(Date.now() / 1000);
  }
}

/** 远程消息若尚未包含最新助手回复，保留本地已提交的流式文本 */
export function ensureAssistantPresent(sessionId: string, streamedText: string): void {
  if (!sessionId || !streamedText) return;
  const conversation = appState.conversations.find((item) => item.id === sessionId);
  if (!conversation) return;

  const lastAssistant = [...conversation.messages].reverse().find((m) => m.role === 'assistant');
  if (lastAssistant) {
    const prev = lastAssistant.content || '';
    if (prev === streamedText || prev.includes(streamedText) || streamedText.includes(prev)) {
      if (streamedText.length > prev.length) {
        lastAssistant.content = streamedText;
      }
      return;
    }
  }

  const last = conversation.messages[conversation.messages.length - 1];
  if (last?.role === 'user' || !lastAssistant) {
    conversation.messages.push({
      id: `stream-assistant-${Date.now()}`,
      role: 'assistant',
      content: streamedText,
      timestamp: Math.floor(Date.now() / 1000),
    });
    conversation.updated_at = Math.floor(Date.now() / 1000);
  }
}

/** 将当前缓冲的文本追加到当前 text 块的 content */
export function flushPendingTextDelta(sessionId: string) {
  const pending = appState.pendingTextDelta.get(sessionId);
  if (!pending) return;
  const state = getStreamingState(sessionId);
  const block = state.blocks[state.currentBlockIdx];
  if (block && block.type === 'text') {
    block.content += pending;
  }
  appState.pendingTextDelta.set(sessionId, '');
}

export function handleMessageChunk(payload: MessageChunkPayload) {
  const { conversation_id: sid, kind, content } = payload;
  if (!sid) return;

  // 新进程已开始输出：切模型重启保护结束
  appState.modelRestartingSessions.delete(sid);

  // 本轮已结束：忽略迟到的流式块，避免与已落盘助手气泡叠成「重复且无操作栏」
  if (
    kind !== 'session_created' &&
    !appState.runningSessions.has(sid) &&
    !appState.runningSessions.has('pending')
  ) {
    return;
  }

  if (kind === 'session_created') {
    // pending -> 真实 session ID 转换
    appState.runningSessions.delete('pending');
    appState.runningSessions.add(sid);
    const pendingModel = appState.sessionProcessModels.get('pending');
    if (pendingModel !== undefined) {
      appState.sessionProcessModels.set(sid, pendingModel);
      appState.sessionProcessModels.delete('pending');
    }
    // 仅在尚未激活会话时设置 appState.activeConversationId，避免打断用户已切换的视图
    if (!appState.activeConversationId) {
      appState.activeConversationId = sid;
    }
    const now = Math.floor(Date.now() / 1000);
    const existing = appState.conversations.find((c) => c.id === sid);
    // 只有当 appState.pendingUserMessage 属于此会话时才使用（防止串会话）
    const pendingMatchesThisSession = appState.pendingUserMessage &&
      (!appState.pendingUserMessageConvId || appState.pendingUserMessageConvId === sid);
    updateOrAddConversation({
      id: sid,
      title: existing?.title || 'New Chat',
      messages: existing?.messages ?? (pendingMatchesThisSession
        ? [{ id: `user-${Date.now()}`, role: 'user', content: appState.pendingUserMessage!, timestamp: now }]
        : []),
      platform: 'claude',
      project_dir: content?.trim() || existing?.project_dir || null,
      source_path: existing?.source_path ?? null,
      created_at: existing?.created_at ?? now,
      updated_at: now,
    });
    // 此时尚无会话数据，保留 appState.pendingUserMessage 以确保用户消息可见
    updateSendButtonState();
    ensureChatViewVisible();
    updateConversationListSpinner();
    // ensureChatViewVisible 可能调用了 shellApi.render()，需要恢复按钮 loading 状态
    // 只有当 pending 消息属于此会话时才设置 loading（防止串会话）
    if (sid === appState.activeConversationId || (!appState.activeConversationId && appState.pendingUserMessage && !appState.pendingUserMessageConvId)) {
      setSendButtonLoading(true);
    }
    return;
  }

  // 所有会话都累积流式数据（包括后台运行的会话）
  const state = getStreamingState(sid);
  const isActive = sid === appState.activeConversationId || (!appState.activeConversationId && appState.pendingUserMessage && !appState.pendingUserMessageConvId);

  // 常驻会话追问：上一轮 turn-complete 后 CLI 可能立刻开始下一轮，需重新标记忙碌
  if (
    kind === 'thinking_start' ||
    kind === 'text_start' ||
    kind === 'thinking_delta' ||
    kind === 'text_delta'
  ) {
    if (!appState.runningSessions.has(sid) && !appState.abortingSessions.has(sid)) {
      appState.runningSessions.add(sid);
      updateConversationListSpinner();
      if (isActive) {
        setSendButtonLoading(true);
      }
    }
  }

  switch (kind) {
    case 'thinking_start':
      state.thinkingDone = false;
      // 创建新的 thinking 块
      state.blocks.push({ type: 'thinking', content: '' });
      state.currentBlockIdx = state.blocks.length - 1;
      if (isActive) refreshStreamingUI(sid);
      break;
    case 'thinking_delta':
      {
        const block = state.blocks[state.currentBlockIdx];
        if (block && block.type === 'thinking') {
          block.content += content;
        }
      }
      if (isActive) scheduleStreamingRefresh(sid);
      break;
    case 'thinking_end':
      state.thinkingDone = true;
      if (isActive) refreshStreamingUI(sid);
      break;
    case 'text_start':
      // 创建新的 text 块
      state.blocks.push({ type: 'text', content: '' });
      state.currentBlockIdx = state.blocks.length - 1;
      break;
    case 'text_delta':
      appState.pendingTextDelta.set(sid, (appState.pendingTextDelta.get(sid) || '') + content);
      if (isActive) scheduleStreamingRefresh(sid);
      break;
    case 'text_end':
    case 'stream_end':
      flushPendingTextDelta(sid);
      if (isActive) refreshStreamingUI(sid);
      break;
    case 'error':
      flushPendingTextDelta(sid);
      clearStreamingState(sid);
      break;
    case 'api_retry':
      if (isActive) {
        removePendingAssistantIndicator();
        updatePendingStatus(content);
      }
      break;
    case 'complete':
      flushPendingTextDelta(sid);
      if (isActive) {
        refreshStreamingUI(sid);
        // result 已到但 session-ended 稍晚：先去掉「正在输出」，避免误以为还在生成
        document.querySelectorAll('.message-streaming-indicator').forEach((el) => el.remove());
        document.querySelectorAll('.message.streaming').forEach((el) => {
          el.classList.remove('streaming');
        });
      }
      break;
    default:
      break;
  }
}

export function scheduleStreamingRefresh(sessionId: string) {
  if (appState.streamRefreshPending) return;
  appState.streamRefreshPending = true;

  const doRefresh = (timestamp: number) => {
    if (timestamp - appState.streamRefreshLastTime < 100) {
      // 距上次刷新不足 100ms，等待下一帧
      appState.streamRefreshRafId = requestAnimationFrame(doRefresh);
      return;
    }
    appState.streamRefreshLastTime = timestamp;
    appState.streamRefreshRafId = null;
    appState.streamRefreshPending = false;
    flushPendingTextDelta(sessionId);
    refreshStreamingUI(sessionId);
  };

  appState.streamRefreshRafId = requestAnimationFrame(doRefresh);
}

export function handleSessionError(payload: SessionErrorPayload) {
  const sid = payload.conversationId || appState.activeConversationId || null;
  const errorText = payload.error.trim();
  if (!errorText) return;

  clearPendingRequestState();
  clearStreamingState(sid || 'pending');
  hideSendingState();

  const errorMessage: Message = {
    id: `error-${Date.now()}`,
    role: 'error',
    content: errorText,
    timestamp: Math.floor(Date.now() / 1000),
  };

  if (sid) {
    appState.transientSessionError = null;
    let conversation = appState.conversations.find((c) => c.id === sid);
    if (!conversation) {
      conversation = {
        id: sid,
        title: 'New Chat',
        messages: [],
        platform: 'claude',
        project_dir: null,
        created_at: errorMessage.timestamp,
        updated_at: errorMessage.timestamp,
      };
      appState.conversations.unshift(conversation);
    }

    const hasSameError = conversation.messages.some(
      (message) => message.role === 'error' && message.content === errorText,
    );
    if (!hasSameError) {
      conversation.messages.push(errorMessage);
      conversation.updated_at = errorMessage.timestamp;
    }
    appState.activeConversationId = sid;
    appState.pendingUserMessage = null;
    appState.pendingUserMessageConvId = null;
  } else {
    appState.transientSessionError = errorText;
  }

  ensureChatViewVisible();
  shellApi.refreshChatContent();
}

export function ensureChatViewVisible() {
  // 全屏管理页占用主区域时，不因后台流式事件强制切回聊天视图
  if (appState.isApiConfigViewActive || appState.isSettingsViewActive || appState.isMcpViewActive || appState.isKiroViewActive) return;
  const mainContent = document.querySelector('.main-content');
  if (!mainContent) return;
  if (!document.querySelector('#message-list')) {
    shellApi.render();
    return;
  }
  shellApi.refreshChatContent();
}

export function removeStreamingElements() {
  document.querySelectorAll('[id^="streaming-"]').forEach((el) => el.remove());
}

export function refreshStreamingUI(sessionId: string) {
  // 只有当 sessionId 匹配当前会话时才更新
  if (sessionId !== appState.activeConversationId && !(appState.pendingUserMessage && !appState.activeConversationId && !appState.pendingUserMessageConvId)) return;

  const messageList = document.querySelector<HTMLDivElement>('#message-list');
  if (!messageList) return;

  removePendingAssistantIndicator();

  const state = getStreamingState(sessionId);

  // 先合并相邻的同类型块（thinking-thinking, text-text）
  const merged: StreamBlock[] = [];
  for (const block of state.blocks) {
    const last = merged[merged.length - 1];
    if (last && last.type === block.type && block.type === 'thinking') {
      last.content = last.content + '\n' + block.content;
    } else if (last && last.type === block.type && block.type === 'text') {
      last.content = last.content + '\n\n' + block.content;
    } else {
      merged.push({ type: block.type, content: block.content });
    }
  }

  // 收集现有流式块元素，按索引索引
  const existingEls = new Map<number, HTMLElement>();
  messageList.querySelectorAll<HTMLElement>('[id^="streaming-block-"]').forEach((el) => {
    const idx = parseInt(el.id.replace('streaming-block-', ''), 10);
    if (!isNaN(idx)) existingEls.set(idx, el);
  });
  const usedIndices = new Set<number>();

  // 按合并后的块序列更新（就地更新已存在的元素，创建新元素）
  merged.forEach((block, idx) => {
    usedIndices.add(idx);
    const blockId = `streaming-block-${idx}`;
    const existingEl = existingEls.get(idx);

    if (block.type === 'thinking') {
      const label = state.thinkingDone ? '思考过程' : '思考中...';
      const isStreaming = !state.thinkingDone;
      const expanded = isStreaming || appState.expandedThinkingBlocks.has(sessionId);

      if (existingEl && existingEl.classList.contains('thinking-msg')) {
        // 就地更新：只更新 <pre> 文本和 <summary> 标签
        const pre = existingEl.querySelector('.thinking-content pre');
        const summary = existingEl.querySelector('.thinking-summary .thinking-label-text');
        if (pre) pre.textContent = block.content;
        if (summary) summary.textContent = label;
        // 更新流式状态类
        if (isStreaming) {
          existingEl.querySelector('.thinking-block')?.classList.add('streaming-active');
        } else {
          existingEl.querySelector('.thinking-block')?.classList.remove('streaming-active');
        }
        // 思考内容独立滚动
        const scrollEl = existingEl.querySelector<HTMLElement>('.thinking-content-scroll');
        if (scrollEl) getThinkingScroller(scrollEl, blockId).onNewContent();
      } else {
        // 删除旧元素（类型不匹配或不存在）
        existingEl?.remove();
        const el = document.createElement('div');
        el.id = blockId;
        el.className = 'message assistant thinking-msg streaming';
        el.innerHTML = `<div class="message-content">${renderThinkingDetails(block.content, label, expanded, undefined, isStreaming)}</div>`;
        messageList.appendChild(el);
        const detailsEl = el.querySelector('.thinking-block');
        if (detailsEl) {
          detailsEl.addEventListener('toggle', () => {
            if ((detailsEl as HTMLDetailsElement).open) {
              appState.expandedThinkingBlocks.add(sessionId);
            } else {
              appState.expandedThinkingBlocks.delete(sessionId);
            }
          });
        }
        // 新创建的思考块：初始化独立 ScrollController
        const scrollEl = el.querySelector<HTMLElement>('.thinking-content-scroll');
        if (scrollEl) getThinkingScroller(scrollEl, blockId).scrollToBottom();
        existingEls.set(idx, el);
      }
    } else if (block.type === 'text') {
      if (existingEl && !existingEl.classList.contains('thinking-msg')) {
        // 就地更新：只更新 markdown-body 内容
        const mdBody = existingEl.querySelector('.markdown-body');
        if (mdBody) mdBody.innerHTML = renderMarkdown(block.content);
      } else {
        existingEl?.remove();
        const el = document.createElement('div');
        el.id = blockId;
        el.className = 'message assistant streaming';
        el.innerHTML = `<div class="message-content">
          <div class="markdown-body">${renderMarkdown(block.content)}</div>
          <div class="message-footer">
            <span class="message-streaming-indicator">正在输出...</span>
          </div>
        </div>`;
        messageList.appendChild(el);
        initCodeCopyButtons(el);
        existingEls.set(idx, el);
      }
    }
  });

  // 移除不再需要的旧流式元素（块数量减少时）
  existingEls.forEach((el, idx) => {
    if (!usedIndices.has(idx)) {
      // 清理对应的 thinking scroller
      const blockId = `streaming-block-${idx}`;
      appState.thinkingScrollers.get(blockId)?.destroy();
      appState.thinkingScrollers.delete(blockId);
      el.remove();
    }
  });

  // Answer 区域自动置底
  appState.answerScroller?.onNewContent();
}

/** 初始化 Answer 区域 ScrollController（#message-list） */
export function initAnswerScroller(): void {
  const messageList = document.querySelector<HTMLDivElement>('#message-list');
  if (!messageList) return;

  // 销毁旧实例
  appState.answerScroller?.destroy();
  appState.thinkingScrollers.forEach((sc) => sc.destroy());
  appState.thinkingScrollers.clear();

  appState.answerScroller = new ScrollController(messageList, {
    resumePx: 20,
    leavePx: 80,
    createButton: true,
  });
}

/** 捕获消息列表重建前的滚动状态，用于输出结束后恢复（不打断用户阅读上方消息） */
export function captureScrollState(): { autoScroll: boolean; scrollTop: number } | null {
  if (!appState.answerScroller) return null;
  return { autoScroll: appState.answerScroller.autoScroll, scrollTop: appState.answerScroller.el.scrollTop };
}

/** 重建后恢复滚动状态：用户此前在底部 → 置底；否则保持其阅读位置，不强制跳回 */
export function restoreScrollState(snap: { autoScroll: boolean; scrollTop: number } | null): void {
  if (!appState.answerScroller) return;
  if (!snap || snap.autoScroll) {
    appState.answerScroller.scrollToBottom();
  } else {
    appState.answerScroller.restorePosition(snap.scrollTop, false);
  }
}

