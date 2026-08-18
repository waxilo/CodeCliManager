import { describe, expect, it, beforeEach, vi } from 'vitest';
import { appState } from '../../state';
import { handlePermissionRequest, closePermissionDialogs } from './permission-dialog';
import { syncPendingAskToInteractionHost } from './ask-question';
import { handleKeydown } from '../chat/refresh';
import type { PermissionRequestPayload } from '../../types';

// mock 掉 Tauri invoke，捕获 respondToolPermission 调用
const respondMock = vi.fn().mockResolvedValue(undefined);
vi.mock('../../api', () => ({
  respondToolPermission: (...args: unknown[]) => respondMock(...args),
  setPermissionMode: vi.fn().mockResolvedValue(undefined),
}));

function askPayload(overrides: Partial<PermissionRequestPayload> = {}): PermissionRequestPayload {
  return {
    conversationId: 'conv-1',
    requestId: 'req-ask-1',
    toolName: 'AskUserQuestion',
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
    description: null,
    ...overrides,
  };
}

function mountDom(): void {
  document.body.innerHTML = `
    <div class="app-container">
      <div class="main-content">
        <div class="message-list" id="message-list"></div>
      </div>
      <div class="input-area">
        <textarea id="message-input"></textarea>
        <div id="interaction-host" class="interaction-host" hidden></div>
      </div>
    </div>
  `;
}

function host(): HTMLElement {
  return document.querySelector('#interaction-host') as HTMLElement;
}

function card(): HTMLElement | null {
  return host().querySelector('.ask-card.is-interactive');
}

