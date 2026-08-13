import * as api from '../../api';
import type { ClaudeCodeApiConfig } from '../../types';
import { renderSettingsProfileList } from './profile-list';
import { setProviderBalanceVisible } from './provider-balance';
import { OFFICIAL_PROFILE_ID } from './profile-list';
import { getSettingsProfileListEl } from '../settings/view';

const refreshGenerationByOverlay = new WeakMap<HTMLElement, number>();

export function setSettingsFormEditable(overlay: HTMLElement, editable: boolean) {
  for (const name of ['profileName', 'baseUrl', 'apiKey']) {
    const el = overlay.querySelector(`input[name="${name}"]`) as HTMLInputElement | null;
    if (el) el.disabled = !editable;
  }
  const modelInput = overlay.querySelector('.settings-model-config-summary') as HTMLInputElement | null;
  if (modelInput) modelInput.classList.toggle('is-disabled', !editable);
  const saveBtn = overlay.querySelector('.save-only') as HTMLButtonElement | null;
  if (saveBtn) {
    saveBtn.disabled = !editable;
    saveBtn.title = editable ? '' : '官方默认无需保存';
  }
}

/** 在右侧以只读方式展示「官方默认」详情 */
export function fillOfficialView(overlay: HTMLElement) {
  overlay.dataset.profileId = OFFICIAL_PROFILE_ID;
  (overlay.querySelector('input[name="profileName"]') as HTMLInputElement).value = '官方默认（Claude 订阅）';
  const baseInput = overlay.querySelector('input[name="baseUrl"]') as HTMLInputElement;
  baseInput.value = '';
  baseInput.placeholder = '官方登录，无需 Base URL';
  const keyInput = overlay.querySelector('input[name="apiKey"]') as HTMLInputElement;
  keyInput.value = '';
  keyInput.placeholder = '官方登录，无需 API Key';
  resetApiKeyBox(overlay);
  const modelInput = overlay.querySelector('.settings-model-config-summary') as HTMLInputElement | null;
  if (modelInput) modelInput.value = '由订阅 / 官方登录决定';
  setSettingsFormEditable(overlay, false);
  setProviderBalanceVisible(overlay, false);
}

/** 将完整 API Key 转换为首尾可见的脱敏字符串，例如 `sk-a••••••••••wxyz`。 */
export function maskApiKey(key: string): string {
  const trimmed = (key || '').trim();
  if (!trimmed) return '';
  if (trimmed.length <= 8) return '•'.repeat(trimmed.length);
  const head = trimmed.slice(0, 4);
  const tail = trimmed.slice(-4);
  const dots = Math.max(6, Math.min(12, trimmed.length - 8));
  return `${head}${'•'.repeat(dots)}${tail}`;
}

/** API Key 输入框三种模式：
 *  - empty：未保存密钥，纯输入框
 *  - view ：已保存密钥，显示脱敏 + [编辑][复制]
 *  - edit ：编辑中，显示输入框 + [取消]
 */
export type ApiKeyBoxMode = 'empty' | 'view' | 'edit';

export function setApiKeyBoxMode(overlay: HTMLElement, mode: ApiKeyBoxMode) {
  const box = overlay.querySelector('.settings-apikey-box') as HTMLElement | null;
  if (!box) return;
  box.dataset.mode = mode;
  const input = box.querySelector('input[name="apiKey"]') as HTMLInputElement | null;
  const display = box.querySelector('.settings-apikey-display') as HTMLElement | null;
  const editBtn = box.querySelector('[data-action="edit"]') as HTMLButtonElement | null;
  const copyBtn = box.querySelector('[data-action="copy"]') as HTMLButtonElement | null;
  const cancelBtn = box.querySelector('[data-action="cancel"]') as HTMLButtonElement | null;

  if (display) display.hidden = mode !== 'view';
  if (input) input.hidden = mode === 'view';
  if (editBtn) editBtn.hidden = mode !== 'view';
  if (copyBtn) copyBtn.hidden = mode !== 'view';
  if (cancelBtn) cancelBtn.hidden = mode !== 'edit';
}

