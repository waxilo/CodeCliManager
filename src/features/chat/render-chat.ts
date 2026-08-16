import { appState, MAX_VISIBLE_MESSAGES } from '../../state';
import type { Message, Conversation } from '../../types';
import { escapeHtml } from '../../utils';
import { renderMessageListHtml, renderMessageHtmlChunks, type RenderedMessageChunk, extractToolName, extractToolUseId, extractToolResult } from './render-messages';
import { getEffectiveProjectDir } from './session-context';
import { renderCopyIconHtml, renderInputComposerHtml } from './input-composer';
import { dedupeAdjacentDuplicateMessages, getActiveConversation, conversationInstanceKey } from '../conversations/normalize';
import { normalizeMessageForCompare } from '../files/index';

/** tail-N 消息窗口：只保留尾部 windowSize 条；窗口起点是 tool_result 时回退纳入其 tool_use，避免结果无来源 */
export function splitMessageWindow(
  messages: Message[],
  windowSize: number,
): { visible: Message[]; totalHidden: number } {
  const size = Math.max(1, windowSize);
  if (messages.length <= size) {
    return { visible: messages, totalHidden: 0 };
  }
  let start = messages.length - size;
  while (start > 0 && messages[start].role === 'tool_result') {
    start -= 1;
  }
  return {
    visible: messages.slice(start),
    totalHidden: start,
  };
}

function renderLoadEarlierButtonHtml(hidden: number): string {
  return `
    <button type="button" class="load-earlier-btn" data-load-earlier title="加载更早的消息">
      <svg class="load-earlier-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="6 15 12 9 18 15"/></svg>
      <span class="load-earlier-label">加载更早的 ${hidden} 条消息</span>
    </button>
  `;
}

/** 当前会话的消息窗口大小（「加载更早」按会话独立累计，切换会话不丢失） */
export function getActiveMessageWindowSize(): number {
  const winKey = conversationInstanceKey(
    appState.activeConversationId || 'pending',
    appState.activeConversationSourcePath,
  );
  return appState.messageWindowSizeByConversation.get(winKey) ?? MAX_VISIBLE_MESSAGES;
}

/** 确保当前会话有窗口记录（幂等），返回其窗口大小 */
export function ensureMessageWindowForActiveConversation(): number {
  const winKey = conversationInstanceKey(
    appState.activeConversationId || 'pending',
    appState.activeConversationSourcePath,
  );
  const existing = appState.messageWindowSizeByConversation.get(winKey);
  if (existing) return existing;
  appState.messageWindowSizeByConversation.set(winKey, MAX_VISIBLE_MESSAGES);
  return MAX_VISIBLE_MESSAGES;
}

/** 点击「加载更早」：扩大当前会话的消息窗口并返回新值 */
export function incrementActiveMessageWindow(step: number): number {
  const winKey = conversationInstanceKey(
    appState.activeConversationId || 'pending',
    appState.activeConversationSourcePath,
  );
  const size = getActiveMessageWindowSize() + step;
  appState.messageWindowSizeByConversation.set(winKey, size);
  return size;
}
export function renderChatHeaderHtml(conversation: Conversation | undefined): string {
  const hasMessages = (conversation?.messages.length ?? 0) > 0;
  const title = hasMessages ? (conversation?.title || '新会话') : '新会话';
  const sessionId = conversation?.id || appState.activeConversationId || '—';
  const canCopySessionId = sessionId !== '—';
  const projectDir = getEffectiveProjectDir();
  const hasProjectDir = projectDir.length > 0;
  const sessionTitle = canCopySessionId
    ? (hasProjectDir
        ? `Session ID: ${sessionId}（点击在终端中 cd ${projectDir} && claude --resume）`
        : `Session ID: ${sessionId}（点击复制）`)
    : 'Session ID';

  // 终端图标（替代复制图标）
  const terminalIconSvg = canCopySessionId && hasProjectDir
    ? `<svg class="session-id-action-icon" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
        <polyline points="4 17 10 11 4 5"></polyline>
        <line x1="12" y1="19" x2="20" y2="19"></line>
      </svg>`
    : (canCopySessionId
        ? renderCopyIconHtml('session-id-copy-icon')
        : '');

  return `
    <div class="chat-header-left">
      <h2>${escapeHtml(title)}</h2>
    </div>
    <div class="chat-header-meta">
      ${
        canCopySessionId
          ? `
        <button
          type="button"
          class="session-id session-id-copy"
          id="session-id-copy"
          data-session-id="${escapeHtml(sessionId)}"
          title="${escapeHtml(sessionTitle)}"
          aria-label="${escapeHtml(sessionTitle)}"
        >
          <span class="session-id-text">${escapeHtml(sessionId)}</span>
          ${terminalIconSvg}
        </button>
      `
          : `<span class="session-id">${escapeHtml(sessionId)}</span>`
      }
    </div>
  `;
}

