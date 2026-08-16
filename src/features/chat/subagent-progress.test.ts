import { describe, expect, it, beforeEach } from 'vitest';
import { appState } from '../../state';
import { syncRunningSubagentsUI, getRunningSubagents } from './subagent-progress';

/** 构建输入框上方展示区 fixture（与 renderInputComposerHtml 的节点一致） */
function buildHost(): HTMLElement {
  document.body.innerHTML = `
    <div class="input-area">
      <div id="interaction-host" class="interaction-host" hidden></div>
      <div id="running-subagents-host" class="running-subagents-host" hidden></div>
    </div>
  `;
  return document.querySelector<HTMLElement>('#running-subagents-host')!;
}

function addRunningSubagent(
  id: string,
  toolName: 'Task' | 'Agent',
  desc: string,
  status: 'running' | 'done' | 'failed' = 'running',
): void {
  const map = appState.activeToolsBySession.get('conv-1') || new Map();
  map.set(id, {
    toolUseId: id,
    toolName,
    input: { description: desc },
    status,
    isError: status === 'failed',
    startedAt: 1_000,
    ...(status === 'running'
      ? { progress: { status: 'running', totalTokens: 1200, toolUses: 3, durationMs: 4500 } }
      : {}),
  });
  appState.activeToolsBySession.set('conv-1', map);
}

describe('输入框上方「进行中的子代理」展示区', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
    appState.activeToolsBySession.clear();
    appState.activeConversationId = 'conv-1';
  });

  it('有运行中的子代理：展示区可见，行内显示描述 + 执行中 + 进度', () => {
    buildHost();
    addRunningSubagent('t1', 'Task', '分析代码结构');

    syncRunningSubagentsUI();

    const host = document.querySelector<HTMLElement>('#running-subagents-host')!;
    expect(host.hidden).toBe(false);
    expect(host.querySelector('.subagent-desc')?.textContent).toContain('分析代码结构');
    expect(host.querySelector('.subagent-status-text')?.textContent).toBe('执行中');
    expect(host.textContent).toContain('1200 tokens');
    expect(host.textContent).toContain('3 次工具');
    expect(host.textContent).toContain('4.5s');
  });

  it('Agent 子代理同样展示（不只 Task）', () => {
    buildHost();
    addRunningSubagent('a1', 'Agent', '工程审查');

    syncRunningSubagentsUI();

    const host = document.querySelector<HTMLElement>('#running-subagents-host')!;
    expect(host.hidden).toBe(false);
    expect(host.textContent).toContain('工程审查');
  });

  it('已完成/失败的子代理不在展示区（只显示进行中的）', () => {
    buildHost();
    addRunningSubagent('t1', 'Task', '运行中的任务');
    addRunningSubagent('t2', 'Task', '已完成的任务', 'done');
    addRunningSubagent('t3', 'Agent', '失败的任务', 'failed');

    syncRunningSubagentsUI();

    const host = document.querySelector<HTMLElement>('#running-subagents-host')!;
    expect(host.hidden).toBe(false);
    expect(host.textContent).toContain('运行中的任务');
    expect(host.textContent).not.toContain('已完成的任务');
    expect(host.textContent).not.toContain('失败的任务');
  });

  it('无运行中的子代理：展示区隐藏并清空', () => {
    buildHost();
    addRunningSubagent('t1', 'Task', '任务A', 'done');

    syncRunningSubagentsUI();
    const host = document.querySelector<HTMLElement>('#running-subagents-host')!;
    expect(host.hidden).toBe(true);
    expect(host.innerHTML).toBe('');

    // 运行中 → 完成后再次同步：行消失
    addRunningSubagent('t1', 'Task', '任务A');
    syncRunningSubagentsUI();
    expect(host.hidden).toBe(false);
    appState.activeToolsBySession.delete('conv-1');
    syncRunningSubagentsUI();
    expect(host.hidden).toBe(true);
    expect(host.innerHTML).toBe('');
  });

  it('无展示区节点时为空操作', () => {
    document.body.innerHTML = '<div></div>';
    expect(() => syncRunningSubagentsUI()).not.toThrow();
  });

  it('getRunningSubagents 只返回运行中的 Task/Agent', () => {
    addRunningSubagent('t1', 'Task', '任务A');
    addRunningSubagent('t2', 'Task', '任务B', 'done');
    addRunningSubagent('a1', 'Agent', '代理C');
    // 非子代理（脚本）不返回
    const map = appState.activeToolsBySession.get('conv-1')!;
    map.set('b1', {
      toolUseId: 'b1',
      toolName: 'Bash',
      input: { command: 'ls' },
      status: 'running',
      startedAt: 1_000,
    });

    const running = getRunningSubagents('conv-1');
    expect(running.map((t) => t.toolUseId).sort()).toEqual(['a1', 't1']);
  });
});