/** 重置 API Key 输入框（清空输入与脱敏缓存），常用于切换 profile 时。 */
export function resetApiKeyBox(overlay: HTMLElement) {
  const box = overlay.querySelector('.settings-apikey-box') as HTMLElement | null;
  if (!box) return;
  const valueEl = box.querySelector('.settings-apikey-display-value') as HTMLElement | null;
  if (valueEl) {
    valueEl.textContent = '';
    delete valueEl.dataset.masked;
    delete valueEl.dataset.hasKey;
  }
  const input = box.querySelector('input[name="apiKey"]') as HTMLInputElement | null;
  if (input) input.value = '';
  setApiKeyBoxMode(overlay, 'empty');
}

/** 根据 profile 拉取脱敏密钥并展示首尾。明文密钥不进入前端，仅在用户点击复制时由后端写入剪贴板。 */
export async function loadApiKeyPreview(overlay: HTMLElement, profileId: string | null) {
  resetApiKeyBox(overlay);
  if (!profileId || profileId === OFFICIAL_PROFILE_ID) return;
  try {
    const masked = await api.getApiProfileKeyMasked(profileId);
    if (!masked) return;
    // 异步加载期间用户可能已经切换到别的 profile，丢弃陈旧结果。
    if (overlay.dataset.profileId !== profileId) return;
    const valueEl = overlay.querySelector('.settings-apikey-display-value') as HTMLElement | null;
    if (!valueEl) return;
    valueEl.dataset.masked = masked;
    valueEl.dataset.hasKey = '1';
    valueEl.textContent = masked;
    setApiKeyBoxMode(overlay, 'view');
  } catch {
    /* keep empty mode */
  }
}

export function fillSettingsForm(
  overlay: HTMLElement,
  config: ClaudeCodeApiConfig,
  profileName = '',
  profileId: string | null = null,
) {
  setSettingsFormEditable(overlay, true);
  overlay.dataset.profileId = profileId || '';
  (overlay.querySelector('input[name="profileName"]') as HTMLInputElement).value = profileName;
  const baseInput = overlay.querySelector('input[name="baseUrl"]') as HTMLInputElement;
  baseInput.value = config.baseUrl || '';
  baseInput.placeholder = 'https://api.anthropic.com';

  const apiKeyInput = overlay.querySelector('input[name="apiKey"]') as HTMLInputElement;
  apiKeyInput.value = '';
  apiKeyInput.placeholder = config.hasApiKey ? '已配置，留空则不修改' : 'sk-...';

  if (profileId && config.hasApiKey) {
    void loadApiKeyPreview(overlay, profileId);
  } else {
    resetApiKeyBox(overlay);
  }
}

export async function refreshSettingsModal(
  overlay: HTMLElement,
  selectedProfileId: string | null,
  onConfigLoaded?: (config: ClaudeCodeApiConfig) => void,
) {
  const generation = (refreshGenerationByOverlay.get(overlay) || 0) + 1;
  refreshGenerationByOverlay.set(overlay, generation);
  const isLatest = () => refreshGenerationByOverlay.get(overlay) === generation && overlay.isConnected;
  const state = await api.getApiProfilesState();

  // 官方默认处于使用中（无指定 profile 且无激活 profile）：展示只读官方视图，
  // 不要回退到第一个 API 配置，否则会把别的配置的模型/详情显示成「官方默认」
  const officialActive = !selectedProfileId && !state.activeProfileId;
  if (officialActive) {
    if (isLatest()) {
      const listEl = getSettingsProfileListEl();
      if (listEl) {
        listEl.innerHTML = renderSettingsProfileList(state.profiles, OFFICIAL_PROFILE_ID);
      }
      fillOfficialView(overlay);
      onConfigLoaded?.(state.current);
    }
    return { state, selectedProfileId: OFFICIAL_PROFILE_ID };
  }

  const resolvedSelectedId =
    selectedProfileId ||
    state.activeProfileId ||
    state.profiles.find((profile) => profile.isActive)?.id ||
    state.profiles[0]?.id ||
    null;

  let config = state.current;
  let profileName = '';

  if (resolvedSelectedId) {
    const selected = state.profiles.find((profile) => profile.id === resolvedSelectedId);
    if (selected) {
      profileName = selected.name;
      config = await api.getApiProfileConfig(resolvedSelectedId);
    }
  }

  if (isLatest()) {
    const listEl = getSettingsProfileListEl();
    if (listEl) {
      listEl.innerHTML = renderSettingsProfileList(state.profiles, resolvedSelectedId);
    }
    fillSettingsForm(overlay, config, profileName, resolvedSelectedId);
    onConfigLoaded?.(config);
  }
  return { state, selectedProfileId: resolvedSelectedId };
}

