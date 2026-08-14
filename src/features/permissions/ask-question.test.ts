import { describe, expect, it, beforeEach } from 'vitest';
import { appState } from '../../state';
import type { PendingAskQuestionState } from '../../types';
import { syncPendingAskToInteractionHost } from './ask-question';
import { renderAskUserQuestionCardHtml } from '../chat/render-messages';

function pendingAskState(): PendingAskQuestionState {
  return {
    requestId: 'req-1',
    conversationId: 'pending',
    input: {
      questions: [
        {
          question: '选择运行方式？',
          header: '运行',
          options: [
            { label: '前台', description: '前台运行' },
            { label: '后台' },
          ],
        },
      ],
    },
    finish: () => {},
  };
}

function mountHost(): HTMLElement {
  document.body.innerHTML = '<div id="interaction-host" class="interaction-host" hidden></div>';
  const host = document.querySelector<HTMLElement>('#interaction-host')!;
  expect(host.hidden).toBe(true);
  return host;
}

describe('syncPendingAskToInteractionHost（待问答卡片钉在输入框上方）', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
    appState.pendingAskQuestions.clear();
    appState.activeConversationId = '';
    appState.activeInteractionPanel = null;
  });

  it('有待问答时把可点选卡片挂进 interaction-host 并取消隐藏', () => {
    const host = mountHost();
    appState.pendingAskQuestions.set('pending', pendingAskState());

    syncPendingAskToInteractionHost();

    const card = host.querySelector<HTMLElement>('.ask-card.is-interactive');
    expect(card).not.toBeNull();
    expect(card!.dataset.askRequestId).toBe('req-1');
    expect(card!.dataset.askBound).toBe('1');
    expect(host.hidden).toBe(false);
  });

  it('问答完成后移除卡片并隐藏 host', () => {
    const host = mountHost();
    appState.pendingAskQuestions.set('pending', pendingAskState());
    syncPendingAskToInteractionHost();
    expect(host.querySelector('.ask-card')).not.toBeNull();

    appState.pendingAskQuestions.delete('pending');
    syncPendingAskToInteractionHost();

    expect(host.querySelector('.ask-card')).toBeNull();
    expect(host.hidden).toBe(true);
  });

  it('无待问答时清理历史残留卡片', () => {
    const host = mountHost();
    // 残留一张旧卡（如切换会话后未清干净）
    host.innerHTML = renderAskUserQuestionCardHtml(
      { questions: [] },
      null,
      false,
      false,
    );
    host.hidden = false;

    syncPendingAskToInteractionHost();

    expect(host.querySelector('.ask-card')).toBeNull();
    expect(host.hidden).toBe(true);
  });

  it('同会话工具权限面板正展示时不抢占 host', () => {
    const host = mountHost();
    const permissionEl = document.createElement('div');
    permissionEl.id = 'perm-panel';
    host.replaceChildren(permissionEl);
    host.hidden = false;
    appState.activeInteractionPanel = {
      conversationId: 'pending',
      element: permissionEl,
      cleanup: () => {},
    };
    // 权限面板与问卡属同一会话（互斥）：保留面板，不挂问卡
    appState.pendingAskQuestions.set('pending', pendingAskState());

    syncPendingAskToInteractionHost();

    expect(host.querySelector('#perm-panel')).not.toBeNull();
    expect(host.querySelector('.ask-card')).toBeNull();
    expect(host.hidden).toBe(false);
  });

  it('其他会话遗留权限面板不压制当前会话问卡（挂到面板之前，双方可作答）', () => {
    const host = mountHost();
    const permissionEl = document.createElement('div');
    permissionEl.id = 'perm-panel';
    host.replaceChildren(permissionEl);
    host.hidden = false;
    appState.activeInteractionPanel = {
      conversationId: 'conv-other',
      element: permissionEl,
      cleanup: () => {},
    };
    appState.pendingAskQuestions.set('pending', pendingAskState());

    syncPendingAskToInteractionHost();

    // 问卡挂载，遗留面板保留（不被 replaceChildren 清掉）
    expect(host.querySelector('.ask-card')).not.toBeNull();
    expect(host.querySelector('#perm-panel')).not.toBeNull();
    expect(host.hidden).toBe(false);
  });

  it('重复同步不重建已绑定卡片（保留用户选择现场）', () => {
    const host = mountHost();
    appState.pendingAskQuestions.set('pending', pendingAskState());
    syncPendingAskToInteractionHost();
    const card = host.querySelector('.ask-card')!;

    syncPendingAskToInteractionHost();

    expect(host.querySelector('.ask-card')).toBe(card);
  });

  it('无 pending 时对空 host 是幂等 no-op', () => {
    mountHost();
    expect(() => syncPendingAskToInteractionHost()).not.toThrow();
  });
});
