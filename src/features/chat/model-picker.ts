import { appState } from '../../state';
import * as api from '../../api';
import { escapeHtml } from '../../utils';
import { refreshModelInfo } from './render-chat';
export function getActiveChatModelForRender(): string {
  // 优先使用配置文件中的默认模型；同步刷新时尽量保留页面上已选模型，避免跳回列表第一项
  if (appState.currentDefaultModel && appState.chatModelOptions.includes(appState.currentDefaultModel)) {
    return appState.currentDefaultModel;
  }
  if (appState.currentDefaultModel) {
    return appState.currentDefaultModel;
  }
  const trigger = document.querySelector('#chat-model-picker-trigger') as HTMLButtonElement | null;
  const fromUi = trigger?.dataset.value?.trim() || '';
  if (fromUi && appState.chatModelOptions.includes(fromUi)) {
    return fromUi;
  }
  return appState.chatModelOptions[0] || '';
}

export function getActiveChatModel(): string {
  const trigger = document.querySelector('#chat-model-picker-trigger') as HTMLButtonElement | null;
  const value = trigger?.dataset.value?.trim();
  if (value) {
    return value;
  }
  return getActiveChatModelForRender();
}

export function renderChatModelPickerListItems(filter: string): string {
  const query = filter.trim().toLowerCase();
  const current = getActiveChatModelForRender();
  const models = appState.chatModelOptions.filter(
    (model) => !query || model.toLowerCase().includes(query),
  );

  if (models.length === 0) {
    return `<div class="chat-model-picker-empty">${query ? '无匹配模型' : '未配置模型'}</div>`;
  }

  return models
    .map((model) => {
      const isActive = model === current;
      return `
        <button
          type="button"
          class="chat-model-picker-option${isActive ? ' is-active' : ''}"
          data-model="${escapeHtml(model)}"
          title="${escapeHtml(model)}"
        >
          <span class="chat-model-picker-option-label">${escapeHtml(model)}</span>
          ${isActive ? '<span class="chat-model-picker-option-check" aria-hidden="true">✓</span>' : ''}
        </button>
      `;
    })
    .join('');
}

export function renderChatModelPickerHtml(): string {
  const current = getActiveChatModelForRender();
  const disabled = appState.chatModelOptions.length === 0;
  const label = current || '未配置模型';

  return `
    <div class="chat-model-picker" id="chat-model-picker">
      <div class="chat-model-picker-panel is-hidden" id="chat-model-picker-panel">
        <input
          type="search"
          class="chat-model-picker-search"
          placeholder="搜索模型..."
          autocomplete="off"
          aria-label="搜索模型"
        />
        <div class="chat-model-picker-list" id="chat-model-picker-list">
          ${renderChatModelPickerListItems('')}
        </div>
      </div>
      <button
        type="button"
        class="chat-model-picker-trigger"
        id="chat-model-picker-trigger"
        title="${escapeHtml(current || '未配置模型')}"
        aria-haspopup="listbox"
        aria-expanded="false"
        ${disabled ? 'disabled' : ''}
        data-value="${escapeHtml(current)}"
      >
        <span class="chat-model-picker-value">${escapeHtml(label)}</span>
        <span class="chat-model-picker-chevron" aria-hidden="true">▾</span>
      </button>
    </div>
  `;
}

export function resetChatModelPickerHighlight() {
  appState.chatModelPickerHighlightIndex = -1;
  document.querySelectorAll('.chat-model-picker-option.is-highlighted').forEach((element) => {
    element.classList.remove('is-highlighted');
  });
}

export function getVisibleChatModelOptions(): HTMLElement[] {
  return Array.from(document.querySelectorAll('#chat-model-picker-list .chat-model-picker-option'));
}

export function setChatModelPickerHighlight(index: number) {
  const options = getVisibleChatModelOptions();
  resetChatModelPickerHighlight();
  if (options.length === 0) {
    return;
  }

  const clamped = Math.max(0, Math.min(index, options.length - 1));
  appState.chatModelPickerHighlightIndex = clamped;
  const option = options[clamped];
  option.classList.add('is-highlighted');
  option.scrollIntoView({ block: 'nearest' });
}

