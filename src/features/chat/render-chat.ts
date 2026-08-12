import { appState } from '../../state';
import type { Message, Conversation } from '../../types';
import { escapeHtml } from '../../utils';
import * as api from '../../api';
import { renderMessageListHtml } from './render-messages';
import { getEffectiveProjectDir } from './session-context';
import { renderCopyIconHtml } from './input-composer';
import { getActiveChatModelForRender } from './model-picker';
import { dedupeAdjacentDuplicateMessages } from '../conversations/normalize';
import { normalizeMessageForCompare } from '../files/index';
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

  return dedupeAdjacentDuplicateMessages(messages);
}

export function renderConversationMessagesInnerHtml(messages: Message[]): string {
  const messageHtml = renderMessageListHtml(messages);
  if (messageHtml) return messageHtml;

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
  const conversation = appState.activeConversationId
    ? appState.conversations.find((c) => c.id === appState.activeConversationId)
    : undefined;

  const messages = buildDisplayMessages(conversation);

  return `
    <div class="message-list" id="message-list">
      ${renderConversationMessagesInnerHtml(messages)}
    </div>
  `;
}

export function renderEmptyState(): string {
  return `
    <div class="empty-chat">
      <div class="empty-icon">💬</div>
      <h2>Start a New Conversation</h2>
      <p>Select a platform from the dropdown and start chatting with your AI CLI</p>
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

