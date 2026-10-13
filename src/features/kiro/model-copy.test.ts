import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  describeKiroCopyResult,
  filterKiroCopyModels,
  openKiroModelCopyPicker,
  type KiroModelCopyItem,
} from './model-copy';

vi.mock('../../ui', () => ({
  showToast: vi.fn(),
}));

const ITEMS: KiroModelCopyItem[] = [
  { id: 'auto', ownedBy: 'kiro' },
  { id: 'claude-opus-5.5', ownedBy: 'anthropic' },
  { id: 'claude-sonnet-5', ownedBy: 'anthropic' },
  { id: 'gpt-5.6-sol', ownedBy: 'openai' },
  { id: 'deepseek-3.2', ownedBy: null },
];

describe('Kiro 模型复制：过滤', () => {
  it('空查询返回全部（且不返回同一引用）', () => {
    const result = filterKiroCopyModels(ITEMS, '');
    expect(result).toHaveLength(ITEMS.length);
    expect(result).not.toBe(ITEMS);
  });

  it('纯空白查询等价于空查询', () => {
    expect(filterKiroCopyModels(ITEMS, '   ')).toHaveLength(ITEMS.length);
  });

  it('按模型 ID 子串匹配', () => {
    const ids = filterKiroCopyModels(ITEMS, 'claude').map((m) => m.id);
    expect(ids).toEqual(['claude-opus-5.5', 'claude-sonnet-5']);
  });

  it('匹配大小写不敏感', () => {
    expect(filterKiroCopyModels(ITEMS, 'CLAUDE')).toHaveLength(2);
    expect(filterKiroCopyModels(ITEMS, 'Gpt')).toHaveLength(1);
  });

  it('也能按归属方匹配', () => {
    const ids = filterKiroCopyModels(ITEMS, 'openai').map((m) => m.id);
    expect(ids).toEqual(['gpt-5.6-sol']);
  });

  it('ownedBy 为 null 时不会因读属性抛错', () => {
    expect(filterKiroCopyModels(ITEMS, 'deepseek')).toHaveLength(1);
    expect(() => filterKiroCopyModels(ITEMS, 'x')).not.toThrow();
  });

  it('无命中返回空数组', () => {
    expect(filterKiroCopyModels(ITEMS, 'zzz-not-exist')).toEqual([]);
  });
});

describe('Kiro 模型复制：结果文案', () => {
  it('无候选时说明要先启动代理', () => {
    expect(describeKiroCopyResult(0, 0)).toContain('暂无');
  });

  it('有候选但无命中时提示无匹配', () => {
    expect(describeKiroCopyResult(21, 0)).toContain('无匹配');
  });

  it('同时给出总数与命中数', () => {
    const text = describeKiroCopyResult(21, 3);
    expect(text).toContain('21');
    expect(text).toContain('3');
  });
});

describe('Kiro 模型复制：弹窗', () => {
  function query(selector: string): HTMLElement | null {
    return document.querySelector(selector);
  }

  beforeEach(() => {
    document.body.innerHTML = '';
  });

  it('渲染全部模型，单击卡片复制该模型并关闭弹窗', async () => {
    const onCopy = vi.fn().mockResolvedValue(true);
    openKiroModelCopyPicker({ items: ITEMS, onCopy });

    const tiles = document.querySelectorAll('.kiro-model-copy-tile');
    expect(tiles).toHaveLength(ITEMS.length);
    expect(query('.kiro-model-copy-overlay')).not.toBeNull();

    const target = query('[data-model-id="gpt-5.6-sol"]') as HTMLButtonElement;
    target.click();
    await vi.waitFor(() => {
      expect(onCopy).toHaveBeenCalledWith('gpt-5.6-sol');
    });
    await vi.waitFor(() => {
      expect(query('.kiro-model-copy-overlay')).toBeNull();
    });
  });

  it('搜索框过滤卡片', async () => {
    openKiroModelCopyPicker({ items: ITEMS, onCopy: vi.fn().mockResolvedValue(true) });
    const search = query('.kiro-model-copy-search') as HTMLInputElement;

    search.value = 'claude';
    search.dispatchEvent(new Event('input', { bubbles: true }));

    const ids = [...document.querySelectorAll('.kiro-model-copy-tile')].map(
      (el) => (el as HTMLElement).dataset.modelId,
    );
    expect(ids).toEqual(['claude-opus-5.5', 'claude-sonnet-5']);
  });

  it('过滤无命中时展示空态文案，且不渲染卡片', () => {
    openKiroModelCopyPicker({ items: ITEMS, onCopy: vi.fn().mockResolvedValue(true) });
    const search = query('.kiro-model-copy-search') as HTMLInputElement;

    search.value = 'zzz';
    search.dispatchEvent(new Event('input', { bubbles: true }));

    expect(document.querySelectorAll('.kiro-model-copy-tile')).toHaveLength(0);
    expect(query('.model-picker-empty')?.textContent).toContain('无匹配');
  });

  it('复制失败时保留弹窗，便于重试', async () => {
    const onCopy = vi.fn().mockResolvedValue(false);
    openKiroModelCopyPicker({ items: ITEMS, onCopy });

    (query('[data-model-id="auto"]') as HTMLButtonElement).click();
    await vi.waitFor(() => {
      expect(onCopy).toHaveBeenCalledWith('auto');
    });
    expect(query('.kiro-model-copy-overlay')).not.toBeNull();
  });

  it('复制抛错时不静默：弹窗保留、错误被吞在内部不冒泡', async () => {
    const onCopy = vi.fn().mockRejectedValue(new Error('clipboard denied'));
    openKiroModelCopyPicker({ items: ITEMS, onCopy });

    (query('[data-model-id="auto"]') as HTMLButtonElement).click();
    await vi.waitFor(() => {
      expect(onCopy).toHaveBeenCalled();
    });
    expect(query('.kiro-model-copy-overlay')).not.toBeNull();
  });

  it('候选为空时展示引导文案', () => {
    openKiroModelCopyPicker({ items: [], onCopy: vi.fn().mockResolvedValue(true) });
    expect(query('.model-picker-empty')?.textContent).toContain('暂无');
  });

  it('Esc 关闭弹窗', () => {
    openKiroModelCopyPicker({ items: ITEMS, onCopy: vi.fn().mockResolvedValue(true) });
    expect(query('.kiro-model-copy-overlay')).not.toBeNull();

    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(query('.kiro-model-copy-overlay')).toBeNull();
  });

  it('重复打开不会叠加多个弹窗', () => {
    openKiroModelCopyPicker({ items: ITEMS, onCopy: vi.fn().mockResolvedValue(true) });
    openKiroModelCopyPicker({ items: ITEMS, onCopy: vi.fn().mockResolvedValue(true) });
    expect(document.querySelectorAll('.kiro-model-copy-overlay')).toHaveLength(1);
  });
});
