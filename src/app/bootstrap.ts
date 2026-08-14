import { listen } from '@tauri-apps/api/event';
import type { KiroStatusData } from '../types';
import { appState } from '../state';
import * as api from '../api';
import {
  initTheme,
  initSidebarWidth,
  initSidebarCollapsed,
  syncSidebarResponsiveState,
  bindSidebarResponsive,
  registerUiRefreshExecutor,
} from '../ui';
import { shellApi } from './shell/api';
import { render, syncTitlebarActions } from './shell/render';
import { refreshChatContent } from '../features/chat/refresh';
import { initPlatformClass, setupExternalLinkInterceptor } from './shell/platform';
import { syncPermissionModeToBackend } from '../features/permissions/permission-mode';
import { loadData } from '../features/conversations';
import { loadChatModelOptions, updateChatModelPicker } from '../features/chat/model-picker';
import { selectConversation } from '../features/conversations/select';
import {
  startMainBalanceBarAutoRefresh,
  scheduleMainBalanceBar,
  syncStatusBarSections,
  clearMainBalanceBarCache,
  clearGitBranchCache,
  refreshGitBranch,
} from '../features/status-bar';
import { remountActiveInteractionPanel, closePermissionDialogs } from '../features/permissions';
import {
  updateSendButtonState,
  setAbortingUi,
  setSendButtonLoading,
} from '../features/chat/session-context';
import { hideSendingState } from '../features/chat/retry';
import { updateConversationListSpinner, refreshConversationListDom } from '../features/sidebar';
import { refreshStreamingUI } from '../features/chat/streaming';
import { syncSubagentProgressUI } from '../features/chat/subagent-progress';
import { syncTodoPanelUI } from '../features/chat/todo-panel';
import {
  invalidateFileCache,
  bindDragDropFileRefs,
  clearPasteAttachments,
  clearImportedFileRefs,
} from '../features/files';
import { ensureChatViewVisible } from '../features/chat/streaming';
import {
  openApiConfigView,
  closeApiConfigView,
  dismissApiConfigViewState,
  mountApiConfigView,
} from '../features/api-config';
import {
  openSettingsView,
  closeSettingsView,
  dismissSettingsViewState,
  mountSettingsView,
} from '../features/settings';
import { openMcpView, closeMcpView, dismissMcpViewState, mountMcpView } from '../features/mcp';
import {
  openKiroView,
  closeKiroView,
  dismissKiroViewState,
  mountKiroView,
  renderKiroCard,
  refreshKiroStatus,
  scheduleKiroUsage,
} from '../features/kiro';
import { newChat } from '../features/chat/send';
import { refreshSettingsModal } from '../features/api-config';
import { refreshModelInfo } from '../features/chat/render-chat';
import { checkClaudeCodeUpdate, initAppUpdate } from '../features/updates';
import { setupEventListeners } from '../events/session-events';

/** 将各 feature 实现注册到 shellApi，打破循环依赖。 */
function wireShellApi(): void {
  shellApi.render = render;
  shellApi.syncTitlebarActions = syncTitlebarActions;
  shellApi.refreshChatContent = refreshChatContent;
  shellApi.refreshConversationListDom = refreshConversationListDom;
  shellApi.loadData = loadData;
  shellApi.selectConversation = selectConversation;
  shellApi.startMainBalanceBarAutoRefresh = startMainBalanceBarAutoRefresh;
  shellApi.scheduleMainBalanceBar = scheduleMainBalanceBar;
  shellApi.remountActiveInteractionPanel = remountActiveInteractionPanel;
  shellApi.updateSendButtonState = updateSendButtonState;
  shellApi.updateConversationListSpinner = updateConversationListSpinner;
  shellApi.loadChatModelOptions = loadChatModelOptions;
  shellApi.updateChatModelPicker = updateChatModelPicker;
  shellApi.syncStatusBarSections = syncStatusBarSections;
  shellApi.clearMainBalanceBarCache = clearMainBalanceBarCache;
  shellApi.clearGitBranchCache = clearGitBranchCache;
  shellApi.refreshGitBranch = refreshGitBranch;
  shellApi.invalidateFileCache = invalidateFileCache;
  shellApi.bindDragDropFileRefs = bindDragDropFileRefs;
  shellApi.clearPasteAttachments = clearPasteAttachments;
  shellApi.clearImportedFileRefs = clearImportedFileRefs;
  shellApi.closePermissionDialogs = closePermissionDialogs;
  shellApi.hideSendingState = hideSendingState;
  shellApi.setAbortingUi = setAbortingUi;
  shellApi.setSendButtonLoading = setSendButtonLoading;
  shellApi.ensureChatViewVisible = ensureChatViewVisible;
  shellApi.openApiConfigView = openApiConfigView;
  shellApi.openSettingsView = openSettingsView;
  shellApi.openMcpView = openMcpView;
  shellApi.openKiroView = openKiroView;
  shellApi.closeApiConfigView = closeApiConfigView;
  shellApi.closeSettingsView = closeSettingsView;
  shellApi.closeMcpView = closeMcpView;
  shellApi.closeKiroView = closeKiroView;
  shellApi.dismissApiConfigViewState = dismissApiConfigViewState;
  shellApi.dismissSettingsViewState = dismissSettingsViewState;
  shellApi.dismissMcpViewState = dismissMcpViewState;
  shellApi.dismissKiroViewState = dismissKiroViewState;
  shellApi.mountApiConfigView = mountApiConfigView;
  shellApi.mountSettingsView = mountSettingsView;
  shellApi.mountMcpView = mountMcpView;
  shellApi.mountKiroView = mountKiroView;
  shellApi.newChat = newChat;
  shellApi.renderKiroCard = renderKiroCard as (status: unknown) => void;
  shellApi.refreshKiroStatus = refreshKiroStatus;
  shellApi.refreshSettingsModal = async (overlay, profileId) => {
    await refreshSettingsModal(overlay, profileId);
  };
  shellApi.refreshModelInfo = refreshModelInfo;
}

