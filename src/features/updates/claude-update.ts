import { appState } from '../../state';
import * as api from '../../api';
import { escapeHtml } from '../../utils';
import { showCopyToastMsg, showConfirmDialog } from '../../ui';
import {
  syncSettingsUpdateBadgeUI,
  renderAppUpdatePopoverBody,
  bindAppUpdatePopoverEvents,
} from './app-update';

export function shouldShowClaudeUpdateBadge(): boolean {
  return Boolean(appState.claudeUpdateInfo?.updateAvailable && appState.claudeUpdateInfo.latest);
}

export function getClaudeUpdateButtonTitle(): string {
  if (appState.claudeUpdateCheckStatus === 'installing') return '正在安装 Claude Code…';
  if (appState.claudeUpdateCheckStatus === 'updating') return '正在静默更新 Claude Code…';
  if (appState.claudeUpdateCheckStatus === 'checking') return '正在检查 Claude Code 更新…';
  if (shouldShowClaudeUpdateBadge() && appState.claudeUpdateInfo?.latest) {
    return `Claude Code 有新版本 ${appState.claudeUpdateInfo.latest}`;
  }
  if (appState.claudeUpdateInfo?.installed) {
    return `Claude Code ${appState.claudeUpdateInfo.installed}`;
  }
  return '检查 Claude Code 更新';
}

export function renderClaudeUpdateIcon(): string {
  return `
    <svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
      <path d="M21 12a9 9 0 0 0-9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/>
      <path d="M3 3v5h5"/>
      <path d="M3 12a9 9 0 0 0 9 9 9.75 9.75 0 0 0 6.74-2.74L21 16"/>
      <path d="M16 16h5v5"/>
    </svg>
  `;
}

export function syncClaudeUpdateButtonUI() {
  const showBadge = shouldShowClaudeUpdateBadge();
  const checking = appState.claudeUpdateCheckStatus === 'checking' || appState.claudeUpdateCheckStatus === 'updating' || appState.claudeUpdateCheckStatus === 'installing';
  const btn = document.querySelector('#claude-update-btn') as HTMLButtonElement | null;
  if (btn) {
    btn.classList.toggle('has-update', showBadge);
    btn.classList.toggle('is-checking', checking);
    const label = btn.querySelector('.toolbar-update-btn-label');
    if (label) {
      label.textContent =
        appState.claudeUpdateCheckStatus === 'updating' ? '更新中' : showBadge ? '有更新' : '版本';
    }
    let dot = btn.querySelector('.toolbar-update-btn-dot');
    if (showBadge && !dot) {
      dot = document.createElement('span');
      dot.className = 'toolbar-update-btn-dot';
      dot.setAttribute('aria-hidden', 'true');
      btn.appendChild(dot);
    } else if (!showBadge && dot) {
      dot.remove();
    }
    const title = getClaudeUpdateButtonTitle();
    btn.title = title;
    btn.setAttribute('aria-label', title);
  }
  syncSettingsUpdateBadgeUI();
  renderSettingsUpdateSectionIfOpen();
}

export async function checkClaudeCodeUpdate(force = false): Promise<void> {
  // 手动重查与启动检查共享同一个任务，避免并发结果相互覆盖。
  if (appState.claudeUpdateCheckPromise) {
    if (!force) return appState.claudeUpdateCheckPromise;
    // 更新完成后的强制复查：等当前任务结束后再查一次，确保小红点状态刷新
    await appState.claudeUpdateCheckPromise;
  }
  // 安装/更新进行中不启动新检查（调用方应在结束后再 force 复查）
  if (appState.claudeUpdateCheckStatus === 'updating' || appState.claudeUpdateCheckStatus === 'installing') {
    return;
  }

  appState.claudeUpdateCheckStatus = 'checking';
  appState.claudeUpdateError = null;
  syncClaudeUpdateButtonUI();

  appState.claudeUpdateCheckPromise = (async () => {
    try {
      const info = await api.checkClaudeCodeUpdate();
      // 与 CCM 一致：已是最新时若 latest 为空则回填为当前版本
      if (!info.updateAvailable && info.installed && !info.latest) {
        info.latest = info.installed;
      }
      appState.claudeUpdateInfo = info;
      appState.claudeUpdateError = null;
      appState.claudeUpdateCheckStatus = info.error && !info.installed && !info.latest ? 'error' : 'ready';
    } catch (e) {
      appState.claudeUpdateInfo = {
        installed: null,
        latest: null,
        updateAvailable: false,
        executablePath: null,
        canSilentUpdate: false,
        error: String(e),
      };
      appState.claudeUpdateCheckStatus = 'error';
    } finally {
      syncClaudeUpdateButtonUI();
      appState.claudeUpdateCheckPromise = null;
      refreshClaudeUpdatePopoverIfOpen();
    }
  })();

  return appState.claudeUpdateCheckPromise;
}

