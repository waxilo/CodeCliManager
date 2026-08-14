import { appState } from '../../state';

/**
 * 输入框下方状态条：由权威状态（runningSessions / streamingBySession /
 * activeToolsBySession / abortingSessions / pendingAskQuestions）派生当前执行状态，
 * 并从计时锚点计算执行时长。
 *
 * 生命周期设计：
 * - 锚点（sessionRunStartedAt）在每次新执行开始时「总是覆盖」——语义为「本轮执行时长」，
 *   无需判断是否续跑；追问/排队续跑也会各自从 0 计时。
 * - 结束不做任何显式记录：状态条在展示层检测「活跃 → 空闲」的转变，自愈删除残留锚点，
 *   并短暂展示最终时长（余量）后再隐藏。因此不存在「漏调结束函数导致计时泄漏」的脆弱点。
 */

/** 运行结束后的余量展示时长（ms）：完成后短暂显示最终时长再隐藏 */
const LINGER_MS = 3000;

/** 输入框下方「执行时长」格式化：<1s → 0.4s，<1min → 12s，否则 M:SS */
export function formatElapsed(ms: number): string {
  if (ms < 0) return '0s';
  const totalSeconds = Math.floor(ms / 1000);
  if (totalSeconds < 1) return `${(ms / 1000).toFixed(1)}s`;
  if (totalSeconds < 60) return `${totalSeconds}s`;
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${seconds.toString().padStart(2, '0')}`;
}

export interface RunStatusInfo {
  status: string;
  /** 本轮运行已耗时（无计时锚点时为 null） */
  elapsedMs: number | null;
  /** 是否属于「进行中」动画状态（状态点脉冲） */
  busy: boolean;
}

/**
 * 从 appState 派生当前会话的运行状态。
 * 优先级：临时文案(api_retry) > 停止中 > 切换模型 > 等待选择 > 子代理 > 工具 > 输入中 > 思考中 > 处理中。
 * 空闲（未运行、无流式、无工具、无计时锚点）返回 null → 状态条隐藏。
 */
export function getSessionRunStatus(sessionId: string): RunStatusInfo | null {
  const override = appState.runStatusOverride.get(sessionId);
  const startedAt = appState.sessionRunStartedAt.get(sessionId);
  const elapsedMs = startedAt != null ? Date.now() - startedAt : null;
  const running = appState.runningSessions.has(sessionId);

  if (override) return { status: override, elapsedMs, busy: true };

  if (appState.abortingSessions.has(sessionId)) {
    return { status: '正在停止…', elapsedMs, busy: false };
  }
  if (appState.modelRestartingSessions.has(sessionId)) {
    return { status: '正在切换模型…', elapsedMs, busy: false };
  }

  const hasAsk =
    appState.pendingAskQuestions.has(sessionId) ||
    appState.pendingAskQuestions.has('pending');
  if (hasAsk && (running || startedAt != null)) {
    return { status: '等待你的选择…', elapsedMs, busy: false };
  }

  const tools = appState.activeToolsBySession.get(sessionId);
  if (tools && tools.size > 0) {
    const taskStates = [...tools.values()].filter((t) => t.toolName === 'Task');
    const runningTasks = taskStates.filter((t) => t.status === 'running');
    if (runningTasks.length > 0) {
      const done = taskStates.filter((t) => t.status === 'done').length;
      return { status: `子代理执行中 · 完成 ${done}/${taskStates.length}`, elapsedMs, busy: true };
    }
    const runningTool = [...tools.values()].find((t) => t.status === 'running');
    if (runningTool) {
      return { status: `正在执行工具 ${runningTool.toolName}`, elapsedMs, busy: true };
    }
  }

  if (!running && startedAt == null) return null;

  const streaming = appState.streamingBySession.get(sessionId);
  if (streaming) {
    const lastText = [...streaming.blocks].reverse().find((b) => b.type === 'text');
    if (lastText && !lastText.finalized) {
      return { status: '输入中…', elapsedMs, busy: true };
    }
    if (!streaming.thinkingDone && streaming.blocks.some((b) => b.type === 'thinking')) {
      return { status: '思考中…', elapsedMs, busy: true };
    }
  }

  if (running) return { status: '正在处理…', elapsedMs, busy: true };
  return null;
}

/** 记录本轮运行起点。总是覆盖：每次新的执行（发送/重试/追问派发/续跑）都从 0 重新计时。 */
export function markSessionRunStart(sessionId: string): void {
  appState.sessionRunStartedAt.set(sessionId, Date.now());
  refreshRunStatusStrip();
}

/** pending → 真实会话时把计时锚点与临时文案一起迁移。 */
export function transferSessionRunTimer(from: string, to: string): void {
  const start = appState.sessionRunStartedAt.get(from);
  if (start !== undefined) {
    appState.sessionRunStartedAt.set(to, start);
    appState.sessionRunStartedAt.delete(from);
  }
  const override = appState.runStatusOverride.get(from);
  if (override !== undefined) {
    appState.runStatusOverride.set(to, override);
    appState.runStatusOverride.delete(from);
  }
  refreshRunStatusStrip();
}

/** 临时状态文案（api_retry 等），传 null 清除。 */
export function setRunStatusOverride(sessionId: string, text: string | null): void {
  if (text == null) {
    appState.runStatusOverride.delete(sessionId);
  } else {
    appState.runStatusOverride.set(sessionId, text);
  }
  refreshRunStatusStrip();
}

/** 与会话无关的临时状态（发送前 Kiro 预检等）：在状态条展示，不计时，不占会话锚点。 */
let transientStatus: string | null = null;

/** 设置/清除全局临时状态文案。设置后状态条优先展示该文案，清除后回到会话运行态。 */
export function setTransientStatus(text: string | null): void {
  transientStatus = text;
  refreshRunStatusStrip();
}

/** 最近一次刷新的状态条元素与内容 key，避免无变化时反复写 DOM */
let lastRowEl: HTMLElement | null = null;
let lastRenderedKey = '';
/** 最近一次刷新的会话；切换会话时重置活动/余量状态，避免跨会话串用 */
let lastSessionId = '';
/** 该会话最近一次「活动渲染」的时刻（ms）；用于判断「刚结束」以触发最终时长余量 */
let lastActiveAt = 0;
/** 运行结束后的余量展示（最终时长），非空表示正处于余量窗口内 */
let lingering: { status: string; text: string } | null = null;
let lingerUntil = 0;

function renderStrip(
  row: HTMLElement,
  status: string,
  elapsedText: string,
  busy: boolean,
): void {
  const key = `${busy ? 'b' : 's'}|${status}|${elapsedText}`;
  if (key === lastRenderedKey) return;
  lastRenderedKey = key;
  row.hidden = false;
  row.classList.toggle('is-busy', busy);
  const text = row.querySelector<HTMLElement>('.composer-status-text');
  const elapsed = row.querySelector<HTMLElement>('.composer-status-elapsed');
  if (text) text.textContent = status;
  if (elapsed) elapsed.textContent = elapsedText;
}

function hideStrip(row: HTMLElement): void {
  if (lastRenderedKey === 'h') return;
  lastRenderedKey = 'h';
  row.hidden = true;
}

/** 把当前会话的运行状态 + 执行时长刷进输入框下方的状态条。无状态条元素时为空操作。 */
export function refreshRunStatusStrip(): void {
  const row = document.querySelector<HTMLElement>('#composer-status-row');
  if (!row) return;
  if (lastRowEl !== row) {
    // 全量渲染重建了状态条 DOM：重置 key，避免「内容相同被跳过」导致新元素停在模板初始态
    lastRowEl = row;
    lastRenderedKey = '';
  }

  // 全局临时状态（发送前 Kiro 预检等）优先展示，不参与会话计时/余量逻辑
  if (transientStatus) {
    renderStrip(row, transientStatus, '', true);
    return;
  }

  const sessionId = appState.activeConversationId || 'pending';
  if (sessionId !== lastSessionId) {
    lastSessionId = sessionId;
    lastActiveAt = 0;
    lingering = null;
  }

  const info = getSessionRunStatus(sessionId);

  if (info) {
    // 进行中：实时状态；取消可能残留的余量
    lingering = null;
    lastActiveAt = Date.now();
    const elapsedText = info.elapsedMs != null ? formatElapsed(info.elapsedMs) : '';
    renderStrip(row, info.status, elapsedText, info.busy);
    return;
  }

  // 空闲：若正处于余量窗口内，继续展示最终时长
  if (lingering && Date.now() < lingerUntil) {
    renderStrip(row, lingering.status, lingering.text, false);
    return;
  }
  lingering = null;

  // 刚结束（锚点仍在、距上次活动很近）：短暂展示最终时长后隐藏，并自愈清理锚点
  const anchor = appState.sessionRunStartedAt.get(sessionId);
  if (anchor !== undefined && Date.now() - lastActiveAt < LINGER_MS) {
    lingering = { status: '已结束', text: formatElapsed(Date.now() - anchor) };
    lingerUntil = Date.now() + LINGER_MS;
    renderStrip(row, lingering.status, lingering.text, false);
    appState.sessionRunStartedAt.delete(sessionId);
    appState.runStatusOverride.delete(sessionId);
    return;
  }

  // 常规空闲：自愈清理残留锚点/临时文案，隐藏
  appState.sessionRunStartedAt.delete(sessionId);
  appState.runStatusOverride.delete(sessionId);
  hideStrip(row);
}

let tickerStarted = false;

/**
 * 启动全局状态条定时器（空闲且隐藏时为空转，不做任何 DOM 写入）。
 * 幂等，应在应用启动（setupEventListeners）调用一次。
 */
export function startRunStatusTicker(): void {
  if (tickerStarted) return;
  tickerStarted = true;
  setInterval(() => {
    const row = document.querySelector<HTMLElement>('#composer-status-row');
    if (!row) return;
    if (row.hidden && !getSessionRunStatus(appState.activeConversationId || 'pending') && !transientStatus) {
      return;
    }
    refreshRunStatusStrip();
  }, 250);
}
