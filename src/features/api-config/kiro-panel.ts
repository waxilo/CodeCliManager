import { appState } from '../../state';
import * as api from '../../api';
import type { KiroStatusData } from '../../types';
import { formatKiroExpiry, formatKiroUsageText, formatDeepSeekBalanceText, isDeepSeekBaseUrl } from './balance-helpers';
import { loadChatModelOptions } from '../chat/model-picker';
import { refreshSettingsModal } from './profile-form';
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

export function setKiroUsageText(text: string) {
  const el = document.querySelector('#kiro-card [data-kiro-usage]') as HTMLElement | null;
  if (el) el.textContent = text;
}

export async function refreshKiroUsage(): Promise<void> {
  const requestId = appState.kiroUsageGuard.next();
  const refreshBtn = document.querySelector('#kiro-card .kiro-usage-refresh') as HTMLButtonElement | null;
  if (refreshBtn) refreshBtn.disabled = true;
  setKiroUsageText('查询中…');
  try {
    const usage = await api.kiroUsage();
    if (!(appState.kiroUsageGuard.isCurrent(requestId))) return;
    setKiroUsageText(formatKiroUsageText(usage));
  } catch (e) {
    if (!(appState.kiroUsageGuard.isCurrent(requestId))) return;
    setKiroUsageText(`查询失败：${String(e)}`);
  } finally {
    if (appState.kiroUsageGuard.isCurrent(requestId) && refreshBtn) {
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

export function scheduleKiroUsage(): void {
  window.setTimeout(() => {
    if (!appState.isApiConfigViewActive) return;
    void refreshKiroUsage();
  }, 0);
}

/** 把后端 kiro_status 结果渲染到卡片 DOM（无卡片时仅更新全局状态） */
export function renderKiroCard(status: KiroStatusData | null) {
  appState.kiroStatus = status;
  const card = document.querySelector('#kiro-card');
  if (!card || !status) return;

  const statusEl = card.querySelector('[data-kiro-status]') as HTMLElement | null;
  const toggleBtn = card.querySelector('.kiro-toggle-btn') as HTMLButtonElement | null;
  const portEl = card.querySelector('[data-kiro-port]') as HTMLElement | null;
  const authEl = card.querySelector('[data-kiro-auth]') as HTMLElement | null;
  const expiresEl = card.querySelector('[data-kiro-expires]') as HTMLElement | null;
  const arnEl = card.querySelector('[data-kiro-arn]') as HTMLElement | null;

  if (statusEl) {
    if (status.running) {
      statusEl.textContent = '运行中';
      statusEl.dataset.kiroStatus = 'running';
    } else {
      statusEl.textContent = '已停止';
      statusEl.dataset.kiroStatus = 'stopped';
    }
  }

  if (toggleBtn) {
    toggleBtn.dataset.kiroRunning = status.running ? 'true' : 'false';
    toggleBtn.textContent = status.running ? '停止' : '启动';
    toggleBtn.disabled = false;
  }

  if (portEl) {
    portEl.textContent = status.running && status.port != null ? `http://127.0.0.1:${status.port}` : '未运行';
  }
  if (authEl) {
    authEl.textContent = status.authSource || '—';
  }
  if (expiresEl) {
    expiresEl.textContent = formatKiroExpiry(status.expiresAt);
  }
  if (arnEl) {
    arnEl.textContent = status.profileArn || '—';
    arnEl.title = status.profileArn || '';
  }
}

export async function refreshKiroStatus(): Promise<void> {
  try {
    const status = await api.kiroStatus();
    renderKiroCard(status);
    scheduleKiroUsage();
  } catch (e) {
    console.error('获取 Kiro 状态失败:', e);
  }
}

export async function toggleKiroProxy(overlay: HTMLElement): Promise<void> {
  const btn = overlay.querySelector('.kiro-toggle-btn') as HTMLButtonElement | null;
  if (btn) {
    btn.disabled = true;
    btn.textContent = '处理中…';
  }
  try {
    if (appState.kiroStatus?.running) {
      await api.kiroStop();
    } else {
      await api.kiroStart(null);
    }
    await refreshKiroStatus();
    // 启动成功后代理已写入 Kiro profile 并激活，把表单与左侧列表切到 Kiro 配置
    if (appState.kiroStatus?.running) {
      const state = await api.getApiProfilesState();
      const kiroId = state.profiles.find((p) => p.name === 'Kiro')?.id || state.activeProfileId || null;
      const refreshed = await refreshSettingsModal(overlay, kiroId);
      const pathEl = overlay.querySelector('.settings-live-path') as HTMLElement | null;
      if (pathEl) {
        pathEl.textContent = `配置文件：${refreshed.state.current.configPath}`;
      }
      await loadChatModelOptions();
    }
  } catch (e) {
    console.error('切换 Kiro 代理失败:', e);
    alert('Kiro 代理操作失败: ' + String(e));
    await refreshKiroStatus();
  } finally {
    const currentBtn = overlay.querySelector('.kiro-toggle-btn') as HTMLButtonElement | null;
    if (currentBtn) {
      currentBtn.disabled = false;
    }
  }
}

