import { describe, expect, it, beforeEach, vi } from 'vitest';
import { appState } from '../../state';
import { handlePermissionRequest, closePermissionDialogs } from './permission-dialog';
import { syncPendingAskToInteractionHost } from './ask-question';
import { renderAskUserQuestionCardHtml } from '../chat/render-messages';
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

  it('「自定义回答」是始终可见的输入框：直接填写即答案，全部答完才可提交', async () => {
    const p = handlePermissionRequest(askPayload());
    const c = card()!;
    const otherInput = c.querySelector<HTMLInputElement>('input[data-ask-other-input="1"]')!;
    const submitBtn = c.querySelector<HTMLButtonElement>('[data-ask-action="submit"]')!;

    // 自定义回答输入框始终可见，无需先勾选「其他」
    expect(c.querySelector('.ask-other')).not.toBeNull();
    expect(otherInput).not.toBeNull();

    // 没选选项、也没填自定义回答时提交按钮禁用（不发送响应）
    expect(submitBtn.disabled).toBe(true);
    submitBtn.click();
    await Promise.resolve();
    await Promise.resolve();
    expect(respondMock).not.toHaveBeenCalled();

    // 只填自定义回答即可作为答案提交（无需点选任何选项）
    otherInput.value = '自定义回答内容';
    otherInput.dispatchEvent(new Event('input', { bubbles: true }));
    expect(submitBtn.disabled).toBe(false);
    submitBtn.click();
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

  it('未选任何选项时提交按钮禁用，选择后放开（不发送响应，等待用户继续作答）', async () => {
    // promise 会保持 pending（等待用户作答），此处仅触发处理流程
    void handlePermissionRequest(askPayload());
    const c = card()!;
    expect(c).not.toBeNull();
    const submitBtn = c.querySelector<HTMLButtonElement>('[data-ask-action="submit"]')!;
    expect(submitBtn.disabled).toBe(true);

    // 禁用状态下点击不发送响应（jsdom 抑制 disabled 点击，handler 另有守卫）
    submitBtn.click();
    await Promise.resolve();
    await Promise.resolve();
    expect(respondMock).not.toHaveBeenCalled();
    expect(appState.pendingAskQuestions.size).toBe(1);

    // 选中选项后提交放开
    const radio = c.querySelector<HTMLInputElement>('input[value="前台"]')!;
    radio.click();
    expect(submitBtn.disabled).toBe(false);
    expect(c.querySelector<HTMLElement>('.ask-error')!.hidden).toBe(true);
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

  it('多问题卡片：横向 tab 分页，答完自动切换，全部答完才可提交', async () => {
    const p = handlePermissionRequest(
      askPayload({
        input: {
          questions: [
            {
              question: '选择运行方式？',
              header: '运行',
              options: [{ label: '前台' }, { label: '后台' }],
            },
            {
              question: '是否继续？',
              header: '后续',
              options: [{ label: '继续' }, { label: '停止' }],
            },
          ],
        },
      }),
    );
    const c = card()!;
    const tabs = c.querySelectorAll<HTMLElement>('.ask-tab');
    expect(tabs.length).toBe(2);
    expect(tabs[0].classList.contains('is-active')).toBe(true);
    expect(tabs[0].textContent).toContain('运行');
    expect(tabs[1].textContent).toContain('后续');

    const blocks = c.querySelectorAll<HTMLElement>('.ask-block');
    expect(blocks.length).toBe(2);
    expect(blocks[0].hidden).toBe(false);
    expect(blocks[1].hidden).toBe(true);
    const submitBtn = c.querySelector<HTMLButtonElement>('[data-ask-action="submit"]')!;
    expect(submitBtn.disabled).toBe(true);
    const progressEl = c.querySelector<HTMLElement>('[data-ask-progress]')!;
    expect(progressEl.textContent).toBe('已答 0/2');

    // 答 Q1 → 自动切到 Q2，Q1 tab 打勾并显示答案摘要
    const radio1 = c.querySelector<HTMLInputElement>('input[name="ask-q-0"][value="前台"]')!;
    radio1.click();
    expect(tabs[0].classList.contains('is-answered')).toBe(true);
    expect(tabs[0].querySelector('.ask-tab-answer')!.textContent).toBe('前台');
    expect(tabs[1].classList.contains('is-active')).toBe(true);
    expect(blocks[0].hidden).toBe(true);
    expect(blocks[1].hidden).toBe(false);
    expect(progressEl.textContent).toBe('已答 1/2');
    // 只答了一题，提交仍未放开
    expect(submitBtn.disabled).toBe(true);

    // 手动切回 Q1 可复查/修改
    tabs[0].click();
    expect(blocks[0].hidden).toBe(false);
    expect(blocks[1].hidden).toBe(true);

    // 切回 Q2 作答 → 全部答完 → 提交放开
    tabs[1].click();
    const radio2 = c.querySelector<HTMLInputElement>('input[name="ask-q-1"][value="继续"]')!;
    radio2.click();
    expect(tabs[1].classList.contains('is-answered')).toBe(true);
    expect(submitBtn.disabled).toBe(false);
    expect(submitBtn.classList.contains('is-ready')).toBe(true);
    expect(progressEl.textContent).toBe('全部完成 ✓');

    submitBtn.click();
    await p;
    expect(respondMock).toHaveBeenCalledTimes(1);
    const [args] = respondMock.mock.calls[0] as [
      { requestId: string; behavior: string; updatedInput: unknown },
    ];
    expect(
      (args.updatedInput as { answers: Record<string, string> }).answers,
    ).toEqual({ '选择运行方式？': '前台', '是否继续？': '继续' });
    expect(card()).toBeNull();
  });

  it('Enter 提交遇未答问题：切到该题并提示，不发送响应', async () => {
    // promise 保持 pending（等待用户作答），此处仅触发处理流程
    void handlePermissionRequest(
      askPayload({
        input: {
          questions: [
            { question: '问题一？', options: [{ label: 'A1' }, { label: 'A2' }] },
            { question: '问题二？', options: [{ label: 'B1' }, { label: 'B2' }] },
          ],
        },
      }),
    );
    const c = card()!;
    const tabs = c.querySelectorAll<HTMLElement>('.ask-tab');
    const blocks = c.querySelectorAll<HTMLElement>('.ask-block');

    // 先答 Q2（切到 tab 2），Q1 仍空着
    tabs[1].click();
    c.querySelector<HTMLInputElement>('input[name="ask-q-1"][value="B1"]')!.click();
    expect(tabs[1].classList.contains('is-answered')).toBe(true);
    expect(tabs[0].classList.contains('is-answered')).toBe(false);

    // 在 Q2 自定义回答框按 Enter：校验先卡在 Q1 → 自动切回 Q1 并提示
    const other1 = c.querySelector<HTMLInputElement>(
      'input[data-ask-other-input="1"][data-q-index="1"]',
    )!;
    other1.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }),
    );
    await Promise.resolve();
    await Promise.resolve();
    expect(respondMock).not.toHaveBeenCalled();
    expect(c.querySelector<HTMLElement>('.ask-error')!.hidden).toBe(false);
    expect(tabs[0].classList.contains('is-active')).toBe(true);
    expect(blocks[0].hidden).toBe(false);
    expect(blocks[1].hidden).toBe(true);
    // 补答 Q1 → 全部答完 → 提交放开
    c.querySelector<HTMLInputElement>('input[name="ask-q-0"][value="A1"]')!.click();
    expect(c.querySelector<HTMLButtonElement>('[data-ask-action="submit"]')!.disabled).toBe(false);
  });

  it('多选问题：勾多项计入答案，取消全部后提交重新禁用', async () => {
    const p = handlePermissionRequest(
      askPayload({
        input: {
          questions: [
            {
              question: '多选？',
              multiSelect: true,
              options: [{ label: 'A' }, { label: 'B' }, { label: 'C' }],
            },
          ],
        },
      }),
    );
    const c = card()!;
    const submitBtn = c.querySelector<HTMLButtonElement>('[data-ask-action="submit"]')!;
    const boxes = {
      a: c.querySelector<HTMLInputElement>('input[value="A"]')!,
      b: c.querySelector<HTMLInputElement>('input[value="B"]')!,
    };
    expect(submitBtn.disabled).toBe(true);

    // 勾 A、B → 已答，答案合并写入
    boxes.a.click();
    boxes.b.click();
    expect(submitBtn.disabled).toBe(false);
    const s = [...appState.pendingAskQuestions.values()][0];
    expect(s.answers?.['多选？']).toBe('A, B');

    // 取消 A → 仍勾着 B，保持已答
    boxes.a.click();
    expect(submitBtn.disabled).toBe(false);
    expect([...appState.pendingAskQuestions.values()][0].answers?.['多选？']).toBe('B');

    // 取消 B → 全部取消 → 重新禁用
    boxes.b.click();
    expect(submitBtn.disabled).toBe(true);
    void p;
  });

  it('自定义回答清空后提交重新禁用', async () => {
    const p = handlePermissionRequest(askPayload());
    const c = card()!;
    const otherInput = c.querySelector<HTMLInputElement>('input[data-ask-other-input="1"]')!;
    const submitBtn = c.querySelector<HTMLButtonElement>('[data-ask-action="submit"]')!;

    otherInput.value = '临时内容';
    otherInput.dispatchEvent(new Event('input', { bubbles: true }));
    expect(submitBtn.disabled).toBe(false);

    // 清空 → 重新禁用
    otherInput.value = '';
    otherInput.dispatchEvent(new Event('input', { bubbles: true }));
    expect(submitBtn.disabled).toBe(true);
    void p;
  });

  it('部分作答后 host 清空重建：已答进度恢复（选中态/打勾/摘要/禁用态）', async () => {
    const p = handlePermissionRequest(
      askPayload({
        input: {
          questions: [
            { question: '问题一？', options: [{ label: 'A1' }, { label: 'A2' }] },
            { question: '问题二？', options: [{ label: 'B1' }, { label: 'B2' }] },
          ],
        },
      }),
    );
    // 答 Q1 → 自动切到 Q2
    const radio1 = card()!.querySelector<HTMLInputElement>('input[name="ask-q-0"][value="A1"]')!;
    radio1.click();
    expect(card()!.querySelector<HTMLElement>('.ask-tab[data-q-index="1"]')!.classList.contains('is-active')).toBe(true);

    // 模拟切会话/重建把 host 清空
    host().innerHTML = '';
    syncPendingAskToInteractionHost();

    const rebuilt = card()!;
    const tabs = rebuilt.querySelectorAll<HTMLElement>('.ask-tab');
    expect(tabs[0].classList.contains('is-answered')).toBe(true);
    expect(tabs[0].querySelector('.ask-tab-answer')!.textContent).toBe('A1');
    expect(tabs[1].classList.contains('is-answered')).toBe(false);
    // 已答选项恢复选中
    expect(
      rebuilt.querySelector<HTMLInputElement>('input[name="ask-q-0"][value="A1"]')!.checked,
    ).toBe(true);
    // 进度与提交态恢复
    expect(rebuilt.querySelector<HTMLElement>('[data-ask-progress]')!.textContent).toBe('已答 1/2');
    expect(
      rebuilt.querySelector<HTMLButtonElement>('[data-ask-action="submit"]')!.disabled,
    ).toBe(true);

    // 续答 Q2 → 提交放开 → 提交成功
    rebuilt.querySelector<HTMLInputElement>('input[name="ask-q-1"][value="B1"]')!.click();
    expect(
      rebuilt.querySelector<HTMLButtonElement>('[data-ask-action="submit"]')!.disabled,
    ).toBe(false);
    rebuilt.querySelector<HTMLButtonElement>('[data-ask-action="submit"]')!.click();
    await p;
    expect(respondMock).toHaveBeenCalledTimes(1);
    expect(
      (respondMock.mock.calls[0][0] as { updatedInput: { answers: Record<string, string> } })
        .updatedInput.answers,
    ).toEqual({ '问题一？': 'A1', '问题二？': 'B1' });
  });

  it('历史只读多题卡：无 tab、全部问题平铺、无提交按钮', () => {
    host().innerHTML = renderAskUserQuestionCardHtml(
      {
        questions: [
          { question: 'Q1', options: [{ label: 'A' }] },
          { question: 'Q2', options: [{ label: 'B' }] },
        ],
      },
      { Q1: 'A', Q2: 'B' },
      false,
      false,
    );
    const c = host().querySelector<HTMLElement>('.ask-card')!;
    expect(c.querySelector('.ask-tabs')).toBeNull();
    expect(c.querySelectorAll('.ask-block').length).toBe(2);
    c.querySelectorAll<HTMLElement>('.ask-block').forEach((b) => {
      expect(b.hidden).toBe(false);
      expect(b.getAttribute('role')).toBeNull();
    });
    expect(c.querySelector('[data-ask-action="submit"]')).toBeNull();
    expect(c.querySelectorAll('.ask-option.is-selected').length).toBe(2);
  });

  it('单题卡：无 tab、无进度元素', () => {
    void handlePermissionRequest(askPayload());
    const c = card()!;
    expect(c.querySelector('.ask-tabs')).toBeNull();
    expect(c.querySelector('.ask-tabs-row')).toBeNull();
    expect(c.querySelector('[data-ask-progress]')).toBeNull();
    expect(c.classList.contains('is-multi')).toBe(false);
  });

  it('三题乱序作答：答完自动跳到下一个未答问题', async () => {
    const p = handlePermissionRequest(
      askPayload({
        input: {
          questions: [
            { question: 'Q1', options: [{ label: 'A' }] },
            { question: 'Q2', options: [{ label: 'B' }] },
            { question: 'Q3', options: [{ label: 'C' }] },
          ],
        },
      }),
    );
    const c = card()!;
    const tabs = c.querySelectorAll<HTMLElement>('.ask-tab');
    const progress = c.querySelector<HTMLElement>('[data-ask-progress]')!;

    // 先答最后一题 Q3
    tabs[2].click();
    c.querySelector<HTMLInputElement>('input[name="ask-q-2"][value="C"]')!.click();
    expect(progress.textContent).toBe('已答 1/3');
    expect(tabs[2].classList.contains('is-answered')).toBe(true);

    // 回 Q1 作答 → 自动跳到 Q2（Q3 已答，跳过）
    tabs[0].click();
    c.querySelector<HTMLInputElement>('input[name="ask-q-0"][value="A"]')!.click();
    expect(tabs[1].classList.contains('is-active')).toBe(true);
    expect(progress.textContent).toBe('已答 2/3');

    // 答 Q2 → 全部完成
    c.querySelector<HTMLInputElement>('input[name="ask-q-1"][value="B"]')!.click();
    expect(progress.textContent).toBe('全部完成 ✓');
    c.querySelector<HTMLButtonElement>('[data-ask-action="submit"]')!.click();
    await p;
    expect(
      (respondMock.mock.calls[0][0] as { updatedInput: { answers: Record<string, string> } })
        .updatedInput.answers,
    ).toEqual({ Q1: 'A', Q2: 'B', Q3: 'C' });
  });

  it('多题卡 ARIA：tab/panel 互指、roving tabindex、aria-selected、aria-label 已答', async () => {
    void handlePermissionRequest(
      askPayload({
        input: {
          questions: [
            { question: 'Q1', options: [{ label: 'A' }] },
            { question: 'Q2', options: [{ label: 'B' }] },
          ],
        },
      }),
    );
    const c = card()!;
    const tabs = c.querySelectorAll<HTMLElement>('.ask-tab');
    const blocks = c.querySelectorAll<HTMLElement>('.ask-block');

    // tab ↔ panel 互指
    expect(tabs[0].id).toBeTruthy();
    expect(tabs[0].getAttribute('aria-controls')).toBe(blocks[0].id);
    expect(blocks[0].getAttribute('role')).toBe('tabpanel');
    expect(blocks[0].getAttribute('aria-labelledby')).toBe(tabs[0].id);

    // roving tabindex + aria-selected 初始
    expect(tabs[0].tabIndex).toBe(0);
    expect(tabs[1].tabIndex).toBe(-1);
    expect(tabs[0].getAttribute('aria-selected')).toBe('true');
    expect(tabs[1].getAttribute('aria-selected')).toBe('false');

    // 切换后互换
    tabs[1].click();
    expect(tabs[0].tabIndex).toBe(-1);
    expect(tabs[1].tabIndex).toBe(0);
    expect(tabs[0].getAttribute('aria-selected')).toBe('false');
    expect(tabs[1].getAttribute('aria-selected')).toBe('true');

    // 已答后 aria-label 带「已答」
    c.querySelector<HTMLInputElement>('input[name="ask-q-1"][value="B"]')!.click();
    expect(tabs[1].getAttribute('aria-label')).toContain('已答');
  });

  it('主输入框 Enter：多题卡遇未答问题不发送，切到该题并提示', async () => {
    const textarea = document.querySelector<HTMLTextAreaElement>('#message-input')!;
    textarea.addEventListener('keydown', handleKeydown);
    void handlePermissionRequest(
      askPayload({
        input: {
          questions: [
            { question: 'Q1', options: [{ label: 'A' }] },
            { question: 'Q2', options: [{ label: 'B' }] },
          ],
        },
      }),
    );
    const c = card()!;
    // 只答 Q1（自动切到 Q2）
    c.querySelector<HTMLInputElement>('input[name="ask-q-0"][value="A"]')!.click();

    // 主输入框 Enter：Q2 未答 → 拦截不发送，提示出现
    textarea.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }),
    );
    await Promise.resolve();
    await Promise.resolve();
    expect(respondMock).not.toHaveBeenCalled();
    expect(c.querySelector<HTMLElement>('.ask-error')!.hidden).toBe(false);
    expect(c.querySelector<HTMLElement>('.ask-tab[data-q-index="1"]')!.classList.contains('is-active')).toBe(true);
  });

  it('同一会话新请求覆盖旧请求：旧 promise 以 deny 落定，新卡接管', async () => {
    const pOld = handlePermissionRequest(
      askPayload({ requestId: 'req-old', conversationId: 'conv-1' }),
    );
    expect(card()).not.toBeNull();

    // 同会话第二个请求（新 requestId）到达 → 旧卡被驱逐
    const pNew = handlePermissionRequest(
      askPayload({ requestId: 'req-new', conversationId: 'conv-1' }),
    );

    // 旧请求立即以 deny 落定并回执
    await pOld;
    expect(respondMock).toHaveBeenCalledWith({
      requestId: 'req-old',
      behavior: 'deny',
      message: '用户跳过了问题',
      updatedInput: null,
    });

    // 新卡接管，旧的旧卡被移除（host 只留一张卡）
    const cards = document.querySelectorAll<HTMLElement>('.ask-card.is-interactive');
    expect(cards.length).toBe(1);
    expect(cards[0].dataset.askRequestId).toBe('req-new');

    // 新卡可正常作答提交
    cards[0].querySelector<HTMLInputElement>('input[value="前台"]')!.click();
    cards[0].querySelector<HTMLButtonElement>('[data-ask-action="submit"]')!.click();
    await pNew;
    expect(respondMock).toHaveBeenCalledWith(
      expect.objectContaining({ requestId: 'req-new', behavior: 'allow' }),
    );
  });

  it('两会话各一张多问题卡：各自收集各自答案互不串扰', async () => {
    const twoQ = {
      questions: [
        { question: 'Q1', options: [{ label: 'A' }, { label: 'B' }] },
        { question: 'Q2', options: [{ label: 'C' }, { label: 'D' }] },
      ],
    };
    const pA = handlePermissionRequest(
      askPayload({ requestId: 'req-a', conversationId: 'conv-1', input: twoQ }),
    );
    // 后台会话多题卡注册：不渲染到 host，仅入 pending 表
    const pB = handlePermissionRequest(
      askPayload({ requestId: 'req-b', conversationId: 'sub-session-b', input: twoQ }),
    );
    expect(appState.pendingAskQuestions.size).toBe(2);
    expect(
      document.querySelectorAll<HTMLElement>('.ask-card.is-interactive').length,
    ).toBe(1);

    // A 卡作答并提交：收集 A 自己的答案
    const cardA = Array.from(
      document.querySelectorAll<HTMLElement>('.ask-card.is-interactive'),
    ).find((el) => el.dataset.askRequestId === 'req-a')!;
    cardA.querySelector<HTMLInputElement>('input[name="ask-q-0"][value="A"]')!.click();
    cardA.querySelector<HTMLInputElement>('input[name="ask-q-1"][value="C"]')!.click();
    cardA.querySelector<HTMLButtonElement>('[data-ask-action="submit"]')!.click();
    await pA;
    expect(
      (respondMock.mock.calls[0][0] as { updatedInput: { answers: Record<string, string> } })
        .updatedInput.answers,
    ).toEqual({ Q1: 'A', Q2: 'C' });

    // 切到 B 会话：B 卡渲染，进度全新，作答提交收集 B 的答案
    appState.activeConversationId = 'sub-session-b';
    syncPendingAskToInteractionHost();
    const cardB = Array.from(
      document.querySelectorAll<HTMLElement>('.ask-card.is-interactive'),
    ).find((el) => el.dataset.askRequestId === 'req-b')!;
    expect(cardB).not.toBeUndefined();
    expect(cardB.querySelector<HTMLElement>('[data-ask-progress]')!.textContent).toBe('已答 0/2');
    cardB.querySelector<HTMLInputElement>('input[name="ask-q-0"][value="B"]')!.click();
    cardB.querySelector<HTMLInputElement>('input[name="ask-q-1"][value="D"]')!.click();
    cardB.querySelector<HTMLButtonElement>('[data-ask-action="submit"]')!.click();
    await pB;
    expect(
      (respondMock.mock.calls[1][0] as { updatedInput: { answers: Record<string, string> } })
        .updatedInput.answers,
    ).toEqual({ Q1: 'B', Q2: 'D' });
  });

  it('多题卡只答 1/2 时合成点击提交按钮：守卫拦截不发送', async () => {
    void handlePermissionRequest(
      askPayload({
        input: {
          questions: [
            { question: 'Q1', options: [{ label: 'A' }] },
            { question: 'Q2', options: [{ label: 'B' }] },
          ],
        },
      }),
    );
    const c = card()!;
    c.querySelector<HTMLInputElement>('input[name="ask-q-0"][value="A"]')!.click();
    const submitBtn = c.querySelector<HTMLButtonElement>('[data-ask-action="submit"]')!;
    expect(submitBtn.disabled).toBe(true);

    // jsdom 对 disabled 按钮 .click() 直接抑制；用合成事件穿透验证实现守卫本身
    submitBtn.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    await Promise.resolve();
    await Promise.resolve();
    expect(respondMock).not.toHaveBeenCalled();
    // 卡仍在等待 Q2
    expect(card()).not.toBeNull();
    expect(c.querySelector<HTMLElement>('.ask-error')!.hidden).toBe(true);
  });

  it('点「跳过」deny 全流程：回执 deny、卡移除、条目清理', async () => {
    const p = handlePermissionRequest(askPayload());
    const c = card()!;
    expect(c).not.toBeNull();

    (c.querySelector('[data-ask-action="deny"]') as HTMLButtonElement).click();
    await p;
    expect(respondMock).toHaveBeenCalledWith({
      requestId: 'req-ask-1',
      behavior: 'deny',
      message: '用户跳过了问题',
      updatedInput: null,
    });
    expect(card()).toBeNull();
    expect(appState.pendingAskQuestions.size).toBe(0);
    expect(appState.activeQuestionEnterHandlers.size).toBe(0);
  });
});
