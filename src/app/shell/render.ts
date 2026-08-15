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
import { patchTitlebarActions, renderTitlebarActions } from './titlebar';
import {
  clearStashedMainDom,
  bindSettingsSectionNav,
  mountActiveManagementView,
} from './management-view';
import {
  handleConversationListClick,
  handleConversationListKeydown,
  handleConversationListContextMenu,
  refreshConversationListDom,
  renderSidebarTabsHtml,
  renderActiveTabContent,
  bindSidebarTabs,
  getActiveSidebarTab,
} from '../../features/sidebar';
import { renderChatAreaHtml } from '../../features/chat/render-chat';
import { renderBalanceStatusBarHtml, bindSessionIdCopyEvents, bindQueuedPromptEvents } from '../../features/chat/input-composer';
import { setSendButtonLoading, isActiveConversationRunning, updateSendButtonState } from '../../features/chat/session-context';
import { refreshStreamingUI } from '../../features/chat/streaming';
import { syncSubagentProgressUI } from '../../features/chat/subagent-progress';
import { remountActiveInteractionPanel } from '../../features/permissions';
import { bindPermissionModeBarEvents } from '../../features/settings/mount';
import {
  openApiConfigView,
  closeApiConfigView,
  renderApiConfigViewHtml,
} from '../../features/api-config';
import { renderApiConfigSidebarHtml } from '../../features/settings/view';
import {
  openSettingsView,
  closeSettingsView,
  renderSettingsViewHtml,
  renderSettingsSidebarHtml,
} from '../../features/settings';
import { openMcpView, closeMcpView, renderMcpViewHtml } from '../../features/mcp';
import { openKiroView, closeKiroView } from '../../features/kiro';
import { startMainBalanceBarAutoRefresh } from '../../features/status-bar';
import { loadData } from '../../features/conversations';
import { newChat } from '../../features/chat/send';
import { handleSendButtonClick } from '../../features/chat/retry';
import { handleKeydown, refreshChatContent, resetChatRenderKey, afterChatMounted } from '../../features/chat/refresh';
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
  // 全量重绘重建整个 #app，任何被摘下保存的主视图引用都失效
  clearStashedMainDom();
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
      <div class="sidebar${appState.isApiConfigViewActive || appState.isSettingsViewActive ? ' is-api-config' : ''}${!appState.isApiConfigViewActive && !appState.isSettingsViewActive && !appState.isMcpViewActive ? ` is-${getActiveSidebarTab()}` : ''}">
        ${appState.isApiConfigViewActive ? renderApiConfigSidebarHtml() : appState.isSettingsViewActive ? renderSettingsSidebarHtml() : appState.isMcpViewActive ? '' : `
        <div class="sidebar-header">
          <div class="sidebar-header-actions">
            <div class="new-chat-btn-wrapper">
              <button type="button" class="new-chat-btn" id="new-chat-btn" aria-haspopup="menu"><svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" aria-hidden="true"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>新建会话</button>
            </div>
            <button type="button" class="refresh-btn" id="refresh-btn" title="扫描本地新会话" aria-label="刷新会话列表"><span class="refresh-icon">↻</span></button>
          </div>
        </div>
        ${renderSidebarTabsHtml()}
        <div class="conversation-list" id="conversation-list">
          ${renderActiveTabContent()}
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
        ${appState.isApiConfigViewActive ? renderApiConfigViewHtml() : appState.isSettingsViewActive ? renderSettingsViewHtml() : appState.isMcpViewActive ? renderMcpViewHtml() : renderChatAreaHtml({ shellOnly: true })}
      </div>
      </div>
      ${!appState.isApiConfigViewActive && !appState.isSettingsViewActive && !appState.isMcpViewActive ? renderBalanceStatusBarHtml() : ''}
    </div>
  `;
  
  attachEventListeners();
  // render 重建了发送按钮 DOM，按 appState.runningSessions（与左侧同一逻辑）恢复 loading
  if (!appState.isApiConfigViewActive && !appState.isSettingsViewActive && !appState.isMcpViewActive) {
    // 聊天区只渲染了壳：重置指纹后从渲染缓存 / 内容指纹填充，
    // 避免全量重建时把当前会话全部消息再序列化一遍（连点回切/删除后渲染命中缓存）。
    resetChatRenderKey();
    refreshChatContent();
    setSendButtonLoading(isActiveConversationRunning());
    // 全量重绘不包含进行中的流式块（buildDisplayMessages 只取已提交消息）。
    // 从设置/API 配置等页面返回时，立即按 appState 恢复流式 DOM，
    // 避免模型在思考/子代理静默期聊天区看起来「空白卡死」。
    // 长列表分块挂载期间 DOM 未就绪：流式块恢复挂到 afterChatMounted。
    const sid = appState.activeConversationId;
    if (sid && appState.streamingBySession.has(sid)) {
      afterChatMounted(() => refreshStreamingUI(sid));
    }
    // 同步左侧「子代理」tab 内容 / 角标 / 自动切换（全量 HTML 已嵌入时也要补）
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

  bindSidebarTabs();

  const listEl = document.querySelector('#conversation-list');
  if (listEl) {
    // dataset.bound 守卫：全量 render 每次重建节点，只需绑一次；
    // 若未来改为复用节点，也能避免同一节点监听叠加（removeEventListener 前置在新建节点上是无效操作）。
    const listElBound = listEl as HTMLElement & { dataset: DOMStringMap };
    if (listElBound.dataset.bound !== '1') {
      listElBound.dataset.bound = '1';
      listEl.addEventListener('click', handleConversationListClick);
      listEl.addEventListener('contextmenu', handleConversationListContextMenu);
      listEl.addEventListener('keydown', handleConversationListKeydown);
    }
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
  bindSettingsSectionNav();
  bindTitlebarActionEvents();
  mountActiveManagementView();

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

  // 消息列表的后处理（复制按钮/思考块折叠/滚动控制器）统一由 refreshChatContent 的
  // applyChatDom 完成，全量渲染的聊天壳也在随后同步调用了 refreshChatContent，
  // 这里不再重复绑定，避免同一节点监听叠加。
}

