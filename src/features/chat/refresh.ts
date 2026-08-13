import { appState } from '../../state';
import { initCodeCopyButtons, copyToClipboard } from '../../markdown';
import { bindInteractiveAskCards } from '../permissions';
import { renderConversationMessagesInnerHtml, buildDisplayMessages } from './render-chat';
import { bindSessionIdCopyEvents } from './input-composer';
import { updateSendButtonState, isSendButtonLoading } from './session-context';
import { sendMessage } from './send';
import { handleRetryClick, handleUndoClick, removePendingAssistantIndicator, showPendingAssistantIndicator } from './retry';
import { initAnswerScroller, captureScrollState, restoreScrollState } from './streaming';
import { renderChatHeaderHtml } from './render-chat';
import { canSendMessage } from './session-context';
import { getActiveSuggestionIndex, getFileSuggestionsContainer } from '../files/index';
import { getActiveConversation } from '../conversations/normalize';
export function setupMessageListPostRender(container: HTMLElement): void {
  // 对话流内 AskUserQuestion 可点选卡片
  bindInteractiveAskCards(container);

  // 初始化代码块复制按钮
  initCodeCopyButtons(container);

  // 绑定思考块折叠事件
  container.querySelectorAll('.thinking-block[data-thinking-id]').forEach((details) => {
    // 避免重复绑定
    if ((details as HTMLElement).dataset.thinkingBound === '1') return;
    (details as HTMLElement).dataset.thinkingBound = '1';
    details.addEventListener('toggle', () => {
      const id = (details as HTMLElement).dataset.thinkingId;
      if (!id) return;
      if ((details as HTMLDetailsElement).open) {
        appState.expandedThinkingBlocks.add(id);
      } else {
        appState.expandedThinkingBlocks.delete(id);
      }
    });
  });

  // 初始化 Answer 区域滚动控制器
  initAnswerScroller();

  // 初始化消息复制按钮
  container.querySelectorAll('.msg-copy-btn').forEach((btn) => {
    if ((btn as HTMLElement).dataset.bound === '1') return;
    (btn as HTMLElement).dataset.bound = '1';
    btn.addEventListener('click', async () => {
      const content = (btn as HTMLElement).dataset.copyContent || '';
      const copyAsMarkdown = (btn as HTMLElement).dataset.copyMarkdown === '1';
      let textToCopy = content;
      if (copyAsMarkdown) {
        // 复制为 Markdown：去掉 HTML 标签，将代码块转回 markdown 格式
        const tempDiv = document.createElement('div');
        tempDiv.innerHTML = content;
        tempDiv.querySelectorAll('.code-block-wrapper').forEach((wrapper) => {
          const code = (wrapper.querySelector('.code-copy-btn') as HTMLElement)?.dataset.code || '';
          const lang = wrapper.querySelector('.code-lang-badge')?.textContent || '';
          const fence = '```' + (lang && lang !== 'text' ? lang : '');
          wrapper.outerHTML = fence + '\n' + code + '\n```';
        });
        textToCopy = tempDiv.textContent || '';
      }
      const ok = await copyToClipboard(textToCopy);
      if (!ok) return;
      const icon = btn.querySelector('.msg-copy-icon-svg') as HTMLElement | null;
      if (icon) {
        icon.innerHTML = '<polyline points="20 6 9 17 4 12"></polyline>';
      }
      btn.classList.add('copied');
      setTimeout(() => {
        if (icon) {
          icon.innerHTML = '<rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path>';
        }
        btn.classList.remove('copied');
      }, 2000);
    });
  });

  // 初始化重试/撤回按钮事件委托（仅绑定一次）
  if (!(container as HTMLElement).dataset.retryBound) {
    (container as HTMLElement).dataset.retryBound = '1';
    container.addEventListener('click', (e) => {
      const btn = (e.target as HTMLElement).closest<HTMLButtonElement>('.msg-retry-btn');
      if (!btn) return;
      const action = btn.dataset.action;
      if (action === 'retry') {
        void handleRetryClick();
      } else if (action === 'undo') {
        void handleUndoClick();
      }
    });
  }
}

export function refreshChatContent() {
  if (!appState.activeConversationId && !appState.pendingUserMessage && !appState.transientSessionError) return;
  
  const conversation = getActiveConversation();
  
  const messageList = document.querySelector<HTMLDivElement>('#message-list');
  const topbarMain = document.querySelector<HTMLDivElement>('.main-topbar-main');

  if (topbarMain) {
    topbarMain.innerHTML = renderChatHeaderHtml(conversation);
    bindSessionIdCopyEvents();
  }

  updateSendButtonState();
  if (messageList) {
    // 重建前记录滚动状态：输出结束时若用户在阅读上方消息，重建后不应强制跳回底部
    const scrollSnap = captureScrollState();
    const messages = buildDisplayMessages(conversation);
    messageList.innerHTML = renderConversationMessagesInnerHtml(messages);
    // 后处理：代码复制按钮、思考块折叠事件、消息复制控件
    setupMessageListPostRender(messageList);
    if (isSendButtonLoading()) {
      showPendingAssistantIndicator();
    } else {
      removePendingAssistantIndicator();
    }
    // 恢复滚动状态（最后执行，覆盖 showPendingAssistantIndicator 的置底）
    restoreScrollState(scrollSnap);
  }
}

export function handleKeydown(e: KeyboardEvent) {
  // IME 组字中（如 macOS 拼音未选字）：Enter 用于上屏，不发送
  // keyCode 229 是部分浏览器/输入法在组字期间的兼容标识
  if (e.isComposing || e.keyCode === 229) {
    return;
  }
  // 文件建议列表可见且有待选项时，Enter 交给文件建议键盘处理逻辑（选择当前高亮项）
  const suggestionContainer = getFileSuggestionsContainer();
  if (suggestionContainer && suggestionContainer.style.display !== 'none' && e.key === 'Enter' && !e.shiftKey) {
    const activeIdx = getActiveSuggestionIndex();
    if (activeIdx >= 0) {
      // handleFileSuggestionKeydown 已注册在同一个 textarea 上，会处理选择逻辑
      return;
    }
  }
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    // 互动问答进行中：Enter 提交选项/「其他」自定义回答，不发成普通追问
    if (appState.activeQuestionEnterHandler) {
      if (appState.activeQuestionEnterHandler()) return;
      return;
    }
    // 运行中也允许 Enter：有内容则追问，无内容不触发停止
    if (isSendButtonLoading() && !canSendMessage()) {
      return;
    }
    void sendMessage();
  }
}
