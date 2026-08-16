import { appState } from '../../state';
import * as api from '../../api';
import { shellApi } from '../../app/shell/api';
import { showToast } from '../../ui';
import type { FetchedModel, KiroModelsStateData, KiroStatusData } from '../../types';
import { formatKiroExpiry, formatKiroUsageText } from '../api-config/balance-helpers';
import { getActiveChatModel, loadChatModelOptions, updateChatModelPicker } from '../chat/model-picker';
import { openDisplayModelsPicker } from '../models/display-models-picker';
import { scheduleMainBalanceBar } from '../status-bar';

let cachedKiroModels: KiroModelsStateData | null = null;
let kiroStatusRequest: Promise<KiroStatusData> | null = null;
let kiroModelsRequest: Promise<void> | null = null;
let kiroUsageRequest: Promise<void> | null = null;
let kiroUsageTimer: number | null = null;
/** 模块级互斥：防止连点启动/停止与 render 重绘后按钮重新可点导致并发 invoke */
let isTogglingKiroProxy = false;

export function isKiroProxyToggling(): boolean {
  return isTogglingKiroProxy;
}

export function setKiroUsageText(text: string) {
  const el = document.querySelector('#kiro-card [data-kiro-usage]') as HTMLElement | null;
  if (el) el.textContent = text;
}

export async function refreshKiroUsage(): Promise<void> {
  if (kiroUsageRequest) return kiroUsageRequest;

  const requestId = appState.kiroUsageGuard.next();
  const refreshBtn = document.querySelector('#kiro-card .kiro-usage-refresh') as HTMLButtonElement | null;
  if (refreshBtn) refreshBtn.disabled = true;
  setKiroUsageText('查询中…');

  kiroUsageRequest = (async () => {
    try {
      const usage = await api.kiroUsage();
      if (!(appState.kiroUsageGuard.isCurrent(requestId)) || !appState.isKiroViewActive) return;
      setKiroUsageText(formatKiroUsageText(usage));
    } catch (e) {
      if (!(appState.kiroUsageGuard.isCurrent(requestId)) || !appState.isKiroViewActive) return;
      setKiroUsageText(`查询失败：${String(e)}`);
    } finally {
      if (appState.kiroUsageGuard.isCurrent(requestId) && refreshBtn) {
        refreshBtn.disabled = false;
      }
    }
  })();

  try {
    await kiroUsageRequest;
  } finally {
    kiroUsageRequest = null;
  }
}

/** 延后到下一宏任务，并合并同一轮页面切换触发的额度刷新 */
export function scheduleKiroUsage(): void {
  if (kiroUsageTimer != null) window.clearTimeout(kiroUsageTimer);
  kiroUsageTimer = window.setTimeout(() => {
    kiroUsageTimer = null;
    if (!appState.isKiroViewActive) return;
    void refreshKiroUsage();
  }, 0);
}

function syncKiroToolbarEntry(
  prevAvailable: boolean,
  nextAvailable: boolean,
  prevRunning: boolean,
  nextRunning: boolean,
) {
  if (prevAvailable === nextAvailable && prevRunning === nextRunning) return;
  // 凭据不可用且正停留在 Kiro 页：局部移除覆盖层，不重建底层聊天 DOM。
  if (!nextAvailable && appState.isKiroViewActive) {
    shellApi.dismissKiroViewState();
    shellApi.syncTitlebarActions();
    return;
  }
  // 仅入口显隐 / 运行绿点变化：局部刷新标题栏，避免 Win 端全页重绘卡死
  shellApi.syncTitlebarActions();
}

