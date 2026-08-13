import { appState } from '../../state';
import * as api from '../../api';
import { formatDeepSeekBalanceText, isDeepSeekBaseUrl } from './balance-helpers';

export function setProviderBalanceVisible(overlay: HTMLElement, visible: boolean) {
  const wrap = overlay.querySelector('[data-provider-balance-wrap]') as HTMLElement | null;
  if (wrap) wrap.hidden = !visible;
}

export function setProviderBalanceText(overlay: HTMLElement, text: string) {
  const el = overlay.querySelector('[data-provider-balance]') as HTMLElement | null;
  if (el) el.textContent = text;
}

export async function refreshDeepSeekBalance(overlay: HTMLElement): Promise<void> {
  const requestId = appState.deepSeekBalanceGuard.next();
  const baseUrl =
    (overlay.querySelector('input[name="baseUrl"]') as HTMLInputElement | null)?.value.trim() || '';
  if (!isDeepSeekBaseUrl(baseUrl)) {
    if (appState.deepSeekBalanceGuard.isCurrent(requestId)) {
      setProviderBalanceVisible(overlay, false);
    }
    return;
  }
  setProviderBalanceVisible(overlay, true);
  setProviderBalanceText(overlay, '查询中…');
  const refreshBtn = overlay.querySelector('.provider-balance-refresh') as HTMLButtonElement | null;
  if (refreshBtn) refreshBtn.disabled = true;
  try {
    const apiKeyRaw =
      (overlay.querySelector('input[name="apiKey"]') as HTMLInputElement | null)?.value.trim() || '';
    const profileId = overlay.dataset.profileId || null;
    const balance = await api.fetchDeepseekBalance({
      baseUrl,
      apiKey: apiKeyRaw || null,
      profileId,
    });
    if (!(appState.deepSeekBalanceGuard.isCurrent(requestId)) || !appState.isApiConfigViewActive) return;
    setProviderBalanceText(overlay, formatDeepSeekBalanceText(balance));
  } catch (e) {
    if (!(appState.deepSeekBalanceGuard.isCurrent(requestId)) || !appState.isApiConfigViewActive) return;
    setProviderBalanceText(overlay, `查询失败：${String(e)}`);
  } finally {
    if (appState.deepSeekBalanceGuard.isCurrent(requestId) && refreshBtn) {
      refreshBtn.disabled = false;
    }
  }
}

/** 延后到下一宏任务，避免挡住 API 配置页首次渲染 */
export function scheduleDeepSeekBalance(overlay: HTMLElement): void {
  window.setTimeout(() => {
    if (!appState.isApiConfigViewActive) return;
    void refreshDeepSeekBalance(overlay);
  }, 0);
}
