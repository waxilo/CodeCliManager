import { appState } from '../../state';
import { shellApi } from '../../app/shell/api';
import * as api from '../../api';
import { showCopyToastMsg } from '../../ui';
import { setSendButtonLoading, setAbortingUi, updateSendButtonState } from './session-context';
import { clearStreamingState } from './streaming';
import { abortSession, sendMessage } from './send';
import { canSendMessage, isSendButtonLoading } from './session-context';
import { refreshConversationFromBackend } from '../conversations/load';
import { updateConversationListSpinner } from '../sidebar/render-list';
export async function invokeRetryMessage(mode: 'regenerate' | 'undo') {
  if (!appState.activeConversationId) {
    showCopyToastMsg(mode === 'regenerate' ? '无法重新生成' : '无法撤回');
    return;
  }
  if (isSendButtonLoading()) {
    showCopyToastMsg(mode === 'regenerate' ? '请等待当前回复结束后再试' : '请等待当前回复结束后再撤回');
    return;
  }

  const cid = appState.activeConversationId;
  if (mode === 'regenerate') {
    setSendButtonLoading(true);
    appState.runningSessions.add(cid);
  } else {
    // 撤回：也设置 loading 状态防止双击，但不加入 appState.runningSessions
    setSendButtonLoading(true);
  }

  try {
    await api.retryMessage({ conversationId: cid, mode });

    if (mode === 'regenerate') {
      // 兜底超时：如果 session-ended 在 3 分钟内未到达，强制恢复 UI
      setTimeout(() => {
        if (appState.runningSessions.has(cid)) {
          console.warn('[retry] regenerate 超时未收到 session-ended，强制恢复');
          appState.runningSessions.delete(cid);
          hideSendingState();
        }
      }, 180_000);
    }

    // undo 模式：清理本地瞬时状态，并强制刷新（防止事件偶发丢失时残留气泡）
    if (mode === 'undo') {
      if (appState.pendingUserMessageConvId === cid) {
        appState.pendingUserMessage = null;
        appState.pendingUserMessageConvId = null;
      }
      clearStreamingState(cid);
      appState.runningSessions.delete(cid);
      setSendButtonLoading(false);
      hideSendingState();
      // messages-updated 通常已更新 appState.conversations；再拉一次兜底
      await refreshConversationFromBackend(cid);
      if (appState.activeConversationId === cid) {
        shellApi.refreshChatContent();
        updateConversationListSpinner();
      }
      showCopyToastMsg('已撤回');
    }
  } catch (e) {
    console.error(`[${mode}] 操作失败:`, e);
    if (mode === 'regenerate') {
      appState.runningSessions.delete(cid);
    }
    setSendButtonLoading(false);
    const detail = e instanceof Error ? e.message : String(e ?? '');
    showCopyToastMsg(
      mode === 'regenerate'
        ? '重新生成失败'
        : detail.includes('未找到可撤回')
          ? '没有可撤回的消息'
          : '撤回失败',
    );
  }
}

/** 重新生成：截断最后 AI 回复并重发 */
export async function handleRetryClick() {
  await invokeRetryMessage('regenerate');
}

/** 撤回：删除最后一条用户消息及其回复 */
export async function handleUndoClick() {
  await invokeRetryMessage('undo');
}

export function handleSendButtonClick() {
  const sendBtn = document.querySelector<HTMLButtonElement>('#send-btn');
  if (!sendBtn) return;

  if (isSendButtonLoading()) {
    // 运行中：有输入内容则追问，否则停止当前任务
    if (canSendMessage()) {
      void sendMessage();
    } else {
      void abortSession();
    }
  } else {
    void sendMessage();
  }
}

export function removePendingAssistantIndicator() {
  document.querySelector('#pending-assistant')?.remove();
}

export function showPendingAssistantIndicator(statusText = '正在思考...') {
  const messageList = document.querySelector<HTMLDivElement>('#message-list');
  if (!messageList) return;

  let pendingEl = document.querySelector('#pending-assistant') as HTMLDivElement | null;
  if (!pendingEl) {
    pendingEl = document.createElement('div');
    pendingEl.id = 'pending-assistant';
    pendingEl.className = 'message assistant pending';
    pendingEl.innerHTML = `
      <div class="message-content message-pending-content">
        <div class="pending-animation">
          <span class="pending-dot"></span>
          <span class="pending-dot"></span>
          <span class="pending-dot"></span>
        </div>
        <span class="pending-text"></span>
      </div>
    `;
    messageList.appendChild(pendingEl);
  }

  const textEl = pendingEl.querySelector('.pending-text');
  if (textEl) {
    textEl.textContent = statusText;
  }
  appState.answerScroller?.scrollToBottom();
}

export function updatePendingStatus(statusText: string) {
  showPendingAssistantIndicator(statusText);
}

export function clearPendingRequestState() {
  removePendingAssistantIndicator();
}

export function hideSendingState() {
  clearPendingRequestState();
  setAbortingUi(false);
  // 直接重置按钮为非加载状态（此函数仅在当前查看的会话结束时调用）
  setSendButtonLoading(false);
  updateSendButtonState();
}

/** 消息列表渲染后的统一后处理：代码复制按钮、思考块折叠、消息复制控件 */
