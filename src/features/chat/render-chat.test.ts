import { describe, expect, it, beforeEach } from 'vitest';
import {
  splitMessageWindow,
  renderConversationMessagesInnerHtml,
  ensureMessageWindowForActiveConversation,
  getActiveMessageWindowSize,
  incrementActiveMessageWindow,
  renderChatAreaHtml,
  buildDisplayMessages,
} from './render-chat';
import { appState, MAX_VISIBLE_MESSAGES } from '../../state';
import type { Conversation, Message } from '../../types';

function message(id: string, role: Message['role'], content: string): Message {
  return { id, role, content, timestamp: 1 };
}

describe('splitMessageWindow', () => {
  it('窗口足够大时返回全部消息', () => {
    const msgs = [message('a', 'user', 'hi'), message('b', 'assistant', 'hello')];
    const { visible, totalHidden } = splitMessageWindow(msgs, 10);
    expect(visible).toEqual(msgs);
    expect(totalHidden).toBe(0);
  });

  it('只保留尾部窗口并报告隐藏条数', () => {
    const msgs = Array.from({ length: 250 }, (_, i) =>
      message(`m${i}`, i % 2 === 0 ? 'user' : 'assistant', `msg ${i}`),
    );
    const { visible, totalHidden } = splitMessageWindow(msgs, 200);
    expect(totalHidden).toBe(50);
    expect(visible).toHaveLength(200);
    expect(visible[0].id).toBe('m50');
    expect(visible[199].id).toBe('m249');
  });

  it('窗口起点是 tool_result 时回退纳入其 tool_use，避免结果无来源', () => {
    const msgs = [
      message('u', 'user', 'q'),
      message('t', 'tool_use', '{"name":"Bash","id":"bash-1"}'),
      message('r', 'tool_result', '{"tool_use_id":"bash-1","content":"ok"}'),
      message('a', 'assistant', 'done'),
    ];
    const { visible, totalHidden } = splitMessageWindow(msgs, 2);
    expect(totalHidden).toBe(1);
    expect(visible.map((m) => m.id)).toEqual(['t', 'r', 'a']);
  });
});

describe('renderConversationMessagesInnerHtml tail-N 窗口', () => {
  beforeEach(() => {
    appState.activeConversationId = 'conv-1';
    appState.activeConversationSourcePath = null;
    appState.messageWindowSizeByConversation.clear();
    appState.runningSessions.clear();
    appState.pendingUserMessage = null;
    appState.pendingUserMessageConvId = null;
    appState.transientSessionError = null;
    appState.pendingAskQuestions.clear();
    appState.activeToolsBySession.clear();
  });

  it('超过窗口时顶部渲染「加载更早」按钮', () => {
    const msgs = Array.from({ length: 250 }, (_, i) =>
      message(`m${i}`, i % 2 === 0 ? 'user' : 'assistant', `msg ${i}`),
    );
    const html = renderConversationMessagesInnerHtml(msgs);
    expect(html).toContain('load-earlier-btn');
    expect(html).toContain('加载更早的 50 条消息');
  });

  it('窗口内不渲染「加载更早」按钮', () => {
    const msgs = [message('a', 'user', 'hi')];
    const html = renderConversationMessagesInnerHtml(msgs);
    expect(html).not.toContain('load-earlier-btn');
  });

  it('消息窗口按会话独立记忆：切换会话不丢失各自累计值', () => {
    // 会话 A 扩到 600 条
    appState.activeConversationId = 'conv-1';
    ensureMessageWindowForActiveConversation();
    incrementActiveMessageWindow(400);
    expect(getActiveMessageWindowSize()).toBe(600);

    // 切到会话 B：默认窗口
    appState.activeConversationId = 'conv-2';
    expect(getActiveMessageWindowSize()).toBe(MAX_VISIBLE_MESSAGES);

    // 切回会话 A：仍保留 600
    appState.activeConversationId = 'conv-1';
    expect(getActiveMessageWindowSize()).toBe(600);
  });
});

