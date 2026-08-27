import { appState } from '../../state';
import { shellApi } from '../../app/shell/api';
import { invalidateFileCache, restoreComposerDraft, stashComposerDraft } from '../files';
import { isActiveConversationRunning, setSendButtonLoading } from '../chat/session-context';
import { dismissApiConfigViewState } from '../api-config/view-lifecycle';
import { refreshConversationFromBackend } from './load';
import { scheduleUiRefresh } from '../../ui';
import { conversationInstanceKey } from './normalize';
import { dismissMcpViewState } from '../mcp/mount';
import { dismissSettingsViewState } from '../settings/mount';
import { dismissKiroViewState } from '../kiro/mount';
import { renderChatAreaHtml, renderMessageListShellHtml } from '../chat/render-chat';
import { syncQueuedPromptsUI } from '../chat/input-composer';
import { clearInteractionHostUi, remountActiveInteractionPanel } from '../permissions/interaction-panel';
import { startMainBalanceBarAutoRefresh } from '../status-bar';

let selectGeneration = 0;
const conversationRequests = new Map<string, Promise<void>>();

function isManagementDomVisible(): boolean {
  return Boolean(document.querySelector('#api-config-view, #settings-view, #mcp-view'));
}

/** 仅切换侧栏高亮，避免整表 innerHTML 重建 */
function syncConversationActiveHighlight(id: string, sourcePath: string | null): void {
  document.querySelectorAll('.conversation-item.active').forEach((el) => {
    el.classList.remove('active');
  });
  document.querySelectorAll('.workspace-card.has-active').forEach((el) => {
    el.classList.remove('has-active');
  });
  const item = [...document.querySelectorAll<HTMLElement>('.conversation-item')].find(
    (candidate) =>
      candidate.dataset.id === id &&
      (candidate.dataset.sourcePath || null) === sourcePath,
  );
  if (!item) return;
  item.classList.add('active');
  item.closest('.workspace-card')?.classList.add('has-active');
}

/**
 * 空状态 → 会话：只补齐主区 topbar + message-list-shell 壳，内容由 refreshChatContent 填充。
 * @returns 是否已具备可刷新的消息列表壳
 */
export function ensureChatMessageShell(): boolean {
  const existingList = document.querySelector<HTMLElement>('#message-list');
  if (
    existingList?.matches('.message-list-shell > #message-list') &&
    existingList.querySelector(':scope > [data-chat-content] > [data-chat-bottom]') &&
    existingList.parentElement?.querySelector(':scope > .scroll-to-bottom-btn')
  ) {
    return true;
  }
  const main = document.querySelector('.main-content');
  if (!main || main.classList.contains('is-api-config') || main.classList.contains('is-mcp')) {
    return false;
  }
  if (existingList) {
    let listShell = existingList.closest<HTMLElement>('.message-list-shell');
    if (!listShell) {
      listShell = document.createElement('div');
      listShell.className = 'message-list-shell';
      existingList.replaceWith(listShell);
      listShell.appendChild(existingList);
    }

    const legacyButton = existingList.querySelector<HTMLElement>(':scope > .scroll-to-bottom-btn');
    legacyButton?.remove();
    let content = existingList.querySelector<HTMLElement>(':scope > [data-chat-content]');
    if (!content) {
      content = document.createElement('div');
      content.className = 'message-content-layer';
      content.dataset.chatContent = '';
      const children = [...existingList.children];
      for (const child of children) content.appendChild(child);
      existingList.appendChild(content);
    }
    if (!content.querySelector(':scope > [data-chat-bottom]')) {
      const sentinel = document.createElement('div');
      sentinel.className = 'chat-bottom-sentinel';
      sentinel.dataset.chatBottom = '';
      sentinel.setAttribute('aria-hidden', 'true');
      content.appendChild(sentinel);
    }
    existingList.tabIndex = 0;
    if (!listShell.querySelector(':scope > .scroll-to-bottom-btn')) {
      const template = document.createElement('template');
      template.innerHTML = renderMessageListShellHtml();
      const button = template.content.querySelector<HTMLElement>('.scroll-to-bottom-btn');
      if (button) listShell.appendChild(button);
    }
    return true;
  }

  // 复用全量渲染的聊天区结构（shellOnly 只取壳，消息内容由 refreshChatContent 填充）。
  // 顺序恒为 drop-zone-overlay → main-topbar → message-list-shell → input-area，
  // 增量路径与全量渲染共用同一份结构定义，杜绝漂移。
  const shell = document.createElement('div');
  shell.innerHTML = renderChatAreaHtml({ shellOnly: true });
  const topbar = shell.querySelector<HTMLElement>('.main-topbar');
  const listShell = shell.querySelector<HTMLElement>('.message-list-shell');
  if (!topbar || !listShell?.querySelector('#message-list')) return false;

  const composer = main.querySelector('.input-area');
  const empty = main.querySelector('.empty-chat');
  // 防御：清掉异常中间态可能遗留的重复 topbar
  main.querySelector('.main-topbar')?.remove();

  if (empty) {
    empty.replaceWith(topbar, listShell);
  } else if (composer) {
    main.insertBefore(topbar, composer);
    main.insertBefore(listShell, composer);
  } else {
    main.appendChild(topbar);
    main.appendChild(listShell);
  }
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
  syncQueuedPromptsUI();
  // 注意：不在这里调 updateConversationListSpinner——纯点击不改变运行态，
  // active 高亮已由 syncConversationActiveHighlight 单独处理；运行态同步由 session-events 驱动。
  syncInteractionPanelForConversation(id);

  // 会话滚动状态由 ChatScrollCoordinator 按 conversation instance 独立恢复；
  // 切换会话不再无条件置底覆盖用户的阅读位置。
}

