import { appState } from '../../state';
import { scheduleUiRefresh, afterUiRefresh } from '../../ui';
import type { PermissionRequestPayload, AskUserQuestionOption, AskUserQuestionItem, AskUserQuestionInput, QuestionDialogResult, PendingAskQuestionState } from '../../types';
import { getActiveSessionKey, syncMessageInputPlaceholder } from '../chat/session-context';
import { renderAskUserQuestionCardHtml } from '../chat/render-messages';
import { getInteractionHost } from './interaction-panel';
import { getPermissionMode } from './permission-mode';
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
 * 「全自动」模式：不弹卡，自动选择每个问题的第一个选项并立即提交
 */
export function showQuestionDialog(
  payload: PermissionRequestPayload,
  parsed: AskUserQuestionInput,
): Promise<QuestionDialogResult> {
  if (getPermissionMode() === 'auto') {
    const answers: Record<string, string> = {};
    for (const q of parsed.questions) {
      answers[q.question] = q.options[0]?.label ?? '';
    }
    return Promise.resolve({ action: 'submit', answers });
  }

  return new Promise((resolve) => {
    const askKey = payload.conversationId;
    let settled = false;

    const findCurrentAskKey = (): string => {
      for (const [key, state] of appState.pendingAskQuestions) {
        if (state.requestId === payload.requestId) return key;
      }
      return askKey;
    };

    const finish = (result: QuestionDialogResult) => {
      if (settled) return;
      settled = true;
      document.removeEventListener('keydown', onKey);
      const currentAskKey = findCurrentAskKey();
      appState.activeQuestionEnterHandlers.delete(currentAskKey);
      syncMessageInputPlaceholder();

      appState.pendingAskQuestions.delete(currentAskKey);
      syncPendingAskToInteractionHost();
      if (currentAskKey === getActiveSessionKey()) {
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
          // 未答完时把该问题切到前台，用户直接看到要回答的题
          activateAskQuestionTab(card, qIndex);
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
      if (getActiveSessionKey() !== findCurrentAskKey()) return;
      event.preventDefault();
      finish({ action: 'deny' });
    };

    // 入表前驱逐过期条目：同 key（会话槽）或同 requestId 的旧请求先 finish(deny)，
    // 让旧 promise 落定、旧卡/旧监听随 sync 清理，再写入新条目（避免悬挂与旧闭包串扰）
    const prevByKey = appState.pendingAskQuestions.get(askKey);
    if (prevByKey) {
      prevByKey.finish?.({ action: 'deny' });
      // finish 未自行清理（如测试桩）时兜底删除
      if (appState.pendingAskQuestions.get(askKey) === prevByKey) {
        appState.pendingAskQuestions.delete(askKey);
      }
    }
    for (const [k, s] of appState.pendingAskQuestions) {
      if (s.requestId === payload.requestId && k !== askKey) {
        s.finish?.({ action: 'deny' });
        if (appState.pendingAskQuestions.get(k) === s) {
          appState.pendingAskQuestions.delete(k);
        }
      }
    }
    appState.pendingAskQuestions.set(askKey, {
      requestId: payload.requestId,
      conversationId: askKey,
      input: parsed,
      finish,
      submit: trySubmit,
    });
    // 按 askKey 注册 Enter 提交回调：并发多卡互不覆盖（主输入框只提交当前会话对应卡）
    appState.activeQuestionEnterHandlers.set(askKey, () => trySubmit());
    document.addEventListener('keydown', onKey);

    // 立即挂卡（不依赖聊天重建；若 refreshChatContent 因无会话对象提前返回，卡也已就位）。
    // 后续 rebuild 的 setupMessageListPostRender 会再次同步，但同 requestId 已绑定卡会被保留。
    syncPendingAskToInteractionHost();
    if (askKey === getActiveSessionKey()) {
      scheduleUiRefresh({ chat: true });
      afterUiRefresh(() => {
        Array.from(document.querySelectorAll<HTMLElement>('.ask-card.is-interactive'))
          .find((el) => el.dataset.askRequestId === payload.requestId)
          ?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
      });
    }
  });
}

/** 是否所有问题都已有答案（answers 含部分进度时也算未答完） */
function isAskFullyAnswered(state: PendingAskQuestionState): boolean {
  return (
    state.input.questions.length > 0 &&
    state.input.questions.every((q) => (state.answers?.[q.question] || '').trim() !== '')
  );
}

/** 切换问卡当前展示的问题 tab（多问题分页；单问题无 tab 时 no-op）。
 *  roving tabindex：激活 tab 为 Tab 停靠点，其余移出 Tab 序 */
function activateAskQuestionTab(card: HTMLElement, qIndex: number, opts?: { focus?: boolean }): void {  card.querySelectorAll<HTMLElement>('.ask-tab').forEach((tab) => {
    const active = Number(tab.dataset.qIndex) === qIndex;
    tab.classList.toggle('is-active', active);
    tab.setAttribute('aria-selected', String(active));
    tab.tabIndex = active ? 0 : -1;
  });
  card.querySelectorAll<HTMLElement>('.ask-block').forEach((block) => {
    block.hidden = Number(block.dataset.qIndex) !== qIndex;
  });
  if (opts?.focus) {
    card.querySelector<HTMLElement>(`.ask-tab[data-q-index="${qIndex}"]`)?.focus();
  }
}

/** 绑定对话流内可交互选择卡事件 */
export function bindInteractiveAskCards(container: HTMLElement): void {
  container.querySelectorAll<HTMLElement>('.ask-card.is-interactive').forEach((card) => {
    if (card.dataset.askBound === '1') return;
    card.dataset.askBound = '1';

    const requestId = card.dataset.askRequestId || '';
    const state = [...appState.pendingAskQuestions.values()].find((s) => s.requestId === requestId);
    if (!state?.finish) return;

    // —— 多问题 tab：点击 / 方向键（ARIA tabs 模式，roving tabindex） ——
    card.querySelectorAll<HTMLElement>('.ask-tab').forEach((tab) => {
      tab.addEventListener('click', () => {
        activateAskQuestionTab(card, Number(tab.dataset.qIndex));
      });
      tab.addEventListener('keydown', (event) => {
        const tabs = Array.from(card.querySelectorAll<HTMLElement>('.ask-tab'));
        const current = tabs.indexOf(tab);
        let nextIdx: number | null = null;
        if (event.key === 'ArrowRight') nextIdx = (current + 1) % tabs.length;
        else if (event.key === 'ArrowLeft') nextIdx = (current - 1 + tabs.length) % tabs.length;
        else if (event.key === 'Home') nextIdx = 0;
        else if (event.key === 'End') nextIdx = tabs.length - 1;
        if (nextIdx !== null) {
          event.preventDefault();
          activateAskQuestionTab(card, Number(tabs[nextIdx].dataset.qIndex), { focus: true });
        }
      });
    });

    // —— 进度刷新：每题是否已答 → tab 打勾 + 答案摘要 + 全部答完才放开提交 ——
    const submitBtn = card.querySelector<HTMLButtonElement>('[data-ask-action="submit"]');
    const progressEl = card.querySelector<HTMLElement>('[data-ask-progress]');
    const refreshAskCardProgress = (): boolean => {
      const qIndexes = Array.from(card.querySelectorAll<HTMLElement>('.ask-block')).map((b) =>
        Number(b.dataset.qIndex),
      );
      let allAnswered = qIndexes.length > 0;
      let answeredCount = 0;
      // 作答结果同步回 state.answers：切会话/重建后恢复进度
      const collected: Record<string, string> = {};
      for (const qi of qIndexes) {
        const block = card.querySelector(`.ask-block[data-q-index="${qi}"]`);
        const checked = Array.from(
          block?.querySelectorAll<HTMLInputElement>(`input[name="ask-q-${qi}"]:checked`) ?? [],
        );
        const customValue = (
          block?.querySelector<HTMLInputElement>('input[data-ask-other-input="1"]')?.value || ''
        ).trim();
        const multiSelect = Boolean(state.input.questions[qi]?.multiSelect);
        const answered = checked.length > 0 || customValue !== '';
        if (answered) answeredCount += 1;
        else allAnswered = false;
        card.querySelectorAll(`.ask-tab[data-q-index="${qi}"]`).forEach((tab) => {
          tab.classList.toggle('is-answered', answered);
          const summary = answered ? customValue || checked.map((i) => i.value).join('、') : '';
          const answerEl = tab.querySelector<HTMLElement>('.ask-tab-answer');
          if (answerEl) {
            answerEl.textContent = summary;
          }
          // 读屏可感知已答状态（进度条 aria-live 只在计数变化时播报，逐键不重复）
          const label = tab.querySelector<HTMLElement>('.ask-tab-label')?.textContent || '';
          tab.setAttribute('aria-label', answered ? `${label}，已答：${summary}` : label);
        });
        const question = state.input.questions[qi]?.question;
        if (question) {
          collected[question] = multiSelect
            ? [...checked.map((i) => i.value), ...(customValue ? [customValue] : [])].join(', ')
            : customValue || checked[0]?.value || '';
        }
      }
      state.answers = Object.keys(collected).length > 0 ? collected : undefined;
      if (submitBtn) {
        submitBtn.disabled = !allAnswered;
        submitBtn.title = allAnswered ? '' : '完成所有问题后可提交';
        submitBtn.classList.toggle('is-ready', allAnswered);
      }
      if (progressEl) {
        progressEl.textContent = allAnswered
          ? '全部完成 ✓'
          : `已答 ${answeredCount}/${qIndexes.length}`;
      }
      return allAnswered;
    };

    // —— 答完当前问题自动切到下一个未答问题（单选点选后；多选/自定义输入不打断） ——
    const maybeAdvanceAskTab = (qIndex: number) => {
      const tabs = Array.from(card.querySelectorAll<HTMLElement>('.ask-tab'));
      if (tabs.length < 2) return;
      const next = tabs.find(
        (t) => Number(t.dataset.qIndex) > qIndex && !t.classList.contains('is-answered'),
      );
      if (next) activateAskQuestionTab(card, Number(next.dataset.qIndex), { focus: true });
    };

    const clearAskError = () => {
      const err = card.querySelector<HTMLElement>('.ask-error');
      if (err) err.hidden = true;
    };

    card.querySelectorAll<HTMLInputElement>('input[type="radio"], input[type="checkbox"]').forEach((input) => {
      input.addEventListener('change', () => {
        // 同步选中样式
        card.querySelectorAll('.ask-option').forEach((opt) => {
          const inp = opt.querySelector('input');
          opt.classList.toggle('is-selected', !!inp?.checked);
        });
        clearAskError();
        const qi = Number(input.dataset.qIndex);
        refreshAskCardProgress();
        // 多选可能继续勾选，不自动切题；单选点选即完成，切下一题
        if (input.type === 'radio') maybeAdvanceAskTab(qi);
      });
    });

    // 卡片「自定义回答」输入框：Enter 直接提交（用本卡自己的 submit，并发多卡互不串扰）
    card.querySelectorAll<HTMLInputElement>('input[data-ask-other-input="1"]').forEach((input) => {
      input.addEventListener('keydown', (event) => {
        if (event.key === 'Enter') {
          event.preventDefault();
          state.submit?.();
        }
      });
      // 边输入边计入「已答」，全部答完自动放开提交
      input.addEventListener('input', () => {
        clearAskError();
        refreshAskCardProgress();
      });
      // 失焦且已填内容才切题：避免输入首个字符就切走导致后续输入丢失
      input.addEventListener('blur', () => {
        const qi = Number(input.dataset.qIndex);
        if ((input.value || '').trim() !== '') maybeAdvanceAskTab(qi);
      });
    });

    card.querySelector('[data-ask-action="deny"]')?.addEventListener('click', () => {
      state.finish?.({ action: 'deny' });
    });
    submitBtn?.addEventListener('click', () => {
      if (submitBtn.disabled) return;
      state.submit?.();
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

  const askKey = getActiveSessionKey();
  const pendingAsk = askKey ? appState.pendingAskQuestions.get(askKey) : undefined;
  const interactionPanel = askKey
    ? appState.interactionPanelsBySession.get(askKey)
    : undefined;

  if (
    pendingAsk?.finish &&
    !isAskFullyAnswered(pendingAsk) &&
    interactionPanel
  ) {
    return;
  }

  // 无待问答（条目已被 finish 删除）：清掉输入框上方的问卡残留，host 空则隐藏。
  // 注意：answers 部分/全部写入≠结束——卡要保留到用户提交（finish）为止。
  if (!pendingAsk?.finish) {
    const leftover = host.querySelector<HTMLElement>('.ask-card');
    if (leftover) leftover.remove();
    if (host.childElementCount === 0) host.hidden = true;
    return;
  }

  // 已有同 requestId 且已绑定好的卡片：保留现场，不打断用户正在做的选择
  // （用 dataset 遍历而非 CSS.escape 选择器，避免 jsdom 缺 CSS.escape 时测试炸掉）
  // 先移除不属于当前待答卡的旧卡（刚 finish 的卡 / 其他会话残留卡）
  host.querySelectorAll<HTMLElement>('.ask-card.is-interactive').forEach((c) => {
    if (c.dataset.askRequestId !== pendingAsk.requestId) c.remove();
  });
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
    // 部分作答后重建：带 answers 恢复已答进度（选中态/打勾/摘要/提交可用性）
    pendingAsk.answers ?? null,
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
