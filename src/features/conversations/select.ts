import { appState } from '../../state';
import { shellApi } from '../../app/shell/api';
import { invalidateFileCache } from '../files';
import { isActiveConversationRunning, setSendButtonLoading } from '../chat/session-context';
import { showPendingAssistantIndicator } from '../chat/retry';
import { dismissApiConfigViewState } from '../api-config/view-lifecycle';
import { refreshStreamingUI } from '../chat/streaming';
import { refreshConversationFromBackend } from './load';
import { dismissMcpViewState } from '../mcp/mount';
import { dismissSettingsViewState } from '../settings/mount';
import { dismissKiroViewState } from '../kiro/mount';
import { updateConversationListSpinner } from '../sidebar/render-list';
import { renderChatHeaderHtml } from '../chat/render-chat';
import { clearInteractionHostUi, remountActiveInteractionPanel } from '../permissions/interaction-panel';
import { startMainBalanceBarAutoRefresh } from '../status-bar';

let selectGeneration = 0;
const conversationRequests = new Map<string, Promise<void>>();

function isManagementDomVisible(): boolean {
  return Boolean(
    document.querySelector('#api-config-view, #settings-view, #mcp-view, #kiro-view'),
  );
}

/** 仅切换侧栏高亮，避免整表 innerHTML 重建 */
function syncConversationActiveHighlight(id: string): void {
  document.querySelectorAll('.conversation-item.active').forEach((el) => {
    el.classList.remove('active');
  });
  document.querySelectorAll('.workspace-card.has-active').forEach((el) => {
    el.classList.remove('has-active');
  });
  const escapedId =
    typeof CSS !== 'undefined' && typeof CSS.escape === 'function' ? CSS.escape(id) : id.replace(/"/g, '\\"');
  const item = document.querySelector(`.conversation-item[data-id="${escapedId}"]`);
  if (!item) return;
  item.classList.add('active');
  item.closest('.workspace-card')?.classList.add('has-active');
}

/**
 * 空状态 → 会话：只补齐主区 topbar + message-list 壳，内容由 refreshChatContent 填充。
 * @returns 是否已具备可刷新的消息列表壳
 */
function ensureChatMessageShell(): boolean {
  if (document.querySelector('#message-list')) return true;
  const main = document.querySelector('.main-content');
  if (!main || main.classList.contains('is-api-config') || main.classList.contains('is-mcp')) {
    return false;
  }

  const conversation = appState.activeConversationId
    ? appState.conversations.find((c) => c.id === appState.activeConversationId)
    : undefined;
  const composer = main.querySelector('.input-area');
  const empty = main.querySelector('.empty-chat');

  if (!main.querySelector('.main-topbar')) {
    const topbar = document.createElement('div');
    topbar.className = 'main-topbar';
    topbar.innerHTML = `<div class="main-topbar-main">${renderChatHeaderHtml(conversation)}</div>`;
    if (composer) main.insertBefore(topbar, composer);
    else main.appendChild(topbar);
  }

  const list = document.createElement('div');
  list.className = 'message-list';
  list.id = 'message-list';
  if (empty) empty.replaceWith(list);
  else if (composer) main.insertBefore(list, composer);
  else main.appendChild(list);
  return true;
}

function syncInteractionPanelForConversation(id: string): void {
  const panel = appState.activeInteractionPanel;
  if (!panel) {
    clearInteractionHostUi();
    return;
  }
  if (panel.conversationId === id) {
    remountActiveInteractionPanel();
  } else {
    // 隐藏其他会话的权限/问答面板，保留状态以便切回
    clearInteractionHostUi();
  }
}

function finishSelectUi(id: string): void {
  const thisSessionRunning = isActiveConversationRunning();
  setSendButtonLoading(thisSessionRunning);
  updateConversationListSpinner();
  syncInteractionPanelForConversation(id);

  window.setTimeout(() => {
    if (appState.activeConversationId !== id) return;
    appState.answerScroller?.scrollToBottom();
    if (thisSessionRunning && appState.streamingBySession.has(id)) {
      showPendingAssistantIndicator();
      refreshStreamingUI(id);
    }
  }, 0);
}

/** 用当前缓存立刻画出选中会话（Win 上避免整页 render） */
function paintSelectedConversation(id: string, wasManagement: boolean): void {
  if (wasManagement || isManagementDomVisible() || !document.querySelector('#conversation-list')) {
    shellApi.render();
    // 管理页切回聊天时不立即触发额度网络请求，避免与页面切换/会话读取争抢资源。
    finishSelectUi(id);
    return;
  }

  if (!document.querySelector('#message-list')) {
    if (!ensureChatMessageShell()) {
      shellApi.render();
      startMainBalanceBarAutoRefresh();
      finishSelectUi(id);
      return;
    }
  }

  syncConversationActiveHighlight(id);
  shellApi.refreshChatContent();
  finishSelectUi(id);
}

function refreshConversationOnce(id: string): Promise<void> {
  const existing = conversationRequests.get(id);
  if (existing) return existing;

  const request = refreshConversationFromBackend(id).finally(() => {
    if (conversationRequests.get(id) === request) {
      conversationRequests.delete(id);
    }
  });
  conversationRequests.set(id, request);
  return request;
}

export function selectConversation(id: string) {
  const wasManagement =
    appState.isApiConfigViewActive ||
    appState.isSettingsViewActive ||
    appState.isMcpViewActive ||
    appState.isKiroViewActive;

  dismissApiConfigViewState();
  dismissSettingsViewState();
  dismissMcpViewState();
  dismissKiroViewState();

  const generation = ++selectGeneration;
  const alreadyActive = appState.activeConversationId === id && !wasManagement;

  appState.activeConversationId = id;
  invalidateFileCache();

  // 先本地切换（缓存消息），不再等后端后整页重绘
  if (!alreadyActive) {
    paintSelectedConversation(id, wasManagement);
  }

  void refreshConversationOnce(id).then(() => {
    if (generation !== selectGeneration || appState.activeConversationId !== id) return;

    if (document.querySelector('#message-list')) {
      shellApi.refreshChatContent();
      finishSelectUi(id);
    } else {
      paintSelectedConversation(id, false);
    }
  });
}