/** 用当前缓存立刻画出选中会话（Win 上避免整页 render） */
function paintSelectedConversation(id: string, sourcePath: string | null, wasManagement: boolean): void {
  if (wasManagement || isManagementDomVisible() || !document.querySelector('#conversation-list')) {
    // 管理页增量退出成功：主视图 DOM 原样挂回，再按新会话走增量路径
    if (wasManagement && shellApi.exitManagementView()) {
      if (!document.querySelector('#message-list')) {
        if (!ensureChatMessageShell()) {
          shellApi.render();
          startMainBalanceBarAutoRefresh();
          finishSelectUi(id);
          return;
        }
      }
      syncConversationActiveHighlight(id, sourcePath);
      scheduleUiRefresh({ chat: true });
      finishSelectUi(id);
      return;
    }
    shellApi.render();
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

  syncConversationActiveHighlight(id, sourcePath);
  // 增量路径：聊天区重建走调度器合并（连点同一会话时指纹未变会自动跳过）
  scheduleUiRefresh({ chat: true });
  finishSelectUi(id);
}

function refreshConversationOnce(id: string, sourcePath: string | null): Promise<void> {
  const key = conversationInstanceKey(id, sourcePath);
  const existing = conversationRequests.get(key);
  if (existing) return existing;

  const request = refreshConversationFromBackend(id, sourcePath).finally(() => {
    if (conversationRequests.get(key) === request) {
      conversationRequests.delete(key);
    }
  });
  conversationRequests.set(key, request);
  return request;
}

export function selectConversation(id: string, sourcePath: string | null = null) {
  const wasFullPageManagement =
    appState.isApiConfigViewActive || appState.isSettingsViewActive || appState.isMcpViewActive;

  dismissApiConfigViewState();
  dismissSettingsViewState();
  dismissMcpViewState();
  dismissKiroViewState();

  const generation = ++selectGeneration;
  const alreadyActive =
    appState.activeConversationId === id &&
    appState.activeConversationSourcePath === sourcePath &&
    !wasFullPageManagement;

  if (!alreadyActive) {
    stashComposerDraft();
  }
  appState.activeConversationId = id;
  appState.activeConversationSourcePath = sourcePath;
  invalidateFileCache();

  if (!alreadyActive) {
    paintSelectedConversation(id, sourcePath, wasFullPageManagement);
    restoreComposerDraft();
  }

  void refreshConversationOnce(id, sourcePath).then(() => {
    if (
      generation !== selectGeneration ||
      appState.activeConversationId !== id ||
      appState.activeConversationSourcePath !== sourcePath
    ) return;

    if (document.querySelector('#message-list')) {
      scheduleUiRefresh({ chat: true });
      finishSelectUi(id);
    } else {
      paintSelectedConversation(id, sourcePath, false);
    }
  });
}