/** 模拟完整流程：问题到达 → 卡片挂载 → 全量重建后卡片仍在 → 用户选择 → 提交 → 响应发回 */
describe('AskUserQuestion 完整交互流程', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
    appState.pendingAskQuestions.clear();
    appState.activeConversationId = 'conv-1';
    appState.activeInteractionPanel = null;
    appState.activeQuestionEnterHandlers.clear();
    respondMock.mockClear();
    // jsdom 未实现 scrollIntoView；afterUiRefresh 可能触发它
    Element.prototype.scrollIntoView = vi.fn();
    mountDom();
  });

  it('卡片挂载后可点选并提交，respondToolPermission 收到 allow+answers', async () => {
    const p = handlePermissionRequest(askPayload());
    // showQuestionDialog 同步挂卡（不依赖聊天重建）
    expect(card()).not.toBeNull();
    expect(host().hidden).toBe(false);
    expect(appState.pendingAskQuestions.size).toBe(1);

    // 模拟一次全量重建后，卡仍在（setupMessageListPostRender 会再同步）
    host().innerHTML = '';
    syncPendingAskToInteractionHost();
    expect(card()).not.toBeNull();

    // 用户点选「前台」并提交
    const radio = card()!.querySelector<HTMLInputElement>('input[value="前台"]')!;
    radio.click();
    (card()!.querySelector('[data-ask-action="submit"]') as HTMLButtonElement).click();

    await p;
    expect(respondMock).toHaveBeenCalledTimes(1);
    const [args] = respondMock.mock.calls[0] as [{ requestId: string; behavior: string; updatedInput: unknown }];
    expect(args.requestId).toBe('req-ask-1');
    expect(args.behavior).toBe('allow');
    const updated = args.updatedInput as { questions: unknown; answers: Record<string, string> };
    expect(updated.answers).toEqual({ '选择运行方式？': '前台' });
    // 卡片清理
    expect(card()).toBeNull();
    expect(appState.pendingAskQuestions.size).toBe(0);
  });

  it('「自定义回答」是始终可见的输入框：直接填写即答案，空值时提交被拦截', async () => {
    const p = handlePermissionRequest(askPayload());
    const c = card()!;
    const otherInput = c.querySelector<HTMLInputElement>('input[data-ask-other-input="1"]')!;

    // 自定义回答输入框始终可见，无需先勾选「其他」
    expect(c.querySelector('.ask-other')).not.toBeNull();
    expect(otherInput).not.toBeNull();

    // 没选选项、也没填自定义回答时提交被拦截（不发送响应）
    (c.querySelector('[data-ask-action="submit"]') as HTMLButtonElement).click();
    await Promise.resolve();
    await Promise.resolve();
    expect(respondMock).not.toHaveBeenCalled();
    const err = c.querySelector<HTMLElement>('.ask-error')!;
    expect(err.hidden).toBe(false);

    // 只填自定义回答即可作为答案提交（无需点选任何选项）
    otherInput.value = '自定义回答内容';
    (c.querySelector('[data-ask-action="submit"]') as HTMLButtonElement).click();
    await p;
    expect(respondMock).toHaveBeenCalledTimes(1);
    const [args] = respondMock.mock.calls[0] as [
      { requestId: string; behavior: string; updatedInput: unknown },
    ];
    const updated = args.updatedInput as { questions: unknown; answers: Record<string, string> };
    expect(updated.answers).toEqual({ '选择运行方式？': '自定义回答内容' });
    expect(card()).toBeNull();
  });

  it('在「自定义回答」输入框内按 Enter 直接提交', async () => {
    const p = handlePermissionRequest(askPayload());
    const c = card()!;
    const otherInput = c.querySelector<HTMLInputElement>('input[data-ask-other-input="1"]')!;
    otherInput.value = 'Enter 提交的自定义回答';

    otherInput.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }),
    );
    await p;
    expect(respondMock).toHaveBeenCalledTimes(1);
    const [args] = respondMock.mock.calls[0] as [
      { requestId: string; behavior: string; updatedInput: unknown },
    ];
    const updated = args.updatedInput as { questions: unknown; answers: Record<string, string> };
    expect(updated.answers).toEqual({ '选择运行方式？': 'Enter 提交的自定义回答' });
    expect(card()).toBeNull();
  });

  it('未选任何选项时提交被拦截（不发送响应，等待用户继续作答）', async () => {
    // promise 会保持 pending（等待用户作答），此处仅触发处理流程
    void handlePermissionRequest(askPayload());
    expect(card()).not.toBeNull();

    // 直接点提交：应被 collectAnswersFromCard 拦截，不 resolve
    (card()!.querySelector('[data-ask-action="submit"]') as HTMLButtonElement).click();

    // 微任务让出，确认没有提前响应
    await Promise.resolve();
    await Promise.resolve();
    expect(respondMock).not.toHaveBeenCalled();
    // 错误提示出现，卡仍在
    const err = card()!.querySelector<HTMLElement>('.ask-error');
    expect(err).not.toBeNull();
    expect(err!.hidden).toBe(false);
    expect(appState.pendingAskQuestions.size).toBe(1);
  });

  it('其他会话遗留的工具权限面板（activeInteractionPanel）不压制本会话的问卡', async () => {
    // 另一会话的权限面板仍挂在 host 上，activeInteractionPanel 残留
    const stalePanel = document.createElement('div');
    stalePanel.id = 'stale-perm-panel';
    host().replaceChildren(stalePanel);
    host().hidden = false;
    appState.activeInteractionPanel = {
      conversationId: 'conv-other',
      element: stalePanel,
      cleanup: () => {},
    };

    const p = handlePermissionRequest(askPayload({ conversationId: 'conv-1' }));

    // 当前会话的问卡必须照常挂载（不能被其他会话的残留面板压制）
    expect(card()).not.toBeNull();
    expect(host().querySelector('#stale-perm-panel')).not.toBeNull();

    const radio = card()!.querySelector<HTMLInputElement>('input[value="后台"]')!;
    radio.click();
    (card()!.querySelector('[data-ask-action="submit"]') as HTMLButtonElement).click();
    await p;
    expect(respondMock).toHaveBeenCalledWith({
      requestId: 'req-ask-1',
      behavior: 'allow',
      message: null,
      updatedInput: { questions: expect.any(Array), answers: { '选择运行方式？': '后台' } },
    });
  });

  it('子代理等非当前会话 id 的问卡也能挂载并可作答', async () => {
    // 子代理的 permission 携带的是其自身 session id，与当前 activeConversationId 不同；
    // 预置一条同 requestId 的旧条目（旧卡已过期），新请求到达后应覆盖它
    appState.pendingAskQuestions.set('pending', {
      requestId: 'req-subagent-9',
      conversationId: 'pending',
      input: {
        questions: [
          { question: '继续吗？', options: [{ label: '是' }, { label: '否' }] },
        ],
      },
      finish: () => {},
    });
    const p = handlePermissionRequest(
      askPayload({
        conversationId: 'subagent-session-9',
        requestId: 'req-subagent-9',
      }),
    );

    // 旧条目被同 requestId 的新请求覆盖，只剩新状态
    expect(appState.pendingAskQuestions.size).toBe(1);
    expect(appState.pendingAskQuestions.has('subagent-session-9')).toBe(true);
    expect(card()).not.toBeNull();

    const radio = card()!.querySelector<HTMLInputElement>('input[value="前台"]')!;
    radio.click();
    (card()!.querySelector('[data-ask-action="submit"]') as HTMLButtonElement).click();
    await p;
    expect(respondMock).toHaveBeenCalledTimes(1);
    const [args] = respondMock.mock.calls[0] as [
      { requestId: string; behavior: string; updatedInput: unknown },
    ];
    expect(args.requestId).toBe('req-subagent-9');
    expect(args.behavior).toBe('allow');
    expect(
      (args.updatedInput as { answers: Record<string, string> }).answers,
    ).toEqual({ '选择运行方式？': '前台' });
  });

  it('后台会话问卡注册不会顶掉当前会话卡的提交（各自 state.submit 互不串扰）', async () => {
    // 当前会话卡（conv-1，req-a）先渲染
    const pA = handlePermissionRequest(
      askPayload({ requestId: 'req-a', conversationId: 'conv-1' }),
    );
    const cardA = Array.from(
      document.querySelectorAll<HTMLElement>('.ask-card.is-interactive'),
    ).find((el) => el.dataset.askRequestId === 'req-a')!;
    expect(cardA).not.toBeUndefined();

    // 后台会话（子代理）问卡随后注册：不渲染到 host（host 只展示当前会话卡），仅进入 pending 表。
    // 旧实现里这一步会把全局 Enter 处理器顶成 B 的，导致之后点 A 的提交「点了没反应」。
    const pB = handlePermissionRequest(
      askPayload({ requestId: 'req-b', conversationId: 'sub-session-b' }),
    );
    expect(appState.pendingAskQuestions.size).toBe(2);
    expect(appState.activeQuestionEnterHandlers.size).toBe(2);
    // host 仍只展示 A 卡
    expect(
      Array.from(document.querySelectorAll<HTMLElement>('.ask-card.is-interactive')).length,
    ).toBe(1);

    // A 卡提交必须走 A 自己的 submit，收集 A 的答案
    const radioA = cardA.querySelector<HTMLInputElement>('input[value="前台"]')!;
    radioA.click();
    (cardA.querySelector('[data-ask-action="submit"]') as HTMLButtonElement).click();
    await pA;
    expect(respondMock).toHaveBeenCalledTimes(1);
    const [argsA] = respondMock.mock.calls[0] as [
      { requestId: string; behavior: string; updatedInput: unknown },
    ];
    expect(argsA.requestId).toBe('req-a');
    expect(
      (argsA.updatedInput as { answers: Record<string, string> }).answers,
    ).toEqual({ '选择运行方式？': '前台' });

    // B 仍在等待作答
    expect(appState.pendingAskQuestions.has('sub-session-b')).toBe(true);
    expect(appState.activeQuestionEnterHandlers.has('sub-session-b')).toBe(true);

    // B 卡进入前台（切到该会话）后可正常作答
    appState.activeConversationId = 'sub-session-b';
    syncPendingAskToInteractionHost();
    const cardB = Array.from(
      document.querySelectorAll<HTMLElement>('.ask-card.is-interactive'),
    ).find((el) => el.dataset.askRequestId === 'req-b')!;
    expect(cardB).not.toBeUndefined();
    const radioB = cardB.querySelector<HTMLInputElement>('input[value="后台"]')!;
    radioB.click();
    (cardB.querySelector('[data-ask-action="submit"]') as HTMLButtonElement).click();
    await pB;
    expect(respondMock).toHaveBeenCalledTimes(2);
    const [argsB] = respondMock.mock.calls[1] as [
      { requestId: string; behavior: string; updatedInput: unknown },
    ];
    expect(argsB.requestId).toBe('req-b');
    expect(
      (argsB.updatedInput as { answers: Record<string, string> }).answers,
    ).toEqual({ '选择运行方式？': '后台' });
    expect(appState.pendingAskQuestions.size).toBe(0);
    expect(appState.activeQuestionEnterHandlers.size).toBe(0);
  });

  it('主输入框 Enter 只提交当前会话的问卡，不受后台会话问卡注册影响', async () => {
    const textarea = document.querySelector<HTMLTextAreaElement>('#message-input')!;
    textarea.addEventListener('keydown', handleKeydown);

    // 当前会话问卡先到
    const pA = handlePermissionRequest(
      askPayload({ requestId: 'req-a', conversationId: 'conv-1' }),
    );
    const cardA = Array.from(
      document.querySelectorAll<HTMLElement>('.ask-card.is-interactive'),
    ).find((el) => el.dataset.askRequestId === 'req-a')!;
    const radioA = cardA.querySelector<HTMLInputElement>('input[value="前台"]')!;
    radioA.click();

    // 后台会话问卡随后注册（旧实现会顶掉全局 Enter 处理器）
    const pB = handlePermissionRequest(
      askPayload({ requestId: 'req-b', conversationId: 'sub-session-b' }),
    );
    expect(appState.activeQuestionEnterHandlers.has('conv-1')).toBe(true);

    // 主输入框 Enter：应提交当前会话（conv-1）的问卡，而不是后台卡
    textarea.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }),
    );
    await pA;
    expect(respondMock).toHaveBeenCalledTimes(1);
    const [args] = respondMock.mock.calls[0] as [
      { requestId: string; behavior: string; updatedInput: unknown },
    ];
    expect(args.requestId).toBe('req-a');
    expect(
      (args.updatedInput as { answers: Record<string, string> }).answers,
    ).toEqual({ '选择运行方式？': '前台' });
    // 后台卡仍在等待作答
    expect(appState.pendingAskQuestions.has('sub-session-b')).toBe(true);
    // 清理：deny 后台卡（按会话精确清理），让 pB 落定
    closePermissionDialogs('sub-session-b');
    await pB;
    expect(appState.pendingAskQuestions.size).toBe(0);
  });
});
