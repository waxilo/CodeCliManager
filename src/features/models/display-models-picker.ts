import { escapeHtml } from '../../utils';
import type { FetchedModel } from '../../types';

export interface DisplayModelsPickerSavePayload {
  display: string[];
  custom: string[];
}

export interface OpenDisplayModelsPickerOptions {
  title?: string;
  syncLabel?: string;
  syncingLabel?: string;
  tip?: string;
  displayModels: string[];
  customModels: string[];
  fetchedModels?: FetchedModel[];
  canSync?: boolean;
  onSync: () => Promise<FetchedModel[]>;
  onSave: (models: DisplayModelsPickerSavePayload) => Promise<boolean>;
  onAfterChange?: () => void | Promise<void>;
}

function normalizeModelList(models: string[]): string[] {
  const seen = new Set<string>();
  const normalized: string[] = [];
  for (const model of models) {
    const trimmed = model.trim();
    if (!trimmed || seen.has(trimmed)) continue;
    seen.add(trimmed);
    normalized.push(trimmed);
  }
  return normalized;
}

function getEffectiveModels(displayModels: string[], customModels: string[], fetched: FetchedModel[]): string[] {
  const apiPart = displayModels.length > 0 ? displayModels : fetched.map((model) => model.id);
  const merged = [...apiPart];
  for (const modelId of customModels) {
    if (!merged.includes(modelId)) merged.push(modelId);
  }
  return merged;
}

/**
 * 打开与 API 配置页一致的「展示模型 / 自定义模型」弹层。
 */
