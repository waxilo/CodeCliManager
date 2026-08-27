import { appState } from '../../state';
import { shellApi } from '../../app/shell/api';
import * as api from '../../api';
import { isDeepSeekBaseUrl, isKiroRuntimeActive, formatDeepSeekBalanceText, formatKiroUsageText } from '../api-config/balance-helpers';
import { refreshGitBranch } from './git-branch';
import { getActiveConversation } from '../conversations/normalize';
export function getMainBalanceBarEl(): HTMLElement | null {
  return document.querySelector('#balance-status-bar');
}

export function syncStatusBarSections(): void {
  const bar = getMainBalanceBarEl();
  if (!bar) return;
  const dirWrap = bar.querySelector('.status-bar-dir') as HTMLElement | null;
  const gitWrap = bar.querySelector('.status-bar-git') as HTMLElement | null;
  const balanceWrap = bar.querySelector('.status-bar-balance') as HTMLElement | null;
  const d1 = bar.querySelector('[data-status-divider="1"]') as HTMLElement | null;
  const d2 = bar.querySelector('[data-status-divider="2"]') as HTMLElement | null;
  const showDir = Boolean(appState.activeProjectDirCache);
  const showGit = Boolean(appState.gitBranchCache);
  const showBalance = Boolean(appState.mainBalanceCache);
  if (dirWrap) dirWrap.hidden = !showDir;
  if (gitWrap) gitWrap.hidden = !showGit;
  if (balanceWrap) balanceWrap.hidden = !showBalance;
  // 分隔线只出现在「可见的相邻 section」之间
  if (d1) d1.hidden = !(showDir && showGit);
  if (d2) d2.hidden = !((showDir || showGit) && showBalance);
}

/**
 * 底栏工作目录：取当前激活会话的 project_dir；pending（新会话未创建）阶段
 * 显示待选目录。在 refreshChatContent 每次渲染后同步（切会话/新会话/发送都会触发）。
 */
export function syncActiveProjectDir(): void {
  let dir = '';
  if (appState.activeConversationId) {
    dir = getActiveConversation()?.project_dir || '';
  }
  if (!dir && appState.pendingProjectDir) {
    dir = appState.pendingProjectDir;
  }
  if (dir === appState.activeProjectDirCache) return;
  appState.activeProjectDirCache = dir || null;
  const bar = getMainBalanceBarEl();
  if (!bar) return;
  const dirEl = bar.querySelector('[data-project-dir]') as HTMLElement | null;
  if (dirEl) {
    dirEl.textContent = dir;
    dirEl.title = dir;
  }
  syncStatusBarSections();
}

export function setMainBalanceBarContent(profileId: string, label: string, value: string): void {
  appState.mainBalanceCache = { profileId, label, value };
  const bar = getMainBalanceBarEl();
  if (!bar) return;
  const labelEl = bar.querySelector('[data-balance-label]') as HTMLElement | null;
  const valueEl = bar.querySelector('[data-balance-value]') as HTMLElement | null;
  if (labelEl) labelEl.textContent = label;
  if (valueEl) {
    valueEl.textContent = value;
    valueEl.title = value;
  }
  syncStatusBarSections();
}

export function clearMainBalanceBarCache(): void {
  appState.mainBalanceCache = null;
  syncStatusBarSections();
}

export async function refreshMainBalanceBar(): Promise<void> {
  const bar = getMainBalanceBarEl();
  if (!bar) return;

  const requestId = appState.mainBalanceGuard.next();
  try {
    const state = await api.getApiProfilesState();
    if (!(appState.mainBalanceGuard.isCurrent(requestId))) return;

    const activeProfile = state.profiles.find((p) => p.id === state.activeProfileId);
    const baseUrl = (activeProfile?.baseUrl || state.current?.baseUrl || '').trim();
    const profileId = activeProfile?.id ?? '';
    // 标题栏 DSH 入口条件缓存（kiro 运行时由渲染侧再叠加判断）；
    // 值变化时刷新标题栏按钮显隐（配置切换后即时生效）
    const prevDeepSeek = appState.activeProfileIsDeepSeek;
    appState.activeProfileIsDeepSeek = isDeepSeekBaseUrl(baseUrl);
    appState.activeProfileBaseUrl = baseUrl;
    appState.activeProfileId = profileId;
    if (prevDeepSeek !== appState.activeProfileIsDeepSeek) {
      shellApi.syncTitlebarActions();
    }
    const profileName = activeProfile?.name || '官方默认';
    const kiroRunning = Boolean(appState.kiroStatus?.running);
    const kiroPort = appState.kiroStatus?.port ?? null;

    // 配置已切换时，不要继续展示上一套配置的余额
    const balanceKey = kiroRunning ? '__kiro__' : profileId;
    if (appState.mainBalanceCache && appState.mainBalanceCache.profileId !== balanceKey) {
      clearMainBalanceBarCache();
    }

    if (isKiroRuntimeActive(baseUrl, kiroRunning, kiroPort)) {
      try {
        const usage = await api.kiroUsage();
        if (!(appState.mainBalanceGuard.isCurrent(requestId))) return;
        setMainBalanceBarContent(balanceKey, 'Kiro · 额度', formatKiroUsageText(usage));
      } catch (e) {
        if (!(appState.mainBalanceGuard.isCurrent(requestId))) return;
        if (!appState.mainBalanceCache || appState.mainBalanceCache.profileId !== balanceKey) {
          setMainBalanceBarContent(balanceKey, 'Kiro · 额度', `查询失败：${String(e)}`);
        }
      }
      return;
    }

    if (isDeepSeekBaseUrl(baseUrl) && activeProfile) {
      try {
        const balance = await api.fetchDeepseekBalance({
          baseUrl,
          apiKey: null,
          profileId: activeProfile.id,
        });
        if (!(appState.mainBalanceGuard.isCurrent(requestId))) return;
        setMainBalanceBarContent(profileId, `${profileName} · 余额`, formatDeepSeekBalanceText(balance));
      } catch (e) {
        if (!(appState.mainBalanceGuard.isCurrent(requestId))) return;
        if (!appState.mainBalanceCache || appState.mainBalanceCache.profileId !== profileId) {
          setMainBalanceBarContent(profileId, `${profileName} · 余额`, `查询失败：${String(e)}`);
        }
      }
      return;
    }

    clearMainBalanceBarCache();
  } catch {
    if (!(appState.mainBalanceGuard.isCurrent(requestId))) return;
    // 保留缓存，避免偶发失败把底栏刷没
  }
}

/** 已排队的余额条刷新定时器：合并同帧内多次进入主页面触发的刷新，避免退出管理页连点排 N 个 setTimeout + 2N 发 IPC */
let pendingBalanceRefresh: number | null = null;

export function scheduleMainBalanceBar(): void {
  if (pendingBalanceRefresh !== null) return;
  pendingBalanceRefresh = window.setTimeout(() => {
    pendingBalanceRefresh = null;
    if (appState.isApiConfigViewActive || appState.isSettingsViewActive || appState.isMcpViewActive || appState.isKiroViewActive) return;
    void refreshGitBranch();
    void refreshMainBalanceBar();
  }, 0);
}

/** 进入主聊天页时刷新余额条（无定时轮询） */
export function startMainBalanceBarAutoRefresh(): void {
  scheduleMainBalanceBar();
}

