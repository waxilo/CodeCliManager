import { appState, LOAD_EARLIER_STEP } from '../../state';
import type { Conversation } from '../../types';
import { initCodeCopyButtons, copyToClipboard } from '../../markdown';
import { bindInteractiveAskCards } from '../permissions';
import { renderConversationMessagesInnerHtml, buildDisplayMessages, ensureMessageWindowForActiveConversation, getActiveMessageWindowSize, incrementActiveMessageWindow } from './render-chat';
import { bindSessionIdCopyEvents } from './input-composer';
import { updateSendButtonState, isSendButtonLoading } from './session-context';
import { sendMessage } from './send';
import { handleRetryClick, handleUndoClick, removePendingAssistantIndicator, showPendingAssistantIndicator } from './retry';
import { initAnswerScroller, captureScrollState, restoreScrollState } from './streaming';
import { renderChatHeaderHtml } from './render-chat';
import { canSendMessage } from './session-context';
import { getActiveSuggestionIndex, getFileSuggestionsContainer } from '../files/index';
import { getActiveConversation, conversationInstanceKey } from '../conversations/normalize';
import { scheduleUiRefresh } from '../../ui';
export function setupMessageListPostRender(container: HTMLElement): void {
  // 对话流内 AskUserQuestion 可点选卡片
  bindInteractiveAskCards(container);

  // 初始化代码块复制按钮
  initCodeCopyButtons(container);

  // 绑定思考块折叠事件
  container.querySelectorAll('.thinking-block[data-thinking-id]').forEach((details) => {
    // 避免重复绑定
    if ((details as HTMLElement).dataset.thinkingBound === '1') return;
    (details as HTMLElement).dataset.thinkingBound = '1';
    details.addEventListener('toggle', () => {
      const id = (details as HTMLElement).dataset.thinkingId;
      if (!id) return;
      if ((details as HTMLDetailsElement).open) {
        appState.expandedThinkingBlocks.add(id);
      } else {
        appState.expandedThinkingBlocks.delete(id);
      }
    });
  });

  // 初始化 Answer 区域滚动控制器
  initAnswerScroller();

  // 「加载更早」按钮：扩大当前会话的消息窗口（按会话独立累计）
  container.querySelectorAll<HTMLElement>('.load-earlier-btn').forEach((btn) => {
    if (btn.dataset.bound === '1') return;
    btn.dataset.bound = '1';
    btn.addEventListener('click', () => {
      incrementActiveMessageWindow(LOAD_EARLIER_STEP);
      scheduleUiRefresh({ chat: true });
    });
  });

  // 初始化消息复制按钮
  container.querySelectorAll('.msg-copy-btn').forEach((btn) => {
    if ((btn as HTMLElement).dataset.bound === '1') return;
    (btn as HTMLElement).dataset.bound = '1';
    btn.addEventListener('click', async () => {
      const content = (btn as HTMLElement).dataset.copyContent || '';
      const copyAsMarkdown = (btn as HTMLElement).dataset.copyMarkdown === '1';
      let textToCopy = content;
      if (copyAsMarkdown) {
        // 复制为 Markdown：去掉 HTML 标签，将代码块转回 markdown 格式
        const tempDiv = document.createElement('div');
        tempDiv.innerHTML = content;
        tempDiv.querySelectorAll('.code-block-wrapper').forEach((wrapper) => {
          const code = (wrapper.querySelector('.code-copy-btn') as HTMLElement)?.dataset.code || '';
          const lang = wrapper.querySelector('.code-lang-badge')?.textContent || '';
          const fence = '```' + (lang && lang !== 'text' ? lang : '');
          wrapper.outerHTML = fence + '\n' + code + '\n```';
        });
        textToCopy = tempDiv.textContent || '';
      }
      const ok = await copyToClipboard(textToCopy);
      if (!ok) return;
      const icon = btn.querySelector('.msg-copy-icon-svg') as HTMLElement | null;
      if (icon) {
        icon.innerHTML = '<polyline points="20 6 9 17 4 12"></polyline>';
      }
      btn.classList.add('copied');
      setTimeout(() => {
        if (icon) {
          icon.innerHTML = '<rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path>';
        }
        btn.classList.remove('copied');
      }, 2000);
    });
  });

  // 初始化重试/撤回按钮事件委托（仅绑定一次）
  if (!(container as HTMLElement).dataset.retryBound) {
    (container as HTMLElement).dataset.retryBound = '1';
    container.addEventListener('click', (e) => {
      const btn = (e.target as HTMLElement).closest<HTMLButtonElement>('.msg-retry-btn');
      if (!btn) return;
      const action = btn.dataset.action;
      if (action === 'retry') {
        void handleRetryClick();
      } else if (action === 'undo') {
        void handleUndoClick();
      }
    });
  }
}

