import { describe, expect, it, beforeEach, vi } from 'vitest';
import { appState } from '../../state';
import { handleMessageChunk, syncStreamingBlocksInPlace, reconcileActiveToolsWithHistory } from './streaming';
import { refreshChatContent, resetChatRenderKey } from './refresh';

const SID = 'sess-1';

function setupShell(): void {
  document.body.innerHTML = `
    <div class="main-content">
      <div class="main-topbar"><div class="main-topbar-main"></div></div>
      <div id="message-list"></div>
    </div>
  `;
  appState.conversations = [
    {
      id: SID,
      title: 't',
      platform: 'cli',
      messages: [],
      created_at: 0,
      updated_at: 0,
    },
  ];
  appState.activeConversationId = SID;
  appState.activeConversationSourcePath = null;
  appState.pendingUserMessage = null;
  appState.transientSessionError = null;
  appState.activeToolsBySession.clear();
  appState.runningSessions.clear();
  appState.streamingBySession.clear();
  appState.pendingTextDelta.clear();
  appState.streamRefreshBySession.clear();
  appState.pendingAskQuestions.clear();
  appState.todosBySession.clear();
  appState.expandedThinkingBlocks.clear();
  appState.messageWindowSizeByConversation.clear();
  resetChatRenderKey();
}

