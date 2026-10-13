import { appState } from '../../state';
import * as api from '../../api';
import { shellApi } from '../../app/shell/api';
import { showConfirmDialog, showToast } from '../../ui';
import { copyTextToClipboard } from '../../utils/clipboard';
import { KIRO_COPY_KINDS_NEEDING_KEY } from '../../types';
import { openKiroModelCopyPicker } from './model-copy';
import type {
  FetchedModel,
  KiroAccessCopyKind,
  KiroAccessData,
  KiroModelsStateData,
  KiroStatusData,
} from '../../types';
import { formatKiroExpiry, formatKiroUsageText } from '../api-config/balance-helpers';
import { getActiveChatModel, loadChatModelOptions, updateChatModelPicker } from '../chat/model-picker';
import { openDisplayModelsPicker } from '../models/display-models-picker';
import { scheduleMainBalanceBar } from '../status-bar';

let cachedKiroModels: KiroModelsStateData | null = null;
/**
 * 模型 ID → 归属方。仅用于「复制模型名称」弹窗展示与筛选。
 * 后端 `kiro_models_state` 不带该字段，只有 `fetchApiModels` 的详情结果里有，
 * 因此单独缓存，拉取失败时保持为空（弹窗照常可用，只是不显示归属方）。
 */
const fetchedOwnedBy = new Map<string, string | null>();
let cachedKiroAccess: KiroAccessData | null = null;
let kiroStatusRequest: Promise<KiroStatusData> | null = null;
let kiroModelsRequest: Promise<void> | null = null;
let kiroUsageRequest: Promise<void> | null = null;
let kiroAccessRequest: Promise<void> | null = null;
let kiroUsageTimer: number | null = null;
/**
 * 最近一次已知的账户额度文案（null = 从未查到过）。
 *
 * 退出 Kiro 页再进来时 DOM 会随 overlay 重建而回到初始的 `—`。有了这份缓存
 * 就能在重新挂载时**立刻回填旧值**，再异步查新的替换 —— 用户不会再看到额度先消失。
 * 只在拿到「真实额度」后更新；失败文案不写入，避免污染缓存。
 */
let cachedKiroUsageText: string | null = null;
/** 模块级互斥：防止连点启动/停止与 render 重绘后按钮重新可点导致并发 invoke */
let isTogglingKiroProxy = false;

export function setKiroUsageText(text: string) {
  const el = document.querySelector('#kiro-view [data-kiro-usage]') as HTMLElement | null;
  if (el) el.textContent = text;
}

/**
 * 把上次已知的额度回填到刚重建的 DOM（overlay 重建后节点回到初始的 `—`）。
 * 无缓存时不动，交给 `refreshKiroUsage` 的冷启动占位逻辑。
 */
export function restoreKiroUsageCache(): void {
  if (cachedKiroUsageText === null) return;
  const el = document.querySelector('#kiro-view [data-kiro-usage]') as HTMLElement | null;
  if (el) el.textContent = cachedKiroUsageText;
}

/**
 * 丢弃额度缓存（重新挂载时不再回填旧值）。
 *
 * 代理重启后可能换了账号/套餐，旧额度就不再可信 —— 此时应当回到冷启动路径，
 * 老老实实显示「查询中…」。与底栏在 profile 切换时 `clearMainBalanceBarCache`
 * 是同一个道理：**只在「数据归属可能变了」时清，而不是每次离开页面都清**。
 */
export function clearKiroUsageCache(): void {
  cachedKiroUsageText = null;
}

/**
 * 账户额度：**先展示旧值，异步查到新值再替换**（stale-while-revalidate）。
 *
 * 进入 Kiro 页时 `refreshKiroStatus` 会自动触发一次额度查询。查询要走 Kiro 管理面
 * 网络，耗时不确定；如果此时把已知额度抹成「查询中…」，用户每次进页面都会看到
 * 额度先消失再出现 —— 而额度是低频变化的数据，旧值几乎总是可用的。
 *
 * 因此这里只在**从没有过任何值时**（冷启动）才显示「查询中…」占位；
 * 已有缓存则原样保留，静默等新值到达后原地替换。刷新按钮同样在有旧值时不禁用，
 * 避免「点一下刷新，额度先闪没了」。
 *
 * 失败时也遵循同一原则：有旧值就保留旧值，不把可用数据换成错误文案
 * （与底栏 `refreshMainBalanceBar` 的失败处理一致）。
 */