/** 最近一次聊天重建时的内容指纹；连点同一会话 / 重复事件时用于跳过昂贵的 innerHTML 重建 */
let lastChatRenderKey = '';

/**
 * 强制下次 refreshChatContent 重建聊天区（忽略指纹跳过）。
 * 管理页增量进出时主视图 DOM 被摘下保存，期间会话可能推进；
 * 挂回后必须重置指纹，避免「指纹未变」跳过导致展示 stash 时的旧内容。
 */
export function resetChatRenderKey(): void {
  lastChatRenderKey = '';
}

/** 进行中工具的可见态签名：状态 / 是否错误 / 结果长度变化时也必须重建（否则卡片停留旧状态）。
 * 与 buildDisplayMessages 一致：当前会话无工具时回退到 'pending' 槽（发送中尚未落盘的工具）。 */
function activeToolsSignature(sid: string): string {
  const tools =
    appState.activeToolsBySession.get(sid) ||
    (appState.activeConversationId
      ? appState.activeToolsBySession.get('pending')
      : undefined);
  if (!tools || tools.size === 0) return '';
  const parts: string[] = [];
  for (const [toolUseId, tool] of tools) {
    parts.push(
      `${toolUseId}:${tool.status}:${tool.isError ? 1 : 0}:${String(tool.toolResult ?? '').length}`,
    );
  }
  return parts.join(',');
}

/** 进行中 AskUserQuestion 的 requestId 签名（含 'pending' 槽回退，对齐 buildDisplayMessages） */
function pendingAskSignature(sid: string): string {
  const direct = appState.pendingAskQuestions.get(sid)?.requestId ?? '';
  if (direct) return direct;
  if (appState.activeConversationId) {
    return appState.pendingAskQuestions.get('pending')?.requestId ?? '';
  }
  return '';
}

function chatRenderKey(conversation: Conversation | undefined): string {
  const msgs = conversation?.messages ?? [];
  const last = msgs[msgs.length - 1];
  const sid = appState.activeConversationId || 'pending';
  return [
    appState.activeConversationId || '',
    appState.activeConversationSourcePath || '',
    conversation?.updated_at ?? '',
    msgs.length,
    last?.id ?? '',
    last?.timestamp ?? '',
    getActiveMessageWindowSize(),
    appState.runningSessions.has(appState.activeConversationId) ? 'r' : '',
    appState.pendingUserMessage ? 'p' : '',
    appState.transientSessionError ? 'e' : '',
    pendingAskSignature(sid),
    activeToolsSignature(sid),
  ].join('|');
}

interface RenderedConversationEntry {
  renderKey: string;
  topbarHtml: string;
  chatHtml: string;
}

/**
 * 按会话实例的渲染结果缓存：连点 A→B→A 时，回切 A 直接复用上次渲染的 HTML 字符串，
 * 跳过整条渲染管线（工具配对 / markdown 缓存查找 / 逐消息拼接 / 事件重绑）。
 * 键包含 expandedThinkingBlocks 签名——展开/折叠思考块后切走再切回不会退回旧态。
 */
const renderCache = new Map<string, RenderedConversationEntry>();
const RENDER_CACHE_MAX = 6;

export function renderCacheKey(conversation: Conversation | undefined): string {
  const thinkingSignature = [...appState.expandedThinkingBlocks].sort().join(',');
  return `${chatRenderKey(conversation)}|t:${thinkingSignature}`;
}

/** 当前会话是否仍在流式/运行中：此时每帧 key 都在变，缓存命中率低且写入大字符串徒增 GC 压力 */
function isActiveConversationBusy(): boolean {
  const sid = appState.activeConversationId;
  if (!sid) return false;
  return appState.runningSessions.has(sid) || appState.streamingBySession.has(sid);
}

