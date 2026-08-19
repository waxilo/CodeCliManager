import { appState } from '../../state';
import { shellApi } from '../../app/shell/api';
import { loadMcpServers, openMcpEditorDialog } from './editor-dialog';
import { openMcpImportDialog } from './import-dialog';
import { stashComposerDraft, restoreComposerDraft } from '../files/index';
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
  if (appState.isKiroViewActive) {
    shellApi.dismissKiroViewState();
  }
  // 增量进出会摘取/挂回主视图；先保存草稿以防回退到全量重绘路径时丢失
  stashComposerDraft();
  appState.isMcpViewActive = true;
  shellApi.enterManagementView('mcp');
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
  shellApi.exitManagementView();
  restoreComposerDraft();
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

  // 管理壳节点缓存复用：按钮监听与服务器列表已在首次挂载完成，二次挂载只重绑 Escape
  if ((view as HTMLElement).dataset.mcpCachedMounted === '1') return;
  (view as HTMLElement).dataset.mcpCachedMounted = '1';

  view.querySelector('.settings-close-btn')?.addEventListener('click', close);
  view.querySelector('#mcp-add-btn')?.addEventListener('click', () => openMcpEditorDialog(null));
  view.querySelector('#mcp-import-btn')?.addEventListener('click', () => openMcpImportDialog());

  await loadMcpServers();
}
