import { appState } from '../../state';
import { scheduleUiRefresh, afterUiRefresh } from '../../ui';
import type { PermissionRequestPayload, AskUserQuestionOption, AskUserQuestionItem, AskUserQuestionInput, QuestionDialogResult } from '../../types';
import { syncMessageInputPlaceholder } from '../chat/session-context';
import { renderAskUserQuestionCardHtml } from '../chat/render-messages';
import { getInteractionHost } from './interaction-panel';
export function parseAskUserQuestionInput(input: unknown): AskUserQuestionInput | null {
  if (!input || typeof input !== 'object') return null;
  const questionsRaw = (input as { questions?: unknown }).questions;
  if (!Array.isArray(questionsRaw) || questionsRaw.length === 0) return null;

  const questions: AskUserQuestionItem[] = [];
  for (const item of questionsRaw) {
    if (!item || typeof item !== 'object') continue;
    const q = item as Record<string, unknown>;
    const question = typeof q.question === 'string' ? q.question.trim() : '';
    if (!question) continue;
    const optionsRaw = Array.isArray(q.options) ? q.options : [];
    const options: AskUserQuestionOption[] = [];
    for (const opt of optionsRaw) {
      if (!opt || typeof opt !== 'object') continue;
      const o = opt as Record<string, unknown>;
      const label = typeof o.label === 'string' ? o.label.trim() : '';
      if (!label) continue;
      options.push({
        label,
        description: typeof o.description === 'string' ? o.description : undefined,
      });
    }
    if (options.length === 0) continue;
    questions.push({
      question,
      header: typeof q.header === 'string' ? q.header : undefined,
      options,
      multiSelect: Boolean(q.multiSelect),
    });
  }
  return questions.length > 0 ? { questions } : null;
}

/**
 * AskUserQuestion：可点选卡片钉在输入框上方（#interaction-host）
 * 「自定义回答」是卡片内始终可见的输入框，直接填写即作为答案，无需先勾选「其他」
 */
export function showQuestionDialog(
  payload: PermissionRequestPayload,
  parsed: AskUserQuestionInput,
): Promise<QuestionDialogResult> {
  return new Promise((resolve) => {
    const askKey = payload.conversationId || 'pending';
    let settled = false;

    const finish = (result: QuestionDialogResult) => {
      if (settled) return;
      settled = true;
      document.removeEventListener('keydown', onKey);
      appState.activeQuestionEnterHandler = null;
      appState.activeAskQuestionCleanup = null;
      syncMessageInputPlaceholder();

      // 清掉临时可点选卡；已选结果等会话历史回写后展示
      appState.pendingAskQuestions.delete(askKey);
      // 立即移除输入框上方的问卡（不依赖后续重建；幂等，无 host / 有权限面板时 no-op）
      syncPendingAskToInteractionHost();
      if (!appState.activeConversationId || askKey === appState.activeConversationId || askKey === 'pending') {
        scheduleUiRefresh({ chat: true });
      }
      resolve(result);
    };

    const collectAnswersFromCard = (card: HTMLElement): Record<string, string> | null => {
      const answers: Record<string, string> = {};
      const errorEl = card.querySelector('.ask-error') as HTMLElement | null;

      for (let qIndex = 0; qIndex < parsed.questions.length; qIndex++) {
        const q = parsed.questions[qIndex];
        const block = card.querySelector(`.ask-block[data-q-index="${qIndex}"]`);
        if (!block) return null;
        const selected = Array.from(
          block.querySelectorAll<HTMLInputElement>(`input[name="ask-q-${qIndex}"]:checked`),
        );
        const customInput = block.querySelector<HTMLInputElement>(
          `input[data-ask-other-input="1"][data-q-index="${qIndex}"]`,
        );
        const customText = (customInput?.value || '').trim();

        // 既没选项也没填写自定义回答 → 拦截，不发送响应
        if (selected.length === 0 && !customText) {
          if (errorEl) {
            errorEl.hidden = false;
            errorEl.textContent = `请回答：${q.question}`;
          }
          return null;
        }

        // 自定义回答输入框即答案：非空即计入。单选时自定义回答优先（替换已选项）；多选时与已选项合并。
        if (q.multiSelect) {
          const values = selected.map((input) => input.value);
          if (customText) values.push(customText);
          answers[q.question] = values.join(', ');
        } else {
          answers[q.question] = customText || selected[0]?.value || '';
        }
      }
      if (errorEl) {
        errorEl.hidden = true;
        errorEl.textContent = '';
      }
      return answers;
    };

    const trySubmit = (): boolean => {
      // 用 dataset 遍历而非 CSS.escape 选择器：requestId 均由后端生成（UUID/init_/permission_mode_），
      // 无需转义；且 jsdom 缺 CSS.escape 时测试可正常跑（与 syncPendingAskToInteractionHost 一致）。
      const card = Array.from(
        document.querySelectorAll<HTMLElement>('.ask-card.is-interactive'),
      ).find((el) => el.dataset.askRequestId === payload.requestId);
      if (!card) return false;
      const answers = collectAnswersFromCard(card);
      if (!answers) return false;
      finish({ action: 'submit', answers });
      return true;
    };

    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      finish({ action: 'deny' });
    };

    appState.pendingAskQuestions.set(askKey, {
      requestId: payload.requestId,
      conversationId: askKey,
      input: parsed,
      finish,
    });
    appState.activeAskQuestionCleanup = () => finish({ action: 'deny' });
    appState.activeQuestionEnterHandler = () => trySubmit();
    document.addEventListener('keydown', onKey);

    // 立即挂卡（不依赖聊天重建；若 refreshChatContent 因无会话对象提前返回，卡也已就位）。
    // 后续 rebuild 的 setupMessageListPostRender 会再次同步，但同 requestId 已绑定卡会被保留。
    syncPendingAskToInteractionHost();
    if (!appState.activeConversationId || askKey === appState.activeConversationId || askKey === 'pending') {
      scheduleUiRefresh({ chat: true });
      // 滚到选择卡，便于直接点选（卡已挂在输入框上方，scrollIntoView 幂等）
      afterUiRefresh(() => {
        Array.from(document.querySelectorAll<HTMLElement>('.ask-card.is-interactive'))
          .find((el) => el.dataset.askRequestId === payload.requestId)
          ?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
      });
    }
  });
}

