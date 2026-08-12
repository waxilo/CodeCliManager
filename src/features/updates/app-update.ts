import { getVersion } from '@tauri-apps/api/app';
import { check as checkAppUpdateRemote } from '@tauri-apps/plugin-updater';
import { relaunch } from '@tauri-apps/plugin-process';
import { appState } from '../../state';
import { escapeHtml } from '../../utils';
import { showCopyToastMsg } from '../../ui';
import { renderMarkdownCached as renderMarkdown } from '../../markdown';
import { shouldShowClaudeUpdateBadge } from './claude-update';
import { renderSettingsUpdateSectionIfOpen } from './claude-update';

// ── 应用自身更新（tauri-plugin-updater 拉取 GitHub Releases） ──────────

export function shouldShowAppUpdateBadge(): boolean {
  return Boolean(appState.appUpdateInfo.updateAvailable && appState.appUpdateInfo.latestVersion);
}

export function shouldShowSettingsUpdateBadge(): boolean {
  return shouldShowAppUpdateBadge() || shouldShowClaudeUpdateBadge();
}

export function syncSettingsUpdateBadgeUI(): void {
  const btn = document.querySelector('#settings-btn') as HTMLButtonElement | null;
  if (!btn) return;

  const showBadge = shouldShowSettingsUpdateBadge();
  let dot = btn.querySelector('.toolbar-settings-update-dot');
  if (showBadge && !dot) {
    dot = document.createElement('span');
    dot.className = 'toolbar-settings-update-dot';
    dot.setAttribute('aria-hidden', 'true');
    btn.appendChild(dot);
  } else if (!showBadge && dot) {
    dot.remove();
  }

  const title = showBadge ? '设置（有可用更新）' : '设置';
  btn.title = title;
  btn.setAttribute('aria-label', title);
}

export function getAppUpdateButtonTitle(): string {
  if (appState.appUpdateCheckStatus === 'checking') return '正在检查应用更新…';
  if (appState.appUpdateCheckStatus === 'downloading') return '正在下载更新…';
  if (shouldShowAppUpdateBadge() && appState.appUpdateInfo.latestVersion) {
    return `发现新版本 ${appState.appUpdateInfo.latestVersion}`;
  }
  if (appState.appUpdateInfo.currentVersion) {
    return `当前版本 ${appState.appUpdateInfo.currentVersion}`;
  }
  return '检查应用更新';
}

export function renderAppUpdateIcon(): string {
  return `
    <svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
      <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/>
      <polyline points="7 10 12 15 17 10"/>
      <line x1="12" y1="15" x2="12" y2="3"/>
    </svg>
  `;
}

export function syncAppUpdateButtonUI(): void {
  const btn = document.querySelector('#app-update-btn') as HTMLButtonElement | null;
  const showBadge = shouldShowAppUpdateBadge();
  const checking = appState.appUpdateCheckStatus === 'checking';
  const downloading = appState.appUpdateCheckStatus === 'downloading';
  if (btn) {
    btn.classList.toggle('has-update', showBadge);
    btn.classList.toggle('is-checking', checking || downloading);
    const label = btn.querySelector('.toolbar-update-btn-label');
    if (label) label.textContent = showBadge ? '有更新' : '更新';
    let dot = btn.querySelector('.toolbar-update-btn-dot');
    if (showBadge && !dot) {
      dot = document.createElement('span');
      dot.className = 'toolbar-update-btn-dot';
      dot.setAttribute('aria-hidden', 'true');
      btn.appendChild(dot);
    } else if (!showBadge && dot) {
      dot.remove();
    }
    const title = getAppUpdateButtonTitle();
    btn.title = title;
    btn.setAttribute('aria-label', title);
  }
  syncSettingsUpdateBadgeUI();
  renderSettingsUpdateSectionIfOpen();
}

