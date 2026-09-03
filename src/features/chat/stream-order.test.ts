import { describe, expect, it, beforeEach, vi } from 'vitest';
import { appState } from '../../state';
import { handleMessageChunk } from './streaming';
import { refreshChatContent, resetChatRenderKey } from './refresh';
import { renderStreamingBlocksChunks } from './render-chat';

const SID = 's1';

function setup(): void {
  document.body.innerHTML = `
    <div class="main-content">
      <div class="main-topbar"><div class="main-topbar-main"></div></div>
      <div class="message-list-shell">
        <div id="message-list">
          <div class="message-content-layer" data-chat-content>
            <div class="chat-bottom-sentinel" data-chat-bottom></div>
          </div>
        </div>
        <button class="scroll-to-bottom-btn" type="button"></button>
      </div>
    </div>`;
  appState.conversations = [{ id: SID, title: 't', platform: 'cli', messages: [], created_at: 0, updated_at: 0 }];
  appState.activeConversationId = SID;
  appState.activeConversationSourcePath = null;
  appState.activePendingSessionKey = '';
  appState.pendingUserMessagesBySession.clear();
  appState.transientSessionErrorsBySession.clear();
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

function chunk(kind: string, content = ''): void {
  handleMessageChunk({ conversation_id: SID, kind, content });
}

function domSequence(): string[] {
  refreshChatContent();
  const content = document.querySelector<HTMLElement>('[data-chat-content]')!;
  return [...content.children].map((el) => {
    const sid = el.getAttribute('data-stream-id') || '';
    if (sid.startsWith('streaming-block-')) return `block:${sid}`;
    if (sid.startsWith('live-tool-')) return `tool:${sid.replace('live-tool-', '')}`;
    return el.className;
  }).filter((s) => s.startsWith('block:') || s.startsWith('tool:'));
}

/**
 * 流式输出顺序回归测试（真实事件路径）：
 * - Claude 直连：thinking → tool_use → text，工具卡插在思考块之后；
 * - kiro/OpenAI 兼容上游：tool_use 先于 reasoning，工具卡排最前。
 * 覆盖 tool_use_end / task_started 覆盖状态时丢失 blockIndexAtStart 的回归。
 */
describe('真实事件路径的流式顺序', () => {
  it('工具锚点使相邻段拆分时仍保留创建时的永久 segmentId', () => {
    const blocks = [
      { segmentId: 'streaming-block-7', type: 'text' as const, content: 'A', finalized: false },
      { segmentId: 'streaming-block-8', type: 'text' as const, content: 'B', finalized: false },
    ];

    const merged = renderStreamingBlocksChunks(blocks);
    expect(merged.map((chunk) => chunk.id)).toEqual(['streaming-block-7']);

    const split = renderStreamingBlocksChunks(blocks, new Set([0]));
    expect(split.map((chunk) => chunk.id)).toEqual([
      'streaming-block-7',
      'streaming-block-8',
    ]);
  });

  beforeEach(() => { setup(); vi.restoreAllMocks(); });

  it('kiro 场景：tool_use_start 先于 thinking_start → 工具卡在最前，思考块在后', () => {
    appState.runningSessions.add(SID);
    // 工具先开始（此时无任何流式块）
    chunk('tool_use_start', JSON.stringify({ id: 't1', name: 'Read', index: 0 }));
    chunk('tool_use_end', JSON.stringify({ id: 't1', name: 'Read', input: { file_path: '/a.rs' }, index: 0 }));
    // 思考随后输出
    chunk('thinking_start', '');
    chunk('thinking_delta', '先看代码再下结论');
    chunk('thinking_end', JSON.stringify({ duration_ms: 100 }));
    // 文本
    chunk('text_start', '');
    chunk('text_delta', '分析结果');
    chunk('text_end', '');
    const seq = domSequence();
    console.log('kiro事件序列:', seq.join(' | '));
    // 工具卡在前，思考块中间，文本块最后
    expect(seq[0]).toBe('tool:t1');
    expect(seq[1]).toBe('block:streaming-block-0');
    expect(seq[2]).toBe('block:streaming-block-1');
  });

  it('Claude 直连：thinking_start 先 → 工具卡插思考块后，文本块最后', () => {
    appState.runningSessions.add(SID);
    chunk('thinking_start', '');
    chunk('thinking_delta', '先思考');
    chunk('tool_use_start', JSON.stringify({ id: 't1', name: 'Read', index: 0 }));
    chunk('tool_use_end', JSON.stringify({ id: 't1', name: 'Read', input: { file_path: '/a.rs' }, index: 0 }));
    chunk('thinking_end', JSON.stringify({ duration_ms: 100 }));
    chunk('text_start', '');
    chunk('text_delta', '结果');
    chunk('text_end', '');
    const seq = domSequence();
    console.log('直连事件序列:', seq.join(' | '));
    expect(seq[0]).toBe('block:streaming-block-0');
    expect(seq[1]).toBe('tool:t1');
    expect(seq[2]).toBe('block:streaming-block-1');
  });

  it('text → tool → text：后一个文本块最终化后工具卡仍保持居中', () => {
    appState.runningSessions.add(SID);
    chunk('text_start', '');
    chunk('text_delta', '工具前说明');
    chunk('text_end', '');
    chunk('tool_use_start', JSON.stringify({ id: 't1', name: 'Read', index: 0 }));
    chunk('tool_use_end', JSON.stringify({ id: 't1', name: 'Read', input: { file_path: '/a.rs' }, index: 0 }));
    chunk('text_start', '');
    chunk('text_delta', '工具后说明');

    expect(domSequence()).toEqual([
      'block:streaming-block-0',
      'tool:t1',
      'block:streaming-block-1',
    ]);

    chunk('text_end', '');
    expect(domSequence()).toEqual([
      'block:streaming-block-0',
      'tool:t1',
      'block:streaming-block-1',
    ]);
  });

  it('thinking → tool → thinking：后一个思考块最终化后工具卡仍保持居中', () => {
    appState.runningSessions.add(SID);
    chunk('thinking_start', '');
    chunk('thinking_delta', '工具前思考');
    chunk('thinking_end', JSON.stringify({ duration_ms: 100 }));
    chunk('tool_use_start', JSON.stringify({ id: 't1', name: 'Read', index: 0 }));
    chunk('tool_use_end', JSON.stringify({ id: 't1', name: 'Read', input: { file_path: '/a.rs' }, index: 0 }));
    chunk('thinking_start', '');
    chunk('thinking_delta', '工具后思考');

    expect(domSequence()).toEqual([
      'block:streaming-block-0',
      'tool:t1',
      'block:streaming-block-1',
    ]);

    chunk('thinking_end', JSON.stringify({ duration_ms: 200 }));
    expect(domSequence()).toEqual([
      'block:streaming-block-0',
      'tool:t1',
      'block:streaming-block-1',
    ]);
  });
});