export function selectHighlightedChatModelOption() {
  const options = getVisibleChatModelOptions();
  if (options.length === 0) {
    return;
  }

  const index = appState.chatModelPickerHighlightIndex >= 0 ? appState.chatModelPickerHighlightIndex : 0;
  const model = options[index]?.dataset.model;
  if (!model) {
    return;
  }

  closeChatModelPicker();
  void applyChatModelSelection(model);
}

export function closeChatModelPicker() {
  const panel = document.querySelector('#chat-model-picker-panel');
  const picker = document.querySelector('#chat-model-picker');
  const trigger = document.querySelector('#chat-model-picker-trigger') as HTMLButtonElement | null;
  panel?.classList.add('is-hidden');
  picker?.classList.remove('is-open');
  resetChatModelPickerHighlight();
  if (trigger) {
    trigger.setAttribute('aria-expanded', 'false');
  }
}

export function openChatModelPicker() {
  const panel = document.querySelector('#chat-model-picker-panel');
  const picker = document.querySelector('#chat-model-picker');
  const trigger = document.querySelector('#chat-model-picker-trigger') as HTMLButtonElement | null;
  if (!panel || appState.chatModelOptions.length === 0) {
    return;
  }

  panel.classList.remove('is-hidden');
  picker?.classList.add('is-open');
  if (trigger) {
    trigger.setAttribute('aria-expanded', 'true');
  }

  const search = document.querySelector('.chat-model-picker-search') as HTMLInputElement | null;
  const list = document.querySelector('#chat-model-picker-list');
  if (search) {
    search.value = '';
  }
  if (list) {
    list.innerHTML = renderChatModelPickerListItems('');
  }
  resetChatModelPickerHighlight();
  search?.focus();
}

export function handleChatModelPickerOutsideClick(event: Event) {
  const picker = document.querySelector('#chat-model-picker');
  if (picker && !picker.contains(event.target as Node)) {
    closeChatModelPicker();
  }
}

export function bindChatModelPickerEvents() {
  document.removeEventListener('click', handleChatModelPickerOutsideClick);

  const trigger = document.querySelector('#chat-model-picker-trigger');
  const search = document.querySelector('.chat-model-picker-search');
  const list = document.querySelector('#chat-model-picker-list');

  trigger?.addEventListener('click', (event) => {
    event.stopPropagation();
    const panel = document.querySelector('#chat-model-picker-panel');
    const isOpen = panel && !panel.classList.contains('is-hidden');
    if (isOpen) {
      closeChatModelPicker();
    } else {
      openChatModelPicker();
    }
  });

  search?.addEventListener('input', (event) => {
    const query = (event.target as HTMLInputElement).value;
    if (list) {
      list.innerHTML = renderChatModelPickerListItems(query);
    }
    resetChatModelPickerHighlight();
  });

  search?.addEventListener('keydown', (event) => {
    const keyboardEvent = event as KeyboardEvent;
    const options = getVisibleChatModelOptions();

    if (keyboardEvent.key === 'ArrowDown') {
      keyboardEvent.preventDefault();
      if (options.length === 0) {
        return;
      }
      const nextIndex =
        appState.chatModelPickerHighlightIndex < 0 ? 0 : appState.chatModelPickerHighlightIndex + 1;
      setChatModelPickerHighlight(Math.min(nextIndex, options.length - 1));
      return;
    }

    if (keyboardEvent.key === 'ArrowUp') {
      keyboardEvent.preventDefault();
      if (options.length === 0) {
        return;
      }
      const nextIndex =
        appState.chatModelPickerHighlightIndex < 0
          ? options.length - 1
          : appState.chatModelPickerHighlightIndex - 1;
      setChatModelPickerHighlight(Math.max(nextIndex, 0));
      return;
    }

    if (keyboardEvent.key === 'Enter') {
      keyboardEvent.preventDefault();
      if (options.length === 0) {
        return;
      }
      selectHighlightedChatModelOption();
      return;
    }

    if (keyboardEvent.key === 'Escape') {
      keyboardEvent.preventDefault();
      closeChatModelPicker();
    }
    keyboardEvent.stopPropagation();
  });

  list?.addEventListener('click', (event) => {
    const option = (event.target as HTMLElement).closest('.chat-model-picker-option') as HTMLElement | null;
    const model = option?.dataset.model;
    if (!model) {
      return;
    }
    closeChatModelPicker();
    void applyChatModelSelection(model);
  });

  document.addEventListener('click', handleChatModelPickerOutsideClick);
}

