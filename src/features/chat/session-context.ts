import { appState } from '../../state';
import { getActiveConversation } from '../conversations/normalize';
export function isNewChatSession(): boolean {
  return !appState.activeConversationId;
}

export function getEffectiveProjectDir(): string {
  if (appState.activeConversationId) {
    const dir = getActiveConversation()?.project_dir?.trim();
    return dir || '';
  }
  return appState.pendingProjectDir?.trim() || '';
}

export function hasRequiredProjectDir(): boolean {
  return getEffectiveProjectDir().length > 0;
}

export function canSendMessage(content?: string): boolean {
  const input = document.querySelector<HTMLTextAreaElement>('#message-input');
  const text = (content ?? input?.value ?? '').trim();
  // 纯文字、粘贴图片或导入引用任一存在即可发送。
  if (
    !text &&
    appState.pasteAttachments.length === 0 &&
    appState.importedFileRefs.length === 0
  ) {
    return false;
  }
  if (isNewChatSession() && !hasRequiredProjectDir()) {
    return false;
  }
  return true;
}

/** 当前激活会话是否在运行中（与左侧会话列表同一数据源：appState.runningSessions） */
export function isActiveConversationRunning(): boolean {
  if (appState.activeConversationId) {
    return appState.runningSessions.has(appState.activeConversationId);
  }
  return appState.runningSessions.has('pending');
}

export function isSendButtonLoading(): boolean {
  // 优先跟左侧一致：以 appState.runningSessions 为准；dataset 仅覆盖撤回等短暂 UI busy
  if (isActiveConversationRunning()) return true;
  const sendBtn = document.querySelector<HTMLButtonElement>('#send-btn');
  return sendBtn?.dataset.loading === 'true';
}

export function updateSendButtonState() {
  const sendBtn = document.querySelector<HTMLButtonElement>('#send-btn');
  if (!sendBtn) {
    return;
  }

  const sendIcon = sendBtn.querySelector('.send-icon') as SVGElement | null;
  const stopIcon = sendBtn.querySelector('.stop-icon') as SVGElement | null;
  const checkSpinner = sendBtn.querySelector('.send-check-spinner') as HTMLElement | null;

  // 发送前 Kiro 预检：保持检查中 UI，避免被后续状态同步冲掉
  if (sendBtn.dataset.checkingKiro === 'true') {
    sendBtn.disabled = true;
    sendBtn.classList.remove('is-loading', 'is-aborting');
    sendBtn.classList.add('is-checking');
    sendBtn.setAttribute('aria-label', '正在检查 Kiro 代理');
    sendBtn.title = '正在检查 Kiro 代理…';
    if (sendIcon) sendIcon.style.display = 'none';
    if (stopIcon) stopIcon.style.display = 'none';
    if (checkSpinner) checkSpinner.hidden = false;
    return;
  }
  sendBtn.classList.remove('is-checking');
  if (checkSpinner) checkSpinner.hidden = true;

  // 与左侧一致：运行中以 appState.runningSessions 为准；若 DOM 状态落后则完整同步（含输入区）
  const sessionRunning = isActiveConversationRunning();
  if (sessionRunning && sendBtn.dataset.loading !== 'true') {
    setSendButtonLoading(true);
    return;
  }
  const loading = sessionRunning || sendBtn.dataset.loading === 'true';
  const hasContent = canSendMessage();

  if (appState.isAbortingActiveSession) {
    sendBtn.disabled = true;
    sendBtn.classList.add('is-loading');
    sendBtn.classList.add('is-aborting');
    sendBtn.setAttribute('aria-label', '正在停止');
    sendBtn.title = '正在停止…';
    if (sendIcon) sendIcon.style.display = 'none';
    if (stopIcon) stopIcon.style.display = '';
    return;
  }
  sendBtn.classList.remove('is-aborting');

  if (loading) {
    // 运行中：有内容 → 会话中追问；无内容 → 停止本轮
    const followupMode = hasContent;
    const queuedCount = appState.activeConversationId
      ? appState.queuedPromptsBySession.get(appState.activeConversationId)?.length || 0
      : 0;
    sendBtn.disabled = false;
    sendBtn.classList.toggle('is-loading', !followupMode);
    sendBtn.setAttribute('aria-label', followupMode ? '发送追问' : '停止');
    sendBtn.title = followupMode
      ? queuedCount > 0
        ? `加入队列（当前 ${queuedCount} 条）`
        : '发送追问（回答结束后自动处理）'
      : '停止当前任务';
    if (sendIcon) sendIcon.style.display = followupMode ? '' : 'none';
    if (stopIcon) stopIcon.style.display = followupMode ? 'none' : '';
    return;
  }

  sendBtn.classList.remove('is-loading');
  sendBtn.disabled = !hasContent;
  sendBtn.setAttribute('aria-label', '发送');
  sendBtn.title = '发送';
  if (sendIcon) sendIcon.style.display = '';
  if (stopIcon) stopIcon.style.display = 'none';
}

export function setAbortingUi(aborting: boolean) {
  appState.isAbortingActiveSession = aborting;
  syncMessageInputPlaceholder();
  updateSendButtonState();
}

export function getDefaultMessagePlaceholder(loading = isSendButtonLoading()): string {
  if (appState.isAbortingActiveSession) return '正在停止当前任务…';
  if (loading) {
    const queuedCount = appState.activeConversationId
      ? appState.queuedPromptsBySession.get(appState.activeConversationId)?.length || 0
      : 0;
    const suffix = queuedCount > 0 ? `（已排队 ${queuedCount} 条）` : '';
    return `AI 正在回答中，可继续输入后 Enter 发送追问${suffix}…`;
  }
  return '输入你的问题，Enter 发送，Shift+Enter 换行，@ 引用文件，粘贴图片...';
}

export function syncMessageInputPlaceholder(): void {
  const input = document.querySelector<HTMLTextAreaElement>('#message-input');
  if (!input) return;
  input.placeholder = getDefaultMessagePlaceholder();
}

export function setSendButtonLoading(loading: boolean) {
  const sendBtn = document.querySelector<HTMLButtonElement>('#send-btn');
  if (!sendBtn) {
    return;
  }
  sendBtn.dataset.loading = loading ? 'true' : 'false';

  // 运行中仍允许继续输入并追问，不禁用输入框
  const input = document.querySelector<HTMLTextAreaElement>('#message-input');
  if (input) {
    input.disabled = false;
    if (!appState.isAbortingActiveSession) {
      syncMessageInputPlaceholder();
    }
  }

  const inputArea = document.querySelector('.input-composer');
  if (inputArea) {
    inputArea.classList.toggle('is-loading', loading || appState.isAbortingActiveSession);
  }

  updateSendButtonState();
}

/** 流式「待回复」占位已移除：状态改由输入框下方状态条承载。保留空实现兼容调用方。 */
export function removePendingAssistantIndicator() {
  document.querySelector('#pending-assistant')?.remove();
}

/** 流式「待回复」占位已移除：状态改由输入框下方状态条承载。保留空实现兼容调用方。 */
export function clearPendingRequestState() {
  removePendingAssistantIndicator();
}

/** 结束/清除发送状态：清占位、重置 aborting 与按钮 loading。 */
export function hideSendingState() {
  clearPendingRequestState();
  setAbortingUi(false);
  // 直接重置按钮为非加载状态（此函数仅在当前查看的会话结束时调用）
  setSendButtonLoading(false);
  updateSendButtonState();
}

