import { appState } from '../../state';
import { shellApi } from '../../app/shell/api';
import { startMainBalanceBarAutoRefresh } from '../status-bar';
import {
  openKiroModelConfigDialog,
  refreshKiroStatus,
  refreshKiroToken,
  scheduleKiroUsage,
  toggleKiroProxy,
} from './panel';

export function openKiroView() {
  if (appState.isKiroViewActive) return;
  if (!appState.kiroStatus?.available) return;
  if (appState.isApiConfigViewActive) {
    shellApi.dismissApiConfigViewState();
  }
  if (appState.isSettingsViewActive) {
    shellApi.dismissSettingsViewState();
  }
  if (appState.isMcpViewActive) {
    shellApi.dismissMcpViewState();
  }
  appState.isKiroViewActive = true;
  shellApi.render();
}

/** 退出 Kiro 代理页状态（不触发 render，供即将全量重绘的路径使用） */
export function dismissKiroViewState() {
  if (!appState.isKiroViewActive && !appState.kiroEscapeHandler) return;
  if (appState.kiroEscapeHandler) {
    document.removeEventListener('keydown', appState.kiroEscapeHandler);
    appState.kiroEscapeHandler = null;
  }
  appState.kiroMountToken += 1;
  appState.isKiroViewActive = false;
}

export function closeKiroView() {
  if (!appState.isKiroViewActive) {
    dismissKiroViewState();
    return;
  }
  dismissKiroViewState();
  shellApi.render();
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
  // 连点打开/关闭时，过期 mount 的异步刷新不得继续触发后续副作用
  if (!isMountCurrent()) return;
}
