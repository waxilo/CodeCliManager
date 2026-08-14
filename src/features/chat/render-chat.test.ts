import { describe, expect, it, beforeEach } from 'vitest';
import {
  splitMessageWindow,
  renderConversationMessagesInnerHtml,
  ensureMessageWindowForActiveConversation,
  getActiveMessageWindowSize,
  incrementActiveMessageWindow,
} from './render-chat';
import { appState, MAX_VISIBLE_MESSAGES } from '../../state';
import type { Message } from '../../types';

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
