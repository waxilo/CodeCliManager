import { describe, expect, it, beforeEach } from 'vitest';
import {
  registerUiRefreshExecutor,
  scheduleUiRefresh,
  afterUiRefresh,
  flushUiRefreshNow,
} from './refresh-scheduler';

describe('refresh-scheduler', () => {
  beforeEach(() => {
    // 清掉上一用例遗留的排队 flush（模块级状态）
    flushUiRefreshNow();
    registerUiRefreshExecutor(() => {});
  });

  it('同帧内多次 scheduleUiRefresh 合并为一次 executor 执行', () => {
    const runs: Array<{ chat?: boolean; sidebar?: boolean }> = [];
    registerUiRefreshExecutor((flags) => runs.push(flags as { chat?: boolean; sidebar?: boolean }));

    scheduleUiRefresh({ chat: true });
    scheduleUiRefresh({ chat: true });
    scheduleUiRefresh({ sidebar: true });
    flushUiRefreshNow();

    expect(runs).toHaveLength(1);
    expect(runs[0].chat).toBe(true);
    expect(runs[0].sidebar).toBe(true);
  });

  it('afterUiRefresh 在 executor flush 之后执行', () => {
    const order: string[] = [];
    registerUiRefreshExecutor(() => order.push('executor'));

    scheduleUiRefresh({ chat: true });
    afterUiRefresh(() => order.push('after'));
    flushUiRefreshNow();

    expect(order).toEqual(['executor', 'after']);
  });

  it('无排队 flush 时 afterUiRefresh 推迟到下一帧执行', async () => {
    const order: string[] = [];
    registerUiRefreshExecutor(() => order.push('executor'));

    afterUiRefresh(() => order.push('after'));
    expect(order).toEqual([]);

    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(order).toEqual(['after']);
  });

  it('未调用 flush 前 executor 不执行', () => {
    const runs: Array<Record<string, boolean>> = [];
    registerUiRefreshExecutor((flags) => runs.push({ ...flags }));

    scheduleUiRefresh({ chat: true });
    expect(runs).toHaveLength(0);

    flushUiRefreshNow();
    expect(runs).toHaveLength(1);
  });
});
