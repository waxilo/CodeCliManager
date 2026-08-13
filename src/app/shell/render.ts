import type { SettingsSection } from '../../types';
import { app, appState } from '../../state';
import { escapeHtml } from '../../utils';
import {
  getIsSidebarCollapsed,
  getSidebarToggleTitle,
  getSidebarToggleIcon,
  toggleSidebarCollapsed,
  syncSidebarCollapsedUI,
  syncSidebarResponsiveState,
  bindSidebarResizer,
  toggleTheme,
} from '../../ui';
import { shellApi } from './api';
import { patchTitlebarActions, renderTitlebarActions } from './titlebar';
import {
  renderConversationList,
  bindSidebarSearch,
  handleConversationListClick,
  handleConversationListKeydown,
  handleConversationListContextMenu,
  refreshConversationListDom,
} from '../../features/sidebar';
import { renderChatAreaHtml } from '../../features/chat/render-chat';
import { renderBalanceStatusBarHtml, bindSessionIdCopyEvents, bindQueuedPromptEvents } from '../../features/chat/input-composer';
import { setSendButtonLoading, isActiveConversationRunning, updateSendButtonState } from '../../features/chat/session-context';
import { refreshStreamingUI } from '../../features/chat/streaming';
import { renderSubagentProgressHtml, syncSubagentProgressUI } from '../../features/chat/subagent-progress';
import { remountActiveInteractionPanel } from '../../features/permissions';
import { bindPermissionModeBarEvents } from '../../features/settings/mount';
import {
  openApiConfigView,
  closeApiConfigView,
  mountApiConfigView,
  renderApiConfigViewHtml,
} from '../../features/api-config';
import { renderApiConfigSidebarHtml } from '../../features/settings/view';
import {
  openSettingsView,
  closeSettingsView,
  mountSettingsView,
  renderSettingsViewHtml,
  renderSettingsSidebarHtml,
} from '../../features/settings';
import { openMcpView, closeMcpView, mountMcpView, renderMcpViewHtml } from '../../features/mcp';
import { openKiroView, closeKiroView } from '../../features/kiro';
import { startMainBalanceBarAutoRefresh } from '../../features/status-bar';
import { loadData } from '../../features/conversations';
import { newChat } from '../../features/chat/send';
import { handleSendButtonClick } from '../../features/chat/retry';
import { handleKeydown, setupMessageListPostRender } from '../../features/chat/refresh';
import { bindChatModelPickerEvents } from '../../features/chat/model-picker';
import {
  handlePaste,
  handleFileSuggestionInput,
  handleFileSuggestionKeydown,
  hideFileSuggestions,
  bindDragDropFileRefs,
  showImportMenu,
  previewFileByPath,
} from '../../features/files';
import { handleEditKeydown } from '../../features/conversations/edit-export';
import { checkAppUpdate, bindAppUpdatePopoverEvents } from '../../features/updates/app-update';
import { bindClaudeUpdatePopoverEvents } from '../../features/updates/claude-update';

/** 合并连点/并发触发的全量重绘，避免 Win WebView2 上堆积卡死 */
let isShellRendering = false;
let hasPendingShellRender = false;

export function render() {
  if (isShellRendering) {
    hasPendingShellRender = true;
    return;
  }
  isShellRendering = true;
  try {
    do {
      hasPendingShellRender = false;
      performRender();
    } while (hasPendingShellRender);
  } finally {
    isShellRendering = false;
  }
}