export function buildDisplayMessages(conversation: Conversation | undefined): Message[] {
  // 子代理（Task）不在主输出页面展示：主页面只显示用户/助手对话与普通工具卡，
  // 子代理执行态由侧边栏「子代理」标签页承载；已提交的 Task 卡同样过滤，
  // 避免历史里混排「子代理」卡片（会话数据完整保留，仅不渲染）。
  // 注意：历史 tool_use 是原始 role（tool_use/tool_result），要按 content 里的
  // tool_name 识别 Task，并连带其 tool_result 一起移除，否则孤立结果会错配到 Agent 卡。
  const taskToolUseIds = new Set<string>();
  const messages = [...(conversation?.messages ?? [])].filter((m) => {
    // 已配对的内嵌工具消息（pending-* 乐观态）
    if (m.role === 'tool' && m.toolData?.toolName === 'Task') return false;
    // 原始 tool_use：Task 记录其 id 供结果配对移除，Agent 保留（主视图展示子代理完成卡）
    if (m.role === 'tool_use') {
      if (extractToolName(m.content) === 'Task') {
        const id = extractToolUseId(m.content);
        if (id) taskToolUseIds.add(id);
        return false;
      }
      return true;
    }
    // 原始 tool_result：Task 的结果一并移除，避免无主结果污染配对
    if (m.role === 'tool_result') {
      const resultToolUseId = extractToolResult(m.content).toolUseId;
      return !(resultToolUseId && taskToolUseIds.has(resultToolUseId));
    }
    return true;
  });
  // 只有当 appState.pendingUserMessage 属于当前会话时才显示（防止串会话）
  const pendingBelongsToThisConv = appState.pendingUserMessage &&
    (appState.pendingUserMessageConvId === appState.activeConversationId || (!appState.pendingUserMessageConvId && !appState.activeConversationId));
  if (pendingBelongsToThisConv && appState.pendingUserMessage && !messages.some((m) => m.role === 'user' && normalizeMessageForCompare(m.content) === normalizeMessageForCompare(appState.pendingUserMessage))) {
    messages.push({
      id: `pending-user-${Date.now()}`,
      role: 'user',
      content: appState.pendingUserMessage,
      timestamp: Math.floor(Date.now() / 1000),
    });
  }
  if (appState.transientSessionError) {
    messages.push({
      id: `transient-error-${Date.now()}`,
      role: 'error',
      content: appState.transientSessionError,
      timestamp: Math.floor(Date.now() / 1000),
    });
  }

  // 进行中的 AskUserQuestion 不再注入消息流：可点选卡片由 syncPendingAskToInteractionHost
  // 钉到输入框上方（#interaction-host），避免长输出会话中「选择卡」与正文混排、滚动被顶走。
  // 已选结果由会话历史回写展示。

  // 进行中的 Task（Subagent）同样不注入消息流：运行中子代理由侧边栏「子代理」标签页
  // 承载，主输出页面只保留用户/助手正文。

  return dedupeAdjacentDuplicateMessages(messages);
}

export function renderConversationMessagesInnerHtml(messages: Message[]): string {
  // 确保当前会话有窗口记录（「加载更早」按会话独立累计）
  ensureMessageWindowForActiveConversation();

  // tail-N 窗口：只渲染尾部最多 MAX_VISIBLE_MESSAGES 条，顶部提供「加载更早」按钮
  const { visible, totalHidden } = splitMessageWindow(messages, getActiveMessageWindowSize());
  const loadEarlierHtml = totalHidden > 0 ? renderLoadEarlierButtonHtml(totalHidden) : '';
  const messageHtml = renderMessageListHtml(visible);
  if (loadEarlierHtml || messageHtml) return loadEarlierHtml + messageHtml;

  return `
    <div class="conversation-empty-state">
      <span class="conversation-empty-state-icon" aria-hidden="true">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">
          <path d="M21 15a2 2 0 0 1-2 2H8l-5 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>
        </svg>
      </span>
      <strong>会话内容已撤回</strong>
      <span>在下方输入消息，重新开始这段会话</span>
    </div>
  `;
}

