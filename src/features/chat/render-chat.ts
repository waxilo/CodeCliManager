import { appState, MAX_VISIBLE_MESSAGES } from '../../state';
import type { Message, Conversation } from '../../types';
import { escapeHtml } from '../../utils';
import * as api from '../../api';
import { renderMessageListHtml, TOOL_CONFIG_MAP, getDefaultToolConfig, extractToolUseId } from './render-messages';
import { getEffectiveProjectDir } from './session-context';
import { renderCopyIconHtml, renderInputComposerHtml } from './input-composer';
import { getActiveChatModelForRender } from './model-picker';
import { dedupeAdjacentDuplicateMessages, getActiveConversation, conversationInstanceKey } from '../conversations/normalize';
import { normalizeMessageForCompare } from '../files/index';

/** 单遍收集历史中已存在的 tool_use_id（替代对每个进行中工具重跑 processToolMessages 的 O(T·N)） */
function collectToolUseIds(messages: Message[]): Set<string> {
  const ids = new Set<string>();
  for (const msg of messages) {
    if (msg.role === 'tool_use' || msg.role === 'tool') {
      const id = msg.toolData?.toolUseId || extractToolUseId(msg.content);
      if (id) ids.add(id);
    }
  }
  return ids;
}

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
  const messages = [...(conversation?.messages ?? [])];
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

  // 进行中的 AskUserQuestion：可点选卡片（已选结果由会话历史展示）
  const askKey = appState.activeConversationId || 'pending';
  const pendingAsk =
    appState.pendingAskQuestions.get(askKey) ||
    (appState.activeConversationId ? appState.pendingAskQuestions.get('pending') : undefined);
  if (pendingAsk?.finish && !pendingAsk.answers) {
    const toolInput = {
      questions: pendingAsk.input.questions,
    };
    messages.push({
      id: `pending-ask-${pendingAsk.requestId}`,
      role: 'tool',
      content: JSON.stringify(toolInput),
      timestamp: Math.floor(Date.now() / 1000),
      toolData: {
        toolName: 'AskUserQuestion',
        toolInput,
        displayMode: 'collapsible',
        colorScheme: {
          border: '#58a6ff',
          icon: '#58a6ff',
          primary: '#58a6ff',
        },
      },
    });
  }

  // 进行中的 Task（Subagent）：历史尚未落盘时注入卡片（含刚完成、等历史合并）
  const toolsKey = appState.activeConversationId || 'pending';
  const activeTools =
    appState.activeToolsBySession.get(toolsKey) ||
    (appState.activeConversationId
      ? appState.activeToolsBySession.get('pending')
      : undefined);
  if (activeTools) {
    const existingToolUseIds = collectToolUseIds(messages);
    for (const [toolUseId, tool] of activeTools) {
      if (existingToolUseIds.has(toolUseId)) continue;
      const config = TOOL_CONFIG_MAP[tool.toolName] || getDefaultToolConfig();
      const isRunning = tool.status === 'running';
      messages.push({
        id: `pending-tool-${toolUseId}`,
        role: 'tool',
        content: JSON.stringify(tool.input || {}),
        timestamp: Math.floor(tool.startedAt / 1000) || Math.floor(Date.now() / 1000),
        toolData: {
          toolName: tool.toolName,
          toolInput: tool.input || {},
          toolUseId,
          toolResult: isRunning ? undefined : tool.toolResult ?? '',
          isError: tool.isError,
          displayMode: config.displayMode,
          colorScheme: {
            border: config.borderColor,
            icon: config.iconColor,
            primary: config.borderColor,
          },
        },
      });
    }
  }

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

export async function refreshModelInfo() {
  const container = document.querySelector('#empty-chat-model-info');
  if (!container) return;

  try {
    const state = await api.getApiProfilesState();
    const activeProfile = state.profiles.find((p) => p.id === state.activeProfileId);
    const profileName = activeProfile?.name || '';
    const baseUrl = activeProfile?.baseUrl || state.current?.baseUrl || '';
    // 当前模型直接读自配置文件
    // 'default' 表示订阅默认（非具体模型），按未指定处理，让卡片回到「官方默认」文案
    const rawModel = getActiveChatModelForRender();
    const currentModel =
      (rawModel && rawModel !== 'default' ? rawModel : '') ||
      activeProfile?.defaultModel ||
      state.current?.defaultModel ||
      '';

    const hasInfo = Boolean(currentModel || profileName || baseUrl);
    const body = hasInfo
      ? `
          <div class="model-info-row"><span class="model-info-key">当前模型</span><span class="model-info-value model-info-model">${escapeHtml(currentModel || '未配置模型')}</span></div>
          ${profileName ? `<div class="model-info-row"><span class="model-info-key">配置方案</span><span class="model-info-value">${escapeHtml(profileName)}</span></div>` : ''}
          ${baseUrl ? `<div class="model-info-row"><span class="model-info-key">API 地址</span><span class="model-info-value model-info-url">${escapeHtml(baseUrl)}</span></div>` : ''}
        `
      : `
          <div class="model-info-row"><span class="model-info-key">当前模型</span><span class="model-info-value model-info-model">官方默认（Claude 订阅）</span></div>
          <div class="model-info-empty-text">正在使用 Claude 官方登录 / 订阅。如需改用第三方 API，点击右上角「API 配置」进入配置页并「应用」。</div>
        `;

    container.innerHTML = `
      <div class="model-info-card">
        <div class="model-info-header">
          <svg class="model-info-icon" viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <path d="M12 2L2 7l10 5 10-5-10-5z"/>
            <path d="M2 17l10 5 10-5"/>
            <path d="M2 12l10 5 10-5"/>
          </svg>
          <span class="model-info-label">当前模型配置</span>
        </div>
        <div class="model-info-body">${body}</div>
      </div>
    `;
  } catch {
    // 静默处理错误，不阻塞页面渲染
  }
}

