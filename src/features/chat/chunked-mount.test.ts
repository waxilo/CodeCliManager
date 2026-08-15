import { describe, expect, it, beforeEach, vi } from 'vitest';
import { appState } from '../../state';
import { afterChatMounted, refreshChatContent, resetChatRenderKey } from './refresh';

/**
 * 键控 DOM diff 挂载（H1 彻底方案）行为测试：
 * - 消息渲染输出带 data-message-id；applyChatDom 按 (id, renderKey) 复用既有节点，
 *   内容/状态未变的消息节点保持同一性（保留事件监听、展开态、滚动位置），
 *   只新建变化消息、删除已移除消息。
 * - 首次渲染长会话（无现成节点）或新建节点过多时，回退到分块挂载让出主线程。
 */

function setupChatDomShell(): HTMLElement {
  document.body.innerHTML = `
    <div class="main-content">
      <div class="main-topbar"><div class="main-topbar-main"></div></div>
      <div id="message-list"></div>
    </div>
  `;
  return document.querySelector<HTMLElement>('#message-list')!;
}

/** 构造一个带 N 条消息的会话，并把它设为当前会话 */
function seedConversation(count: number, id = 'c1', contentLen = 20): void {
  const messages = [];
  for (let i = 0; i < count; i++) {
    messages.push({
      id: `m${i}`,
      role: 'user',
      content: `消息 ${i} `.repeat(contentLen),
      timestamp: i,
    });
  }
  appState.conversations = [
    {
      id,
      title: 't',
      platform: 'cli',
      messages,
      created_at: 0,
      updated_at: count,
    },
  ];
  appState.activeConversationId = id;
  appState.activeConversationSourcePath = null;
  appState.pendingUserMessage = null;
  appState.transientSessionError = null;
  appState.messageWindowSizeByConversation.clear();
  appState.runningSessions.clear();
  appState.pendingAskQuestions.clear();
  appState.activeToolsBySession.clear();
  appState.expandedThinkingBlocks.clear();
}

async function flushRaf(rounds = 50): Promise<void> {
  for (let i = 0; i < rounds; i++) {
    await new Promise((resolve) => requestAnimationFrame(() => resolve(null)));
  }
}

describe('applyChatDom 键控 diff 挂载', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
    appState.conversations = [];
    appState.activeConversationId = '';
    appState.activeConversationSourcePath = null;
    appState.messageWindowSizeByConversation.clear();
    vi.restoreAllMocks();
  });

  it('短列表同步挂载完成，afterChatMounted 立即执行', async () => {
    setupChatDomShell();
    seedConversation(5);
    let mounted = 0;
    const rebuilt = refreshChatContent();
    expect(rebuilt).toBe(true);
    afterChatMounted(() => { mounted += 1; });
    const list = document.querySelector<HTMLElement>('#message-list')!;
    expect(list.querySelectorAll('.message[data-message-id]').length).toBe(5);
    expect(mounted).toBe(1);
  });

  it('消息未变时重建：既有消息节点保持同一性（diff 复用，不重建 DOM）', async () => {
    setupChatDomShell();
    seedConversation(3);
    refreshChatContent();
    const list = document.querySelector<HTMLElement>('#message-list')!;
    const firstNode = list.querySelector('.message[data-message-id="m0"]')!;

    resetChatRenderKey();
    refreshChatContent();
    const firstNodeAfter = list.querySelector('.message[data-message-id="m0"]')!;
    expect(firstNodeAfter).toBe(firstNode);
  });

  it('消息内容变化：仅该消息节点被重建，其余节点保持同一性', async () => {
    setupChatDomShell();
    seedConversation(3);
    // 前置 reset：指纹在上一个测试里已被同会话 key 占用，必须先清才能确保真正渲染
    resetChatRenderKey();
    refreshChatContent();
    const list = document.querySelector<HTMLElement>('#message-list')!;
    const before = {
      m0: list.querySelector('.message[data-message-id="m0"]')!,
      m1: list.querySelector('.message[data-message-id="m1"]')!,
      m2: list.querySelector('.message[data-message-id="m2"]')!,
    };

    const conv = appState.conversations[0];
    conv.messages[1] = { ...conv.messages[1], content: 'changed content! '.repeat(30), timestamp: 999 };
    conv.updated_at = 1000;
    resetChatRenderKey();
    refreshChatContent();

    const after = {
      m0: list.querySelector('.message[data-message-id="m0"]')!,
      m1: list.querySelector('.message[data-message-id="m1"]')!,
      m2: list.querySelector('.message[data-message-id="m2"]')!,
    };
    expect(after.m0).toBe(before.m0);
    expect(after.m2).toBe(before.m2);
    expect(after.m1).not.toBe(before.m1);
    expect(after.m1.textContent).toContain('changed content');
  });

  it('消息删除：被移除的消息节点从 DOM 中删除', async () => {
    setupChatDomShell();
    seedConversation(3);
    refreshChatContent();

    const conv = appState.conversations[0];
    conv.messages = conv.messages.slice(1);
    conv.updated_at = 1000;
    resetChatRenderKey();
    refreshChatContent();

    const list = document.querySelector<HTMLElement>('#message-list')!;
    expect(list.querySelector('.message[data-message-id="m0"]')).toBeNull();
    expect(list.querySelectorAll('.message[data-message-id]').length).toBe(2);
  });

  it('长列表首次渲染（无现成节点）：分块挂载，rAF 推进后全部插入', async () => {
    setupChatDomShell();
    seedConversation(90);
    let mounted = 0;
    refreshChatContent();
    afterChatMounted(() => { mounted += 1; });
    const list = document.querySelector<HTMLElement>('#message-list')!;
    await flushRaf();
    expect(list.querySelectorAll('.message[data-message-id]').length).toBe(90);
    expect(mounted).toBe(1);
  });

  it('条数少但总字节超阈值（大工具结果）：同样走分块挂载', async () => {
    setupChatDomShell();
    seedConversation(30, 'big', 20_000);
    let mounted = 0;
    refreshChatContent();
    afterChatMounted(() => { mounted += 1; });
    const list = document.querySelector<HTMLElement>('#message-list')!;
    await flushRaf();
    expect(list.querySelectorAll('.message[data-message-id]').length).toBe(30);
    expect(mounted).toBe(1);
  });
});
