import { appState, app } from '../../state';
import { shellApi } from '../../app/shell/api';
import { startMainBalanceBarAutoRefresh } from '../status-bar';
import { renderKiroViewHtml } from './view';
import {
  openKiroModelConfigDialog,
  refreshKiroStatus,
  refreshKiroModels,
  refreshKiroToken,
  scheduleKiroUsage,
  toggleKiroProxy,
} from './panel';

function removeKiroOverlay(): void {
  document.querySelector('#kiro-overlay')?.remove();
  document.querySelector('.app-shell')?.classList.remove('has-kiro-overlay');
}

function mountKiroOverlay(): boolean {
  if (document.querySelector('#kiro-overlay')) return true;
  const shell = app.querySelector('.app-shell');
  if (!shell) return false;

  const overlay = document.createElement('div');
  overlay.id = 'kiro-overlay';
  overlay.className = 'kiro-overlay';
  overlay.setAttribute('role', 'dialog');
  overlay.setAttribute('aria-modal', 'true');
  overlay.setAttribute('aria-label', 'Kiro 代理');
  overlay.innerHTML = renderKiroViewHtml();
  shell.appendChild(overlay);
  shell.classList.add('has-kiro-overlay');
  return true;
}

export function openKiroView() {
  if (appState.isKiroViewActive) {
    if (!document.querySelector('#kiro-overlay') && mountKiroOverlay()) {
      shellApi.syncTitlebarActions();
      void mountKiroView();
    }
    return;
  }
  if (!appState.kiroStatus?.available) return;
  const leavingFullPageView =
    appState.isApiConfigViewActive || appState.isSettingsViewActive || appState.isMcpViewActive;
  if (appState.isApiConfigViewActive) {
    shellApi.dismissApiConfigViewState();
  }
  if (appState.isSettingsViewActive) {
    shellApi.dismissSettingsViewState();
  }
  if (appState.isMcpViewActive) {
    shellApi.dismissMcpViewState();
  }
  if (leavingFullPageView) {
    shellApi.exitManagementView();
  }
  appState.isKiroViewActive = true;
  if (!mountKiroOverlay()) {
    appState.isKiroViewActive = false;
    return;
  }
  shellApi.syncTitlebarActions();
  void mountKiroView();
}

/** 退出 Kiro 代理页状态（不触发 render，供即将全量重绘的路径使用） */
export function dismissKiroViewState() {
  if (!appState.isKiroViewActive && !appState.kiroEscapeHandler && !document.querySelector('#kiro-overlay')) return;
  if (appState.kiroEscapeHandler) {
    document.removeEventListener('keydown', appState.kiroEscapeHandler);
    appState.kiroEscapeHandler = null;
  }
  appState.kiroMountToken += 1;
  appState.isKiroViewActive = false;
  removeKiroOverlay();
}

export function closeKiroView() {
  if (!appState.isKiroViewActive) {
    dismissKiroViewState();
    return;
  }
  dismissKiroViewState();
  shellApi.syncTitlebarActions();
  startMainBalanceBarAutoRefresh();
}

export async function mountKiroView() {
  const view = document.querySelector('#kiro-view') as HTMLElement | null;
  if (!view || !appState.isKiroViewActive) return;

  const mountToken = ++appState.kiroMountToken;
  const isMountCurrent = () => mountToken === appState.kiroMountToken && appState.isKiroViewActive;

  const close = () => closeKiroView();

  const onEscapeKey = (event: KeyboardEvent) => {
    if (event.key !== 'Escape') return;
    if (!isMountCurrent()) return;
    // 模型配置弹层打开时，交给弹层自身关闭
    if (document.querySelector('.model-picker-overlay')) return;
    event.preventDefault();
    close();
  };

  if (appState.kiroEscapeHandler) {
    document.removeEventListener('keydown', appState.kiroEscapeHandler);
  }
  appState.kiroEscapeHandler = onEscapeKey;
  document.addEventListener('keydown', onEscapeKey);

  // 管理壳节点缓存复用：按钮监听已在首次挂载绑定，二次挂载只重绑 Escape。
  // 与 api-config/mcp 的 dataset 守卫一致，避免同一节点重复 addEventListener。
  if (view.dataset.kiroMounted === '1') return;
  view.dataset.kiroMounted = '1';

  view.querySelector('.settings-close-btn')?.addEventListener('click', close);
  view.querySelector('.settings-close-footer')?.addEventListener('click', close);
  view.querySelector('.kiro-toggle-btn')?.addEventListener('click', () => {
    void toggleKiroProxy();
  });
  view.querySelector('.kiro-token-refresh')?.addEventListener('click', () => {
    void refreshKiroToken();
  });
  view.querySelector('.kiro-usage-refresh')?.addEventListener('click', () => {
    scheduleKiroUsage();
  });
  view.querySelector('[data-kiro-model-summary-btn]')?.addEventListener('click', () => {
    openKiroModelConfigDialog();
  });

  await refreshKiroStatus();
  if (!isMountCurrent()) return;
  await refreshKiroModels();
  // 连点打开/关闭时，过期 mount 的异步刷新不得继续触发后续副作用
  if (!isMountCurrent()) return;
}
