import { escapeHtml } from '../../utils';
import { copyTextToClipboard } from '../../utils/clipboard';
import { showToast } from '../../ui';

/**
 * Kiro 模型名复制弹窗。
 *
 * 为什么不复用 `openDisplayModelsPicker`：那是「配置」弹窗 —— 单击卡片是**切换勾选**，
 * 还带批量添加、删除已选、保存等一整套语义。这里的诉求是「挑一个模型名复制走」，
 * 单击即完成、不需要保存。硬套会导致：点一下就变成选中、关不掉弹窗、用户以为改坏了配置。
 * 因此单独实现，但**复用同一套 tile 样式类**，视觉上保持一致。
 */

/** 卡片列表项：模型 ID + 可选归属方（用于展示与筛选） */
export interface KiroModelCopyItem {
  id: string;
  ownedBy?: string | null;
}

/**
 * 按关键词过滤模型。大小写不敏感，匹配 id 与 ownedBy。
 *
 * 抽成纯函数以便单测：过滤是用户唯一的高频交互，边界（空查询、无命中、大小写）
 * 出错会直接表现为「搜不到我想要的模型」。
 */
export function filterKiroCopyModels(
  items: readonly KiroModelCopyItem[],
  query: string,
): KiroModelCopyItem[] {
  const q = query.trim().toLowerCase();
  if (!q) return [...items];
  return items.filter(
    (item) =>
      item.id.toLowerCase().includes(q) ||
      (item.ownedBy ?? '').toLowerCase().includes(q),
  );
}

/** 过滤后命中数量文案（供 aria-live 播报，让键盘/读屏用户也能感知过滤结果） */
export function describeKiroCopyResult(total: number, matched: number): string {
  if (total === 0) return '暂无可复制的模型';
  if (matched === 0) return '无匹配模型';
  return `共 ${total} 个模型，匹配 ${matched} 个`;
}

function renderTile(item: KiroModelCopyItem): string {
  const owner = item.ownedBy?.trim();
  return `
    <button
      type="button"
      class="display-models-tile kiro-model-copy-tile"
      data-model-id="${escapeHtml(item.id)}"
      title="点击复制 ${escapeHtml(item.id)}"
    >
      <span class="display-models-tile-id">${escapeHtml(item.id)}</span>
      ${owner ? `<span class="display-models-tile-owner">${escapeHtml(owner)}</span>` : ''}
    </button>
  `;
}

export interface OpenKiroModelCopyPickerOptions {
  items: KiroModelCopyItem[];
  /**
   * 单击卡片后的复制动作；返回 false 表示复制失败（会提示）。
   * 默认走渲染层剪贴板 —— 模型名不是机密，前端本就有明文，无需绕后端。
   */
  onCopy?: (modelId: string) => Promise<boolean>;
}

/**
 * 打开模型名复制弹窗：支持搜索过滤，单击卡片即复制并关闭。
 */
export function openKiroModelCopyPicker(options: OpenKiroModelCopyPickerOptions): void {
  if (document.querySelector('.kiro-model-copy-overlay')) return;

  const items = options.items;
  const total = items.length;
  const onCopy = options.onCopy ?? copyTextToClipboard;

  const overlay = document.createElement('div');
  overlay.className = 'model-picker-overlay kiro-model-copy-overlay';
  overlay.innerHTML = `
    <div class="model-picker-dialog display-models-picker-dialog kiro-model-copy-dialog" role="dialog" aria-modal="true" aria-label="复制模型名称">
      <div class="model-picker-header">
        <h4 class="model-picker-title">复制模型名称</h4>
        <button type="button" class="model-picker-close" aria-label="关闭">✕</button>
      </div>
      <div class="display-models-picker-toolbar">
        <input
          type="search"
          class="model-picker-search kiro-model-copy-search"
          placeholder="搜索模型名称或归属方"
          autocomplete="off"
        />
      </div>
      <p class="kiro-model-copy-hint">单击模型卡片即可复制该模型名</p>
      <p class="kiro-model-copy-status" role="status" aria-live="polite"></p>
      <div class="display-models-picker-section">
        <div class="display-models-api-list kiro-model-copy-list"></div>
      </div>
    </div>
  `;

  const dialog = overlay.querySelector<HTMLElement>('.kiro-model-copy-dialog')!;
  const listEl = overlay.querySelector<HTMLElement>('.kiro-model-copy-list')!;
  const searchEl = overlay.querySelector<HTMLInputElement>('.kiro-model-copy-search')!;
  const statusEl = overlay.querySelector<HTMLElement>('.kiro-model-copy-status')!;
  const closeBtn = overlay.querySelector<HTMLButtonElement>('.model-picker-close')!;

  let filtered: KiroModelCopyItem[] = [...items];

  const render = () => {
    filtered = filterKiroCopyModels(items, searchEl.value);
    statusEl.textContent = describeKiroCopyResult(total, filtered.length);
    if (filtered.length === 0) {
      listEl.innerHTML = `<div class="model-picker-empty is-filter-empty">${escapeHtml(
        total === 0 ? '暂无可复制的模型，请先启动 Kiro 代理' : '无匹配模型',
      )}</div>`;
      return;
    }
    listEl.innerHTML = filtered.map(renderTile).join('');
  };

  const close = () => {
    document.removeEventListener('keydown', onKeydown, true);
    overlay.remove();
  };

  const onKeydown = (event: KeyboardEvent) => {
    if (event.key === 'Escape') {
      event.stopPropagation();
      close();
    }
  };

  const copyModel = async (modelId: string) => {
    // 防连点：复制成功即关闭，失败则保留弹窗让用户重试
    const tiles = listEl.querySelectorAll<HTMLButtonElement>('.kiro-model-copy-tile');
    tiles.forEach((tile) => {
      tile.disabled = true;
    });
    try {
      const ok = await onCopy(modelId);
      if (ok) {
        close();
      } else {
        showToast('复制失败，请重试');
      }
    } catch (e) {
      console.error('复制模型名失败:', e);
      showToast('复制失败: ' + String(e));
    } finally {
      tiles.forEach((tile) => {
        tile.disabled = false;
      });
    }
  };

  searchEl.addEventListener('input', render);
  overlay.addEventListener('click', (event) => {
    const target = event.target as HTMLElement;
    if (target === overlay) {
      close();
      return;
    }
    const tile = target.closest<HTMLButtonElement>('.kiro-model-copy-tile');
    if (tile) {
      const modelId = tile.dataset.modelId || '';
      if (modelId) void copyModel(modelId);
    }
  });
  closeBtn.addEventListener('click', close);
  document.addEventListener('keydown', onKeydown, true);

  document.body.appendChild(overlay);
  render();
  // 打开即可输入：模型多的时候用户第一动作基本都是搜索
  searchEl.focus();

  // 兜底：对话框高度受 CSS 限制，这里不额外处理滚动
  void dialog;
}
