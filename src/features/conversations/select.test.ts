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

  it('空状态 → 会话：标题栏在消息列表上方、输入框上方（不落到输入框头顶）', () => {
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
    const listIdx = order.indexOf('message-list');
    const inputIdx = order.indexOf('input-area');

    expect(topbarIdx).toBeGreaterThanOrEqual(0);
    expect(topbarIdx).toBeLessThan(listIdx);
    expect(listIdx).toBeLessThan(inputIdx);
    // 具体顺序必须是 drop-zone-overlay → main-topbar → message-list → input-area
    expect(order).toEqual([
      'drop-zone-overlay',
      'main-topbar',
      'message-list',
      'input-area',
    ]);
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
    expect(order).toEqual(['main-topbar', 'message-list', 'input-area']);
  });

  it('已存在 #message-list 时直接返回，不重复插入', () => {
    const main = document.createElement('div');
    main.className = 'main-content';
    main.innerHTML = `<div class="main-topbar"></div><div id="message-list"></div><div class="input-area"></div>`;
    document.body.appendChild(main);

    expect(ensureChatMessageShell()).toBe(true);
    expect(document.querySelectorAll('#message-list')).toHaveLength(1);
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

    // 全量渲染路径：drop-zone + topbar + 带内容的消息列表 + composer
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
      'message-list',
      'input-area',
    ]);
    // 结构顺序完全一致；差别只在消息列表是否内嵌内容
    expect(shellOrder).toEqual(fullOrder);
    expect(shell.querySelector('#message-list')!.innerHTML).toBe('');
    expect(full.querySelector('#message-list')!.innerHTML).not.toBe('');
  });
});
