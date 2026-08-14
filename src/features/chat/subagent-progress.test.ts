import { describe, expect, it, beforeEach } from 'vitest';
import { appState } from '../../state';
import { syncSubagentProgressUI } from './subagent-progress';

function buildContainer(): void {
  document.body.innerHTML = `
    <div class="app-container">
      <div class="main-content">
        <div id="message-list"></div>
      </div>
    </div>
  `;
}

function addRunningTask(): void {
  appState.activeToolsBySession.set(
    'conv-1',
    new Map([
      [
        't1',
        {
          toolUseId: 't1',
          toolName: 'Task',
          input: { description: '子任务' },
          status: 'running',
          isError: false,
          startedAt: 1_000,
        },
      ],
    ]),
  );
}

describe('subagent 面板（主输出页面已移除子代理卡，面板保持原样展示）', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
    appState.activeToolsBySession.clear();
    appState.activeConversationId = 'conv-1';
  });

  it('有子代理时挂载面板并加 has-subagent-panel class', () => {
    buildContainer();
    addRunningTask();

    syncSubagentProgressUI();

    expect(document.querySelector('#subagent-progress')).not.toBeNull();
    expect(
      document.querySelector('.app-container')!.classList.contains('has-subagent-panel'),
    ).toBe(true);
  });

  it('无子代理时移除面板并去掉布局 class', () => {
    buildContainer();
    addRunningTask();
    syncSubagentProgressUI();
    expect(document.querySelector('#subagent-progress')).not.toBeNull();

    appState.activeToolsBySession.clear();
    syncSubagentProgressUI();

    expect(document.querySelector('#subagent-progress')).toBeNull();
    expect(
      document.querySelector('.app-container')!.classList.contains('has-subagent-panel'),
    ).toBe(false);
  });

  it('无子代理时不误加面板（不依赖输入状态）', () => {
    buildContainer();
    syncSubagentProgressUI();
    const container = document.querySelector('.app-container')!;
    expect(container.classList.contains('has-subagent-panel')).toBe(false);
    expect(document.querySelector('#subagent-progress')).toBeNull();
  });
});