function performRender() {
  app.innerHTML = `
    <div class="app-shell">
      <header class="app-titlebar">
        <div class="app-titlebar-leading">
          <button
            type="button"
            class="toolbar-icon-btn sidebar-toggle-btn"
            id="sidebar-toggle-btn"
            title="${escapeHtml(getSidebarToggleTitle())}"
            aria-label="${escapeHtml(getSidebarToggleTitle())}"
            aria-expanded="${!getIsSidebarCollapsed()}"
          >
            ${getSidebarToggleIcon()}
          </button>
        </div>
        <div class="app-titlebar-drag" data-tauri-drag-region></div>
        <h1 class="app-titlebar-title">AI CLI Manager</h1>
        <div class="app-titlebar-actions">
          ${renderTitlebarActions()}
        </div>
      </header>
      <div class="app-container${getIsSidebarCollapsed() ? ' is-sidebar-collapsed' : ''}${appState.isApiConfigViewActive || appState.isSettingsViewActive ? ' is-api-config' : appState.isMcpViewActive ? ' is-mcp' : ''}">
      <div class="sidebar${appState.isApiConfigViewActive || appState.isSettingsViewActive ? ' is-api-config' : ''}">
        ${appState.isApiConfigViewActive ? renderApiConfigSidebarHtml() : appState.isSettingsViewActive ? renderSettingsSidebarHtml() : appState.isMcpViewActive ? '' : `
        <div class="sidebar-header">
          <div class="sidebar-header-actions">
            <div class="new-chat-btn-wrapper">
              <button type="button" class="new-chat-btn" id="new-chat-btn" aria-haspopup="menu"><svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" aria-hidden="true"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>新建会话</button>
            </div>
          </div>
          <div class="sidebar-search-row">
            <div class="sidebar-search">
              <span class="sidebar-search-icon" aria-hidden="true">
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="7"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>
              </span>
              <input
                type="text"
                class="sidebar-search-input"
                id="sidebar-search-input"
                placeholder="搜索会话或项目…"
                autocomplete="off"
                spellcheck="false"
                aria-label="搜索会话或项目"
                value="${escapeHtml(appState.sidebarSearchQuery)}"
              />
              <button
                type="button"
                class="sidebar-search-clear"
                id="sidebar-search-clear"
                title="清空搜索"
                aria-label="清空搜索"
                ${appState.sidebarSearchQuery ? '' : 'hidden'}
              >
                <svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" aria-hidden="true"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
              </button>
            </div>
            <button type="button" class="refresh-btn" id="refresh-btn" title="扫描本地新会话" aria-label="刷新会话列表"><span class="refresh-icon">↻</span></button>
          </div>
        </div>
        <div class="conversation-list" id="conversation-list">
          ${renderConversationList()}
        </div>
        `}
      </div>
      <div
        class="sidebar-resizer"
        id="sidebar-resizer"
        role="separator"
        aria-orientation="vertical"
        aria-label="调整侧边栏宽度"
      ></div>
      <div class="main-content${appState.isApiConfigViewActive || appState.isSettingsViewActive ? ' is-api-config' : appState.isMcpViewActive ? ' is-mcp' : ''}">
        ${appState.isApiConfigViewActive ? renderApiConfigViewHtml() : appState.isSettingsViewActive ? renderSettingsViewHtml() : appState.isMcpViewActive ? renderMcpViewHtml() : renderChatAreaHtml()}
      </div>
      ${!appState.isApiConfigViewActive && !appState.isSettingsViewActive && !appState.isMcpViewActive ? renderSubagentProgressHtml() : ''}
      </div>
      ${!appState.isApiConfigViewActive && !appState.isSettingsViewActive && !appState.isMcpViewActive ? renderBalanceStatusBarHtml() : ''}
    </div>
  `;
  
  attachEventListeners();
  // render 重建了发送按钮 DOM，按 appState.runningSessions（与左侧同一逻辑）恢复 loading
  if (!appState.isApiConfigViewActive && !appState.isSettingsViewActive && !appState.isMcpViewActive) {
    setSendButtonLoading(isActiveConversationRunning());
    // 全量重绘不包含进行中的流式块（buildDisplayMessages 只取已提交消息）。
    // 从设置/API 配置等页面返回时，立即按 appState 恢复流式 DOM，
    // 避免模型在思考/子代理静默期聊天区看起来「空白卡死」。
    const sid = appState.activeConversationId;
    if (sid && appState.streamingBySession.has(sid)) {
      refreshStreamingUI(sid);
    }
    // 同步右侧子代理栏显隐与左侧会话栏收起状态（全量 HTML 已嵌入面板时也要补 class）
    syncSubagentProgressUI();
  }
  remountActiveInteractionPanel();
  if (appState.isKiroViewActive) {
    openKiroView();
  }
}

/** 轻量刷新标题栏（Kiro 绿点/入口显隐），不触发全页重绘 */
export function syncTitlebarActions(): void {
  if (!patchTitlebarActions()) return;
  bindTitlebarActionEvents();
}

function bindTitlebarActionEvents(): void {
  document.querySelector('#theme-toggle-btn')?.addEventListener('click', toggleTheme);
  document.querySelector('#api-config-btn')?.addEventListener('click', () => {
    if (appState.isApiConfigViewActive) {
      closeApiConfigView();
    } else {
      openApiConfigView();
    }
  });
  document.querySelector('#kiro-proxy-btn')?.addEventListener('click', () => {
    if (appState.isKiroViewActive) {
      closeKiroView();
    } else {
      openKiroView();
    }
  });
  document.querySelector('#settings-btn')?.addEventListener('click', () => {
    if (appState.isSettingsViewActive) {
      closeSettingsView();
    } else {
      openSettingsView();
    }
  });
  document.querySelector('#mcp-btn')?.addEventListener('click', () => {
    if (appState.isMcpViewActive) {
      closeMcpView();
    } else {
      openMcpView();
    }
  });
}