function shortenAuthSource(raw: string): { label: string; title: string } {
  const text = raw.trim();
  if (!text) return { label: '—', title: '' };
  // 长路径只展示类型，完整内容放 title
  const pathMatch = text.match(/(\/[^\s)]+kiro-auth-token\.json)/);
  if (text.includes('SSO') || text.includes('共享缓存')) {
    const expiry = text.includes('过期') ? text.split('过期').pop()?.trim() : '';
    return {
      label: expiry ? `SSO 共享缓存 · 过期 ${expiry}` : 'SSO 共享缓存（IDE/CLI 共用）',
      title: pathMatch?.[1] || text,
    };
  }
  if (text.includes('环境变量')) {
    return { label: '环境变量', title: text };
  }
  return {
    label: text.length > 48 ? `${text.slice(0, 48)}…` : text,
    title: text,
  };
}

export function renderKiroModels(modelsState: KiroModelsStateData | null) {
  cachedKiroModels = modelsState;
  const summary = document.querySelector('#kiro-card [data-kiro-model-summary]') as HTMLElement | null;
  const hint = document.querySelector('#kiro-card [data-kiro-models-hint]') as HTMLElement | null;
  if (!summary) return;

  const running = Boolean(modelsState?.running ?? appState.kiroStatus?.running);
  const displayCount = modelsState?.displayModels?.length ?? 0;
  const customCount = modelsState?.customModels?.length ?? 0;
  const defaultModel = (modelsState?.defaultModel || '').trim();

  if (!modelsState || (displayCount === 0 && customCount === 0)) {
    summary.textContent = running ? '点击配置展示与自定义模型' : '启动代理后可同步并配置模型';
    if (hint) {
      hint.textContent = running
        ? '同步后可在聊天输入框快捷选择模型。'
        : '自定义模型可先配置；启动后再同步账户可用模型。';
    }
    return;
  }

  const parts = [`API ${displayCount} 个`];
  if (customCount > 0) parts.push(`自定义 ${customCount} 个`);
  if (defaultModel) parts.push(`当前 ${defaultModel}`);
  summary.textContent = parts.join(' · ');
  if (hint) {
    hint.textContent = running
      ? '同步后可在聊天输入框快捷选择模型。'
      : '模型列表已保存；启动代理后可同步最新可用模型。';
  }
}

export async function refreshKiroModels(): Promise<void> {
  if (kiroModelsRequest) return kiroModelsRequest;

  kiroModelsRequest = (async () => {
    try {
      const modelsState = await api.kiroModelsState();
      if (appState.isKiroViewActive) renderKiroModels(modelsState);
    } catch (e) {
      console.error('获取 Kiro 模型失败:', e);
      if (appState.isKiroViewActive) renderKiroModels(null);
    }
  })();

  try {
    await kiroModelsRequest;
  } finally {
    kiroModelsRequest = null;
  }
}

async function fetchKiroProxyModels(): Promise<FetchedModel[]> {
  const status = appState.kiroStatus;
  if (!status?.running || status.port == null) {
    throw new Error('请先启动 Kiro 代理');
  }
  const baseUrl = `http://127.0.0.1:${status.port}`;
  const fetched = await api.fetchApiModels({
    baseUrl,
    apiKey: null,
    profileId: null,
  });
  return fetched;
}

export function openKiroModelConfigDialog(): void {
  const running = Boolean(appState.kiroStatus?.running);
  const displayModels = cachedKiroModels?.displayModels ?? [];
  const customModels = cachedKiroModels?.customModels ?? [];

  openDisplayModelsPicker({
    title: 'Kiro 模型配置',
    syncLabel: '同步模型',
    syncingLabel: '正在同步…',
    tip: '点击方块选中模型；同步后的列表会保存，聊天输入框可快捷选择',
    displayModels,
    customModels,
    canSync: running,
    onSync: async () => {
      // 先走后端 sync（写 prefs），再拉详情列表供 UI 展示 ownedBy
      const synced = await api.kiroSyncModels();
      renderKiroModels(synced);
      try {
        return await fetchKiroProxyModels();
      } catch {
        return (synced.displayModels || []).map((id) => ({
          id,
          ownedBy: null,
        }));
      }
    },
    onSave: async ({ display, custom }) => {
      try {
        const preferred =
          appState.currentDefaultModel.trim() ||
          getActiveChatModel().trim() ||
          cachedKiroModels?.defaultModel?.trim() ||
          '';
        const saved = await api.kiroSaveModelsConfig({
          displayModels: display,
          customModels: custom,
          defaultModel: preferred || null,
        });
        renderKiroModels(saved);
        await loadChatModelOptions();
        if (preferred && appState.chatModelOptions.includes(preferred) && appState.currentDefaultModel !== preferred) {
          appState.currentDefaultModel = preferred;
          updateChatModelPicker();
        }
        return true;
      } catch (e) {
        console.error('保存 Kiro 模型配置失败:', e);
        showToast('保存模型配置失败: ' + String(e));
        return false;
      }
    },
    onAfterChange: async () => {
      await loadChatModelOptions();
    },
  });
}

