import { appState } from '../../state';
import { shellApi } from '../../app/shell/api';
import { getIsSidebarCollapsed, setSidebarCollapsed, showCopyToastMsg } from '../../ui';
import { stashComposerDraft, restoreComposerDraft } from '../files/index';
import { setPermissionMode } from '../permissions/permission-mode';
import { startMainBalanceBarAutoRefresh } from '../status-bar';

export function openSettingsView() {
  if (appState.isSettingsViewActive) return;
  if (appState.isApiConfigViewActive) {
    shellApi.dismissApiConfigViewState();
  }
  if (appState.isMcpViewActive) {
    shellApi.dismissMcpViewState();
  }
  if (appState.isKiroViewActive) {
    shellApi.dismissKiroViewState();
  }
  if (getIsSidebarCollapsed()) {
    setSidebarCollapsed(false);
  }
  // 增量进出会摘取/挂回主视图；先保存草稿以防回退到全量重绘路径时丢失
  stashComposerDraft();
  appState.isSettingsViewActive = true;
  shellApi.enterManagementView('settings');
}

/** 退出设置页状态（不触发 render） */
export function dismissSettingsViewState() {
  if (!appState.isSettingsViewActive && !appState.settingsEscapeHandler) return;
  if (appState.settingsEscapeHandler) {
    document.removeEventListener('keydown', appState.settingsEscapeHandler);
    appState.settingsEscapeHandler = null;
  }
  appState.isSettingsViewActive = false;
}

export function closeSettingsView() {
  if (!appState.isSettingsViewActive) {
    dismissSettingsViewState();
    return;
  }
  dismissSettingsViewState();
  shellApi.exitManagementView();
  restoreComposerDraft();
  startMainBalanceBarAutoRefresh();
}

export function mountSettingsView() {
  if (!appState.isSettingsViewActive) return;

  const onEscapeKey = (event: KeyboardEvent) => {
    if (event.key !== 'Escape') return;
    if (!appState.isSettingsViewActive) return;
    event.preventDefault();
    closeSettingsView();
  };

  if (appState.settingsEscapeHandler) {
    document.removeEventListener('keydown', appState.settingsEscapeHandler);
  }
  appState.settingsEscapeHandler = onEscapeKey;
  document.addEventListener('keydown', onEscapeKey);
}

export function bindPermissionModeBarEvents(): void {
  const bar = document.querySelector('.permission-mode-bar');
  if (!bar || (bar as HTMLElement).dataset.bound === '1') return;
  (bar as HTMLElement).dataset.bound = '1';

  bar.querySelectorAll<HTMLInputElement>('input[name="permission-mode"]').forEach((input) => {
    input.addEventListener('change', () => {
      const value = input.value as 'ask' | 'silent' | 'auto';
      if (value !== 'ask' && value !== 'silent' && value !== 'auto') return;
      setPermissionMode(value);
      bar.querySelectorAll('.permission-mode-chip').forEach((el) => {
        el.classList.toggle('is-selected', el.querySelector('input')?.value === input.value);
      });
      if (value === 'silent') {
        showCopyToastMsg('已开启静默授权（自动允许工具请求）');
      } else if (value === 'auto') {
        showCopyToastMsg('已开启全自动（自动允许工具 + 自动回答互动问答）');
      } else {
        showCopyToastMsg('已恢复询问模式（同工具只问一次）');
      }
    });
  });
}
