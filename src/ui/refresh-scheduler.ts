/**
 * 中央 UI 刷新调度器：把同帧 / 短窗内多次 UI 刷新请求合并成一次 RAF 执行，
 * 避免 Win WebView2 上连点会话 / 流式高频更新导致的同步 innerHTML 重建堆积。
 *
 * 用法：
 *   scheduleUiRefresh()                      // 聊天区内容刷新（最重）
 *   scheduleUiRefresh({ sidebar: true })     // 侧栏运行态刷新
 *   afterUiRefresh(() => { ... })            // 在本次 flush 完成后执行（滚动置底 / 恢复流式块）
 *
 * executor 由 bootstrap 注册（依赖注入，避免 scheduler ↔ features 循环依赖）。
 */
export interface UiRefreshFlags {
  chat?: boolean;
  sidebar?: boolean;
  subagent?: boolean;
  todo?: boolean;
  titlebar?: boolean;
  balance?: boolean;
}

export type UiRefreshExecutor = (flags: UiRefreshFlags) => void;

/** 两次 flush 的最小间隔（与 scheduleStreamingRefresh 的 100ms 节流对齐） */
const MIN_INTERVAL_MS = 100;

let executor: UiRefreshExecutor | null = null;
let rafId: number | null = null;
let lastFlushTime = 0;
let pending: UiRefreshFlags = {};
const afterFlushCallbacks: Array<() => void> = [];

/** bootstrap 启动时注入真正的执行器 */
export function registerUiRefreshExecutor(fn: UiRefreshExecutor): void {
  executor = fn;
}

/** 请求一次合并后的 UI 刷新（同帧内重复调用自动合并为一次） */
export function scheduleUiRefresh(flags: UiRefreshFlags = {}): void {
  if (flags.chat) pending.chat = true;
  if (flags.sidebar) pending.sidebar = true;
  if (flags.subagent) pending.subagent = true;
  if (flags.todo) pending.todo = true;
  if (flags.titlebar) pending.titlebar = true;
  if (flags.balance) pending.balance = true;

  if (rafId !== null) return;
  rafId = requestAnimationFrame(tick);
}

function tick(timestamp: number): void {
  rafId = null;
  if (timestamp - lastFlushTime < MIN_INTERVAL_MS) {
    rafId = requestAnimationFrame(tick);
    return;
  }
  flush();
}

function flush(): void {
  lastFlushTime = performance.now();
  const flags = pending;
  pending = {};
  if (executor) {
    executor(flags);
  }
  const callbacks = afterFlushCallbacks.splice(0, afterFlushCallbacks.length);
  for (const cb of callbacks) {
    try {
      cb();
    } catch (e) {
      console.error('[ui-refresh] afterUiRefresh 回调异常:', e);
    }
  }
}

/**
 * 在本次（或下一次）UI flush 完成后执行回调。
 * 若已有排队的 flush，则挂到 flush 之后；否则下一帧执行——
 * 保证回调一定发生在 DOM 重建 / 滚动恢复之后（避免 setTimeout(0) 抢先于 RAF 重建）。
 */
export function afterUiRefresh(cb: () => void): void {
  if (rafId !== null) {
    afterFlushCallbacks.push(cb);
    return;
  }
  requestAnimationFrame(() => cb());
}

/** 立即同步执行一次 flush（测试 / 手动场景；正常路径不要调用） */
export function flushUiRefreshNow(): void {
  if (rafId !== null) {
    cancelAnimationFrame(rafId);
    rafId = null;
  }
  flush();
}