export function refreshClaudeUpdatePopoverIfOpen() {
  const panel = document.querySelector('#claude-update-popover, #settings-claude-update-view');
  if (panel) {
    panel.innerHTML = renderClaudeUpdatePopoverBody();
    bindClaudeUpdatePopoverEvents(panel);
  }
}

export function renderSettingsUpdateSectionIfOpen(): void {
  if (!appState.isSettingsViewActive || (appState.settingsSection !== 'app-update' && appState.settingsSection !== 'claude-update')) return;
  const view = document.querySelector<HTMLElement>('.settings-update-view');
  if (!view) return;
  view.innerHTML = appState.settingsSection === 'app-update'
    ? renderAppUpdatePopoverBody()
    : renderClaudeUpdatePopoverBody();
  if (appState.settingsSection === 'app-update') bindAppUpdatePopoverEvents(view);
  else bindClaudeUpdatePopoverEvents(view);
}

export async function runClaudeCodeInstall(): Promise<void> {
  if (appState.claudeUpdateCheckStatus === 'installing' || appState.claudeUpdateCheckStatus === 'updating') return;
  const confirmed = await showConfirmDialog({
    title: '安装 Claude Code',
    message: '将从 claude.ai 下载并执行官方 Claude Code 安装脚本。是否继续？',
    confirmLabel: '安装',
  });
  if (!confirmed) return;

  appState.claudeUpdateCheckStatus = 'installing';
  appState.claudeUpdateError = null;
  syncClaudeUpdateButtonUI();
  refreshClaudeUpdatePopoverIfOpen();

  try {
    const result = await api.runClaudeCodeInstall();
    showCopyToastMsg(`Claude Code ${result.installed || ''} 安装成功`);
    // 先乐观清掉「有更新」，避免复查完成前小红点残留
    if (appState.claudeUpdateInfo) {
      const installed = result.installed || appState.claudeUpdateInfo.installed;
      appState.claudeUpdateInfo = {
        ...appState.claudeUpdateInfo,
        installed,
        latest: installed || appState.claudeUpdateInfo.latest,
        updateAvailable: false,
        error: null,
      };
    }
    appState.claudeUpdateCheckStatus = 'ready';
    syncClaudeUpdateButtonUI();
    refreshClaudeUpdatePopoverIfOpen();
    await checkClaudeCodeUpdate(true);
  } catch (e) {
    appState.claudeUpdateError = String(e);
    appState.claudeUpdateCheckStatus = 'ready';
    syncClaudeUpdateButtonUI();
    refreshClaudeUpdatePopoverIfOpen();
  }
}

export async function runClaudeCodeSilentUpdate(): Promise<void> {
  if (appState.claudeUpdateCheckStatus === 'updating' || appState.claudeUpdateCheckStatus === 'installing') return;

  appState.claudeUpdateCheckStatus = 'updating';
  appState.claudeUpdateError = null;
  syncClaudeUpdateButtonUI();
  refreshClaudeUpdatePopoverIfOpen();

  try {
    const result = await api.runClaudeCodeUpdateSilent();
    showCopyToastMsg(
      result.usedElevation ? '已通过系统授权完成更新' : 'Claude Code 已静默更新'
    );
    // 先乐观清掉「有更新」，并立即同步侧栏/标题栏小红点（不必等切换分区）
    if (appState.claudeUpdateInfo) {
      const installed = result.installed || appState.claudeUpdateInfo.installed;
      const latest = result.latest || installed || appState.claudeUpdateInfo.latest;
      appState.claudeUpdateInfo = {
        ...appState.claudeUpdateInfo,
        installed,
        latest,
        updateAvailable: false,
        error: null,
      };
    }
    appState.claudeUpdateCheckStatus = 'ready';
    syncClaudeUpdateButtonUI();
    refreshClaudeUpdatePopoverIfOpen();
    await checkClaudeCodeUpdate(true);
  } catch (e) {
    appState.claudeUpdateError = String(e);
    appState.claudeUpdateCheckStatus = 'ready';
    syncClaudeUpdateButtonUI();
    refreshClaudeUpdatePopoverIfOpen();
  }
}

