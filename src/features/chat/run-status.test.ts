import { describe, expect, it, beforeEach, vi } from 'vitest';
import { appState } from '../../state';
import {
  formatElapsed,
  getSessionRunStatus,
  markSessionRunStart,
  setRunStatusOverride,
  setTransientStatus,
  transferSessionRunTimer,
  refreshRunStatusStrip,
  startRunStatusTicker,
} from './run-status';

const SID = 'conv-test-1';
const BASE = new Date('2026-08-14T00:00:00Z').getTime();

describe('formatElapsed', () => {
  it('不足 1 秒显示小数秒', () => {
    expect(formatElapsed(400)).toBe('0.4s');
  });
  it('1 分钟内显示整秒', () => {
    expect(formatElapsed(12_300)).toBe('12s');
  });
  it('超过 1 分钟显示 M:SS', () => {
    expect(formatElapsed(83_000)).toBe('1:23');
    expect(formatElapsed(754_000)).toBe('12:34');
  });
});

describe('getSessionRunStatus', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-14T00:00:00Z'));
    appState.activeConversationId = SID;
    appState.runningSessions.delete(SID);
    appState.abortingSessions.delete(SID);
    appState.modelRestartingSessions.delete(SID);
    appState.pendingAskQuestions.delete(SID);
    appState.pendingAskQuestions.delete('pending');
    appState.activeToolsBySession.delete(SID);
    appState.streamingBySession.delete(SID);
    appState.sessionRunStartedAt.delete(SID);
    appState.runStatusOverride.delete(SID);
  });

  it('空闲（未运行且无计时）返回 null', () => {
    expect(getSessionRunStatus(SID)).toBeNull();
  });

  it('正在停止优先', () => {
    appState.abortingSessions.add(SID);
    const info = getSessionRunStatus(SID);
    expect(info?.status).toBe('正在停止…');
  });

  it('切换模型优先于一般运行', () => {
    appState.runningSessions.add(SID);
    appState.modelRestartingSessions.add(SID);
    expect(getSessionRunStatus(SID)?.status).toBe('正在切换模型…');
  });

  it('有进行中问答时显示等待选择', () => {
    appState.runningSessions.add(SID);
    appState.pendingAskQuestions.set(SID, { requestId: 'q1', finish: null } as never);
    expect(getSessionRunStatus(SID)?.status).toBe('等待你的选择…');
  });

  it('pending 运行只读取自己的问答状态', () => {
    const pendingSid = 'pending-run-a';
    appState.runningSessions.add(pendingSid);
    appState.pendingAskQuestions.set('pending-run-b', { requestId: 'q-other', finish: null } as never);
    expect(getSessionRunStatus(pendingSid)?.status).toBe('正在处理…');

    appState.pendingAskQuestions.set(pendingSid, { requestId: 'q1', finish: null } as never);
    expect(getSessionRunStatus(pendingSid)?.status).toBe('等待你的选择…');
  });

  it('子代理执行中优先于思考/输入，且带完成计数', () => {
    appState.runningSessions.add(SID);
    appState.activeToolsBySession.set(SID, new Map([
      ['t1', {
        toolUseId: 't1', toolName: 'Task', input: {}, status: 'running', startedAt: Date.now(),
      }],
    ]));
    expect(getSessionRunStatus(SID)?.status).toBe('子代理执行中 · 完成 0/1');
  });

  it('子代理完成计数跟随终态工具数', () => {
    appState.runningSessions.add(SID);
    appState.activeToolsBySession.set(SID, new Map([
      ['t1', {
        toolUseId: 't1', toolName: 'Task', input: {}, status: 'running', startedAt: Date.now(),
      }],
      ['t2', {
        toolUseId: 't2', toolName: 'Task', input: {}, status: 'done', startedAt: Date.now(),
      }],
    ]));
    expect(getSessionRunStatus(SID)?.status).toBe('子代理执行中 · 完成 1/2');
  });

  it('非 Task 工具运行时显示动作描述（Bash 命令等）', () => {
    appState.runningSessions.add(SID);
    appState.activeToolsBySession.set(SID, new Map([
      ['t1', {
        toolUseId: 't1', toolName: 'Bash', input: { command: 'npm test' }, status: 'running', startedAt: Date.now(),
      }],
    ]));
    expect(getSessionRunStatus(SID)?.status).toBe('正在执行: npm test');
  });

  it('工具无输入时回退到动作描述（不显示工具名原文）', () => {
    appState.runningSessions.add(SID);
    appState.activeToolsBySession.set(SID, new Map([
      ['t1', {
        toolUseId: 't1', toolName: 'Grep', input: {}, status: 'running', startedAt: Date.now(),
      }],
    ]));
    expect(getSessionRunStatus(SID)?.status).toBe('正在搜索代码');
  });

  it('仅剩终态工具不阻塞输入中', () => {
    appState.runningSessions.add(SID);
    appState.activeToolsBySession.set(SID, new Map([
      ['t1', {
        toolUseId: 't1', toolName: 'Task', input: {}, status: 'done', startedAt: Date.now(),
      }],
    ]));
    appState.streamingBySession.set(SID, {
      blocks: [{ type: 'text', content: 'hi', finalized: false }],
      thinkingDone: true,
      currentBlockIdx: 0,
    });
    expect(getSessionRunStatus(SID)?.status).toBe('输入中…');
  });

  it('流式正文未完成显示输入中', () => {
    appState.runningSessions.add(SID);
    appState.streamingBySession.set(SID, {
      blocks: [{ type: 'text', content: 'hi', finalized: false }],
      thinkingDone: true,
      currentBlockIdx: 0,
    });
    expect(getSessionRunStatus(SID)?.status).toBe('输入中…');
  });

  it('思考中（thinkingDone=false 且有 thinking 块）', () => {
    appState.runningSessions.add(SID);
    appState.streamingBySession.set(SID, {
      blocks: [{ type: 'thinking', content: 'reasoning' }],
      thinkingDone: false,
      currentBlockIdx: 0,
    });
    expect(getSessionRunStatus(SID)?.status).toBe('思考中…');
  });

  it('运行中但无更多信号时显示正在处理', () => {
    appState.runningSessions.add(SID);
    expect(getSessionRunStatus(SID)?.status).toBe('正在处理…');
  });

  it('临时文案（api_retry）优先展示', () => {
    appState.runningSessions.add(SID);
    appState.runStatusOverride.set(SID, '遇到错误，正在重试…');
    expect(getSessionRunStatus(SID)?.status).toBe('遇到错误，正在重试…');
  });

  it('有计时锚点但会话已空闲 → null', () => {
    appState.sessionRunStartedAt.set(SID, Date.now());
    expect(getSessionRunStatus(SID)).toBeNull();
  });
});

