import { appState } from '../../state';
import { shellApi } from '../../app/shell/api';
import type { PermissionRequestPayload, AskUserQuestionOption, AskUserQuestionItem, AskUserQuestionInput, QuestionDialogResult } from '../../types';
import { syncMessageInputPlaceholder } from '../chat/session-context';
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
 * AskUserQuestion：在对话流选择卡内直接点选
 * 「其他」自定义回答使用下方大输入框；不再在输入框上方弹额外面板
 */
export function showQuestionDialog(
  payload: PermissionRequestPayload,
  parsed: AskUserQuestionInput,
): Promise<QuestionDialogResult> {
  return new Promise((resolve) => {
    const askKey = payload.conversationId || 'pending';
    let settled = false;
    let usedComposerForOther = false;

    const mainInput = () =>
      document.querySelector<HTMLTextAreaElement>('#message-input');

    const finish = (result: QuestionDialogResult) => {
      if (settled) return;
      settled = true;
      document.removeEventListener('keydown', onKey);
      appState.activeQuestionEnterHandler = null;
      appState.activeAskQuestionCleanup = null;
      appState.questionOtherInputActive = false;
      if (result.action === 'submit' && usedComposerForOther) {
        const input = mainInput();
        if (input) {
          input.value = '';
          input.dispatchEvent(new Event('input', { bubbles: true }));
        }
      }
      syncMessageInputPlaceholder();

      // 清掉临时可点选卡；已选结果等会话历史回写后展示
      appState.pendingAskQuestions.delete(askKey);
      if (!appState.activeConversationId || askKey === appState.activeConversationId || askKey === 'pending') {
        shellApi.refreshChatContent();
      }
      resolve(result);
    };

    const collectAnswersFromCard = (card: HTMLElement): Record<string, string> | null => {
      const answers: Record<string, string> = {};
      const composerText = (mainInput()?.value || '').trim();
      const errorEl = card.querySelector('.ask-error') as HTMLElement | null;

      for (let qIndex = 0; qIndex < parsed.questions.length; qIndex++) {
        const q = parsed.questions[qIndex];
        const block = card.querySelector(`.ask-block[data-q-index="${qIndex}"]`);
        if (!block) return null;
        const selected = Array.from(
          block.querySelectorAll<HTMLInputElement>(`input[name="ask-q-${qIndex}"]:checked`),
        );
        if (selected.length === 0) {
          if (errorEl) {
            errorEl.hidden = false;
            errorEl.textContent = `请回答：${q.question}`;
          }
          return null;
        }

        const values: string[] = [];
        for (const input of selected) {
          if (input.dataset.other === '1') {
            if (!composerText) {
              if (errorEl) {
                errorEl.hidden = false;
                errorEl.textContent = `请在下方输入框填写「其他」内容：${q.question}`;
              }
              appState.questionOtherInputActive = true;
              syncMessageInputPlaceholder();
              mainInput()?.focus();
              return null;
            }
            usedComposerForOther = true;
            values.push(composerText);
          } else {
            values.push(input.value);
          }
        }
        answers[q.question] = q.multiSelect ? values.join(', ') : values[0];
      }
      if (errorEl) {
        errorEl.hidden = true;
        errorEl.textContent = '';
      }
      return answers;
    };

    const trySubmit = (): boolean => {
      const card = document.querySelector<HTMLElement>(
        `.ask-card.is-interactive[data-ask-request-id="${CSS.escape(payload.requestId)}"]`,
      );
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

    if (!appState.activeConversationId || askKey === appState.activeConversationId || askKey === 'pending') {
      shellApi.refreshChatContent();
      // 滚到选择卡，便于直接点选
      requestAnimationFrame(() => {
        document
          .querySelector(`.ask-card.is-interactive[data-ask-request-id="${CSS.escape(payload.requestId)}"]`)
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

    const mainInput = () =>
      document.querySelector<HTMLTextAreaElement>('#message-input');

    const syncOtherComposerMode = () => {
      const otherOn = !!card.querySelector('input[data-other="1"]:checked');
      appState.questionOtherInputActive = otherOn;
      syncMessageInputPlaceholder();
      if (otherOn) mainInput()?.focus();
    };

    card.querySelectorAll<HTMLInputElement>('input[type="radio"], input[type="checkbox"]').forEach((input) => {
      input.addEventListener('change', () => {
        // 同步选中样式
        card.querySelectorAll('.ask-option').forEach((opt) => {
          const inp = opt.querySelector('input');
          opt.classList.toggle('is-selected', !!inp?.checked);
        });
        syncOtherComposerMode();
      });
    });

    card.querySelector('[data-ask-action="deny"]')?.addEventListener('click', () => {
      state.finish?.({ action: 'deny' });
    });
    card.querySelector('[data-ask-action="submit"]')?.addEventListener('click', () => {
      appState.activeQuestionEnterHandler?.();
    });

    syncOtherComposerMode();
  });
}

/** 关闭指定会话（或全部）的权限/问答 UI；后端已 deny 时前端仅关 UI */
