import { describe, expect, it, beforeEach, vi } from 'vitest';
import { appState } from '../../state';
import { syncActiveToolCardsInMessageList } from './streaming';
import { handleMessageChunk } from './streaming';

const SID = 'sess-1';

function setupShell(): void {
  document.body.innerHTML = `
    <div class="main-content">
      <div id="message-list"></div>
    </div>`;
  appState.activeConversationId = SID;
  appState.activeConversationSourcePath = null;
  appState.activeToolsBySession.clear();
  appState.runningSessions.clear();
  appState.streamingBySession.clear();
  appState.pendingTextDelta.clear();
  appState.streamRefreshBySession.clear();
  appState.pendingAskQuestions.clear();
  appState.todosBySession.clear();
}

describe('主消息流实时工具卡（参考 claudecodeui / Codex）', () => {
  beforeEach(() => {
    setupShell();
    vi.restoreAllMocks();
  });

  it('运行中的普通工具渲染为实时卡，完成后移除', () => {
    // tool_use_start（Bash）→ 实时卡出现
    handleMessageChunk({
      conversation_id: SID,
      kind: 'tool_use_start',
      content: JSON.stringify({ id: 't1', name: 'Bash', index: 0 }),
    });
    // tool_result 到达（完成态）
    handleMessageChunk({
      conversation_id: SID,
      kind: 'tool_result',
      content: JSON.stringify({ tool_use_id: 't1', content: 'ok', is_error: false }),
    });

    const list = document.querySelector<HTMLElement>('#message-list')!;
    const card = list.querySelector('[data-live-tool-id="t1"]');
    // tool_result 后状态为 done：实时卡应移除（running 才显示）
    expect(card).toBeNull();
  });

  it('运行中的 Bash 工具卡展示命令', () => {
    appState.activeToolsBySession.set(SID, new Map([
      ['t1', {
        toolUseId: 't1', toolName: 'Bash', input: { command: 'npm test' }, status: 'running', startedAt: Date.now(),
      }],
    ]));
    syncActiveToolCardsInMessageList(SID);
    const list = document.querySelector<HTMLElement>('#message-list')!;
    const card = list.querySelector('[data-live-tool-id="t1"]');
    expect(card).not.toBeNull();
    expect(card!.textContent).toContain('npm test');
  });

  it('运行中的子代理（Task）渲染为实时容器卡并展示进度', () => {
    appState.activeToolsBySession.set(SID, new Map([
      ['task1', {
        toolUseId: 'task1', toolName: 'Task', input: { description: '分析代码' }, status: 'running', startedAt: Date.now(),
        progress: { status: 'running', totalTokens: 1200, toolUses: 3, durationMs: 4500 },
      }],
    ]));
    syncActiveToolCardsInMessageList(SID);
    const list = document.querySelector<HTMLElement>('#message-list')!;
    const card = list.querySelector('[data-live-tool-id="task1"]');
    expect(card).not.toBeNull();
    expect(card!.textContent).toContain('1K tokens');
    expect(card!.textContent).toContain('子代理执行中');
  });

  it('无活动工具时清空实时卡容器', () => {
    syncActiveToolCardsInMessageList(SID);
    const list = document.querySelector<HTMLElement>('#message-list')!;
    expect(list.querySelector('#live-tool-cards')).toBeNull();
  });
});