describe('计时锚点', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-14T00:00:00Z'));
    appState.sessionRunStartedAt.clear();
    appState.runStatusOverride.clear();
    appState.activeConversationId = '';
  });

  it('markSessionRunStart 记录起点', () => {
    markSessionRunStart(SID);
    expect(appState.sessionRunStartedAt.get(SID)).toBe(Date.now());
  });

  it('markSessionRunStart 总是覆盖旧锚点（每轮从 0 计时）', () => {
    markSessionRunStart(SID);
    vi.advanceTimersByTime(5000);
    markSessionRunStart(SID);
    expect(appState.sessionRunStartedAt.get(SID)).toBe(BASE + 5000);
  });

  it('transferSessionRunTimer 把 pending 锚点迁移到真实会话', () => {
    appState.sessionRunStartedAt.set('pending', 12345);
    transferSessionRunTimer('pending', SID);
    expect(appState.sessionRunStartedAt.has('pending')).toBe(false);
    expect(appState.sessionRunStartedAt.get(SID)).toBe(12345);
  });

  it('setRunStatusOverride 设置与清除', () => {
    setRunStatusOverride(SID, '正在重试…');
    expect(appState.runStatusOverride.get(SID)).toBe('正在重试…');
    setRunStatusOverride(SID, null);
    expect(appState.runStatusOverride.has(SID)).toBe(false);
  });
});