export async function initAppUpdate(): Promise<void> {
  try {
    appState.appUpdateInfo.currentVersion = await getVersion();
  } catch {
    /* 获取当前版本失败时保持 null，不阻塞更新检查 */
  }
  syncAppUpdateButtonUI();
  void checkAppUpdate(false);
}

export async function checkAppUpdate(_force = false): Promise<void> {
  // 自动检查和手动重查必须串行，避免 updater 句柄与 UI 状态竞态。
  if (appState.appUpdateCheckPromise) {
    return appState.appUpdateCheckPromise;
  }

  appState.appUpdateCheckStatus = 'checking';
  syncAppUpdateButtonUI();

  appState.appUpdateCheckPromise = (async () => {
    try {
      // 本机清单代理会改写 GitHub 下载地址为镜像；超时放宽避免慢网误判
      const update = await checkAppUpdateRemote({ timeout: 60_000 });
      appState.appUpdate = update;
      appState.appUpdateInfo.updateAvailable = Boolean(update);
      // updater 在当前版本已是最新时返回 null，此时最新版本就是当前版本。
      appState.appUpdateInfo.latestVersion = update?.version ?? appState.appUpdateInfo.currentVersion;
      appState.appUpdateInfo.body = update?.body ?? null;
      appState.appUpdateInfo.error = null;
      appState.appUpdateCheckStatus = 'ready';
    } catch (e) {
      const raw = String(e);
      const timedOut = /timed?\s*out|timeout|连接超时|error sending request/i.test(raw);
      appState.appUpdateInfo.error = timedOut
        ? `检查更新超时（无法访问 GitHub Releases）。请确认网络或稍后重试。\n${raw}`
        : raw;
      appState.appUpdateCheckStatus = 'error';
    } finally {
      syncAppUpdateButtonUI();
      appState.appUpdateCheckPromise = null;
      // 若弹层开着，刷新内容
      const panel = document.querySelector('#app-update-popover, #settings-app-update-view');
      if (panel) {
        panel.innerHTML = renderAppUpdatePopoverBody();
        bindAppUpdatePopoverEvents(panel);
      }
    }
  })();

  return appState.appUpdateCheckPromise;
}

export function renderAppUpdateNotes(body: string): string {
  const html = renderMarkdown(body);
  return `<div class="markdown-body app-update-notes-body">${html}</div>`;
}

export function renderAppUpdateProgressHtml(): string {
  const pct = appState.appUpdateProgress && appState.appUpdateProgress.total > 0
    ? Math.min(100, Math.round((appState.appUpdateProgress.downloaded / appState.appUpdateProgress.total) * 100))
    : 0;
  return `
    <div class="app-update-progress">
      <div class="app-update-progress-track">
        <div class="app-update-progress-bar" style="width:${pct}%"></div>
      </div>
      <span class="app-update-progress-pct">${pct}%</span>
    </div>
  `;
}

export function renderAppUpdatePopoverBody(): string {
  const checking = appState.appUpdateCheckStatus === 'checking';
  const downloading = appState.appUpdateCheckStatus === 'downloading';
  const hasUpdate = Boolean(appState.appUpdateInfo.updateAvailable && appState.appUpdateInfo.latestVersion);
  const current = appState.appUpdateInfo.currentVersion || '—';
  const latest = appState.appUpdateInfo.latestVersion || '—';
  const error = appState.appUpdateInfo.error || '';
  const hint = !checking && !hasUpdate && appState.appUpdateInfo.currentVersion && appState.appUpdateInfo.latestVersion
    ? '已是最新版本。'
    : '';

  return `
    <div class="claude-update-popover-header">
      <strong>应用更新</strong>
      <button type="button" class="claude-update-popover-close" aria-label="关闭">✕</button>
    </div>
    <div class="claude-update-popover-rows">
      <div class="claude-update-row">
        <span class="claude-update-key">当前版本</span>
        <span class="claude-update-value">${escapeHtml(current)}</span>
      </div>
      <div class="claude-update-row">
        <span class="claude-update-key">最新版本</span>
        <span class="claude-update-value${hasUpdate ? ' is-newer' : ''}">${escapeHtml(latest)}</span>
      </div>
    </div>
    ${checking ? `<p class="claude-update-popover-status">正在检查更新…</p>` : ''}
    ${hint ? `<p class="claude-update-popover-status">${hint}</p>` : ''}
    ${hasUpdate && appState.appUpdateInfo.body ? renderAppUpdateNotes(appState.appUpdateInfo.body) : ''}
    ${downloading ? renderAppUpdateProgressHtml() : ''}
    ${error && !downloading ? `<p class="claude-update-popover-error">${escapeHtml(error)}</p>` : ''}
    <div class="claude-update-popover-actions">
      <button type="button" class="claude-update-action" data-action="recheck" ${checking || downloading ? 'disabled' : ''}>
        ${checking ? '检查中…' : '重新检查'}
      </button>
      ${hasUpdate && !downloading ? `
        <button type="button" class="claude-update-action primary" data-action="install">下载并安装</button>
      ` : ''}
    </div>
  `;
}