describe('统一渲染管线：实时工具卡与流式块（同一 diff 挂载）', () => {
  beforeEach(() => {
    setupShell();
    vi.restoreAllMocks();
  });

  it('工具完成后卡片保留并显示完成态；active 项被清理后才移除', () => {
    // tool_use_start（Bash）→ 实时卡出现
    handleMessageChunk({
      conversation_id: SID,
      kind: 'tool_use_start',
      content: JSON.stringify({ id: 't1', name: 'Bash', index: 0 }),
    });
    refreshChatContent();
    // tool_result 到达（完成态）
    handleMessageChunk({
      conversation_id: SID,
      kind: 'tool_result',
      content: JSON.stringify({ tool_use_id: 't1', content: 'ok', is_error: false }),
    });
    refreshChatContent();

    const list = document.querySelector<HTMLElement>('#message-list')!;
    const card = list.querySelector('[data-stream-id="live-tool-t1"]');
    // tool_result 后状态为 done：卡片保留（等待历史落盘接管），并展示完成态而非运行中
    expect(card).not.toBeNull();
    expect(card!.textContent).toContain('完成');
    expect(card!.classList.contains('streaming')).toBe(false);

    // 历史落盘后 active 项被 reconcile 删除 → 实时卡随之移除（由历史渲染接管）
    appState.activeToolsBySession.delete(SID);
    refreshChatContent();
    expect(list.querySelector('[data-stream-id="live-tool-t1"]')).toBeNull();
  });

  it('运行中的 Bash 工具卡展示命令', () => {
    appState.activeToolsBySession.set(SID, new Map([
      ['t1', {
        toolUseId: 't1', toolName: 'Bash', input: { command: 'npm test' }, status: 'running', startedAt: Date.now(),
      }],
    ]));
    refreshChatContent();
    const list = document.querySelector<HTMLElement>('#message-list')!;
    const card = list.querySelector('[data-stream-id="live-tool-t1"]');
    expect(card).not.toBeNull();
    expect(card!.textContent).toContain('npm test');
    expect(card!.classList.contains('streaming')).toBe(true);
  });

  it('运行中的子代理（Task）渲染为实时容器卡并展示进度', () => {
    appState.activeToolsBySession.set(SID, new Map([
      ['task1', {
        toolUseId: 'task1', toolName: 'Task', input: { description: '分析代码' }, status: 'running', startedAt: Date.now(),
        progress: { status: 'running', totalTokens: 1200, toolUses: 3, durationMs: 4500 },
      }],
    ]));
    refreshChatContent();
    const list = document.querySelector<HTMLElement>('#message-list')!;
    const card = list.querySelector('[data-stream-id="live-tool-task1"]');
    expect(card).not.toBeNull();
    expect(card!.textContent).toContain('1K tokens');
    expect(card!.textContent).toContain('子代理执行中');
  });

  it('无活动工具时清空所有实时工具卡', () => {
    appState.activeToolsBySession.set(SID, new Map([
      ['t1', {
        toolUseId: 't1', toolName: 'Bash', input: { command: 'ls' }, status: 'running', startedAt: Date.now(),
      }],
    ]));
    refreshChatContent();
    appState.activeToolsBySession.delete(SID);
    refreshChatContent();
    const list = document.querySelector<HTMLElement>('#message-list')!;
    expect(list.querySelector('[data-stream-id^="live-tool-"]')).toBeNull();
  });

  it('工具卡插到开始时的流式块之后（思考-工具-思考穿插）', () => {
    // 流式状态：thinking 块(0) + text 块(1)；工具在块 0 开始时启动
    appState.streamingBySession.set(SID, {
      blocks: [
        { type: 'thinking', content: '思考中...' },
        { type: 'text', content: '正文', finalized: false },
      ],
      thinkingDone: false,
      currentBlockIdx: 0,
    });
    appState.activeToolsBySession.set(SID, new Map([
      ['t1', {
        toolUseId: 't1', toolName: 'Bash', input: { command: 'npm test' },
        status: 'running', startedAt: Date.now(), blockIndexAtStart: 0,
      }],
    ]));
    refreshChatContent();

    const list = document.querySelector<HTMLElement>('#message-list')!;
    const block0 = list.querySelector('[data-stream-id="streaming-block-0"]')!;
    const block1 = list.querySelector('[data-stream-id="streaming-block-1"]')!;
    const card = list.querySelector('[data-stream-id="live-tool-t1"]')!;
    // 工具卡应位于 block0 与 block1 之间（思考-工具-思考按真实顺序穿插）
    const children = [...list.children];
    expect(children.indexOf(block0)).toBeLessThan(children.indexOf(card));
    expect(children.indexOf(card)).toBeLessThan(children.indexOf(block1));
  });

  it('工具先于思考（无流式块时启动）：工具卡排在思考块之前，不颠倒顺序', () => {
    // kiro/OpenAI 兼容上游：tool_use 先于 reasoning 输出。
    // 工具启动时还没有任何流式块（blockIndexAtStart = -1）→ 工具卡应排在最前，
    // 后出现的思考块排在它后面（真实时间顺序），而不是思考块跑到工具卡上面。
    appState.activeToolsBySession.set(SID, new Map([
      ['t1', {
        toolUseId: 't1', toolName: 'Read', input: { file_path: '/src/lib.rs' },
        status: 'running', startedAt: Date.now(), blockIndexAtStart: -1,
      }],
    ]));
    refreshChatContent();
    // 思考块随后出现
    appState.streamingBySession.set(SID, {
      blocks: [{ type: 'thinking', content: '先看代码再下结论', finalized: false }],
      thinkingDone: false,
      currentBlockIdx: 0,
    });
    refreshChatContent();

    const list = document.querySelector<HTMLElement>('#message-list')!;
    const card = list.querySelector('[data-stream-id="live-tool-t1"]')!;
    const block = list.querySelector('[data-stream-id="streaming-block-0"]')!;
    const children = [...list.children];
    expect(children.indexOf(card)).toBeLessThan(children.indexOf(block));
  });

  it('text 块节点按 id 复用：delta 就地追加，不重建 DOM', () => {
    appState.streamingBySession.set(SID, {
      blocks: [{ type: 'text', content: 'hello', finalized: false }],
      thinkingDone: true,
      currentBlockIdx: 0,
    });
    refreshChatContent();
    const list = document.querySelector<HTMLElement>('#message-list')!;
    const block = list.querySelector('[data-stream-id="streaming-block-0"]')!;
    expect(block.querySelector('.markdown-body')!.textContent).toBe('hello');

    // 内容追加 → 同一节点，文本就地追加
    const state = appState.streamingBySession.get(SID)!;
    state.blocks[0].content = 'hello world';
    refreshChatContent();
    const blockAfter = list.querySelector('[data-stream-id="streaming-block-0"]')!;
    expect(blockAfter).toBe(block);
    expect(blockAfter.querySelector('.markdown-body')!.textContent).toBe('hello world');
  });

  it('思考块结束：renderKey 变化重建节点，内容与时长保留', () => {
    appState.streamingBySession.set(SID, {
      blocks: [{ type: 'thinking', content: '先想后做', durationMs: 1234 }],
      thinkingDone: true,
      currentBlockIdx: 0,
    });
    refreshChatContent();
    const list = document.querySelector<HTMLElement>('#message-list')!;
    const block = list.querySelector('[data-stream-id="streaming-block-0"]')!;
    expect(block.classList.contains('streaming')).toBe(false);
    expect(block.textContent).toContain('先想后做');
    expect(block.textContent).toContain('2s');
    // 思考块默认折叠（DSH 样式）
    expect(block.querySelector('.thinking-block')!.hasAttribute('open')).toBe(false);
  });

  it('syncStreamingBlocksInPlace 幂等：text 块重复同步不重复追加', () => {
    appState.streamingBySession.set(SID, {
      blocks: [{ type: 'text', content: 'data', finalized: false }],
      thinkingDone: true,
      currentBlockIdx: 0,
    });
    refreshChatContent();
    const list = document.querySelector<HTMLElement>('#message-list')!;
    syncStreamingBlocksInPlace(SID);
    syncStreamingBlocksInPlace(SID);
    const block = list.querySelector('[data-stream-id="streaming-block-0"]')!;
    expect(block.querySelector('.markdown-body')!.textContent).toBe('data');
  });

  it('子代理「启动成功」元数据结果不置完成：保持运行中，真结果到达才完成', () => {
    handleMessageChunk({
      conversation_id: SID,
      kind: 'tool_use_start',
      content: JSON.stringify({ id: 'a1', name: 'Agent', index: 0 }),
    });
    refreshChatContent();
    // 新版 Claude Code 异步子代理：启动即回 "Async agent launched successfully" 元数据
    handleMessageChunk({
      conversation_id: SID,
      kind: 'tool_result',
      content: JSON.stringify({
        tool_use_id: 'a1',
        content: 'Async agent launched successfully.\nagentId: abc (internal metadata)',
        is_error: false,
      }),
    });
    refreshChatContent();
    const list = document.querySelector<HTMLElement>('#message-list')!;
    const card = list.querySelector('[data-stream-id="live-tool-a1"]')!;
    // 元数据不是完成信号：卡保持运行中
    expect(card.textContent).toContain('运行中');
    expect(card.classList.contains('streaming')).toBe(true);
    // 真实结果（子代理完成）到达才显示完成
    handleMessageChunk({
      conversation_id: SID,
      kind: 'tool_result',
      content: JSON.stringify({ tool_use_id: 'a1', content: '## 报告\n\n正文', is_error: false }),
    });
    refreshChatContent();
    const cardAfter = list.querySelector('[data-stream-id="live-tool-a1"]')!;
    expect(cardAfter.textContent).toContain('完成');
    expect(cardAfter.classList.contains('streaming')).toBe(false);
  });

  it('reconcile：历史里子代理 tool_use 只带启动元数据结果时，不判完成、不删 active 卡', () => {
    appState.activeToolsBySession.set(SID, new Map([
      ['a1', {
        toolUseId: 'a1', toolName: 'Agent', input: {}, status: 'running', startedAt: Date.now(),
      }],
    ]));
    // 历史已落盘 Agent tool_use + 启动元数据 result（子代理仍在运行）
    reconcileActiveToolsWithHistory(SID, [
      {
        id: 'tu-1', role: 'tool', content: '{}', timestamp: 1,
        toolData: {
          toolName: 'Agent', toolInput: {}, toolUseId: 'a1', displayMode: 'collapsible',
          toolResult: 'Async agent launched successfully.\nagentId: abc (internal metadata)',
          isError: false,
          colorScheme: { border: '#999', icon: '#999', primary: '#999' },
        },
      },
    ]);
    const active = appState.activeToolsBySession.get(SID);
    expect(active).toBeDefined();
    expect(active!.get('a1')!.status).toBe('running');
  });
});
