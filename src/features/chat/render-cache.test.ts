import { describe, expect, it, beforeEach } from 'vitest';
import {
  renderCacheKey,
  getCurrentChatRenderKey,
  getCurrentCommittedChatRenderKey,
} from './refresh';
import { appState } from '../../state';
import type { Conversation, ActiveToolState } from '../../types';
import { conversationInstanceKey } from '../conversations/normalize';

function conv(id: string, updatedAt: number): Conversation {
  return {
    id,
    title: 't',
    platform: 'cli',
    messages: [{ id: 'm1', role: 'user', content: 'hi', timestamp: 1 }],
    created_at: 1,
    updated_at: updatedAt,
  };
}

describe('renderCacheKey（按会话渲染缓存键）', () => {
  beforeEach(() => {
    appState.activeConversationId = 'c1';
    appState.activeConversationSourcePath = null;
    appState.messageWindowSizeByConversation.clear();
    appState.runningSessions.clear();
    appState.pendingUserMessage = null;
    appState.transientSessionError = null;
    appState.pendingAskQuestions.clear();
    appState.activeToolsBySession.clear();
    appState.expandedThinkingBlocks.clear();
  });

  it('内容签名变化（updated_at / 消息数）时 key 变化，避免复用过期 HTML', () => {
    const c = conv('c1', 100);
    const k1 = renderCacheKey(c);
    expect(renderCacheKey(conv('c1', 101))).not.toBe(k1);
    expect(renderCacheKey({ ...c, messages: [...c.messages, { id: 'm2', role: 'assistant', content: 'x', timestamp: 1 }] })).not.toBe(k1);
  });

  it('切换消息窗口大小使 key 变化', () => {
    const c = conv('c1', 100);
    const k1 = renderCacheKey(c);
    appState.messageWindowSizeByConversation.set(conversationInstanceKey('c1', null), 400);
    expect(renderCacheKey(c)).not.toBe(k1);
  });

  it('展开/折叠思考块使 key 变化（避免缓存退回旧的折叠态）', () => {
    const c = conv('c1', 100);
    const k1 = renderCacheKey(c);
    appState.expandedThinkingBlocks.add('think-1');
    expect(renderCacheKey(c)).not.toBe(k1);
  });

  it('同一状态下 key 稳定', () => {
    const c = conv('c1', 100);
    expect(renderCacheKey(c)).toBe(renderCacheKey(c));
  });

  it('工具转态改变 full key 但不改变「已提交内容」key（管理页退出不因工具转态重建）', () => {
    appState.conversations = [conv('c1', 100)];
    appState.activeConversationId = 'c1';
    appState.activeConversationSourcePath = null;

    const fullBefore = getCurrentChatRenderKey();
    const committedBefore = getCurrentCommittedChatRenderKey();

    // 模拟运行中会话工具转态：tool_result 到达，工具从 running → done
    const task: ActiveToolState = {
      toolUseId: 't1',
      toolName: 'Task',
      input: {},
      status: 'done',
      isError: false,
      toolResult: 'ok',
      startedAt: 1_000,
    };
    appState.activeToolsBySession.set('c1', new Map([['t1', task]]));

    // full key 变（activeToolsSignature 进入）……
    expect(getCurrentChatRenderKey()).not.toBe(fullBefore);
    // ……但已提交内容 key 不变（工具签名被排除）
    expect(getCurrentCommittedChatRenderKey()).toBe(committedBefore);

    // 已提交内容变化（新消息落盘）才让 committed key 变化
    const active = appState.conversations[0];
    active.messages.push({ id: 'm2', role: 'assistant', content: 'x', timestamp: 2 });
    expect(getCurrentCommittedChatRenderKey()).not.toBe(committedBefore);

    appState.conversations = [];
    appState.activeConversationId = '';
    appState.activeConversationSourcePath = null;
    appState.activeToolsBySession.clear();
  });

  it('消息窗口按会话独立记忆：切走再切回，c1 的扩展窗口仍保留', () => {
    const c1 = conv('c1', 100);
    const c2 = conv('c2', 100);
    appState.activeConversationId = 'c1';
    const k1Base = renderCacheKey(c1);
    appState.messageWindowSizeByConversation.set(conversationInstanceKey('c1', null), 600);
    const k1Expanded = renderCacheKey(c1);
    expect(k1Expanded).not.toBe(k1Base);

    // 切到 c2：c2 默认窗口，不受 c1 的扩展影响
    appState.activeConversationId = 'c2';
    const k2 = renderCacheKey(c2);
    expect(k2).not.toBe(k1Expanded);

    // 切回 c1：扩展窗口仍在，key 与 c1 扩大后一致
    appState.activeConversationId = 'c1';
    expect(renderCacheKey(c1)).toBe(k1Expanded);
  });
});