/** Kiro 后台自动启动并同步模型后，刷新前端状态与模型选择器 */
async function setupKiroAutostartListener(): Promise<void> {
  try {
    await listen<KiroStatusData>('kiro-ready', async (event) => {
      renderKiroCard(event.payload);
      try {
        await loadChatModelOptions();
      } catch (e) {
        console.error('[kiro] 自动启动后刷新模型失败:', e);
      }
      if (appState.isKiroViewActive) {
        try {
          await refreshKiroStatus();
        } catch (e) {
          console.error('[kiro] 自动启动后刷新代理页失败:', e);
        }
      } else {
        scheduleMainBalanceBar();
      }
    });
    await listen<KiroStatusData>('kiro-token-refreshed', (event) => {
      renderKiroCard(event.payload);
      if (appState.isKiroViewActive) {
        scheduleKiroUsage();
      }
      scheduleMainBalanceBar();
    });
    // 若自动启动已先于监听完成，补一次刷新
    try {
      const status = await api.kiroStatus();
      if (status.running || status.available) {
        renderKiroCard(status);
        if (status.running) {
          await loadChatModelOptions();
        }
      }
    } catch {
      // ignore
    }
  } catch (e) {
    console.error('[kiro] 注册自动启动监听失败:', e);
  }
}

let appInitialized = false;

export async function init(): Promise<void> {
  // files 模块曾误触发二次 init；全局只允许启动一次
  if (appInitialized) return;
  appInitialized = true;

  wireShellApi();
  registerUiRefreshExecutor((flags) => {
    let chatRebuilt = false;
    if (flags.chat) {
      chatRebuilt = refreshChatContent();
    }
    if (flags.sidebar) {
      updateConversationListSpinner();
    }
    if (flags.subagent) {
      syncSubagentProgressUI();
    }
    if (flags.todo) {
      syncTodoPanelUI();
    }
    // refreshChatContent 会抹掉流式块；当前会话在流式时按 appState 恢复，避免空白卡死
    if (chatRebuilt) {
      const sid = appState.activeConversationId;
      if (sid && appState.streamingBySession.has(sid)) {
        refreshStreamingUI(sid);
      }
    }
  });
  initPlatformClass();
  initTheme();
  initSidebarWidth();
  initSidebarCollapsed();
  // 首屏就按窗口宽度决定侧边栏是否折叠，避免渲染后再跳一次
  syncSidebarResponsiveState();
  await syncPermissionModeToBackend();
  await loadData();
  await loadChatModelOptions();
  // 首屏前探测本地是否有 Kiro，决定是否显示「Kiro 代理」入口
  try {
    appState.kiroStatus = await api.kiroStatus();
  } catch {
    appState.kiroStatus = null;
  }
  render();
  if (!appState.activeConversationId) {
    void refreshModelInfo();
  }
  startMainBalanceBarAutoRefresh();
  setupEventListeners();
  setupExternalLinkInterceptor();
  bindSidebarResponsive();
  // 先让首屏完成绘制，再启动两个独立的后台版本检查。
  setTimeout(() => {
    void checkClaudeCodeUpdate(false);
    void initAppUpdate();
  }, 0);
  void setupKiroAutostartListener();
}
