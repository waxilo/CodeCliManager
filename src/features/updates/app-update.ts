import { getVersion } from '@tauri-apps/api/app';
import { check as checkAppUpdateRemote } from '@tauri-apps/plugin-updater';
import type { Update as AppUpdate } from '@tauri-apps/plugin-updater';
import { relaunch } from '@tauri-apps/plugin-process';
import { appState } from '../../state';
import { escapeHtml } from '../../utils';
import { showCopyToastMsg } from '../../ui';
import { renderMarkdownCached as renderMarkdown } from '../../markdown';
import { shouldShowClaudeUpdateBadge } from './claude-update';
import { renderSettingsUpdateSectionIfOpen } from './claude-update';
import { stopAllSessions } from '../../api/session';

// ── 应用自身更新（tauri-plugin-updater 拉取 GitHub Releases） ──────────

export function shouldShowAppUpdateBadge(): boolean {
  return Boolean(appState.appUpdateInfo.updateAvailable && appState.appUpdateInfo.latestVersion);
}

export function shouldShowSettingsUpdateBadge(): boolean {
  return shouldShowAppUpdateBadge() || shouldShowClaudeUpdateBadge();
}

/** 同步设置侧栏「CCM / Claude Code」分区小红点（不依赖全量 render） */
export function syncSettingsSectionBadgeDots(): void {
  if (!appState.isSettingsViewActive) return;
  const nav = document.querySelector('.settings-section-nav');
  if (!nav) return;

  const entries: Array<{ section: 'app-update' | 'claude-update'; show: boolean }> = [
    { section: 'app-update', show: shouldShowAppUpdateBadge() },
    { section: 'claude-update', show: shouldShowClaudeUpdateBadge() },
  ];

  for (const { section, show } of entries) {
    const item = nav.querySelector(`[data-settings-section="${section}"]`);
    if (!item) continue;
    let dot = item.querySelector('.settings-section-item-dot');
    if (show && !dot) {
      dot = document.createElement('span');
      dot.className = 'settings-section-item-dot';
      dot.setAttribute('aria-label', '有更新');
      item.appendChild(dot);
    } else if (!show && dot) {
      dot.remove();
    }
  }
}

