import { appState } from '../../state';
import * as api from '../../api';
import { escapeHtml } from '../../utils';
import { showConfirmDialog, showCopyToastMsg, showToast } from '../../ui';
import type { ClaudeCodeApiConfig, FetchedModel } from '../../types';
import { fillSettingsForm, refreshSettingsModal, setApiKeyBoxMode, fillOfficialView } from './profile-form';
import { renderSettingsProfileList, showProfileContextMenu, closeProfileContextMenu } from './profile-list';
import { scheduleDeepSeekBalance } from './provider-balance';
import { loadChatModelOptions, updateChatModelPicker } from '../chat/model-picker';
import { clearMainBalanceBarCache } from '../status-bar';
import { OFFICIAL_PROFILE_ID } from './profile-list';
import { closeApiConfigView } from './view-lifecycle';
import { getActiveChatModel } from '../chat/model-picker';
import { getSettingsProfileListEl } from '../settings/view';
export async function mountApiConfigView() {
  const overlay = document.querySelector('#api-config-view') as HTMLElement | null;
  if (!overlay || !appState.isApiConfigViewActive) return;

  const mountToken = ++appState.apiConfigMountToken;
  const isMountCurrent = () => mountToken === appState.apiConfigMountToken && appState.isApiConfigViewActive;

  const close = () => {
    closeApiConfigView();
  };

  const onEscapeKey = (event: KeyboardEvent) => {
    if (event.key !== 'Escape') return;
    if (!isMountCurrent()) return;

    const modelPicker = document.querySelector('.model-picker-overlay');
    if (modelPicker) {
      modelPicker.remove();
      event.preventDefault();
      return;
    }

    if (document.querySelector('.confirm-overlay')) {
      return;
    }

    if (document.querySelector('.profile-context-menu-overlay')) {
      closeProfileContextMenu();
      event.preventDefault();
      return;
    }

    event.preventDefault();
    close();
  };

  if (appState.apiConfigEscapeHandler) {
    document.removeEventListener('keydown', appState.apiConfigEscapeHandler);
  }
  appState.apiConfigEscapeHandler = onEscapeKey;
  document.addEventListener('keydown', onEscapeKey);

  // 管理壳节点缓存复用：表单绑定与模型拉取已在首次挂载完成，二次挂载只重绑 Escape。
  // 注意：标志必须在首次挂载的异步绑定全部完成后才写入；若在挂载中途关闭再重开，
  // 标志未写入 → 会重新走完整绑定，避免出现「重开后按钮无响应」。
  if ((overlay as HTMLElement).dataset.apiConfigCachedMounted === '1') return;

  const livePathEl = overlay.querySelector('.settings-live-path') as HTMLElement | null;
  let fetchedModels: FetchedModel[] = [];
  let modelsFetchInFlight = 0;
  let refreshOpenModelPicker: (() => void) | null = null;
  /** 空数组表示展示 API 拉取到的全部模型 */
  let displayModels: string[] = [];
  let customModels: string[] = [];

  const isModelsLoading = (): boolean => modelsFetchInFlight > 0;

  const setModelsLoading = (loading: boolean) => {
    modelsFetchInFlight = loading
      ? modelsFetchInFlight + 1
      : Math.max(0, modelsFetchInFlight - 1);
    updateModelConfigSummary();
    refreshOpenModelPicker?.();
  };

  const renderModelsLoadingState = (
    listEl: Element,
    message = '正在从 API 获取模型列表…',
    subMessage = '请稍候，这可能需要几秒钟',
  ) => {
    listEl.innerHTML = `
      <div class="model-picker-loading">
        <div class="model-picker-loading-dots" aria-hidden="true">
          <span class="pending-dot"></span>
          <span class="pending-dot"></span>
          <span class="pending-dot"></span>
        </div>
        <div class="model-picker-loading-copy">
          <span class="model-picker-loading-text">${escapeHtml(message)}</span>
          <span class="model-picker-loading-subtext">${escapeHtml(subMessage)}</span>
        </div>
      </div>
    `;
  };

  const getFetchedModelIds = (): Set<string> => new Set(fetchedModels.map((model) => model.id));

  const getApiDisplayModels = (): string[] => {
    if (displayModels.length > 0) {
      return [...displayModels];
    }
    return fetchedModels.map((model) => model.id);
  };

  const getEffectiveDisplayModels = (): string[] => {
    const merged = [...getApiDisplayModels()];
    for (const modelId of customModels) {
      if (!merged.includes(modelId)) {
        merged.push(modelId);
      }
    }
    return merged;
  };

  const splitDraftModels = (draft: string[]) => {
    const fetchedIds = getFetchedModelIds();
    // 已同步：按 API 列表划分；未同步：已保存展示模型保持展示，其余（含新添加）进自定义
    if (fetchedIds.size > 0) {
      return {
        apiModels: draft.filter((modelId) => fetchedIds.has(modelId)),
        customInDraft: draft.filter((modelId) => !fetchedIds.has(modelId)),
      };
    }
    const displaySet = new Set(displayModels);
    return {
      apiModels: draft.filter((modelId) => displaySet.has(modelId)),
      customInDraft: draft.filter((modelId) => !displaySet.has(modelId)),
    };
  };

  const updateModelConfigSummary = () => {
    const input = overlay.querySelector('.settings-model-config-summary') as HTMLInputElement | null;
    const hintEl = overlay.querySelector('.settings-model-config-hint');
    if (!input) return;

    // 官方默认只读：模型由订阅 / 官方登录决定，不展示 API 模型数量
    // （防止上一个配置遗留的异步取模型完成后把官方详情覆盖成「API N 个」）
    if (overlay.dataset.profileId === OFFICIAL_PROFILE_ID) {
      input.classList.remove('is-loading');
      input.value = '由订阅 / 官方登录决定';
      if (hintEl) hintEl.textContent = '官方默认模型由 Claude 订阅 / 官方登录决定';
      return;
    }

    if (isModelsLoading()) {
      input.value = '正在从 API 获取模型列表…';
      input.placeholder = '';
      input.classList.add('is-loading');
      if (hintEl) {
        hintEl.textContent = '请稍候，正在连接 API 并加载可用模型';
      }
      return;
    }

    input.classList.remove('is-loading');
    const apiCount = displayModels.length > 0 ? displayModels.length : fetchedModels.length;
    const hasModels = apiCount > 0 || customModels.length > 0;

    if (!hasModels) {
      input.value = '';
      input.placeholder = '点击配置模型';
    } else {
      const displayPart = apiCount > 0 ? `API ${apiCount} 个` : 'API 0 个';
      const customPart = customModels.length > 0 ? ` · 自定义 ${customModels.length} 个` : '';
      input.value = `${displayPart}${customPart}`;
    }

    if (hintEl) {
      hintEl.textContent = '配置展示模型与自定义模型列表；同步一次后会保存，无需每次重新同步';
    }
  };

  const normalizeDisplayModelsForSave = (models: string[]): string[] => {
    // 始终持久化具体模型 ID，避免存成空数组导致下次必须重新同步才能看到列表
    const seen = new Set<string>();
    const normalized: string[] = [];
    for (const model of models) {
      const id = model.trim();
      if (!id || seen.has(id)) continue;
      seen.add(id);
      normalized.push(id);
    }
    return normalized;
  };

  const setModelConfigFromConfig = (
    display: string[] | undefined,
    custom: string[] | undefined,
  ) => {
    displayModels = [...(display || [])];
    customModels = [...(custom || [])];
    updateModelConfigSummary();
  };

  const handleProfileConfigLoaded = (config: ClaudeCodeApiConfig) => {
    fetchedModels = [];
    setModelConfigFromConfig(config.displayModels, config.customModels);
    scheduleDeepSeekBalance(overlay);
  };

  const fetchModelsForSettings = async (): Promise<FetchedModel[]> => {
    const baseUrl = (overlay.querySelector('input[name="baseUrl"]') as HTMLInputElement | null)?.value.trim() || '';
    const apiKeyRaw = (overlay.querySelector('input[name="apiKey"]') as HTMLInputElement | null)?.value.trim();
    const profileId = overlay.dataset.profileId || null;

    if (!baseUrl) {
      throw new Error('请先填写 API Base URL');
    }

    setModelsLoading(true);
    try {
      fetchedModels = await api.fetchApiModels({
        baseUrl,
        apiKey: apiKeyRaw || null,
        profileId,
      });
      return fetchedModels;
    } finally {
      setModelsLoading(false);
    }
  };

  const saveModelConfigImmediately = async (modelsToSave: {
    display: string[];
    custom: string[];
  }): Promise<boolean> => {
    displayModels = normalizeDisplayModelsForSave(modelsToSave.display);
    customModels = [...modelsToSave.custom];
    updateModelConfigSummary();

    const form = overlay.querySelector('#settings-form') as HTMLFormElement | null;
    if (!form) return false;

    const formData = new FormData(form);
    const profileName = String(formData.get('profileName') || '').trim();
    if (!profileName) {
      showToast('请先填写配置名称');
      return false;
    }

    const profileId = overlay.dataset.profileId || null;
    const apiKeyRaw = String(formData.get('apiKey') || '').trim();
    // 同步/保存展示列表时保留当前聊天页已选模型，避免被清空后回退到列表第一项
    const preferredModel =
      appState.currentDefaultModel.trim() ||
      getActiveChatModel().trim() ||
      '';

    try {
      const result = await api.upsertApiProfile({
        profileId: profileId || null,
        name: profileName,
        config: {
          baseUrl: String(formData.get('baseUrl') || '').trim(),
          apiKey: apiKeyRaw || null,
          defaultModel: preferredModel,
          haikuModel: '',
          sonnetModel: '',
          opusModel: '',
          displayModels: [...displayModels],
          customModels: [...customModels],
        },
        apply: false,
      });

      const savedProfileId =
        profileId ||
        result.profiles.find((profile) => profile.name === profileName)?.id ||
        result.activeProfileId ||
        null;

      if (savedProfileId) {
        overlay.dataset.profileId = savedProfileId;
      }

      await loadChatModelOptions();
      if (preferredModel && appState.chatModelOptions.includes(preferredModel) && appState.currentDefaultModel !== preferredModel) {
        appState.currentDefaultModel = preferredModel;
        updateChatModelPicker();
      }
      return true;
    } catch (e) {
      console.error('保存模型配置失败:', e);
      showToast('保存模型配置失败: ' + String(e));
      return false;
    }
  };

  const openModelConfigDialog = () => {
    if (document.querySelector('.model-picker-overlay')) {
      return;
    }

    let draftModels = [...getEffectiveDisplayModels()];
    let selectedModels = new Set<string>();
    let customAddFeedback = '';
    let isCustomAddFeedbackError = false;

    const getSearchQuery = (): string =>
      (
        pickerOverlay.querySelector('.display-models-picker-search') as HTMLInputElement | null
      )?.value
        .trim()
        .toLowerCase() || '';

    const filterModelIds = (modelIds: string[]): string[] => {
      const query = getSearchQuery();
      if (!query) {
        return modelIds;
      }
      return modelIds.filter((modelId) => modelId.toLowerCase().includes(query));
    };

    const getDraftModelGroups = () => {
      const { apiModels, customInDraft } = splitDraftModels(draftModels);
      return { api: apiModels, custom: customInDraft };
    };

    const getFilteredModelGroups = () => {
      const groups = getDraftModelGroups();
      return {
        api: filterModelIds(groups.api),
        custom: filterModelIds(groups.custom),
      };
    };

    const getAllFilteredModelIds = (): string[] => {
      const groups = getFilteredModelGroups();
      return [...groups.api, ...groups.custom];
    };

    const retainVisibleSelection = () => {
      const visible = new Set(getAllFilteredModelIds());
      selectedModels = new Set([...selectedModels].filter((modelId) => visible.has(modelId)));
    };

    const getFilterEmptyText = (defaultText: string): string =>
      getSearchQuery() ? '无匹配模型' : defaultText;

    const renderBulkBar = () => {
      const bar = pickerOverlay.querySelector('.display-models-picker-bulk');
      if (!bar) {
        return;
      }

      const filtered = getAllFilteredModelIds();
      const countEl = bar.querySelector('.display-models-bulk-count');
      const selectedCountEl = bar.querySelector('.display-models-bulk-selected-count');
      const checkbox = bar.querySelector('.display-models-bulk-checkbox') as HTMLInputElement | null;
      const invertBtn = bar.querySelector('.display-models-bulk-invert') as HTMLButtonElement | null;
      const removeBtn = bar.querySelector('.display-models-bulk-remove') as HTMLButtonElement | null;

      if (countEl) {
        countEl.textContent = String(filtered.length);
      }
      if (selectedCountEl) {
        selectedCountEl.textContent = String(selectedModels.size);
      }

      const allSelected =
        filtered.length > 0 && filtered.every((modelId) => selectedModels.has(modelId));
      const someSelected = filtered.some((modelId) => selectedModels.has(modelId));

      if (checkbox) {
        checkbox.checked = allSelected;
        checkbox.indeterminate = !allSelected && someSelected;
        checkbox.disabled = filtered.length === 0;
      }
      if (invertBtn) {
        invertBtn.disabled = filtered.length === 0;
      }

      if (removeBtn) {
        removeBtn.disabled = selectedModels.size === 0;
        removeBtn.textContent =
          selectedModels.size > 0
            ? `删除已选 (${selectedModels.size})`
            : '删除已选';
      }
    };

    const pickerOverlay = document.createElement('div');
    pickerOverlay.className = 'model-picker-overlay display-models-picker-overlay';
    pickerOverlay.innerHTML = `
      <div class="model-picker-dialog display-models-picker-dialog" role="dialog" aria-modal="true">
        <div class="model-picker-header">
          <h4 class="model-picker-title">模型配置</h4>
          <button type="button" class="model-picker-close" aria-label="关闭">✕</button>
        </div>
        <div class="display-models-picker-toolbar">
          <input
            type="search"
            class="model-picker-search display-models-picker-search"
            placeholder="搜索 API 与自定义模型"
          />
          <button type="button" class="display-models-picker-sync">同步 API</button>
        </div>
        <div class="display-models-picker-bulk">
          <label class="display-models-bulk-select-all">
            <input type="checkbox" class="display-models-bulk-checkbox" />
            <span>全选当前结果 (<span class="display-models-bulk-count">0</span>)</span>
          </label>
          <span class="display-models-bulk-summary">已选 <span class="display-models-bulk-selected-count">0</span></span>
          <div class="display-models-bulk-actions">
            <button type="button" class="display-models-bulk-invert">反选</button>
            <button type="button" class="display-models-bulk-remove" disabled>删除已选</button>
          </div>
        </div>
        <div class="display-models-picker-section">
          <span class="display-models-picker-section-title">
            展示模型 <span class="display-models-picker-section-count" data-model-count="api">0</span>
          </span>
          <div class="display-models-api-list"></div>
        </div>
        <div class="display-models-picker-section">
          <span class="display-models-picker-section-title">
            自定义模型 <span class="display-models-picker-section-count" data-model-count="custom">0</span>
          </span>
          <div class="display-models-custom-add">
            <textarea
              class="display-models-custom-add-input"
              placeholder="每行一个模型，也支持逗号分隔"
              rows="2"
            ></textarea>
            <button type="button" class="display-models-custom-add-btn">批量添加</button>
          </div>
          <p class="display-models-custom-add-feedback" aria-live="polite"></p>
          <div class="display-models-custom-list"></div>
        </div>
        <p class="model-picker-tip">点击方块选中模型；同步后的模型列表会保存，下次打开无需再同步</p>
      </div>
    `;

    const closePicker = () => {
      if (refreshOpenModelPicker === renderDialog) {
        refreshOpenModelPicker = null;
      }
      pickerOverlay.remove();
    };

    const persistDraft = async (): Promise<boolean> => {
      const { apiModels, customInDraft } = splitDraftModels(draftModels);
      return saveModelConfigImmediately({
        display: apiModels,
        custom: customInDraft,
      });
    };

    const renderModelRows = (
      listEl: Element,
      modelIds: string[],
      emptyText: string,
    ) => {
      const filteredIds = filterModelIds(modelIds);
      if (filteredIds.length === 0) {
        listEl.innerHTML = `<div class="model-picker-empty${getSearchQuery() ? ' is-filter-empty' : ''}">${escapeHtml(getFilterEmptyText(emptyText))}</div>`;
        return;
      }

      const fetchedById = new Map(fetchedModels.map((model) => [model.id, model]));
      listEl.innerHTML = filteredIds
        .map((modelId) => {
          const fetched = fetchedById.get(modelId);
          const isSelected = selectedModels.has(modelId);
          return `
            <button
              type="button"
              class="display-models-tile${isSelected ? ' is-selected' : ''}"
              data-model-id="${escapeHtml(modelId)}"
              data-action="toggle-select"
              title="${escapeHtml(modelId)}"
              aria-pressed="${isSelected ? 'true' : 'false'}"
            >
              <span class="display-models-tile-id">${escapeHtml(modelId)}</span>
              ${fetched?.ownedBy ? `<span class="display-models-tile-owner">${escapeHtml(fetched.ownedBy)}</span>` : ''}
            </button>
          `;
        })
        .join('');
    };

    const renderApiModelsList = () => {
      const listEl = pickerOverlay.querySelector('.display-models-api-list');
      if (!listEl) return;

      if (isModelsLoading() && fetchedModels.length === 0) {
        renderModelsLoadingState(listEl);
        return;
      }

      const apiModelIds = getDraftModelGroups().api;
      const countEl = pickerOverlay.querySelector('[data-model-count="api"]');
      if (countEl) {
        countEl.textContent = String(filterModelIds(apiModelIds).length);
      }
      renderModelRows(
        listEl,
        apiModelIds,
        fetchedModels.length === 0 ? '暂无 API 模型，请点击右上角「同步 API」' : '暂无 API 展示模型，请同步 API',
      );
    };

    const renderCustomModelsList = () => {
      const listEl = pickerOverlay.querySelector('.display-models-custom-list');
      if (!listEl) return;

      const customModelIds = getDraftModelGroups().custom;
      const countEl = pickerOverlay.querySelector('[data-model-count="custom"]');
      if (countEl) {
        countEl.textContent = String(filterModelIds(customModelIds).length);
      }
      renderModelRows(listEl, customModelIds, '暂无自定义模型');
    };

    const parseCustomModelInput = (input: string): { models: string[]; duplicateCount: number } => {
      const tokens = input
        .split(/[\n,，]+/)
        .map((modelId) => modelId.trim())
        .filter(Boolean);
      const models = [...new Set(tokens)];
      return {
        models,
        duplicateCount: tokens.length - models.length,
      };
    };

    const submitCustomModelsAdd = async () => {
      const addInput = pickerOverlay.querySelector(
        '.display-models-custom-add-input',
      ) as HTMLTextAreaElement | null;
      const parsed = parseCustomModelInput(addInput?.value || '');
      if (parsed.models.length === 0) {
        customAddFeedback = '请输入至少一个模型名称';
        isCustomAddFeedbackError = true;
        renderCustomAddFeedback();
        addInput?.focus();
        return;
      }

      const existing = new Set(draftModels);
      const modelsToAdd = parsed.models.filter((modelId) => !existing.has(modelId));
      const skippedCount = parsed.duplicateCount + parsed.models.length - modelsToAdd.length;
      if (modelsToAdd.length === 0) {
        const groups = getDraftModelGroups();
        const inDisplay = parsed.models.some((id) => groups.api.includes(id));
        const inCustom = parsed.models.some((id) => groups.custom.includes(id));
        if (inDisplay && !inCustom) {
          customAddFeedback = '该模型已在「展示模型」中，无需重复添加';
        } else if (inCustom) {
          customAddFeedback = '该模型已在「自定义模型」中';
        } else {
          customAddFeedback = `没有新增模型，已跳过 ${skippedCount} 个重复项`;
        }
        isCustomAddFeedbackError = true;
        renderCustomAddFeedback();
        addInput?.focus();
        return;
      }

      draftModels = [...draftModels, ...modelsToAdd];
      customModels = [...new Set([...customModels, ...modelsToAdd])];
      customAddFeedback = `已新增 ${modelsToAdd.length} 个自定义模型${skippedCount > 0 ? `，跳过 ${skippedCount} 个重复项` : ''}`;
      isCustomAddFeedbackError = false;
      renderDialog();
      const saved = await persistDraft();
      if (!saved) {
        customAddFeedback = '模型已加入草稿，但保存失败，请重试';
        isCustomAddFeedbackError = true;
        renderCustomAddFeedback();
        return;
      }
      if (addInput) {
        addInput.value = '';
        addInput.focus();
      }
    };

    const renderCustomAddFeedback = () => {
      const feedback = pickerOverlay.querySelector('.display-models-custom-add-feedback');
      if (!feedback) return;
      feedback.textContent = customAddFeedback;
      feedback.classList.toggle('is-error', isCustomAddFeedbackError);
      feedback.classList.toggle('is-visible', Boolean(customAddFeedback));
    };

    const renderDialog = () => {
      renderApiModelsList();
      renderCustomModelsList();
      renderBulkBar();
      renderCustomAddFeedback();
    };

    const deleteDraftModels = async (modelIds: string[]) => {
      if (modelIds.length === 0) {
        return;
      }

      const toDelete = new Set(modelIds);
      draftModels = draftModels.filter((id) => !toDelete.has(id));
      selectedModels.clear();
      renderDialog();

      await persistDraft();
    };

    const mergeDraftWithApiModels = (apiModelIds: string[]) => {
      const customPart = draftModels.filter((modelId) => !getFetchedModelIds().has(modelId));
      draftModels = [...apiModelIds, ...customPart];
      selectedModels = new Set([...selectedModels].filter((modelId) => draftModels.includes(modelId)));
    };

    pickerOverlay.querySelector('.model-picker-close')?.addEventListener('click', closePicker);
    pickerOverlay.addEventListener('click', (event) => {
      if (event.target === pickerOverlay) closePicker();
    });

    pickerOverlay.querySelector('.display-models-picker-sync')?.addEventListener('click', async () => {
      const syncBtn = pickerOverlay.querySelector('.display-models-picker-sync') as HTMLButtonElement | null;
      if (syncBtn) {
        syncBtn.disabled = true;
        syncBtn.textContent = '正在同步…';
      }

      try {
        const previousSelected =
          appState.currentDefaultModel.trim() ||
          getActiveChatModel().trim() ||
          '';
        await fetchModelsForSettings();
        mergeDraftWithApiModels(fetchedModels.map((model) => model.id));
        renderDialog();
        await persistDraft();
        // 同步后若原先选中模型仍在新列表中，明确保留，避免跳回第一项
        if (previousSelected && appState.chatModelOptions.includes(previousSelected)) {
          if (appState.currentDefaultModel !== previousSelected) {
            appState.currentDefaultModel = previousSelected;
            updateChatModelPicker();
          }
        }
      } catch (e) {
        showToast('同步模型失败: ' + String(e));
      } finally {
        if (syncBtn) {
          syncBtn.disabled = false;
          syncBtn.textContent = '同步 API';
        }
      }
    });

    pickerOverlay.querySelector('.display-models-picker-search')?.addEventListener('input', () => {
      retainVisibleSelection();
      renderDialog();
    });

    pickerOverlay.querySelector('.display-models-custom-add-btn')?.addEventListener('click', () => {
      void submitCustomModelsAdd();
    });

    pickerOverlay.querySelector('.display-models-custom-add-input')?.addEventListener('keydown', (event) => {
      const keyboardEvent = event as KeyboardEvent;
      if (keyboardEvent.key !== 'Enter' || (!keyboardEvent.metaKey && !keyboardEvent.ctrlKey)) {
        return;
      }
      keyboardEvent.preventDefault();
      void submitCustomModelsAdd();
    });

    pickerOverlay.querySelector('.display-models-bulk-checkbox')?.addEventListener('change', (event) => {
      const checkbox = event.target as HTMLInputElement;
      const filtered = getAllFilteredModelIds();
      if (checkbox.checked) {
        selectedModels = new Set(filtered);
      } else {
        selectedModels.clear();
      }
      renderDialog();
    });

    pickerOverlay.querySelector('.display-models-bulk-invert')?.addEventListener('click', () => {
      const filtered = getAllFilteredModelIds();
      selectedModels = new Set(filtered.filter((modelId) => !selectedModels.has(modelId)));
      renderDialog();
    });

    pickerOverlay.querySelector('.display-models-bulk-remove')?.addEventListener('click', () => {
      if (selectedModels.size === 0) {
        return;
      }
      void deleteDraftModels([...selectedModels]);
    });

    const handleModelTileClick = (event: Event) => {
      const target = event.target as HTMLElement;
      const tile = target.closest('.display-models-tile') as HTMLElement | null;
      if (!tile || tile.dataset.action !== 'toggle-select') {
        return;
      }

      const modelId = tile.dataset.modelId;
      if (!modelId) {
        return;
      }

      if (selectedModels.has(modelId)) {
        selectedModels.delete(modelId);
      } else {
        selectedModels.add(modelId);
      }
      renderDialog();
    };

    pickerOverlay.querySelector('.display-models-api-list')?.addEventListener('click', handleModelTileClick);
    pickerOverlay.querySelector('.display-models-custom-list')?.addEventListener('click', handleModelTileClick);

    document.body.appendChild(pickerOverlay);
    refreshOpenModelPicker = renderDialog;
    renderDialog();

    const searchInput = pickerOverlay.querySelector('.display-models-picker-search') as HTMLInputElement | null;
    searchInput?.focus();
  };

  const bindModelConfigEvents = () => {
    const summary = overlay.querySelector('.settings-model-config-summary');
    if (!summary || (summary as HTMLElement).dataset.bound === '1') return;
    (summary as HTMLElement).dataset.bound = '1';
    summary.addEventListener('click', () => {
      // 官方默认为只读，模型由订阅 / 官方登录决定，不打开模型配置
      if (overlay.dataset.profileId === OFFICIAL_PROFILE_ID) return;
      openModelConfigDialog();
    });
  };

  const bindProfileListEvents = () => {
    const list = getSettingsProfileListEl();
    if (!list || list.dataset.bound === 'true') {
      return;
    }
    list.dataset.bound = 'true';

    const stopKiroProxyIfRunning = async () => {
      if (!appState.kiroStatus?.running) return;
      try {
        appState.kiroStatus = await api.kiroStop();
      } catch (e) {
        console.error('停止 Kiro 代理失败:', e);
      }
    };

    const applyProfile = async (profileId: string) => {
      try {
        await stopKiroProxyIfRunning();
        await api.switchApiProfile(profileId);
        clearMainBalanceBarCache();
        await refreshSettingsModal(overlay, profileId, handleProfileConfigLoaded);
        if (livePathEl) {
          const state = await api.getApiProfilesState();
          livePathEl.textContent = `配置文件：${state.current.configPath}`;
        }
        await loadChatModelOptions();
      } catch (e) {
        showToast('应用 API 配置失败: ' + String(e));
      }
    };

    const deleteProfile = async (profileId: string, profileName: string) => {
      const confirmed = await showConfirmDialog({
        title: '删除配置',
        message: `确定要删除配置「${profileName}」吗？`,
        sub: '删除后无法恢复；若正在使用该配置，将自动切换到其他配置。',
        confirmLabel: '删除',
      });
      if (!confirmed) return;

      try {
        await api.deleteApiProfile(profileId);
        const refreshed = await refreshSettingsModal(overlay, null, handleProfileConfigLoaded);
        if (livePathEl) {
          livePathEl.textContent = `配置文件：${refreshed.state.current.configPath}`;
        }
      } catch (e) {
        showToast('删除配置失败: ' + String(e));
      }
    };

    const applyOfficial = async () => {
      try {
        await stopKiroProxyIfRunning();
        await api.useOfficialApi();
        clearMainBalanceBarCache();
        await refreshSettingsModal(overlay, null, handleProfileConfigLoaded);
        if (livePathEl) {
          const state = await api.getApiProfilesState();
          livePathEl.textContent = `配置文件：${state.current.configPath}`;
        }
        await loadChatModelOptions();
      } catch (e) {
        showToast('切换到官方默认失败: ' + String(e));
      }
    };

    list.addEventListener('click', async (event) => {
      const target = event.target as HTMLElement;
      if (target.closest('.settings-profile-official')) {
        // 左键查看官方默认只读详情（应用走「应用」按钮 / 右键）
        try {
          const state = await api.getApiProfilesState();
          list.innerHTML = renderSettingsProfileList(state.profiles, OFFICIAL_PROFILE_ID);
        } catch {
          /* 列表刷新失败不影响查看 */
        }
        // 清空上一个配置遗留的模型缓存，避免官方详情里看到别的配置的模型
        fetchedModels = [];
        displayModels = [];
        customModels = [];
        fillOfficialView(overlay);
        return;
      }

      const item = target.closest('.settings-profile-item') as HTMLElement | null;
      if (!item) return;

      const profileId = item.dataset.profileId;
      if (!profileId) return;

      try {
        await refreshSettingsModal(overlay, profileId, handleProfileConfigLoaded);
      } catch (e) {
        showToast('加载 API 配置失败: ' + String(e));
      }
    });

    list.addEventListener('contextmenu', (event) => {
      const target = event.target as HTMLElement;

      const official = target.closest('.settings-profile-official') as HTMLElement | null;
      if (official) {
        event.preventDefault();
        event.stopPropagation();
        showProfileContextMenu({
          x: event.clientX,
          y: event.clientY,
          profileId: OFFICIAL_PROFILE_ID,
          profileName: '官方默认',
          isActive: official.classList.contains('active'),
          allowDelete: false,
          onApply: () => applyOfficial(),
          onDelete: () => {},
        });
        return;
      }

      const item = target.closest('.settings-profile-item') as HTMLElement | null;
      if (!item) return;

      const profileId = item.dataset.profileId;
      if (!profileId) return;

      event.preventDefault();
      event.stopPropagation();

      const profileName =
        item.querySelector('.settings-profile-name')?.textContent?.trim() || '此配置';
      const isActive = item.classList.contains('active');

      showProfileContextMenu({
        x: event.clientX,
        y: event.clientY,
        profileId,
        profileName,
        isActive,
        onApply: () => applyProfile(profileId),
        onDelete: () => deleteProfile(profileId, profileName),
      });
    });

    list.addEventListener('keydown', (event) => {
      if (event.key !== 'Enter' && event.key !== ' ') return;
      const target = event.target as HTMLElement;
      const item = target.closest('.settings-profile-item') as HTMLElement | null;
      if (!item) return;
      event.preventDefault();
      item.click();
    });
  };

  overlay.querySelector('.settings-close-btn')?.addEventListener('click', close);
  overlay.querySelector('.settings-close-footer')?.addEventListener('click', close);

  // API Key 单框：编辑 / 取消 / 复制
  const apiKeyBox = overlay.querySelector('.settings-apikey-box') as HTMLElement | null;
  apiKeyBox?.addEventListener('click', async (event) => {
    const target = (event.target as HTMLElement | null)?.closest('[data-action]') as HTMLButtonElement | null;
    if (!target) return;
    event.preventDefault();
    const action = target.dataset.action;
    const input = apiKeyBox.querySelector('input[name="apiKey"]') as HTMLInputElement | null;
    const valueEl = apiKeyBox.querySelector('.settings-apikey-display-value') as HTMLElement | null;
    const hasKey = valueEl?.dataset.hasKey === '1';
    const profileId = overlay.dataset.profileId || null;

    if (action === 'edit') {
      setApiKeyBoxMode(overlay, 'edit');
      if (input) {
        input.value = '';
        input.placeholder = hasKey ? '已配置，留空则不修改' : 'sk-...';
        input.focus();
      }
    } else if (action === 'cancel') {
      if (input) input.value = '';
      setApiKeyBoxMode(overlay, hasKey ? 'view' : 'empty');
    } else if (action === 'copy') {
      if (!hasKey || !profileId) return;
      const ok = await api.copyApiProfileKey(profileId);
      showCopyToastMsg(ok ? '已复制密钥' : '复制失败');
    }
  });

  const saveApiProfile = async () => {
    const form = overlay.querySelector('#settings-form') as HTMLFormElement | null;
    if (!form) return;

    const formData = new FormData(form);
    const apiKeyRaw = String(formData.get('apiKey') || '').trim();
    const profileId = overlay.dataset.profileId || null;
    const profileName = String(formData.get('profileName') || '').trim();
    const saveBtn = overlay.querySelector('.save-only') as HTMLButtonElement | null;

    if (!profileName) {
      if (saveBtn) {
        saveBtn.textContent = '请填写配置名称';
        window.setTimeout(() => {
          if (saveBtn.textContent === '请填写配置名称') {
            saveBtn.textContent = '保存';
          }
        }, 2000);
      }
      (overlay.querySelector('input[name="profileName"]') as HTMLInputElement | null)?.focus();
      return;
    }

    if (saveBtn) {
      saveBtn.disabled = true;
      saveBtn.textContent = '保存中...';
    }

    try {
      const displayModelsToSave = [...displayModels];
      const customModelsToSave = [...customModels];
      const preferredModel =
        appState.currentDefaultModel.trim() ||
        getActiveChatModel().trim() ||
        '';
      const result = await api.upsertApiProfile({
        profileId: profileId || null,
        name: profileName,
        config: {
          baseUrl: String(formData.get('baseUrl') || '').trim(),
          apiKey: apiKeyRaw || null,
          defaultModel: preferredModel,
          haikuModel: '',
          sonnetModel: '',
          opusModel: '',
          displayModels: displayModelsToSave,
          customModels: customModelsToSave,
        },
        apply: false,
      });

      const savedProfileId =
        profileId ||
        result.profiles.find((profile) => profile.name === profileName)?.id ||
        result.activeProfileId ||
        null;

      await refreshSettingsModal(overlay, savedProfileId, handleProfileConfigLoaded);
      await loadChatModelOptions();

      if (saveBtn) {
        saveBtn.textContent = '已保存';
        window.setTimeout(() => {
          if (saveBtn.textContent === '已保存') {
            saveBtn.textContent = '保存';
          }
        }, 1500);
      }
    } catch (e) {
      console.error('保存 API 配置失败:', e);
      if (saveBtn) {
        saveBtn.textContent = '保存失败';
        window.setTimeout(() => {
          if (saveBtn.textContent === '保存失败') {
            saveBtn.textContent = '保存';
          }
        }, 2000);
      }
    } finally {
      if (saveBtn) {
        saveBtn.disabled = false;
      }
    }
  };

  overlay.querySelector('.save-only')?.addEventListener('click', () => {
    void saveApiProfile();
  });

  overlay.querySelector('.settings-apply-profile')?.addEventListener('click', async () => {
    const applyBtn = overlay.querySelector('.settings-apply-profile') as HTMLButtonElement | null;
    const profileId = overlay.dataset.profileId || null;
    if (!profileId) {
      if (applyBtn) {
        applyBtn.textContent = '请先选择配置';
        window.setTimeout(() => {
          if (applyBtn.textContent === '请先选择配置') applyBtn.textContent = '应用';
        }, 1800);
      }
      return;
    }
    if (applyBtn) {
      applyBtn.disabled = true;
      applyBtn.textContent = '应用中...';
    }
    try {
      if (profileId === OFFICIAL_PROFILE_ID) {
        if (appState.kiroStatus?.running) {
          appState.kiroStatus = await api.kiroStop();
        }
        await api.useOfficialApi();
        clearMainBalanceBarCache();
        await refreshSettingsModal(overlay, null, handleProfileConfigLoaded);
      } else {
        if (appState.kiroStatus?.running) {
          appState.kiroStatus = await api.kiroStop();
        }
        await api.switchApiProfile(profileId);
        clearMainBalanceBarCache();
        await refreshSettingsModal(overlay, profileId, handleProfileConfigLoaded);
      }
      if (livePathEl) {
        const state = await api.getApiProfilesState();
        livePathEl.textContent = `配置文件：${state.current.configPath}`;
      }
      await loadChatModelOptions();
      if (applyBtn) {
        applyBtn.textContent = '已应用';
        window.setTimeout(() => {
          if (applyBtn.textContent === '已应用') applyBtn.textContent = '应用';
        }, 1500);
      }
    } catch (e) {
      showToast('应用 API 配置失败: ' + String(e));
      if (applyBtn) applyBtn.textContent = '应用';
    } finally {
      if (applyBtn) applyBtn.disabled = false;
    }
  });

  document.querySelector('.settings-add-profile')?.addEventListener('click', () => {
    fillSettingsForm(
      overlay,
      {
        baseUrl: '',
        hasApiKey: false,
        defaultModel: '',
        haikuModel: '',
        sonnetModel: '',
        opusModel: '',
        displayModels: [],
        customModels: [],
        configPath: '',
      },
      '',
      null,
    );
    document.querySelectorAll('.settings-profile-item').forEach((item) => {
      item.classList.remove('selected');
    });
    fetchedModels = [];
    customModels = [];
    setModelConfigFromConfig([], []);
    (overlay.querySelector('input[name="profileName"]') as HTMLInputElement | null)?.focus();
  });

  document.querySelector('.settings-import-cc-switch')?.addEventListener('click', async () => {
    const importBtn = document.querySelector('.settings-import-cc-switch') as HTMLButtonElement | null;
    if (importBtn) {
      importBtn.disabled = true;
      importBtn.textContent = '导入中...';
    }

    try {
      const result = await api.importCcSwitchProfiles();
      const selectedId =
        result.state.activeProfileId ||
        result.state.profiles.find((profile) => profile.isActive)?.id ||
        result.state.profiles[0]?.id ||
        null;
      await refreshSettingsModal(overlay, selectedId, handleProfileConfigLoaded);

      let message: string;
      if (result.importedCount > 0) {
        message = `已从 CC Switch 导入 ${result.importedCount} 个配置`;
        if (result.skippedCount > 0) {
          message += `，跳过 ${result.skippedCount} 个重复或无效项`;
          if (result.skippedNames.length > 0) {
            message += `：${result.skippedNames.join('、')}`;
          }
        }
        message += '。导入后不会自动切换生效配置。';
      } else {
        message = 'CC Switch 配置已全部添加，无需重复导入。';
      }
      showToast(message, 'success');
    } catch (e) {
      showToast('从 CC Switch 导入失败: ' + String(e));
    } finally {
      if (importBtn) {
        importBtn.disabled = false;
        importBtn.textContent = '从 CC Switch 导入';
      }
    }
  });

  overlay.querySelector('.provider-balance-refresh')?.addEventListener('click', () => {
    scheduleDeepSeekBalance(overlay);
  });

  overlay.querySelector('input[name="baseUrl"]')?.addEventListener('change', () => {
    scheduleDeepSeekBalance(overlay);
  });

  try {
    if (!isMountCurrent()) return;
    const initial = await refreshSettingsModal(overlay, null, handleProfileConfigLoaded);
    if (!isMountCurrent()) return;
    if (livePathEl) {
      livePathEl.textContent = `配置文件：${initial.state.current.configPath}`;
    }
    bindProfileListEvents();
    bindModelConfigEvents();
    // 全部绑定完成后再标记「缓存已挂载」，中途关闭重开不会跳过绑定
    (overlay as HTMLElement).dataset.apiConfigCachedMounted = '1';
  } catch (e) {
    if (!isMountCurrent()) return;
    showToast('加载 API 配置失败: ' + String(e));
    close();
  }
}

// ============================================================
// 工具消息渲染系统
// ============================================================

/** 工具显示配置 */
