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
} from '../ui';
import { shellApi } from './shell/api';
import { render } from './shell/render';
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
import { newChat } from '../features/chat/send';
import { renderKiroCard, refreshKiroStatus, refreshSettingsModal } from '../features/api-config';
import { refreshModelInfo } from '../features/chat/render-chat';
import { checkClaudeCodeUpdate, initAppUpdate } from '../features/updates';
import { setupEventListeners } from '../events/session-events';

/** 将各 feature 实现注册到 shellApi，打破循环依赖。 */
function wireShellApi(): void {
  shellApi.render = render;
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
  shellApi.closeApiConfigView = closeApiConfigView;
  shellApi.closeSettingsView = closeSettingsView;
  shellApi.closeMcpView = closeMcpView;
  shellApi.dismissApiConfigViewState = dismissApiConfigViewState;
  shellApi.dismissSettingsViewState = dismissSettingsViewState;
  shellApi.dismissMcpViewState = dismissMcpViewState;
  shellApi.mountApiConfigView = mountApiConfigView;
  shellApi.mountSettingsView = mountSettingsView;
  shellApi.mountMcpView = mountMcpView;
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
      // 若 API 配置页正开着，顺带刷新表单里的模型与 Kiro 卡片
      const overlay = document.querySelector('#api-config-view') as HTMLElement | null;
      if (overlay && appState.isApiConfigViewActive) {
        try {
          await refreshKiroStatus();
          const state = await api.getApiProfilesState();
          const kiroId =
            state.profiles.find((p) => p.name === 'Kiro')?.id || state.activeProfileId || null;
          await refreshSettingsModal(overlay, kiroId);
        } catch (e) {
          console.error('[kiro] 自动启动后刷新设置页失败:', e);
        }
      } else {
        scheduleMainBalanceBar();
      }
    });
    // 若自动启动已先于监听完成，补一次刷新
    try {
      const status = await api.kiroStatus();
      if (status.running) {
        renderKiroCard(status);
        await loadChatModelOptions();
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
  initPlatformClass();
  initTheme();
  initSidebarWidth();
  initSidebarCollapsed();
  // 首屏就按窗口宽度决定侧边栏是否折叠，避免渲染后再跳一次
  syncSidebarResponsiveState();
  await syncPermissionModeToBackend();
  await loadData();
  await loadChatModelOptions();
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