export async function refreshKiroUsage(): Promise<void> {
  if (kiroUsageRequest) return kiroUsageRequest;

  const requestId = appState.kiroUsageGuard.next();
  const hasCachedValue = cachedKiroUsageText !== null;
  const refreshBtn = document.querySelector('#kiro-view .kiro-usage-refresh') as HTMLButtonElement | null;
  if (refreshBtn && !hasCachedValue) refreshBtn.disabled = true;
  // 只有冷启动（没有任何已知额度）才需要占位提示；有旧值就让旧值留在屏幕上
  if (!hasCachedValue) setKiroUsageText('查询中…');

  kiroUsageRequest = (async () => {
    try {
      const usage = await api.kiroUsage();
      if (!(appState.kiroUsageGuard.isCurrent(requestId)) || !appState.isKiroViewActive) return;
      const text = formatKiroUsageText(usage);
      // 只有真实额度才写缓存 —— 占位/错误文案绝不能进缓存，否则会被当成已知旧值
      cachedKiroUsageText = text;
      setKiroUsageText(text);
    } catch (e) {
      if (!(appState.kiroUsageGuard.isCurrent(requestId)) || !appState.isKiroViewActive) return;
      // 有旧值时保留旧值 —— 偶发失败不该把用户已知的额度抹成错误提示
      if (!hasCachedValue) setKiroUsageText(`查询失败：${String(e)}`);
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
  const summary = document.querySelector('#kiro-view [data-kiro-model-summary]') as HTMLElement | null;
  const hint = document.querySelector('#kiro-view [data-kiro-models-hint]') as HTMLElement | null;
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

/** 复制按钮对应的文案（用于 toast 说明复制了什么） */
const KIRO_COPY_TITLES: Record<KiroAccessCopyKind, string> = {
  base_url: '接口地址',
  openai_base_url: 'OpenAI 地址',
  api_key: '代理密钥',
  model: '模型名称',
  env: '环境变量配置',
  json: 'settings.json 片段',
  openai_env: 'OpenAI 环境变量',
  openai_json: 'OpenAI 配置',
};

/** 只有运行中才有可复制内容；密钥缺失时禁用依赖密钥的复制项 */
function isKiroCopyEnabled(access: KiroAccessData | null, kind: string): boolean {
  if (!access?.running) return false;
  const needsKey = (KIRO_COPY_KINDS_NEEDING_KEY as readonly string[]).includes(kind);
  if (needsKey) {
    return access.hasApiKey;
  }
  return true;
}

/** 模型选择按钮：运行中且模型列表非空才可点（没有候选项就没有可选内容） */
function hasSelectableKiroModels(access: KiroAccessData | null): boolean {
  return Boolean(access?.running) && (cachedKiroModels?.models.length ?? 0) > 0;
}

function syncKiroCopyButtons(access: KiroAccessData | null) {
  const card = document.querySelector('#kiro-view');
  if (!card) return;
  card.querySelectorAll<HTMLButtonElement>('[data-kiro-copy]').forEach((btn) => {
    btn.disabled = !isKiroCopyEnabled(access, btn.dataset.kiroCopy || '');
  });
  const pickerBtn = card.querySelector<HTMLButtonElement>('[data-kiro-model-picker]');
  if (pickerBtn) {
    pickerBtn.disabled = !hasSelectableKiroModels(access);
  }
}

/** 把后端 kiro_proxy_access 结果渲染到「外部接入」区块 */
export function renderKiroAccess(access: KiroAccessData | null) {
  cachedKiroAccess = access;
  const card = document.querySelector('#kiro-view');
  if (!card) return;

  const running = Boolean(access?.running);
  const baseEl = card.querySelector('[data-kiro-access-base]') as HTMLElement | null;
  const openaiEl = card.querySelector('[data-kiro-access-openai]') as HTMLElement | null;
  const keyEl = card.querySelector('[data-kiro-access-key]') as HTMLElement | null;
  const modelEl = card.querySelector('[data-kiro-access-model]') as HTMLElement | null;
  const descEl = card.querySelector('[data-kiro-access-desc]') as HTMLElement | null;

  if (baseEl) {
    baseEl.textContent = running && access?.baseUrl ? access.baseUrl : '未运行';
    baseEl.title = running && access?.baseUrl ? access.baseUrl : '';
  }
  if (openaiEl) {
    openaiEl.textContent =
      running && access?.openaiBaseUrl ? access.openaiBaseUrl : '未运行';
    openaiEl.title = running && access?.openaiBaseUrl ? access.openaiBaseUrl : '';
  }
  if (keyEl) {
    keyEl.textContent = access?.apiKeyMasked || (running ? '获取中…' : '启动代理后生成');
  }
  if (modelEl) {
    const model = (access?.model || '').trim();
    modelEl.textContent = model || '—';
    modelEl.title = model;
  }
  if (descEl) {
    descEl.textContent = running
      ? '复制下面字段到其它 Agent，即可复用本机 Kiro 额度（Anthropic 与 OpenAI 协议共用同一密钥）'
      : '启动代理后即可复制到其它 Agent 复用本机额度';
  }

  syncKiroCopyButtons(access);
}

export async function refreshKiroAccess(): Promise<void> {
  if (kiroAccessRequest) return kiroAccessRequest;

  kiroAccessRequest = (async () => {
    try {
      const access = await api.kiroProxyAccess();
      if (appState.isKiroViewActive) renderKiroAccess(access);
    } catch (e) {
      console.error('获取 Kiro 接入信息失败:', e);
      if (appState.isKiroViewActive) renderKiroAccess(null);
    }
  })();

  try {
    await kiroAccessRequest;
  } finally {
    kiroAccessRequest = null;
  }
}

/** 复制接入信息：明文密钥由后端直接写入系统剪贴板，不经过渲染层 */
export async function copyKiroAccess(kind: KiroAccessCopyKind): Promise<void> {
  const title = KIRO_COPY_TITLES[kind] || '接入信息';
  if (!isKiroCopyEnabled(cachedKiroAccess, kind)) {
    showToast(`${title}暂不可复制，请先启动 Kiro 代理`);
    return;
  }
  try {
    const ok = await api.kiroCopyAccess(kind);
    if (ok) {
      showToast(`已复制${title}`, 'success');
    } else {
      showToast('没有可复制的内容');
    }
  } catch (e) {
    console.error('复制 Kiro 接入信息失败:', e);
    showToast('复制失败: ' + String(e));
  }
}

/** 重置代理密钥：旧密钥立即失效，需重新复制到其它 Agent */
export async function resetKiroProxyKey(): Promise<void> {
  if (cachedKiroAccess?.running) {
    showToast('请先停止 Kiro 代理，再重置密钥');
    return;
  }
  const confirmed = await showConfirmDialog({
    title: '重置代理密钥',
    message: '确定要重置 Kiro 代理密钥吗？',
    sub: '重置后已复制到其它 Agent 的旧密钥立即失效，需要重新复制；代理运行中无法重置。',
    confirmLabel: '重置',
  });
  if (!confirmed) return;
  try {
    const access = await api.kiroResetProxyKey();
    renderKiroAccess(access);
    showToast('已重置代理密钥', 'success');
  } catch (e) {
    console.error('重置 Kiro 代理密钥失败:', e);
    showToast('重置密钥失败: ' + String(e));
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
  // 记录归属方供复制弹窗展示/筛选；详情拉取不改变可用模型集合本身
  fetchedOwnedBy.clear();
  for (const model of fetched) {
    fetchedOwnedBy.set(model.id, model.ownedBy ?? null);
  }
  return fetched;
}

/**
 * 打开模型名复制弹窗：搜索过滤 + 单击卡片复制。
 *
 * 候选项取「展示 + 自定义」合并列表；若还没同步过，退回到已同步到本地的详情列表，
 * 避免用户第一次打开时看到空弹窗。
 */
export function openKiroModelCopyDialog(): void {
  if (!cachedKiroAccess?.running) {
    showToast('请先启动 Kiro 代理');
    return;
  }

  const models = cachedKiroModels?.models ?? [];
  if (models.length === 0) {
    showToast('暂无可复制的模型，请先点击「同步模型」');
    return;
  }

  openKiroModelCopyPicker({
    items: models.map((id) => ({ id, ownedBy: fetchedOwnedBy.get(id) ?? null })),
    onCopy: async (modelId) => {
      const ok = await copyTextToClipboard(modelId);
      if (ok) showToast(`已复制模型名称：${modelId}`, 'success');
      return ok;
    },
  });
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

  const card = document.querySelector('#kiro-view');
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
  const btn = document.querySelector('#kiro-view .kiro-token-refresh') as HTMLButtonElement | null;
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
    const current = document.querySelector('#kiro-view .kiro-token-refresh') as HTMLButtonElement | null;
    if (current) {
      current.disabled = false;
      current.textContent = '刷新';
    }
  }
}

export async function toggleKiroProxy(): Promise<void> {
  if (isTogglingKiroProxy) return;
  isTogglingKiroProxy = true;
  const btn = document.querySelector('#kiro-view .kiro-toggle-btn') as HTMLButtonElement | null;
  if (btn) {
    btn.disabled = true;
    btn.textContent = '处理中…';
  }
  try {
    if (appState.kiroStatus?.running) {
      await api.kiroStop();
    } else {
      // 启动前丢弃旧额度：重启后可能换了账号/套餐，旧值不再可信，
      // 让本次刷新走冷启动占位而不是回填上一轮的额度。
      clearKiroUsageCache();
      await api.kiroStart(null);
    }
    await refreshKiroStatus();
    await refreshKiroModels();
    await refreshKiroAccess();
    await loadChatModelOptions();
    scheduleMainBalanceBar();
  } catch (e) {
    console.error('切换 Kiro 代理失败:', e);
    showToast('Kiro 代理操作失败: ' + String(e));
    await refreshKiroStatus();
  } finally {
    isTogglingKiroProxy = false;
    const currentBtn = document.querySelector('#kiro-view .kiro-toggle-btn') as HTMLButtonElement | null;
    if (currentBtn) {
      const running = Boolean(appState.kiroStatus?.running);
      currentBtn.disabled = false;
      currentBtn.textContent = running ? '停止' : '启动';
      currentBtn.classList.toggle('settings-btn-primary', !running);
      currentBtn.classList.toggle('settings-btn-danger', running);
    }
  }
}
