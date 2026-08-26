import { describe, expect, it, beforeEach, vi } from 'vitest';
import { appState } from '../../state';
import { afterChatMounted, refreshChatContent, resetChatRenderKey, getLastChatRenderKey } from './refresh';

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
  }, 20_000);
});

describe('applyChatDom 纯追加快速路径（流式 tick 滚动稳定）', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
    appState.conversations = [];
    appState.activeConversationId = '';
    appState.activeConversationSourcePath = null;
    appState.messageWindowSizeByConversation.clear();
    appState.runningSessions.clear();
    appState.pendingAskQuestions.clear();
    appState.activeToolsBySession.clear();
    appState.streamingBySession.clear();
    appState.expandedThinkingBlocks.clear();
    vi.restoreAllMocks();
  });

  it('流式追加（前缀匹配）：已挂载节点不被摘除重建，新节点追加到末尾', async () => {
    setupChatDomShell();
    seedConversation(2);
    resetChatRenderKey();
    refreshChatContent();
    const list = document.querySelector<HTMLElement>('#message-list')!;
    const m0 = list.querySelector('.message[data-message-id="m0"]')!;
    const m1 = list.querySelector('.message[data-message-id="m1"]')!;

    // 模拟流式新块/新消息追加：会话追加一条消息
    const conv = appState.conversations[0];
    conv.messages.push({ id: 'm2', role: 'assistant', content: '新增内容', timestamp: 3 });
    conv.updated_at = 3;
    resetChatRenderKey();
    refreshChatContent();

    const children = [...list.children].filter((el) =>
      (el as HTMLElement).classList?.contains('message'),
    );
    expect(children.length).toBe(3);
    expect(children[0]).toBe(m0); // 节点引用保持（未被 remove 重建）
    expect(children[1]).toBe(m1);
    expect(children[2].getAttribute('data-message-id')).toBe('m2');
    expect(children[2].textContent).toContain('新增内容');
  });

  it('前缀不匹配（中间消息变化）时不走追加路径，正常 diff 重建该节点', async () => {
    setupChatDomShell();
    seedConversation(3);
    resetChatRenderKey();
    refreshChatContent();
    const list = document.querySelector<HTMLElement>('#message-list')!;
    const m0 = list.querySelector('.message[data-message-id="m0"]')!;

    // 修改中间消息 m1（renderKey 变化 → 前缀不匹配）
    const conv = appState.conversations[0];
    conv.messages[1] = { ...conv.messages[1], content: 'changed!', timestamp: 9 };
    conv.updated_at = 9;
    resetChatRenderKey();
    refreshChatContent();

    const m0After = list.querySelector('.message[data-message-id="m0"]')!;
    expect(m0After).toBe(m0);
    expect(
      list.querySelector('.message[data-message-id="m1"]')!.textContent,
    ).toContain('changed!');
  });
});

describe('canAppendOnly 判定（含回到底部按钮场景）', () => {
  it('列表带「回到底部」按钮时仍判为可追加（生产环境按钮常驻 messageList）', () => {
    setupChatDomShell();
    seedConversation(2);
    resetChatRenderKey();
    refreshChatContent();
    const list = document.querySelector<HTMLElement>('#message-list')!;
    // setupMessageListPostRender 已创建 answerScroller 的浮动按钮
    const btn = list.querySelector('.scroll-to-bottom-btn');
    expect(btn).not.toBeNull();

    const conv = appState.conversations[0];
    conv.messages.push({ id: 'm2', role: 'user', content: 'x', timestamp: 3 });
    conv.updated_at = 3;
    resetChatRenderKey();
    refreshChatContent();

    // 快速路径生效：按钮引用保持（未被移除重建）、新消息追加
    expect(list.querySelector('.scroll-to-bottom-btn')).toBe(btn);
    const children = [...list.children].filter((el) =>
      (el as HTMLElement).classList?.contains('message'),
    );
    expect(children.length).toBe(3);
    expect(children[2].getAttribute('data-message-id')).toBe('m2');
  });

  it('残留问卡等非消息节点 → 不判为可追加', () => {
    setupChatDomShell();
    seedConversation(1);
    resetChatRenderKey();
    refreshChatContent();
    const list = document.querySelector<HTMLElement>('#message-list')!;
    const junk = document.createElement('div');
    junk.className = 'ask-card';
    list.appendChild(junk);

    const conv = appState.conversations[0];
    conv.messages.push({ id: 'm1', role: 'user', content: 'x', timestamp: 3 });
    conv.updated_at = 3;
    resetChatRenderKey();
    refreshChatContent();
    // 慢路径兜底：残留被清理，新消息正常挂载
    expect(list.querySelector('.ask-card')).toBeNull();
    expect(
      list.querySelector('.message[data-message-id="m1"]'),
    ).not.toBeNull();
  });
});

describe('管理页 stash 期间指纹冻结（退出后 diff 补新块）', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
    appState.conversations = [];
    appState.activeConversationId = '';
    appState.activeConversationSourcePath = null;
    appState.messageWindowSizeByConversation.clear();
    appState.runningSessions.clear();
    appState.pendingAskQuestions.clear();
    appState.activeToolsBySession.clear();
    appState.streamingBySession.clear();
    appState.expandedThinkingBlocks.clear();
    vi.restoreAllMocks();
  });

  it('消息列表缺席（stash）期间指纹不更新；恢复后流式新块被 diff 创建', async () => {
    setupChatDomShell();
    seedConversation(1);
    appState.streamingBySession.set('c1', {
      blocks: [{ type: 'thinking', content: '块A', finalized: false }],
      thinkingDone: false,
      currentBlockIdx: 0,
    });
    resetChatRenderKey();
    refreshChatContent();
    const keyBefore = getLastChatRenderKey();
    expect(document.querySelector('[data-stream-id="streaming-block-0"]')).not.toBeNull();

    // 模拟管理页 stash：摘走 message-list
    const list = document.querySelector<HTMLElement>('#message-list')!;
    list.remove();

    // stash 期间流式推进：新增 text 块
    const state = appState.streamingBySession.get('c1')!;
    state.blocks.push({ type: 'text', content: '块B', finalized: false });
    refreshChatContent();
    // 指纹未被更新（缺席早退，不渲染）
    expect(getLastChatRenderKey()).toBe(keyBefore);

    // 恢复：挂回 message-list 后刷新 → diff 运行，新块创建
    document.querySelector<HTMLElement>('.main-content')!.appendChild(list);
    refreshChatContent();
    expect(document.querySelector('[data-stream-id="streaming-block-0"]')).not.toBeNull();
    expect(document.querySelector('[data-stream-id="streaming-block-1"]')).not.toBeNull();
    expect(getLastChatRenderKey()).not.toBe(keyBefore);
  });
});