/** 把已生成的 topbar / 消息列表 HTML 写入 DOM，并重绑事件、恢复滚动状态 */
function applyChatDom(topbarHtml: string, chatHtml: string): void {
  const messageList = document.querySelector<HTMLDivElement>('#message-list');
  const topbarMain = document.querySelector<HTMLDivElement>('.main-topbar-main');

  if (topbarMain) {
    topbarMain.innerHTML = topbarHtml;
    bindSessionIdCopyEvents();
  }

  updateSendButtonState();
  if (messageList) {
    // 重建前记录滚动状态：输出结束时若用户在阅读上方消息，重建后不应强制跳回底部
    const scrollSnap = captureScrollState();
    messageList.innerHTML = chatHtml;
    // 后处理：代码复制按钮、思考块折叠事件、消息复制控件
    setupMessageListPostRender(messageList);
    if (isSendButtonLoading()) {
      showPendingAssistantIndicator();
    } else {
      removePendingAssistantIndicator();
    }
    // 恢复滚动状态（最后执行，覆盖 showPendingAssistantIndicator 的置底）
    restoreScrollState(scrollSnap);
  }
}

/**
 * 重建聊天区内容。返回是否真正重建了 DOM（false = 指纹未变被跳过），
 * 供调度器执行器决定是否需要重跑流式块恢复。
 */
export function refreshChatContent(): boolean {
  if (!appState.activeConversationId && !appState.pendingUserMessage && !appState.transientSessionError) return false;

  const conversation = getActiveConversation();

  // 切会话后先重置消息窗口，再算指纹，避免「上一会话的扩展窗口」导致多一次冗余重建
  ensureMessageWindowForActiveConversation();

  // 内容指纹未变（连点同一会话 / 重复消息事件）：跳过昂贵的内联 HTML 重建，
  // 流式块也得以保留；只轻量同步发送按钮状态。
  const key = chatRenderKey(conversation);
  if (key === lastChatRenderKey && document.querySelector('#message-list')) {
    updateSendButtonState();
    return false;
  }
  lastChatRenderKey = key;

  // 按会话渲染缓存命中：回切 A 时直接复用上次渲染的 HTML 字符串，跳过整条渲染管线
  const cacheKey = conversationInstanceKey(
    appState.activeConversationId || 'pending',
    appState.activeConversationSourcePath,
  );
  const renderKey = renderCacheKey(conversation);
  const cached = renderCache.get(cacheKey);
  if (cached && cached.renderKey === renderKey) {
    renderCache.delete(cacheKey);
    renderCache.set(cacheKey, cached);
    applyChatDom(cached.topbarHtml, cached.chatHtml);
    return true;
  }

  // 完整渲染
  const topbarHtml = renderChatHeaderHtml(conversation);
  const messages = buildDisplayMessages(conversation);
  const chatHtml = renderConversationMessagesInnerHtml(messages);
  applyChatDom(topbarHtml, chatHtml);

  // 仅缓存静止会话（流式/运行中 key 每帧变化，缓存命中率低且写入大字符串徒增 GC 压力）
  if (!isActiveConversationBusy()) {
    renderCache.set(cacheKey, { renderKey, topbarHtml, chatHtml });
    if (renderCache.size > RENDER_CACHE_MAX) {
      const oldest = renderCache.keys().next().value;
      if (oldest !== undefined) renderCache.delete(oldest);
    }
  }
  return true;
}

export function handleKeydown(e: KeyboardEvent) {
  // IME 组字中（如 macOS 拼音未选字）：Enter 用于上屏，不发送
  // keyCode 229 是部分浏览器/输入法在组字期间的兼容标识
  if (e.isComposing || e.keyCode === 229) {
    return;
  }
  // 文件建议列表可见且有待选项时，Enter 交给文件建议键盘处理逻辑（选择当前高亮项）
  const suggestionContainer = getFileSuggestionsContainer();
  if (suggestionContainer && suggestionContainer.style.display !== 'none' && e.key === 'Enter' && !e.shiftKey) {
    const activeIdx = getActiveSuggestionIndex();
    if (activeIdx >= 0) {
      // handleFileSuggestionKeydown 已注册在同一个 textarea 上，会处理选择逻辑
      return;
    }
  }
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    // 互动问答进行中：Enter 提交选项/「其他」自定义回答，不发成普通追问
    if (appState.activeQuestionEnterHandler) {
      if (appState.activeQuestionEnterHandler()) return;
      return;
    }
    // 运行中也允许 Enter：有内容则追问，无内容不触发停止
    if (isSendButtonLoading() && !canSendMessage()) {
      return;
    }
    void sendMessage();
  }
}
