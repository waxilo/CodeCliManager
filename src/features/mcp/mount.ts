import { appState } from '../../state';
import { shellApi } from '../../app/shell/api';
import { loadMcpServers, openMcpEditorDialog } from './editor-dialog';
import { startMainBalanceBarAutoRefresh } from '../status-bar';

export function openMcpView() {
  if (appState.isMcpViewActive) return;
  // 全屏管理页互斥
  if (appState.isApiConfigViewActive) {
    shellApi.dismissApiConfigViewState();
  }
  if (appState.isSettingsViewActive) {
    shellApi.dismissSettingsViewState();
  }
  appState.isMcpViewActive = true;
  shellApi.render();
}

/** 退出 MCP 管理页状态（不触发 render，供即将全量重绘的路径使用） */
export function dismissMcpViewState() {
  if (!appState.isMcpViewActive && !appState.mcpEscapeHandler) return;
  if (appState.mcpEscapeHandler) {
    document.removeEventListener('keydown', appState.mcpEscapeHandler);
    appState.mcpEscapeHandler = null;
  }
  appState.mcpMountToken += 1;
  document.querySelector('.mcp-dialog-overlay')?.remove();
  appState.isMcpViewActive = false;
}

export function closeMcpView() {
  if (!appState.isMcpViewActive) {
    dismissMcpViewState();
    return;
  }
  dismissMcpViewState();
  shellApi.render();
  startMainBalanceBarAutoRefresh();
}

export async function mountMcpView() {
  const view = document.querySelector('#mcp-view');
  if (!view || !appState.isMcpViewActive) return;

  const mountToken = ++appState.mcpMountToken;
  const isMountCurrent = () => mountToken === appState.mcpMountToken && appState.isMcpViewActive;

  const close = () => closeMcpView();

  const onEscapeKey = (event: KeyboardEvent) => {
    if (event.key !== 'Escape') return;
    if (!isMountCurrent()) return;
    // 确认框打开时交由确认框处理（删除确认）
    if (document.querySelector('.confirm-overlay')) {
      return;
    }
    const dialog = document.querySelector('.mcp-dialog-overlay');
    if (dialog) {
      dialog.remove();
      event.preventDefault();
      return;
    }
    event.preventDefault();
    close();
  };

  if (appState.mcpEscapeHandler) {
    document.removeEventListener('keydown', appState.mcpEscapeHandler);
  }
  appState.mcpEscapeHandler = onEscapeKey;
  document.addEventListener('keydown', onEscapeKey);

  view.querySelector('.settings-close-btn')?.addEventListener('click', close);
  view.querySelector('#mcp-add-btn')?.addEventListener('click', () => openMcpEditorDialog(null));

  await loadMcpServers();
}