/**
 * 同 renderConversationMessagesInnerHtml，但返回「消息级 HTML 块数组 + 头部块」，
 * 供 applyChatDom 键控 diff 挂载——复用未变消息节点，避免长会话一次性
 * innerHTML 写入阻塞 WebView2 主线程。语义与拼接版完全一致：
 * `loadEarlier + chunks.map(c => c.html).join('')` 即拼接版结果。
 */
export function renderConversationMessageChunks(messages: Message[]): {
  loadEarlier: string;
  chunks: RenderedMessageChunk[];
  empty: string | null;
} {
  ensureMessageWindowForActiveConversation();

  const { visible, totalHidden } = splitMessageWindow(messages, getActiveMessageWindowSize());
  const loadEarlier = totalHidden > 0 ? renderLoadEarlierButtonHtml(totalHidden) : '';
  const chunks = renderMessageHtmlChunks(visible);
  if (loadEarlier || chunks.length > 0) {
    return { loadEarlier, chunks, empty: null };
  }
  return {
    loadEarlier: '',
    chunks: [],
    empty: `
      <div class="conversation-empty-state">
        <span class="conversation-empty-state-icon" aria-hidden="true">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">
            <path d="M21 15a2 2 0 0 1-2 2H8l-5 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>
          </svg>
        </span>
        <strong>会话内容已撤回</strong>
        <span>在下方输入消息，重新开始这段会话</span>
      </div>
    `,
  };
}

export function renderChatContent(): string {
  const conversation = getActiveConversation();

  const messages = buildDisplayMessages(conversation);

  return `
    <div class="message-list" id="message-list">
      ${renderConversationMessagesInnerHtml(messages)}
    </div>
  `;
}

/**
 * 聊天主区的唯一结构来源。全量渲染（performRender）与增量挂载（ensureChatMessageShell）
 * 都从这里取结构，杜绝两个路径在 DOM 顺序 / 类名上漂移。
 *
 * shellOnly 时消息列表留空（内容由 refreshChatContent 填充），
 * 供空状态 → 会话的增量路径挂载；全量渲染则直接内嵌消息。
 */
export function renderChatAreaHtml(opts: { shellOnly?: boolean } = {}): string {
  const conversation = getActiveConversation();
  const hasActive = Boolean(appState.activeConversationId || appState.pendingUserMessage);
  const messagesHtml =
    hasActive && !opts.shellOnly
      ? renderConversationMessagesInnerHtml(buildDisplayMessages(conversation))
      : '';

  return `
    <div class="drop-zone-overlay" id="drop-zone-overlay">
      <div class="drop-zone-content">
        <div class="drop-zone-icon" aria-hidden="true">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
            <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/>
            <polyline points="17 8 12 3 7 8"/>
            <line x1="12" y1="3" x2="12" y2="15"/>
          </svg>
        </div>
        <p class="drop-zone-title">拖拽文件到此处引用</p>
        <p class="drop-zone-hint">支持项目内文件自动匹配，外部文件以绝对路径引用</p>
      </div>
    </div>
    ${hasActive ? `
    <div class="main-topbar">
      <div class="main-topbar-main">
        ${renderChatHeaderHtml(conversation)}
      </div>
    </div>
    ` : ''}
    ${hasActive
      ? `<div class="message-list" id="message-list">${messagesHtml}</div>`
      : renderEmptyState()}
    ${renderInputComposerHtml()}
  `;
}

export function renderEmptyState(): string {
  return `
    <div class="empty-chat">
      <div class="empty-icon">💬</div>
      <h2>开始新对话</h2>
      <p>从下拉选择 API 配置，开始与你的 AI CLI 对话</p>
      <div class="empty-chat-model-info" id="empty-chat-model-info"></div>
    </div>
  `;
}