export function attachEventListeners() {
  document.querySelector('#new-chat-btn')?.addEventListener('click', newChat);

  document.querySelector('#refresh-btn')?.addEventListener('click', async () => {
    const btn = document.querySelector('#refresh-btn') as HTMLButtonElement | null;
    const sidebar = document.querySelector('.sidebar');
    if (btn) btn.disabled = true;
    btn?.classList.add('is-loading');

    let overlay: HTMLDivElement | null = null;
    if (sidebar && !sidebar.querySelector('.sidebar-loading-overlay')) {
      overlay = document.createElement('div');
      overlay.className = 'sidebar-loading-overlay';
      overlay.innerHTML = `
        <span class="list-loading-spinner" aria-hidden="true"></span>
        <span class="list-loading-text">正在扫描会话…</span>
      `;
      sidebar.appendChild(overlay);
    }

    try {
      // 加了缓存后刷新很快，给 loading 一个最小显示时长，避免一闪而过
      await Promise.all([
        loadData(),
        new Promise((resolve) => setTimeout(resolve, 500)),
      ]);
    } finally {
      refreshConversationListDom();
      overlay?.remove();
      if (btn) btn.disabled = false;
      btn?.classList.remove('is-loading');
    }
  });

  bindSidebarSearch();

  const listEl = document.querySelector('#conversation-list');
  if (listEl) {
    listEl.removeEventListener('click', handleConversationListClick);
    listEl.addEventListener('click', handleConversationListClick);
    listEl.removeEventListener('contextmenu', handleConversationListContextMenu);
    listEl.addEventListener('contextmenu', handleConversationListContextMenu);
    listEl.removeEventListener('keydown', handleConversationListKeydown);
    listEl.addEventListener('keydown', handleConversationListKeydown);
  }

  const textarea = document.querySelector('#message-input') as HTMLTextAreaElement;
  if (textarea) {
    textarea.addEventListener('keydown', handleKeydown);
    textarea.addEventListener('input', updateSendButtonState);
    textarea.addEventListener('input', handleFileSuggestionInput);
    textarea.addEventListener('keydown', handleFileSuggestionKeydown);
    textarea.addEventListener('paste', handlePaste);
    textarea.addEventListener('blur', () => {
      // 延迟关闭，让点击建议项有时间触发
      setTimeout(() => hideFileSuggestions(), 150);
    });
  }

  document.querySelector('#send-btn')?.addEventListener('click', handleSendButtonClick);

  bindChatModelPickerEvents();
  bindSessionIdCopyEvents();
  bindQueuedPromptEvents();
  bindSidebarResizer();
  document.querySelectorAll('.sidebar-toggle-btn').forEach((btn) => {
    btn.addEventListener('click', toggleSidebarCollapsed);
  });
  syncSidebarResponsiveState();
  syncSidebarCollapsedUI();
  document.querySelectorAll<HTMLButtonElement>('[data-settings-section]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const section = btn.dataset.settingsSection as SettingsSection | undefined;
      if (!section || section === appState.settingsSection) return;
      appState.settingsSection = section;
      shellApi.render();
      // 进入 CCM 更新页时，若 UI 显示有更新但句柄已丢，自动补一次检查
      if (
        section === 'app-update' &&
        appState.appUpdateInfo.updateAvailable &&
        !appState.appUpdate &&
        appState.appUpdateCheckStatus !== 'checking' &&
        appState.appUpdateCheckStatus !== 'downloading'
      ) {
        void checkAppUpdate(true);
      }
    });
  });
  bindTitlebarActionEvents();

  if (appState.isApiConfigViewActive) {
    void mountApiConfigView();
  }

  if (appState.isSettingsViewActive) {
    const updatePanel = document.querySelector('.settings-update-view');
    if (updatePanel && appState.settingsSection === 'app-update') {
      bindAppUpdatePopoverEvents(updatePanel);
      if (
        appState.appUpdateInfo.updateAvailable &&
        !appState.appUpdate &&
        appState.appUpdateCheckStatus !== 'checking' &&
        appState.appUpdateCheckStatus !== 'downloading'
      ) {
        void checkAppUpdate(true);
      }
    } else if (updatePanel && appState.settingsSection === 'claude-update') {
      bindClaudeUpdatePopoverEvents(updatePanel);
    }
    void mountSettingsView();
  }

  if (appState.isMcpViewActive) {
    void mountMcpView();
  }

  // 拖拽文件自动引用（全屏管理页无输入区，跳过）
  if (!appState.isApiConfigViewActive && !appState.isSettingsViewActive && !appState.isMcpViewActive) {
    bindDragDropFileRefs();
    bindPermissionModeBarEvents();
    startMainBalanceBarAutoRefresh();
  }

  // 导入外部文件/文件夹按钮（点击弹出选择菜单）
  document.querySelector('#btn-import')?.addEventListener('click', (e) => {
    const target = e.currentTarget as HTMLElement;
    showImportMenu(target);
  });

  // 文件引用芯片双击预览（事件委托，图片 / PDF / 文本通用）
  document.querySelector('#message-list')?.addEventListener('dblclick', (e) => {
    const chip = (e.target as HTMLElement).closest('.file-ref-chip') as HTMLElement | null;
    if (chip?.dataset.filePath) {
      void previewFileByPath(chip.dataset.filePath);
    }
  });

  if (appState.editingConversationId) {
    setTimeout(() => {
      const editInput = document.querySelector(`#edit-input-${appState.editingConversationId}`) as HTMLInputElement;
      if (editInput) {
        editInput.focus();
        editInput.select();
        editInput.addEventListener('keydown', (e) => {
          if (appState.editingConversationId) {
            handleEditKeydown(
              e,
              appState.editingConversationId,
              appState.editingConversationSourcePath,
            );
          }
        });
      }
    }, 50);
  }

  // 初始化代码复制按钮和消息复制控件
  const msgList = document.querySelector<HTMLDivElement>('#message-list');
  if (msgList) setupMessageListPostRender(msgList);
}

