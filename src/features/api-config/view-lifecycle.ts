import { appState } from '../../state';
import { shellApi } from '../../app/shell/api';
import { getIsSidebarCollapsed, setSidebarCollapsed } from '../../ui';
import { closeProfileContextMenu } from './profile-list';
import { loadChatModelOptions } from '../chat/model-picker';
import { refreshModelInfo } from '../chat/render-chat';
import { startMainBalanceBarAutoRefresh } from '../status-bar';

export function openApiConfigView() {
  if (appState.isApiConfigViewActive) return;
  // 全屏管理页互斥
  if (appState.isMcpViewActive) {
    shellApi.dismissMcpViewState();
  }
  if (appState.isSettingsViewActive) {
    shellApi.dismissSettingsViewState();
  }
  // 配置列表在左侧栏，收起时先展开以免看不见
  if (getIsSidebarCollapsed()) {
    setSidebarCollapsed(false);
  }
  appState.isApiConfigViewActive = true;
  shellApi.render();
}

/** 退出 API 配置页状态（不触发 render，供即将全量重绘的路径使用） */
export function dismissApiConfigViewState() {
  if (!appState.isApiConfigViewActive && !appState.apiConfigEscapeHandler) return;
  if (appState.apiConfigEscapeHandler) {
    document.removeEventListener('keydown', appState.apiConfigEscapeHandler);
    appState.apiConfigEscapeHandler = null;
  }
  appState.apiConfigMountToken += 1;
  closeProfileContextMenu();
  document.querySelector('.model-picker-overlay')?.remove();
  appState.isApiConfigViewActive = false;
}

export function closeApiConfigView() {
  if (!appState.isApiConfigViewActive) {
    dismissApiConfigViewState();
    return;
  }
  dismissApiConfigViewState();
  shellApi.render();
  void loadChatModelOptions();
  if (!appState.activeConversationId) {
    void refreshModelInfo();
  }
  startMainBalanceBarAutoRefresh();
}
