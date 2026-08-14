import { describe, expect, it, beforeEach, vi } from 'vitest';
import { appState } from '../../state';
import { handlePermissionRequest } from './permission-dialog';
import { syncPendingAskToInteractionHost } from './ask-question';
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
    appState.activeAskQuestionCleanup = null;
    appState.activeQuestionEnterHandler = null;
    appState.questionOtherInputActive = false;
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

  it('勾选「其他」后显示卡片内联输入框，空值提交被拦截，填写后提交自定义回答', async () => {
    const p = handlePermissionRequest(askPayload());
    const c = card()!;
    const otherWrap = c.querySelector<HTMLElement>('.ask-other-input')!;
    const otherInput = c.querySelector<HTMLInputElement>('input[data-ask-other-input="1"]')!;

    // 默认内联输入框隐藏（不占地方）
    expect(otherWrap.hidden).toBe(true);

    // 勾选「其他」→ 内联输入框出现
    (c.querySelector<HTMLInputElement>('input[data-other="1"]')!).click();
    expect(otherWrap.hidden).toBe(false);

    // 内联输入为空时提交被拦截（不发送响应）
    (c.querySelector('[data-ask-action="submit"]') as HTMLButtonElement).click();
    await Promise.resolve();
    await Promise.resolve();
    expect(respondMock).not.toHaveBeenCalled();
    const err = c.querySelector<HTMLElement>('.ask-error')!;
    expect(err.hidden).toBe(false);

    // 在卡片内联输入框填写后提交成功，不再读取下方大输入框
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
    // 子代理的 permission 携带的是其自身 session id，与当前 activeConversationId 不同
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

    expect(card()).not.toBeNull();

    const radio = card()!.querySelector<HTMLInputElement>('input[value="是"]')!;
    radio.click();
    (card()!.querySelector('[data-ask-action="submit"]') as HTMLButtonElement).click();
    await p;
    expect(respondMock).toHaveBeenCalledTimes(1);
    const [args] = respondMock.mock.calls[0] as [{ requestId: string; behavior: string }];
    expect(args.requestId).toBe('req-subagent-9');
    expect(args.behavior).toBe('allow');
  });
});
