import { describe, expect, it, beforeEach } from 'vitest';
import { appState } from '../../state';
import type { PendingAskQuestionState } from '../../types';
import { syncPendingAskToInteractionHost } from './ask-question';
import { renderAskUserQuestionCardHtml } from '../chat/render-messages';

const SESSION_KEY = 'pending-run-test';

function pendingAskState(): PendingAskQuestionState {
  return {
    requestId: 'req-1',
    conversationId: SESSION_KEY,
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
    appState.activePendingSessionKey = SESSION_KEY;
    appState.interactionPanelsBySession.clear();
  });

  it('有待问答时把可点选卡片挂进 interaction-host 并取消隐藏', () => {
    const host = mountHost();
    appState.pendingAskQuestions.set(SESSION_KEY, pendingAskState());

    syncPendingAskToInteractionHost();

    const card = host.querySelector<HTMLElement>('.ask-card.is-interactive');
    expect(card).not.toBeNull();
    expect(card!.dataset.askRequestId).toBe('req-1');
    expect(card!.dataset.askBound).toBe('1');
    expect(host.hidden).toBe(false);
  });

  it('问答完成后移除卡片并隐藏 host', () => {
    const host = mountHost();
    appState.pendingAskQuestions.set(SESSION_KEY, pendingAskState());
    syncPendingAskToInteractionHost();
    expect(host.querySelector('.ask-card')).not.toBeNull();

    appState.pendingAskQuestions.delete(SESSION_KEY);
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
    appState.interactionPanelsBySession.set(SESSION_KEY, {
      conversationId: SESSION_KEY,
      element: permissionEl,
      cleanup: () => {},
    });
    // 权限面板与问卡属同一会话（互斥）：保留面板，不挂问卡
    appState.pendingAskQuestions.set(SESSION_KEY, pendingAskState());

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
    appState.interactionPanelsBySession.set('conv-other', {
      conversationId: 'conv-other',
      element: permissionEl,
      cleanup: () => {},
    });
    appState.pendingAskQuestions.set(SESSION_KEY, pendingAskState());

    syncPendingAskToInteractionHost();

    // 问卡挂载，遗留面板保留（不被 replaceChildren 清掉）
    expect(host.querySelector('.ask-card')).not.toBeNull();
    expect(host.querySelector('#perm-panel')).not.toBeNull();
    expect(host.hidden).toBe(false);
  });

  it('重复同步不重建已绑定卡片（保留用户选择现场）', () => {
    const host = mountHost();
    appState.pendingAskQuestions.set(SESSION_KEY, pendingAskState());
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

describe('showQuestionDialog（全自动模式自动回答）', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('auto 模式：不弹卡，自动选择每个问题的第一个选项', async () => {
    localStorage.setItem('codemanager-permission-mode', 'auto');
    const { showQuestionDialog } = await import('./ask-question');
    const parsed = {
      questions: [
        { question: 'Q1', header: undefined, options: [{ label: 'A1' }, { label: 'A2' }], multiSelect: false },
        { question: 'Q2', header: undefined, options: [{ label: 'B1' }], multiSelect: false },
      ],
    };
    const result = await showQuestionDialog(
      { requestId: 'req-auto', conversationId: 'c1', toolName: 'AskUserQuestion', input: {} },
      parsed,
    );
    expect(result.action).toBe('submit');
    if (result.action === 'submit') {
      expect(result.answers).toEqual({ Q1: 'A1', Q2: 'B1' });
    }
  });

  it('ask 模式：不自动回答（返回挂起的 Promise，由用户交互完成）', async () => {
    localStorage.setItem('codemanager-permission-mode', 'ask');
    const { showQuestionDialog } = await import('./ask-question');
    const parsed = {
      questions: [
        { question: 'Q1', header: undefined, options: [{ label: 'A1' }], multiSelect: false },
      ],
    };
    let settled = false;
    const p = showQuestionDialog(
      { requestId: 'req-ask', conversationId: 'c1', toolName: 'AskUserQuestion', input: {} },
      parsed,
    );
    p.then(() => { settled = true; });
    await new Promise((r) => setTimeout(r, 10));
    expect(settled).toBe(false);
  });
});