/** @deprecated 保留导出，避免外部引用断裂；请用 openKiroModelConfigDialog */
export async function syncKiroModels(): Promise<void> {
  openKiroModelConfigDialog();
}

/** @deprecated 聊天输入框通过 setActiveDefaultModel 设置默认模型 */
export async function applyKiroDefaultModel(model: string): Promise<void> {
  const trimmed = model.trim();
  if (!trimmed) return;
  try {
    const modelsState = await api.kiroSetDefaultModel(trimmed);
    renderKiroModels(modelsState);
    await loadChatModelOptions();
  } catch (e) {
    console.error('设置 Kiro 默认模型失败:', e);
    showToast('设置默认模型失败: ' + String(e));
    await refreshKiroModels();
  }
}

/** 把后端 kiro_status 结果渲染到卡片 DOM（无卡片时仅更新全局状态） */
export function renderKiroCard(status: KiroStatusData | null) {
  const hadStatus = appState.kiroStatus != null;
  const prevAvailable = appState.kiroStatus?.available ?? false;
  const prevRunning = appState.kiroStatus?.running ?? false;
  appState.kiroStatus = status;
  const nextAvailable = status?.available ?? false;
  const nextRunning = status?.running ?? false;
  // 首次写入由启动流程统一 render；后续可用性/运行状态变化时刷新标题栏入口与绿点
  if (hadStatus) {
    syncKiroToolbarEntry(prevAvailable, nextAvailable, prevRunning, nextRunning);
  }

  const card = document.querySelector('#kiro-card');
  if (!card || !status) return;

  const statusEl = card.querySelector('[data-kiro-status]') as HTMLElement | null;
  const statusDescEl = card.querySelector('[data-kiro-status-desc]') as HTMLElement | null;
  const indicatorEl = card.querySelector('[data-kiro-indicator]') as HTMLElement | null;
  const toggleBtn = card.querySelector('.kiro-toggle-btn') as HTMLButtonElement | null;
  const portEl = card.querySelector('[data-kiro-port]') as HTMLElement | null;
  const authEl = card.querySelector('[data-kiro-auth]') as HTMLElement | null;
  const expiresEl = card.querySelector('[data-kiro-expires]') as HTMLElement | null;
  const arnEl = card.querySelector('[data-kiro-arn]') as HTMLElement | null;
  const arnRow = card.querySelector('[data-kiro-arn-row]') as HTMLElement | null;

  if (statusEl) {
    if (status.running) {
      statusEl.textContent = '运行中';
      statusEl.dataset.kiroStatus = 'running';
    } else {
      statusEl.textContent = '已停止';
      statusEl.dataset.kiroStatus = 'stopped';
    }
  }

  if (indicatorEl) {
    indicatorEl.dataset.kiroIndicator = status.running ? 'running' : 'stopped';
  }

  if (statusDescEl) {
    statusDescEl.textContent = status.running
      ? 'Claude Code 已指向本机代理，关闭后会恢复原 API 配置'
      : '启动后自动接入 Claude Code，不占用 API 配置列表';
  }

  if (toggleBtn) {
    toggleBtn.dataset.kiroRunning = status.running ? 'true' : 'false';
    toggleBtn.classList.toggle('settings-btn-primary', !status.running && !isTogglingKiroProxy);
    toggleBtn.classList.toggle('settings-btn-danger', status.running && !isTogglingKiroProxy);
    if (isTogglingKiroProxy) {
      toggleBtn.disabled = true;
      toggleBtn.textContent = '处理中…';
    } else {
      toggleBtn.disabled = false;
      toggleBtn.textContent = status.running ? '停止' : '启动';
    }
  }

  if (portEl) {
    portEl.textContent = status.running && status.port != null ? `http://127.0.0.1:${status.port}` : '未运行';
  }
  if (authEl) {
    const auth = shortenAuthSource(status.authSource || '');
    authEl.textContent = auth.label;
    authEl.title = auth.title;
  }
  if (expiresEl) {
    expiresEl.textContent = formatKiroExpiry(status.expiresAt);
    expiresEl.title = status.expiresAt?.trim() || '';
  }
  if (arnEl && arnRow) {
    const arn = (status.profileArn || '').trim();
    if (arn) {
      arnRow.hidden = false;
      arnEl.textContent = arn;
      arnEl.title = arn;
    } else {
      arnRow.hidden = true;
      arnEl.textContent = '—';
      arnEl.title = '';
    }
  }

}

