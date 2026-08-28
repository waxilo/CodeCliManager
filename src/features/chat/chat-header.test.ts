import { beforeEach, describe, expect, it } from 'vitest';
import { appState } from '../../state';
import { renderChatHeaderHtml } from './render-chat';
import type { Conversation } from '../../types';

function conversation(id = 'sess-123', title = '我的会话'): Conversation {
  return {
    id,
    title,
    messages: [],
    platform: 'claude',
    project_dir: '/work/project',
    source_path: null,
    created_at: 0,
    updated_at: 0,
    context_tokens: null,
    last_model: null,
    usage: null,
  };
}

describe('renderChatHeaderHtml', () => {
  beforeEach(() => {
    appState.activeConversationId = '';
    appState.activeConversationSourcePath = null;
    appState.pendingProjectDir = null;
  });

  it('在有会话时渲染右上角「刷新/重连」按钮', () => {
    appState.activeConversationId = 'sess-123';
    const html = renderChatHeaderHtml(conversation('sess-123'));
    expect(html).toContain('session-reload-btn');
    expect(html).toContain('重连 / 刷新会话');
    expect(html).toContain('chat-header-actions');
  });

  it('在无会话（新聊天）时不渲染刷新按钮', () => {
    const html = renderChatHeaderHtml(undefined);
    expect(html).not.toContain('session-reload-btn');
    expect(html).not.toContain('chat-header-actions');
  });
});