export function openDisplayModelsPicker(options: OpenDisplayModelsPickerOptions): void {
  if (document.querySelector('.model-picker-overlay')) return;

  const syncLabel = options.syncLabel || '同步 API';
  const syncingLabel = options.syncingLabel || '正在同步…';
  let displayModels = normalizeModelList(options.displayModels);
  let customModels = normalizeModelList(options.customModels);
  let fetchedModels = [...(options.fetchedModels || [])];
  let draftModels = [...getEffectiveModels(displayModels, customModels, fetchedModels)];
  let selectedModels = new Set<string>();
  let customAddFeedback = '';
  let isCustomAddFeedbackError = false;
  let modelsFetchInFlight = 0;

  const isModelsLoading = () => modelsFetchInFlight > 0;
  const getFetchedModelIds = () => new Set(fetchedModels.map((model) => model.id));

  const pickerOverlay = document.createElement('div');
  pickerOverlay.className = 'model-picker-overlay display-models-picker-overlay';
  pickerOverlay.innerHTML = `
    <div class="model-picker-dialog display-models-picker-dialog" role="dialog" aria-modal="true">
      <div class="model-picker-header">
        <h4 class="model-picker-title">${escapeHtml(options.title || '模型配置')}</h4>
        <button type="button" class="model-picker-close" aria-label="关闭">✕</button>
      </div>
      <div class="display-models-picker-toolbar">
        <input
          type="search"
          class="model-picker-search display-models-picker-search"
          placeholder="搜索 API 与自定义模型"
        />
        <button type="button" class="display-models-picker-sync"${options.canSync === false ? ' disabled' : ''}>${escapeHtml(syncLabel)}</button>
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
      <p class="model-picker-tip">${escapeHtml(options.tip || '点击方块选中模型；同步后的模型列表会保存，下次打开无需再同步')}</p>
    </div>
  `;

  const getSearchQuery = (): string =>
    (pickerOverlay.querySelector('.display-models-picker-search') as HTMLInputElement | null)?.value
      .trim()
      .toLowerCase() || '';

  const filterModelIds = (modelIds: string[]): string[] => {
    const query = getSearchQuery();
    if (!query) return modelIds;
    return modelIds.filter((modelId) => modelId.toLowerCase().includes(query));
  };

  /**
   * 分类规则：
   * - 已同步：在 API 列表里的进展示，其余进自定义
   * - 未同步：已保存的展示模型保持展示；其余（含新添加）一律视为自定义
   *   避免「新增自定义」被误判成展示模型，导致自定义区一直为空
   */
  const splitDraftModels = (draft: string[]) => {
    const fetchedIds = getFetchedModelIds();
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

  const persistDraft = async (): Promise<boolean> => {
    const { apiModels, customInDraft } = splitDraftModels(draftModels);
    displayModels = normalizeModelList(apiModels);
    customModels = normalizeModelList(customInDraft);
    const saved = await options.onSave({
      display: [...displayModels],
      custom: [...customModels],
    });
    if (saved) {
      await options.onAfterChange?.();
    }
    return saved;
  };

  const renderModelsLoadingState = (listEl: Element) => {
    listEl.innerHTML = `
      <div class="model-picker-loading">
        <div class="model-picker-loading-dots" aria-hidden="true">
          <span class="pending-dot"></span>
          <span class="pending-dot"></span>
          <span class="pending-dot"></span>
        </div>
        <div class="model-picker-loading-copy">
          <span class="model-picker-loading-text">正在获取模型列表…</span>
          <span class="model-picker-loading-subtext">请稍候，这可能需要几秒钟</span>
        </div>
      </div>
    `;
  };

  const renderModelRows = (listEl: Element, modelIds: string[], emptyText: string) => {
    const filteredIds = filterModelIds(modelIds);
    if (filteredIds.length === 0) {
      listEl.innerHTML = `<div class="model-picker-empty${getSearchQuery() ? ' is-filter-empty' : ''}">${escapeHtml(
        getSearchQuery() ? '无匹配模型' : emptyText,
      )}</div>`;
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

  const renderBulkBar = () => {
    const bar = pickerOverlay.querySelector('.display-models-picker-bulk');
    if (!bar) return;

    const filtered = getAllFilteredModelIds();
    const countEl = bar.querySelector('.display-models-bulk-count');
    const selectedCountEl = bar.querySelector('.display-models-bulk-selected-count');
    const checkbox = bar.querySelector('.display-models-bulk-checkbox') as HTMLInputElement | null;
    const invertBtn = bar.querySelector('.display-models-bulk-invert') as HTMLButtonElement | null;
    const removeBtn = bar.querySelector('.display-models-bulk-remove') as HTMLButtonElement | null;

    if (countEl) countEl.textContent = String(filtered.length);
    if (selectedCountEl) selectedCountEl.textContent = String(selectedModels.size);

    const allSelected = filtered.length > 0 && filtered.every((modelId) => selectedModels.has(modelId));
    const someSelected = filtered.some((modelId) => selectedModels.has(modelId));
    if (checkbox) {
      checkbox.checked = allSelected;
      checkbox.indeterminate = !allSelected && someSelected;
      checkbox.disabled = filtered.length === 0;
    }
    if (invertBtn) invertBtn.disabled = filtered.length === 0;
    if (removeBtn) {
      removeBtn.disabled = selectedModels.size === 0;
      removeBtn.textContent = selectedModels.size > 0 ? `删除已选 (${selectedModels.size})` : '删除已选';
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
    const apiList = pickerOverlay.querySelector('.display-models-api-list');
    const customList = pickerOverlay.querySelector('.display-models-custom-list');
    const groups = getDraftModelGroups();

    if (apiList) {
      if (isModelsLoading() && fetchedModels.length === 0) {
        renderModelsLoadingState(apiList);
      } else {
        const countEl = pickerOverlay.querySelector('[data-model-count="api"]');
        if (countEl) countEl.textContent = String(filterModelIds(groups.api).length);
        renderModelRows(
          apiList,
          groups.api,
          fetchedModels.length === 0 ? `暂无 API 模型，请点击右上角「${syncLabel}」` : '暂无 API 展示模型，请同步',
        );
      }
    }

    if (customList) {
      const countEl = pickerOverlay.querySelector('[data-model-count="custom"]');
      if (countEl) countEl.textContent = String(filterModelIds(groups.custom).length);
      renderModelRows(customList, groups.custom, '暂无自定义模型');
    }

    renderBulkBar();
    renderCustomAddFeedback();
  };

  const parseCustomModelInput = (input: string) => {
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
    // 立刻记入 customModels，保证未同步时分类与展示正确
    customModels = normalizeModelList([...customModels, ...modelsToAdd]);
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

  const deleteDraftModels = async (modelIds: string[]) => {
    if (modelIds.length === 0) return;
    const toDelete = new Set(modelIds);
    draftModels = draftModels.filter((id) => !toDelete.has(id));
    selectedModels.clear();
    renderDialog();
    await persistDraft();
  };

  const closePicker = () => {
    document.removeEventListener('keydown', onKeyDown, true);
    pickerOverlay.remove();
  };

  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key !== 'Escape') return;
    event.preventDefault();
    event.stopPropagation();
    closePicker();
  };

  pickerOverlay.querySelector('.model-picker-close')?.addEventListener('click', closePicker);
  pickerOverlay.addEventListener('click', (event) => {
    if (event.target === pickerOverlay) closePicker();
  });
  document.addEventListener('keydown', onKeyDown, true);

  const canSync = options.canSync !== false;
  pickerOverlay.querySelector('.display-models-picker-sync')?.addEventListener('click', async () => {
    if (!canSync) return;
    const syncBtn = pickerOverlay.querySelector('.display-models-picker-sync') as HTMLButtonElement | null;
    if (syncBtn) {
      syncBtn.disabled = true;
      syncBtn.textContent = syncingLabel;
    }
    modelsFetchInFlight += 1;
    renderDialog();
    try {
      fetchedModels = await options.onSync();
      const apiModelIds = fetchedModels.map((model) => model.id);
      const customPart = draftModels.filter((modelId) => !getFetchedModelIds().has(modelId));
      draftModels = [...apiModelIds, ...customPart];
      selectedModels = new Set([...selectedModels].filter((modelId) => draftModels.includes(modelId)));
      renderDialog();
      await persistDraft();
    } catch (e) {
      alert('同步模型失败: ' + String(e));
    } finally {
      modelsFetchInFlight = Math.max(0, modelsFetchInFlight - 1);
      if (syncBtn) {
        syncBtn.disabled = !canSync;
        syncBtn.textContent = syncLabel;
      }
      renderDialog();
    }
  });

  pickerOverlay.querySelector('.display-models-picker-search')?.addEventListener('input', () => {
    const visible = new Set(getAllFilteredModelIds());
    selectedModels = new Set([...selectedModels].filter((modelId) => visible.has(modelId)));
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
    selectedModels = checkbox.checked ? new Set(filtered) : new Set();
    renderDialog();
  });

  pickerOverlay.querySelector('.display-models-bulk-invert')?.addEventListener('click', () => {
    const filtered = getAllFilteredModelIds();
    selectedModels = new Set(filtered.filter((modelId) => !selectedModels.has(modelId)));
    renderDialog();
  });

  pickerOverlay.querySelector('.display-models-bulk-remove')?.addEventListener('click', () => {
    if (selectedModels.size === 0) return;
    void deleteDraftModels([...selectedModels]);
  });

  const handleModelTileClick = (event: Event) => {
    const target = event.target as HTMLElement;
    const tile = target.closest('.display-models-tile') as HTMLElement | null;
    if (!tile || tile.dataset.action !== 'toggle-select') return;
    const modelId = tile.dataset.modelId;
    if (!modelId) return;
    if (selectedModels.has(modelId)) selectedModels.delete(modelId);
    else selectedModels.add(modelId);
    renderDialog();
  };

  pickerOverlay.querySelector('.display-models-api-list')?.addEventListener('click', handleModelTileClick);
  pickerOverlay.querySelector('.display-models-custom-list')?.addEventListener('click', handleModelTileClick);

  document.body.appendChild(pickerOverlay);
  renderDialog();
  (pickerOverlay.querySelector('.display-models-picker-search') as HTMLInputElement | null)?.focus();
}