export function renderClaudeUpdatePopoverBody(): string {
  const info = appState.claudeUpdateInfo;
  const checking = appState.claudeUpdateCheckStatus === 'checking';
  const installing = appState.claudeUpdateCheckStatus === 'installing';
  const updating = appState.claudeUpdateCheckStatus === 'updating';
  const hasUpdate = Boolean(info?.updateAvailable && info.latest);
  // 与 CCM 一致：已是最新时「最新版本」回填为当前版本，避免显示 —
  const currentVersion = info?.installed || null;
  const latestVersion = info?.latest || (!hasUpdate ? currentVersion : null);
  const installed = currentVersion || '未检测到';
  const latest = latestVersion || '—';
  const path = info?.executablePath || '';
  const error = appState.claudeUpdateError || info?.error || '';
  const canSilent = info?.canSilentUpdate !== false;
  const statusHint = installing
    ? '正在执行 Claude 官方安装脚本，请稍候…'
    : updating
      ? '正在后台静默更新，请稍候…'
      : hasUpdate
        ? canSilent
          ? '发现新版本，可直接静默安装。'
          : '当前安装位于系统目录。将尝试原生安装或系统授权更新。'
        : !currentVersion
          ? '未检测到 Claude Code，可从 CCM 直接安装。'
          : '';
  const upToDateHint = !checking && !installing && !updating && !hasUpdate && currentVersion && latestVersion
    ? '已是最新版本。'
    : '';

  return `
    <div class="claude-update-popover-header">
      <strong>Claude Code 版本</strong>
      <button type="button" class="claude-update-popover-close" aria-label="关闭">✕</button>
    </div>
    <div class="claude-update-popover-rows">
      <div class="claude-update-row">
        <span class="claude-update-key">当前版本</span>
        <span class="claude-update-value">${escapeHtml(installed)}</span>
      </div>
      <div class="claude-update-row">
        <span class="claude-update-key">最新版本</span>
        <span class="claude-update-value${hasUpdate ? ' is-newer' : ''}">${escapeHtml(latest)}</span>
      </div>
      ${path ? `
      <div class="claude-update-row claude-update-row-path">
        <span class="claude-update-key">安装路径</span>
        <span class="claude-update-value" title="${escapeHtml(path)}">${escapeHtml(path)}</span>
      </div>` : ''}
    </div>
    ${checking ? `<p class="claude-update-popover-status">正在检查更新…</p>` : ''}
    ${statusHint ? `<p class="claude-update-popover-status">${escapeHtml(statusHint)}</p>` : ''}
    ${upToDateHint ? `<p class="claude-update-popover-status">${upToDateHint}</p>` : ''}
    ${installing ? `
      <div class="app-update-progress">
        <div class="app-update-progress-track">
          <div class="app-update-progress-bar claude-update-progress-indeterminate"></div>
        </div>
        <span class="app-update-progress-pct">安装中</span>
      </div>
    ` : ''}
    ${updating ? `
      <div class="app-update-progress">
        <div class="app-update-progress-track">
          <div class="app-update-progress-bar claude-update-progress-indeterminate"></div>
        </div>
        <span class="app-update-progress-pct">更新中</span>
      </div>
    ` : ''}
    ${error && !updating ? `<p class="claude-update-popover-error">${escapeHtml(error)}</p>` : ''}
    <div class="claude-update-popover-actions">
      <button type="button" class="claude-update-action" data-action="recheck" ${checking || updating || installing ? 'disabled' : ''}>
        ${checking ? '检查中…' : '重新检查'}
      </button>
      ${!currentVersion && !checking && !installing ? `
        <button type="button" class="claude-update-action primary" data-action="install">安装 Claude Code</button>
      ` : ''}
      ${hasUpdate && !updating && !installing ? `
        <button type="button" class="claude-update-action primary" data-action="update">立即更新</button>
      ` : ''}
    </div>
  `;
}

export function bindClaudeUpdatePopoverEvents(panel: Element) {
  panel.querySelector('.claude-update-popover-close')?.addEventListener('click', () => {
    if (panel.id === 'settings-claude-update-view') return;
    closeClaudeUpdatePopover();
  });

  panel.querySelectorAll<HTMLButtonElement>('[data-action]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const action = btn.dataset.action;
      if (action === 'recheck') {
        if (appState.claudeUpdateCheckStatus === 'checking' || appState.claudeUpdateCheckStatus === 'updating' || appState.claudeUpdateCheckStatus === 'installing') return;
        btn.disabled = true;
        btn.textContent = '检查中…';
        void checkClaudeCodeUpdate(true);
      } else if (action === 'install') {
        void runClaudeCodeInstall();
      } else if (action === 'update') {
        void runClaudeCodeSilentUpdate();
      }
    });
  });
}

export function closeClaudeUpdatePopover() {
  document.querySelector('.claude-update-popover-overlay')?.remove();
  document.querySelector('#claude-update-popover')?.remove();
}