describe('refreshRunStatusStrip（DOM）', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-14T00:00:00Z'));
    document.body.innerHTML = `
      <div class="composer-status-row" id="composer-status-row" hidden>
        <span class="composer-status-dot" aria-hidden="true"></span>
        <span class="composer-status-text" id="composer-status-text"></span>
        <span class="composer-status-elapsed" id="composer-status-elapsed"></span>
      </div>
    `;
    appState.activeConversationId = SID;
    appState.runningSessions.delete(SID);
    appState.abortingSessions.delete(SID);
    appState.modelRestartingSessions.delete(SID);
    appState.pendingAskQuestions.delete(SID);
    appState.activeToolsBySession.delete(SID);
    appState.streamingBySession.delete(SID);
    appState.sessionRunStartedAt.delete(SID);
    appState.runStatusOverride.delete(SID);
    // 清掉上一个用例残留的余量窗口/活动状态/临时状态，避免跨用例串用
    setTransientStatus(null);
    refreshRunStatusStrip();
    vi.advanceTimersByTime(3100);
    refreshRunStatusStrip();
  });

  it('空闲时隐藏状态条', () => {
    refreshRunStatusStrip();
    const row = document.querySelector<HTMLElement>('#composer-status-row');
    expect(row?.hidden).toBe(true);
  });

  it('运行中展示状态文案与时长', () => {
    appState.runningSessions.add(SID);
    appState.sessionRunStartedAt.set(SID, Date.now() - 5000);
    refreshRunStatusStrip();
    const row = document.querySelector<HTMLElement>('#composer-status-row');
    expect(row?.hidden).toBe(false);
    expect(document.querySelector('.composer-status-text')?.textContent).toBe('正在处理…');
    expect(document.querySelector('.composer-status-elapsed')?.textContent).toBe('5s');
    expect(row?.classList.contains('is-busy')).toBe(true);
  });

  it('思考中状态正确渲染', () => {
    appState.runningSessions.add(SID);
    appState.streamingBySession.set(SID, {
      blocks: [{ type: 'thinking', content: 'reasoning' }],
      thinkingDone: false,
      currentBlockIdx: 0,
    });
    refreshRunStatusStrip();
    expect(document.querySelector('.composer-status-text')?.textContent).toBe('思考中…');
  });

  it('子代理（Agent）执行中：状态文案含计数，计时随锚点走', () => {
    appState.runningSessions.add(SID);
    appState.sessionRunStartedAt.set(SID, Date.now() - 5000);
    appState.activeToolsBySession.set(SID, new Map([
      ['a1', { toolUseId: 'a1', toolName: 'Agent', input: {}, status: 'running', startedAt: 1000 }],
      ['a2', { toolUseId: 'a2', toolName: 'Task', input: {}, status: 'done', startedAt: 1000 }],
    ]));
    refreshRunStatusStrip();
    expect(document.querySelector('.composer-status-text')?.textContent).toBe('子代理执行中 · 完成 1/2');
    expect(document.querySelector('.composer-status-elapsed')?.textContent).toBe('5s');
  });

  it('会话结束后残留的 running 工具不显示「执行中」：状态条进入结束态', () => {
    // 会话已结束（runningSessions 已删），但 activeTools 残留 running 工具
    // （事件丢失 / 中断工具 / turn-complete 清理前）→ 不得显示「正在执行」
    appState.sessionRunStartedAt.set(SID, Date.now() - 5000);
    appState.activeToolsBySession.set(SID, new Map([
      ['a1', { toolUseId: 'a1', toolName: 'Agent', input: {}, status: 'running', startedAt: 1000 }],
    ]));
    appState.streamingBySession.set(SID, {
      blocks: [{ type: 'thinking', content: 'x', finalized: false }],
      thinkingDone: false,
      currentBlockIdx: 0,
    });
    refreshRunStatusStrip();
    expect(document.querySelector('.composer-status-text')?.textContent).not.toBe('子代理执行中');
    expect(document.querySelector('.composer-status-text')?.textContent).not.toBe('正在执行');
    expect(document.querySelector('.composer-status-text')?.textContent).not.toBe('思考中…');
  });

  it('ticker：子代理执行期间无事件，计时也持续走动', () => {
    startRunStatusTicker();
    appState.runningSessions.add(SID);
    appState.sessionRunStartedAt.set(SID, Date.now() - 5000);
    appState.activeToolsBySession.set(SID, new Map([
      ['a1', { toolUseId: 'a1', toolName: 'Agent', input: {}, status: 'running', startedAt: 1000 }],
    ]));
    refreshRunStatusStrip();
    expect(document.querySelector('.composer-status-elapsed')?.textContent).toBe('5s');

    // 子代理安静执行（无任何事件）：ticker 每 250ms 刷新，计时持续走动
    vi.advanceTimersByTime(2000);
    expect(document.querySelector('.composer-status-elapsed')?.textContent).toBe('7s');
  });

  it('运行结束后短暂展示最终时长，再隐藏', () => {
    appState.runningSessions.add(SID);
    appState.sessionRunStartedAt.set(SID, Date.now() - 5000);
    refreshRunStatusStrip();
    expect(document.querySelector('.composer-status-text')?.textContent).toBe('正在处理…');

    // 运行结束 → 展示「已结束 + 最终时长」
    appState.runningSessions.delete(SID);
    refreshRunStatusStrip();
    expect(document.querySelector('.composer-status-text')?.textContent).toBe('已结束');
    expect(document.querySelector('.composer-status-elapsed')?.textContent).toBe('5s');

    // 余量窗口内持续展示
    vi.advanceTimersByTime(1500);
    refreshRunStatusStrip();
    expect(document.querySelector('.composer-status-text')?.textContent).toBe('已结束');

    // 窗口结束 → 隐藏
    vi.advanceTimersByTime(2000);
    refreshRunStatusStrip();
    const row = document.querySelector<HTMLElement>('#composer-status-row');
    expect(row?.hidden).toBe(true);
  });

  it('余量窗口内新一轮运行立即回到实时状态', () => {
    appState.runningSessions.add(SID);
    appState.sessionRunStartedAt.set(SID, Date.now() - 5000);
    refreshRunStatusStrip();
    appState.runningSessions.delete(SID);
    refreshRunStatusStrip();
    expect(document.querySelector('.composer-status-text')?.textContent).toBe('已结束');

    // 快速追问：仍在余量窗口内开始新一轮
    appState.runningSessions.add(SID);
    appState.sessionRunStartedAt.set(SID, Date.now());
    refreshRunStatusStrip();
    expect(document.querySelector('.composer-status-text')?.textContent).toBe('正在处理…');
    expect(document.querySelector('.composer-status-elapsed')?.textContent).toBe('0.0s');
  });

  it('临时状态（Kiro 预检）空闲时也能展示，且不计时长', () => {
    setTransientStatus('正在检查 Kiro 代理…');
    refreshRunStatusStrip();
    const row = document.querySelector<HTMLElement>('#composer-status-row');
    expect(row?.hidden).toBe(false);
    expect(document.querySelector('.composer-status-text')?.textContent).toBe('正在检查 Kiro 代理…');
    expect(document.querySelector('.composer-status-elapsed')?.textContent).toBe('');
    expect(row?.classList.contains('is-busy')).toBe(true);
  });

  it('临时状态优先于会话运行状态', () => {
    appState.runningSessions.add(SID);
    appState.sessionRunStartedAt.set(SID, Date.now() - 5000);
    setTransientStatus('正在检查 Kiro 代理…');
    refreshRunStatusStrip();
    expect(document.querySelector('.composer-status-text')?.textContent).toBe('正在检查 Kiro 代理…');
    expect(document.querySelector('.composer-status-elapsed')?.textContent).toBe('');
  });

  it('清除临时状态后回到会话运行态', () => {
    setTransientStatus('正在检查 Kiro 代理…');
    refreshRunStatusStrip();
    expect(document.querySelector('.composer-status-text')?.textContent).toBe('正在检查 Kiro 代理…');

    appState.runningSessions.add(SID);
    appState.sessionRunStartedAt.set(SID, Date.now() - 5000);
    setTransientStatus(null);
    refreshRunStatusStrip();
    expect(document.querySelector('.composer-status-text')?.textContent).toBe('正在处理…');
    expect(document.querySelector('.composer-status-elapsed')?.textContent).toBe('5s');
  });

  it('切到空闲已久的其他会话不展示余量，且自愈清理残留锚点', () => {
    appState.activeConversationId = 'conv-other';
    appState.sessionRunStartedAt.set('conv-other', Date.now() - 99999);
    refreshRunStatusStrip();
    const row = document.querySelector<HTMLElement>('#composer-status-row');
    expect(row?.hidden).toBe(true);
    expect(appState.sessionRunStartedAt.has('conv-other')).toBe(false);
  });
});
