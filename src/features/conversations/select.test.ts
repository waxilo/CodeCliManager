import { describe, expect, it, beforeEach } from 'vitest';
import { appState } from '../../state';
import { ensureChatMessageShell } from './select';
import { renderChatAreaHtml } from '../chat/render-chat';

function buildMainContent(): HTMLElement {
  const main = document.createElement('div');
  main.className = 'main-content';
  main.innerHTML = `
    <div class="drop-zone-overlay" id="drop-zone-overlay"></div>
    <div class="empty-chat"></div>
    <div class="input-area"></div>
  `;
  document.body.appendChild(main);
  return main;
}

function domOrder(main: HTMLElement): string[] {
  return [...main.children].map((el) => el.className || el.id);
}

describe('ensureChatMessageShell DOM 顺序', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
    appState.activeConversationId = '';
    appState.activeConversationSourcePath = null;
    appState.conversations = [];
  });

  it('空状态 → 会话：标题栏和消息列表壳都位于输入框上方', () => {
    const main = buildMainContent();
    appState.activeConversationId = 'conv-1';
    appState.conversations = [
      {
        id: 'conv-1',
        title: '会话标题',
        messages: [{ id: 'm1', role: 'user', content: 'hi', timestamp: 1 }],
        platform: 'claude',
        project_dir: null,
        source_path: null,
        created_at: 1,
        updated_at: 1,
      },
    ];

    const ok = ensureChatMessageShell();
    expect(ok).toBe(true);
    expect(document.querySelector('.empty-chat')).toBeNull();

    const order = domOrder(main);
    const topbarIdx = order.indexOf('main-topbar');
    const listShellIdx = order.indexOf('message-list-shell');
    const inputIdx = order.indexOf('input-area');

    expect(topbarIdx).toBeGreaterThanOrEqual(0);
    expect(topbarIdx).toBeLessThan(listShellIdx);
    expect(listShellIdx).toBeLessThan(inputIdx);
    expect(order).toEqual([
      'drop-zone-overlay',
      'main-topbar',
      'message-list-shell',
      'input-area',
    ]);
    expect(main.querySelector('.message-list-shell > #message-list')).not.toBeNull();
  });

  it('没有 .empty-chat 时（composer 直挂主区）顺序同样正确', () => {
    const main = document.createElement('div');
    main.className = 'main-content';
    main.innerHTML = `<div class="input-area"></div>`;
    document.body.appendChild(main);
    // 与真实调用路径一致：selectConversation 先写 activeConversationId 再挂壳
    appState.activeConversationId = 'conv-1';

    const ok = ensureChatMessageShell();
    expect(ok).toBe(true);

    const order = domOrder(main);
    expect(order).toEqual(['main-topbar', 'message-list-shell', 'input-area']);
  });

  it('已存在裸 #message-list 时原位升级，不重建列表节点', () => {
    const main = document.createElement('div');
    main.className = 'main-content';
    main.innerHTML = `<div class="main-topbar"></div><div id="message-list"></div><div class="input-area"></div>`;
    document.body.appendChild(main);
    const list = document.querySelector('#message-list');

    expect(ensureChatMessageShell()).toBe(true);
    expect(document.querySelectorAll('#message-list')).toHaveLength(1);
    expect(document.querySelector('.message-list-shell > #message-list')).toBe(list);
    expect(document.querySelectorAll('.main-topbar')).toHaveLength(1);
  });

  it('增量壳与全量渲染共用同一份聊天区结构（防漂移）', () => {
    appState.activeConversationId = 'conv-1';
    appState.conversations = [
      {
        id: 'conv-1',
        title: '会话标题',
        messages: [{ id: 'm1', role: 'user', content: 'hi', timestamp: 1 }],
        platform: 'claude',
        project_dir: null,
        source_path: null,
        created_at: 1,
        updated_at: 1,
      },
    ];

    // 全量渲染路径：drop-zone + topbar + 带内容的消息列表壳 + composer
    const full = document.createElement('div');
    full.innerHTML = renderChatAreaHtml();
    const fullOrder = [...full.children].map((el) => el.className || el.id);

    // 增量路径：同源结构，仅消息列表为空壳
    const shell = document.createElement('div');
    shell.innerHTML = renderChatAreaHtml({ shellOnly: true });
    const shellOrder = [...shell.children].map((el) => el.className || el.id);

    expect(fullOrder).toEqual([
      'drop-zone-overlay',
      'main-topbar',
      'message-list-shell',
      'input-area',
    ]);
    // 结构顺序完全一致；差别只在消息列表是否内嵌内容
    expect(shellOrder).toEqual(fullOrder);
    expect(shell.querySelector('[data-chat-content] > .message')).toBeNull();
    expect(shell.querySelector('[data-chat-content] > [data-chat-bottom]')).not.toBeNull();
    expect(full.querySelector('[data-chat-content] > .message')).not.toBeNull();
  });
});