export function bindAppUpdatePopoverEvents(panel: Element) {
  panel.querySelector('.claude-update-popover-close')?.addEventListener('click', () => {
    if (panel.id === 'settings-app-update-view') return;
    closeAppUpdatePopover();
  });

  panel.querySelectorAll<HTMLButtonElement>('[data-action]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const action = btn.dataset.action;
      if (action === 'recheck') {
        if (appState.appUpdateCheckStatus === 'checking' || appState.appUpdateCheckStatus === 'downloading') return;
        btn.disabled = true;
        btn.textContent = '检查中…';
        void checkAppUpdate(true);
      } else if (action === 'install') {
        if (appState.appUpdateCheckStatus === 'downloading' || appState.appUpdateCheckStatus === 'checking') return;
        btn.disabled = true;
        btn.textContent = '准备中…';
        void installAppUpdate();
      }
    });
  });
}

export function closeAppUpdatePopover() {
  document.querySelector('.claude-update-popover-overlay')?.remove();
  document.querySelector('#app-update-popover')?.remove();
}

/** macOS 上 downloadAndInstall 可能卡在 Finished 后不 resolve；超时后强制 relaunch */
const MAC_UPDATE_INSTALL_STALL_MS = 12_000;

export async function relaunchAfterUpdate(): Promise<void> {
  showCopyToastMsg('更新已安装，应用即将重启');
  closeAppUpdatePopover();
  // Windows NSIS 安装器通常会自行退出；macOS/Linux 必须显式 relaunch
  try {
    await relaunch();
  } catch (e) {
    console.error('[updater] relaunch failed:', e);
    showCopyToastMsg('请手动重启应用以完成更新');
  }
}