export function updateChatModelPicker() {
  const trigger = document.querySelector('#chat-model-picker-trigger') as HTMLButtonElement | null;
  const valueEl = trigger?.querySelector('.chat-model-picker-value');
  const search = document.querySelector('.chat-model-picker-search') as HTMLInputElement | null;
  const list = document.querySelector('#chat-model-picker-list');
  const current = getActiveChatModelForRender();

  if (trigger) {
    trigger.dataset.value = current;
    trigger.disabled = appState.chatModelOptions.length === 0;
    trigger.title = current || '未配置模型';
    if (valueEl) {
      valueEl.textContent = current || '未配置模型';
    }
  }
  if (list) {
    list.innerHTML = renderChatModelPickerListItems(search?.value || '');
  }
}

export async function applyChatModelSelection(model: string): Promise<void> {
  const trimmed = model.trim();
  if (!trimmed || !appState.chatModelOptions.includes(trimmed)) {
    return;
  }

  // 立即写入配置文件（Claude Code settings.json + 活跃 profile.default_model）
  try {
    await api.setActiveDefaultModel(trimmed);
    appState.currentDefaultModel = trimmed;
  } catch (err) {
    console.error('[model] 写入默认模型失败:', err);
  }

  updateChatModelPicker();
  if (!appState.activeConversationId) {
    void refreshModelInfo();
  }
}

export async function loadChatModelOptions(): Promise<void> {
  const previousSelected =
    appState.currentDefaultModel.trim() ||
    (document.querySelector('#chat-model-picker-trigger') as HTMLButtonElement | null)?.dataset.value?.trim() ||
    '';

  try {
    const config = await api.getClaudeApiConfig();
    appState.currentDefaultModel = (config.defaultModel || '').trim();
    const customModels = config.customModels || [];
    let apiModels: string[] = [];

    if (config.displayModels && config.displayModels.length > 0) {
      apiModels = [...config.displayModels];
    } else if (config.baseUrl.trim() && config.hasApiKey) {
      try {
        const fetched = await api.fetchApiModels({
          baseUrl: config.baseUrl.trim(),
          apiKey: null,
          profileId: null,
        });
        apiModels = fetched.map((model) => model.id);
      } catch {
        apiModels = [];
      }
    }

    const merged = [...apiModels];
    for (const modelId of customModels) {
      if (!merged.includes(modelId)) {
        merged.push(modelId);
      }
    }
    // 官方订阅模式（未配置第三方 API 且无模型列表）下，提供官方模型选项
    if (merged.length === 0 && !config.baseUrl.trim()) {
      appState.chatModelOptions = ['default', 'opus', 'sonnet', 'haiku'];
    } else {
      appState.chatModelOptions = merged;
    }

    // 同步后配置未带回默认模型时，若原先选中的模型仍在新列表中则继续沿用
    if (!appState.currentDefaultModel && previousSelected && appState.chatModelOptions.includes(previousSelected)) {
      appState.currentDefaultModel = previousSelected;
    }

    // 若配置文件里的当前默认模型不在候选列表，附加到首位以便展示与切换
    if (appState.currentDefaultModel && !appState.chatModelOptions.includes(appState.currentDefaultModel)) {
      appState.chatModelOptions = [appState.currentDefaultModel, ...appState.chatModelOptions];
    }
  } catch {
    appState.chatModelOptions = [];
    appState.currentDefaultModel = previousSelected || '';
  }
  updateChatModelPicker();
}