describe('renderChatAreaHtml shellOnly（全量渲染聊天壳不序列化消息）', () => {
  beforeEach(() => {
    appState.activeConversationId = 'conv-1';
    appState.activeConversationSourcePath = null;
    appState.messageWindowSizeByConversation.clear();
    appState.runningSessions.clear();
    appState.pendingUserMessage = null;
    appState.pendingUserMessageConvId = null;
    appState.transientSessionError = null;
    appState.pendingAskQuestions.clear();
    appState.activeToolsBySession.clear();
    appState.conversations = [{
      id: 'conv-1',
      title: '会话',
      platform: 'cli',
      messages: [
        message('m1', 'user', 'hi'),
        message('m2', 'assistant', 'hello'),
      ],
      created_at: 1,
      updated_at: 2,
    } satisfies Conversation];
  });

  it('shellOnly 只出空壳，消息列表不含任何消息内容', () => {
    const html = renderChatAreaHtml({ shellOnly: true });
    expect(html).toContain('id="message-list"');
    expect(html).toContain('id="message-input"');
    // 关键：不内联任何会话消息，避免全量重建时把全部消息序列化进大 innerHTML
    expect(html).not.toContain('>hi</');
    expect(html).not.toContain('>hello</');
    // 稳定壳永久包含 content layer 与 bottom sentinel，但不含 managed 消息。
    const root = document.createElement('div');
    root.innerHTML = html;
    expect(root.querySelector('#message-list > [data-chat-content]')).not.toBeNull();
    expect(root.querySelector('[data-chat-content] > [data-chat-bottom]')).not.toBeNull();
    expect(root.querySelector('[data-chat-content] > .message')).toBeNull();
  });

  it('非 shellOnly 正常内联全部消息（行为不变）', () => {
    const html = renderChatAreaHtml();
    expect(html).toContain('>hi</');
    expect(html).toContain('>hello</');
  });
});

describe('buildDisplayMessages：主视图过滤子代理（Task）卡，保留 Agent 卡', () => {
  function toolUse(id: string, name: string, input: Record<string, unknown>): Message {
    return {
      id: `tu-${id}`,
      role: 'tool_use',
      content: JSON.stringify({ name, tool_name: name, input, id }),
      timestamp: 1,
    };
  }

  function toolResult(toolUseId: string, content: string): Message {
    return {
      id: `tr-${toolUseId}`,
      role: 'tool_result',
      content: JSON.stringify({ content, tool_use_id: toolUseId }),
      timestamp: 1,
    };
  }

  it('历史 Task tool_use 与其 tool_result 一并移除，Agent tool_use 保留', () => {
    const msgs: Message[] = [
      { id: 'u1', role: 'user', content: '跑子代理', timestamp: 1 },
      toolUse('call_task_1', 'Task', { description: '子代理任务' }),
      toolResult('call_task_1', 'task done'),
      toolUse('call_agent_1', 'Agent', { description: 'Agent 审查' }),
      toolResult('call_agent_1', 'agent result'),
      { id: 'a1', role: 'assistant', content: '完成', timestamp: 1 },
    ];
    const out = buildDisplayMessages({ id: 'c1', messages: msgs } as never);
    expect(out.map((m) => m.role)).toEqual(['user', 'tool_use', 'tool_result', 'assistant']);
    // 保留的是 Agent 的 tool_use + tool_result，Task 的已移除
    expect(JSON.stringify(out)).toContain('call_agent_1');
    expect(JSON.stringify(out)).not.toContain('call_task_1');
    expect(JSON.stringify(out)).not.toContain('task done');
  });

  it('无对应 tool_result 的孤立 Task tool_use 也移除', () => {
    const msgs: Message[] = [
      toolUse('call_task_x', 'Task', { description: 'x' }),
      { id: 'a1', role: 'assistant', content: 'ok', timestamp: 1 },
    ];
    const out = buildDisplayMessages({ id: 'c1', messages: msgs } as never);
    expect(out.map((m) => m.role)).toEqual(['assistant']);
  });
});
