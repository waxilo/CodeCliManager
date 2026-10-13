import { beforeEach, describe, expect, it, vi } from 'vitest';
import { renderKiroViewHtml } from './view';

const usageMock = vi.fn();

vi.mock('../../api', () => ({
  kiroUsage: (...args: unknown[]) => usageMock(...args),
}));

const USAGE_OLD = {
  currentUsage: 100,
  usageLimit: 500,
  remaining: 400,
  percentUsed: 20,
  subscriptionTitle: 'KIRO PRO MAX',
  nextResetAt: null,
  daysUntilReset: 19,
};
const USAGE_NEW = {
  ...USAGE_OLD,
  currentUsage: 183.79,
  remaining: 4816.21,
  percentUsed: 3.7,
};

function usageText(): string | null {
  return document.querySelector('#kiro-view [data-kiro-usage]')?.textContent ?? null;
}

/**
 * 模块级缓存在同一测试文件内会跨用例存活，所以每个用例都要 `resetModules`
 * 重新 import，才能拿到真正「从未查到过」的冷启动状态。
 */
async function freshPanel() {
  vi.resetModules();
  const panel = await import('./panel');
  const view = await import('./view');
  const { appState } = await import('../../state');
  // 渲染结果只在「页面处于激活态」时才会写回 DOM（与真实挂载一致）
  appState.isKiroViewActive = true;
  document.body.innerHTML = view.renderKiroViewHtml();
  return panel;
}

describe('Kiro 账户额度：先展示旧值，异步查到新值再替换', () => {
  beforeEach(() => {
    usageMock.mockReset();
    document.body.innerHTML = renderKiroViewHtml();
  });

  it('冷启动（无任何旧值）才显示「查询中…」占位', async () => {
    const panel = await freshPanel();
    let resolveUsage!: (v: unknown) => void;
    usageMock.mockReturnValueOnce(new Promise((r) => { resolveUsage = r; }));

    const pending = panel.refreshKiroUsage();
    expect(usageText()).toBe('查询中…');
    resolveUsage(USAGE_NEW);
    await pending;
    expect(usageText()).toContain('183.79');
  });

  it('已有旧值时：重建页面立即回填旧值，新值到达后原地替换', async () => {
    const panel = await freshPanel();

    // 第一次查询拿到「旧值」，写入缓存
    usageMock.mockResolvedValueOnce(USAGE_OLD);
    await panel.refreshKiroUsage();
    const first = usageText();
    expect(first).toContain('100');

    // 模拟「重新进入页面」：overlay 重建，DOM 回到初始的 —
    document.body.innerHTML = renderKiroViewHtml();
    expect(usageText()).toBe('—');

    // 挂载流程先回填缓存 —— 立刻看到旧值，且与上次完全一致
    panel.restoreKiroUsageCache();
    expect(usageText()).toBe(first);

    // 随后异步查询返回新值 → 原地替换
    usageMock.mockResolvedValueOnce(USAGE_NEW);
    await panel.refreshKiroUsage();
    expect(usageText()).toContain('183.79');
    expect(usageText()).not.toBe(first);
  });

  it('刷新过程中不把旧值抹成「查询中…」', async () => {
    const panel = await freshPanel();
    usageMock.mockResolvedValueOnce(USAGE_OLD);
    await panel.refreshKiroUsage();
    const old = usageText();

    let resolveUsage!: (v: unknown) => void;
    usageMock.mockReturnValueOnce(new Promise((r) => { resolveUsage = r; }));
    const pending = panel.refreshKiroUsage();

    // 关键断言：查询进行中，屏幕上仍是旧值
    expect(usageText()).toBe(old);
    expect(usageText()).not.toBe('查询中…');

    resolveUsage(USAGE_NEW);
    await pending;
    expect(usageText()).toContain('183.79');
  });

  it('查询失败但有旧值时保留旧值（不替换成错误文案）', async () => {
    const panel = await freshPanel();
    usageMock.mockResolvedValueOnce(USAGE_OLD);
    await panel.refreshKiroUsage();
    const old = usageText();

    usageMock.mockRejectedValueOnce(new Error('network down'));
    await panel.refreshKiroUsage();

    expect(usageText()).toBe(old);
    expect(usageText()).not.toContain('查询失败');
  });

  it('无缓存时查询失败才展示失败提示', async () => {
    const panel = await freshPanel();
    usageMock.mockRejectedValueOnce(new Error('boom'));
    await panel.refreshKiroUsage();
    expect(usageText()).toContain('查询失败');
  });

  it('无缓存时 restoreKiroUsageCache 不改动 DOM（交给冷启动占位）', async () => {
    const panel = await freshPanel();
    panel.restoreKiroUsageCache();
    expect(usageText()).toBe('—');
  });

  it('clearKiroUsageCache 后不再回填旧值（代理重启可能换账号）', async () => {
    const panel = await freshPanel();
    usageMock.mockResolvedValueOnce(USAGE_OLD);
    await panel.refreshKiroUsage();
    expect(usageText()).toContain('100');

    // 丢弃缓存 —— 之后再重建页面就不该出现上一轮的额度
    panel.clearKiroUsageCache();
    document.body.innerHTML = renderKiroViewHtml();
    panel.restoreKiroUsageCache();
    expect(usageText()).toBe('—');

    // 且下次刷新回到冷启动占位语义（有真实结果就正常写入）
    usageMock.mockResolvedValueOnce(USAGE_NEW);
    await panel.refreshKiroUsage();
    expect(usageText()).toContain('183.79');
  });
});