export async function refreshKiroStatus(): Promise<void> {
  const request = kiroStatusRequest || api.kiroStatus();
  if (!kiroStatusRequest) {
    kiroStatusRequest = request;
    const clearRequest = () => {
      if (kiroStatusRequest === request) kiroStatusRequest = null;
    };
    void request.then(clearRequest, clearRequest);
  }

  try {
    const status = await request;
    // 页面已切换时只保留全局状态，不再触发标题栏/卡片副作用。
    if (appState.isKiroViewActive) {
      renderKiroCard(status);
    } else {
      appState.kiroStatus = status;
    }
    if (status.available && appState.isKiroViewActive) {
      scheduleKiroUsage();
    }
  } catch (e) {
    console.error('获取 Kiro 状态失败:', e);
  }
}

export async function refreshKiroToken(): Promise<void> {
  const btn = document.querySelector('#kiro-card .kiro-token-refresh') as HTMLButtonElement | null;
  if (btn) {
    btn.disabled = true;
    btn.textContent = '刷新中…';
  }
  try {
    const status = await api.kiroRefreshToken();
    renderKiroCard(status);
    // 再拉一次状态，确保 Token 时长与凭据行立即反映最新 expiresAt
    await refreshKiroStatus();
    scheduleKiroUsage();
    scheduleMainBalanceBar();
  } catch (e) {
    console.error('刷新 Kiro 凭据失败:', e);
    showToast('刷新 Kiro 凭据失败: ' + String(e));
    await refreshKiroStatus();
  } finally {
    const current = document.querySelector('#kiro-card .kiro-token-refresh') as HTMLButtonElement | null;
    if (current) {
      current.disabled = false;
      current.textContent = '刷新';
    }
  }
}

export async function toggleKiroProxy(): Promise<void> {
  if (isTogglingKiroProxy) return;
  isTogglingKiroProxy = true;
  const btn = document.querySelector('#kiro-card .kiro-toggle-btn') as HTMLButtonElement | null;
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
    await refreshKiroModels();
    await loadChatModelOptions();
    scheduleMainBalanceBar();
  } catch (e) {
    console.error('切换 Kiro 代理失败:', e);
    showToast('Kiro 代理操作失败: ' + String(e));
    await refreshKiroStatus();
  } finally {
    isTogglingKiroProxy = false;
    const currentBtn = document.querySelector('#kiro-card .kiro-toggle-btn') as HTMLButtonElement | null;
    if (currentBtn) {
      const running = Boolean(appState.kiroStatus?.running);
      currentBtn.disabled = false;
      currentBtn.textContent = running ? '停止' : '启动';
      currentBtn.classList.toggle('settings-btn-primary', !running);
      currentBtn.classList.toggle('settings-btn-danger', running);
    }
  }
}