export function syncSettingsUpdateBadgeUI(): void {
  const btn = document.querySelector('#settings-btn') as HTMLButtonElement | null;
  if (btn) {
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

  syncSettingsSectionBadgeDots();
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

export async function checkAppUpdate(force = false): Promise<void> {
  // 自动检查和手动重查必须串行，避免 updater 句柄与 UI 状态竞态。
  if (appState.appUpdateCheckPromise) {
    // 非 force：复用进行中的检查，避免并发。
    if (!force) return appState.appUpdateCheckPromise;
    // force：等当前检查结束后重新发起一次，确保「检查更新」按钮真正重查。
    try {
      await appState.appUpdateCheckPromise;
    } catch {
      // 旧检查的错误已写入 appUpdateInfo，这里忽略即可
    }
    // 等待期间可能已有并发 force 发起了新检查，此时直接复用，避免重复启动
    if (appState.appUpdateCheckPromise) return appState.appUpdateCheckPromise;
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

/** 下载停滞毫秒数：超过仍无字节增长则判定镜像失效，中断并重选镜像重试 */
const DOWNLOAD_STALL_MS = 30_000;
const MAX_DOWNLOAD_ATTEMPTS = 3;

/**
 * 下载更新包：带进度 UI + 停滞检测。镜像只连不上、不吐数据时（本机代理已改为
 * 真实内容探测，仍可能偶发）会在停滞阈值后主动 abort；重试前重新获取清单，
 * 让本机代理重新探测镜像，而不是干等 300s 超时。
 */
async function downloadAppUpdatePackage(): Promise<void> {
  for (let attempt = 1; attempt <= MAX_DOWNLOAD_ATTEMPTS; attempt++) {
    if (!appState.appUpdate) {
      throw new Error('未找到可安装的更新包，请点击「重新检查」后再试。');
    }
    try {
      await downloadOnceWithStallAbort(appState.appUpdate);
      return;
    } catch (e) {
      const raw = String(e);
      const stalled = /stall|timed?\s*out|timeout|连接超时|error sending request/i.test(raw);
      console.warn(`[updater] 第 ${attempt} 次下载失败/停滞:`, e);
      // 释放句柄并重新获取清单，触发本机代理重新探测可用镜像
      try {
        await appState.appUpdate.close();
      } catch {
        /* ignore */
      }
      appState.appUpdate = null;
      if (attempt >= MAX_DOWNLOAD_ATTEMPTS) {
        throw new Error(stalled ? '下载更新超时。请检查网络后重试。' : raw);
      }
      await checkAppUpdate(true);
      if (!appState.appUpdate) {
        throw new Error('未找到可安装的更新包，请点击「重新检查」后再试。');
      }
      appState.appUpdateCheckStatus = 'downloading';
      appState.appUpdateProgress = { downloaded: 0, total: 0 };
      syncAppUpdateButtonUI();
      const panel = document.querySelector('#app-update-popover, #settings-app-update-view');
      if (panel) {
        panel.innerHTML = renderAppUpdatePopoverBody();
        bindAppUpdatePopoverEvents(panel);
      }
    }
  }
}

/** 单次下载：监听进度刷新 UI，长时间无字节增长则调用 close() 中断下载。 */
function downloadOnceWithStallAbort(update: AppUpdate): Promise<void> {
  return new Promise((resolve, reject) => {
    let settled = false;
    let lastProgressAt = Date.now();

    const renderProgress = () => {
      const panel = document.querySelector('#app-update-popover, #settings-app-update-view');
      if (!panel) return;
      const bar = panel.querySelector('.app-update-progress-bar') as HTMLElement | null;
      const pctEl = panel.querySelector('.app-update-progress-pct') as HTMLElement | null;
      const pct = appState.appUpdateProgress && appState.appUpdateProgress.total > 0
        ? Math.min(100, Math.round((appState.appUpdateProgress.downloaded / appState.appUpdateProgress.total) * 100))
        : 0;
      if (bar) bar.style.width = `${pct}%`;
      if (pctEl) pctEl.textContent = `${pct}%`;
    };

    // 停滞看门狗：阈值内无进展 → 中断本次下载，交给外层换镜像重试
    const watchdog = setInterval(() => {
      if (Date.now() - lastProgressAt <= DOWNLOAD_STALL_MS) return;
      clearInterval(watchdog);
      if (settled) return;
      settled = true;
      console.warn('[updater] 下载停滞，正在中断并重试');
      update.close().catch(() => {});
      reject(new Error('下载停滞（镜像不可用）'));
    }, 5000);

    update
      .download(
        (event) => {
          lastProgressAt = Date.now();
          if (event.event === 'Started') {
            appState.appUpdateProgress = { downloaded: 0, total: event.data.contentLength ?? 0 };
          } else if (event.event === 'Progress') {
            appState.appUpdateProgress = {
              downloaded: (appState.appUpdateProgress?.downloaded ?? 0) + event.data.chunkLength,
              total: appState.appUpdateProgress?.total ?? 0,
            };
          }
          renderProgress();
        },
        { timeout: 300_000 },
      )
      .then(
        () => {
          clearInterval(watchdog);
          if (settled) return;
          settled = true;
          resolve();
        },
        (e) => {
          clearInterval(watchdog);
          if (settled) return;
          settled = true;
          reject(e);
        },
      );
  });
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
    // 1. 下载更新包（仅下载，不安装）；带停滞检测，镜像失效时自动换镜像重试
    await downloadAppUpdatePackage();
    clearStallTimer();
    appState.appUpdateProgress = null;

    // 2. 安装前优雅关闭所有常驻 claude 进程。
    // tauri-plugin-updater 无 beforeInstall 钩子：Windows 安装时 process::exit(0) 直接退进程，
    // 若常驻 claude 仍在运行会成为孤儿进程，所以必须在 install 前主动关闭。
    if (isWindows) {
      showCopyToastMsg('下载完成，正在关闭常驻会话…');
    }
    const stopped = await stopAllSessions('update');
    console.debug(`[updater] 安装前已优雅关闭 ${stopped} 个常驻会话`);
    if (isWindows) {
      showCopyToastMsg('常驻会话已关闭，开始安装…（若弹出 UAC 请允许）');
    }

    // 3. 安装
    installResolved = false;
    const installPromise = appState.appUpdate.install();
    // macOS：bundle 可能已替换完成，但 install Promise 偶发不返回；启动看门狗强制重启
    if (navigator.platform.toLowerCase().includes('mac')) {
      stallTimer = setTimeout(() => {
        if (installResolved) return;
        console.warn('[updater] macOS install stall, forcing relaunch');
        void relaunchAfterUpdate();
      }, MAC_UPDATE_INSTALL_STALL_MS);
    }
    await installPromise;
    installResolved = true;
    clearStallTimer();
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