/** 绑定对话流内可交互选择卡事件 */
export function bindInteractiveAskCards(container: HTMLElement): void {
  container.querySelectorAll<HTMLElement>('.ask-card.is-interactive').forEach((card) => {
    if (card.dataset.askBound === '1') return;
    card.dataset.askBound = '1';

    const requestId = card.dataset.askRequestId || '';
    const state = [...appState.pendingAskQuestions.values()].find((s) => s.requestId === requestId);
    if (!state?.finish) return;

    card.querySelectorAll<HTMLInputElement>('input[type="radio"], input[type="checkbox"]').forEach((input) => {
      input.addEventListener('change', () => {
        // 同步选中样式
        card.querySelectorAll('.ask-option').forEach((opt) => {
          const inp = opt.querySelector('input');
          opt.classList.toggle('is-selected', !!inp?.checked);
        });
      });
    });

    // 卡片「自定义回答」输入框：Enter 直接提交
    card.querySelectorAll<HTMLInputElement>('input[data-ask-other-input="1"]').forEach((input) => {
      input.addEventListener('keydown', (event) => {
        if (event.key === 'Enter') {
          event.preventDefault();
          appState.activeQuestionEnterHandler?.();
        }
      });
    });

    card.querySelector('[data-ask-action="deny"]')?.addEventListener('click', () => {
      state.finish?.({ action: 'deny' });
    });
    card.querySelector('[data-ask-action="submit"]')?.addEventListener('click', () => {
      appState.activeQuestionEnterHandler?.();
    });
  });
}

/**
 * 把进行中的 AskUserQuestion 卡片同步到输入框上方（#interaction-host）。
 * 在 setupMessageListPostRender 每次聊天重建后调用；与旧 buildDisplayMessages 共用
 * 同一 pending 槽回退逻辑（当前会话 → 'pending'），再兜底任意待作答卡片。
 *
 * 有工具权限面板展示时：仅当权限面板与问卡属同一会话才不抢占（同会话互斥，防御性分支）。
 * 其他会话遗留的权限面板不应压制当前会话的问卡——问卡挂到面板之前（prepend），
 * 双方都可作答；问卡结束后面板仍在 host 中（切回该会话由 remountActiveInteractionPanel 恢复）。
 */
export function syncPendingAskToInteractionHost(): void {
  const host = getInteractionHost();
  if (!host) return;

  const askKey = appState.activeConversationId || 'pending';
  const pendingAsk =
    appState.pendingAskQuestions.get(askKey) ||
    (appState.activeConversationId
      ? appState.pendingAskQuestions.get('pending')
      : undefined) ||
    // 子代理等非当前会话 id 的问卡：无当前会话问卡时兜底展示任意待作答卡片
    [...appState.pendingAskQuestions.values()].find((s) => s.finish && !s.answers);

  // 同会话工具权限面板正在展示时不抢占（AskUserQuestion 与工具权限互斥，防御性分支）；
  // 其他会话的残留面板不属于当前问卡，不阻断挂载。
  if (
    pendingAsk?.finish &&
    !pendingAsk.answers &&
    appState.activeInteractionPanel &&
    appState.activeInteractionPanel.conversationId === pendingAsk.conversationId
  ) {
    return;
  }

  // 无待问答：清掉输入框上方的问卡残留，host 空则隐藏
  if (!pendingAsk?.finish || pendingAsk.answers) {
    const leftover = host.querySelector<HTMLElement>('.ask-card');
    if (leftover) leftover.remove();
    if (host.childElementCount === 0) host.hidden = true;
    return;
  }

  // 已有同 requestId 且已绑定好的卡片：保留现场，不打断用户正在做的选择
  // （用 dataset 遍历而非 CSS.escape 选择器，避免 jsdom 缺 CSS.escape 时测试炸掉）
  const existing = Array.from(host.querySelectorAll<HTMLElement>('.ask-card.is-interactive')).find(
    (card) => card.dataset.askRequestId === pendingAsk.requestId && card.dataset.askBound === '1',
  );
  if (existing) {
    host.hidden = false;
    return;
  }

  const wrapper = document.createElement('div');
  wrapper.innerHTML = renderAskUserQuestionCardHtml(
    { questions: pendingAsk.input.questions },
    null,
    true,
    true,
    pendingAsk.requestId,
  );
  const card = wrapper.firstElementChild as HTMLElement | null;
  if (!card) return;
  // 挂到 host 最前：不覆盖其他会话残留的权限面板（prepend 而非 replaceChildren）
  host.prepend(card);
  bindInteractiveAskCards(host);
  host.hidden = false;
}

/** 关闭指定会话（或全部）的权限/问答 UI；后端已 deny 时前端仅关 UI */
