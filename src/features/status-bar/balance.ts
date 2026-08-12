import { appState } from '../../state';
import * as api from '../../api';
import { isDeepSeekBaseUrl, isKiroProfile, formatDeepSeekBalanceText, formatKiroUsageText } from '../api-config/balance-helpers';
import { refreshGitBranch } from './git-branch';
export function getMainBalanceBarEl(): HTMLElement | null {
  return document.querySelector('#balance-status-bar');
}

export function syncStatusBarSections(): void {
  const bar = getMainBalanceBarEl();
  if (!bar) return;
  const gitWrap = bar.querySelector('.status-bar-git') as HTMLElement | null;
  const balanceWrap = bar.querySelector('.status-bar-balance') as HTMLElement | null;
  const divider = bar.querySelector('[data-status-divider]') as HTMLElement | null;
  if (gitWrap) gitWrap.hidden = !appState.gitBranchCache;
  if (balanceWrap) balanceWrap.hidden = !appState.mainBalanceCache;
  if (divider) divider.hidden = !(appState.gitBranchCache && appState.mainBalanceCache);
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
    const profileName = activeProfile?.name || '官方默认';
    const profileId = activeProfile?.id ?? '';

    // 配置已切换时，不要继续展示上一套配置的余额
    if (appState.mainBalanceCache && appState.mainBalanceCache.profileId !== profileId) {
      clearMainBalanceBarCache();
    }

    if (isKiroProfile(activeProfile)) {
      try {
        const usage = await api.kiroUsage();
        if (!(appState.mainBalanceGuard.isCurrent(requestId))) return;
        setMainBalanceBarContent(profileId, `${profileName} · 额度`, formatKiroUsageText(usage));
      } catch (e) {
        if (!(appState.mainBalanceGuard.isCurrent(requestId))) return;
        // 已有上次内容时保留；仅首次失败才写错误
        if (!appState.mainBalanceCache || appState.mainBalanceCache.profileId !== profileId) {
          setMainBalanceBarContent(profileId, `${profileName} · 额度`, `查询失败：${String(e)}`);
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

export function scheduleMainBalanceBar(): void {
  window.setTimeout(() => {
    if (appState.isApiConfigViewActive || appState.isSettingsViewActive || appState.isMcpViewActive) return;
    void refreshGitBranch();
    void refreshMainBalanceBar();
  }, 0);
}

/** 进入主聊天页时刷新余额条（无定时轮询） */
export function startMainBalanceBarAutoRefresh(): void {
  scheduleMainBalanceBar();
}