export async function installAppUpdate(): Promise<void> {
  if (appState.appUpdateCheckStatus === 'downloading') return;

  // 更新句柄可能在失败/超时后被清空，但 UI 仍显示「下载并安装」——先重新检查再安装，避免点击无反应
  if (!appState.appUpdate) {
    showCopyToastMsg('正在重新获取更新…');
    appState.appUpdateInfo.error = null;
    await checkAppUpdate(true);
    if (!appState.appUpdate) {
      appState.appUpdateCheckStatus = 'error';
      appState.appUpdateInfo.error = '未找到可安装的更新包，请点击「重新检查」后再试。';
      syncAppUpdateButtonUI();
      const panel = document.querySelector('#app-update-popover, #settings-app-update-view');
      if (panel) {
        panel.innerHTML = renderAppUpdatePopoverBody();
        bindAppUpdatePopoverEvents(panel);
      }
      return;
    }
  }

  const isWindows = /win/i.test(navigator.platform) || /windows/i.test(navigator.userAgent);
  showCopyToastMsg(isWindows ? '开始下载更新…（安装时若弹出 UAC 请允许）' : '开始下载更新…');

  appState.appUpdateCheckStatus = 'downloading';
  appState.appUpdateProgress = { downloaded: 0, total: 0 };
  syncAppUpdateButtonUI();
  const panel = document.querySelector('#app-update-popover, #settings-app-update-view');
  if (panel) {
    panel.innerHTML = renderAppUpdatePopoverBody();
    bindAppUpdatePopoverEvents(panel);
  }

  let installResolved = false;
  let stallTimer: ReturnType<typeof setTimeout> | null = null;
  const clearStallTimer = () => {
    if (stallTimer !== null) {
      clearTimeout(stallTimer);
      stallTimer = null;
    }
  };

  try {
    await appState.appUpdate.downloadAndInstall((event) => {
      if (event.event === 'Started') {
        appState.appUpdateProgress = { downloaded: 0, total: event.data.contentLength ?? 0 };
      } else if (event.event === 'Progress') {
        appState.appUpdateProgress = {
          downloaded: (appState.appUpdateProgress?.downloaded ?? 0) + event.data.chunkLength,
          total: appState.appUpdateProgress?.total ?? 0,
        };
      } else if (event.event === 'Finished') {
        // macOS：bundle 可能已替换完成，但 Promise 偶发不返回；启动看门狗强制重启
        if (stallTimer === null && navigator.platform.toLowerCase().includes('mac')) {
          stallTimer = setTimeout(() => {
            if (installResolved) return;
            console.warn('[updater] macOS install stall, forcing relaunch');
            void relaunchAfterUpdate();
          }, MAC_UPDATE_INSTALL_STALL_MS);
        } else if (isWindows) {
          showCopyToastMsg('下载完成，正在安装…（若弹出 UAC 请允许）');
        }
      }
      const progressPanel = document.querySelector('#app-update-popover, #settings-app-update-view');
      if (progressPanel) {
        const bar = progressPanel.querySelector('.app-update-progress-bar') as HTMLElement | null;
        const pctEl = progressPanel.querySelector('.app-update-progress-pct') as HTMLElement | null;
        const pct = appState.appUpdateProgress && appState.appUpdateProgress.total > 0
          ? Math.min(100, Math.round((appState.appUpdateProgress.downloaded / appState.appUpdateProgress.total) * 100))
          : 0;
        if (bar) bar.style.width = `${pct}%`;
        if (pctEl) pctEl.textContent = `${pct}%`;
      }
    }, { timeout: 300_000 });
    installResolved = true;
    clearStallTimer();
    appState.appUpdateProgress = null;
    // 重启前先释放 updater 资源，避免 macOS 上 close 与 relaunch 竞态
    if (appState.appUpdate) {
      try {
        void appState.appUpdate.close();
      } catch {
        /* ignore */
      }
      appState.appUpdate = null;
    }
    syncAppUpdateButtonUI();
    await relaunchAfterUpdate();
  } catch (e) {
    installResolved = true;
    clearStallTimer();
    appState.appUpdateCheckStatus = 'error';
    const raw = String(e);
    const timedOut = /timed?\s*out|timeout|连接超时|error sending request/i.test(raw);
    appState.appUpdateInfo.error = timedOut
      ? `下载更新超时。请检查网络后重试。\n${raw}`
      : raw;
    // 失败后清空句柄，但保留「有更新」状态，下次点击会重新获取后再装
    if (appState.appUpdateInfo.latestVersion) {
      appState.appUpdateInfo.updateAvailable = true;
    }
    const panel = document.querySelector('#app-update-popover, #settings-app-update-view');
    if (panel) {
      panel.innerHTML = renderAppUpdatePopoverBody();
      bindAppUpdatePopoverEvents(panel);
    }
    appState.appUpdateProgress = null;
    syncAppUpdateButtonUI();
    if (appState.appUpdate) {
      try {
        void appState.appUpdate.close();
      } catch {
        /* ignore */
      }
      appState.appUpdate = null;
    }
  } finally {
    clearStallTimer();
  }
}
