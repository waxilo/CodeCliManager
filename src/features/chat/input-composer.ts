import { appState } from '../../state';
import { escapeHtml, copyTextToClipboard } from '../../utils';
import { invoke } from '@tauri-apps/api/core';
import { showCopyToastMsg } from '../../ui';
import { getEffectiveProjectDir, canSendMessage } from './session-context';
import { renderChatModelPickerHtml } from './model-picker';
import { getPermissionMode } from '../permissions/permission-mode';
import * as api from '../../api';
import { renderContextIndicatorHtml } from './context-indicator';
import { renderTodoPanelHtml } from './todo-panel';
import { renderCostIndicatorHtml } from './cost-indicator';
export function renderCopyIconHtml(className = 'toolbar-copy-icon'): string {
  return `
    <span class="${className}" aria-hidden="true">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
        <rect x="9" y="9" width="13" height="13" rx="2"/>
        <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>
      </svg>
    </span>
  `;
}

export async function openPathInFileManager(path: string): Promise<void> {
  try {
    await invoke('plugin:opener|open_path', { path });
  } catch (e) {
    console.error('[opener] 打开路径失败:', path, e);
    showCopyToastMsg('打开失败');
  }
}

export async function openPathInShell(path: string): Promise<void> {
  try {
    await api.openTerminal(path);
  } catch (e) {
    console.error('[terminal] 打开 Shell 失败:', path, e);
    showCopyToastMsg('打开 Shell 失败');
  }
}

export async function handleSessionIdClick() {
  const control = document.querySelector<HTMLButtonElement>('#session-id-copy');
  const sessionId = control?.dataset.sessionId?.trim();
  if (!sessionId || sessionId === '—') {
    return;
  }

  const projectDir = getEffectiveProjectDir();
  if (!projectDir) {
    // 无工作目录：降级为复制 Session ID
    copyTextToClipboard(sessionId).then((ok) => {
      if (ok) showCopyToastMsg('已复制');
    });
    return;
  }

  try {
    await api.openTerminalResume(projectDir, sessionId);
  } catch (e) {
    console.error('打开终端失败:', e);
    // 失败时降级复制
    copyTextToClipboard(sessionId).then((ok) => {
      if (ok) showCopyToastMsg('已复制');
    });
  }
}

export function bindSessionIdCopyEvents() {
  const control = document.querySelector('#session-id-copy');
  if (!control) {
    return;
  }
  control.removeEventListener('click', handleSessionIdClick);
  control.addEventListener('click', handleSessionIdClick);
}

export function renderSendButtonHtml(): string {
  const disabled = canSendMessage() ? '' : ' disabled';
  return `
    <button class="send-btn" id="send-btn" type="button" aria-label="发送"${disabled}>
      <svg class="send-icon" viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
        <path d="M12 19V5"/>
        <path d="m5 12 7-7 7 7"/>
      </svg>
      <svg class="stop-icon" viewBox="0 0 24 24" aria-hidden="true" style="display:none">
        <rect x="6" y="6" width="12" height="12" rx="2" fill="currentColor"/>
      </svg>
      <span class="send-check-spinner" aria-hidden="true" hidden></span>
    </button>
  `;
}

export function renderBalanceStatusBarHtml(): string {
  const balance = appState.mainBalanceCache;
  const git = appState.gitBranchCache;
  const branch = git?.branch ?? '';
  const label = balance?.label ?? '余额';
  const value = balance?.value ?? '';
  const gitHidden = git ? '' : ' hidden';
  const balanceHidden = balance ? '' : ' hidden';
  const dividerHidden = git && balance ? '' : ' hidden';
  return `
    <div id="balance-status-bar" class="balance-status-bar">
      <span class="status-bar-git"${gitHidden}>
        <span class="balance-status-bar-label">分支</span>
        <span class="status-bar-git-value" data-git-branch title="${escapeHtml(branch)}">${escapeHtml(branch)}</span>
      </span>
      <span class="status-bar-divider" data-status-divider${dividerHidden} aria-hidden="true"></span>
      <span class="status-bar-balance"${balanceHidden}>
        <span class="balance-status-bar-label" data-balance-label>${escapeHtml(label)}</span>
        <span class="balance-status-bar-value" data-balance-value title="${escapeHtml(value)}">${escapeHtml(value)}</span>
      </span>
    </div>
  `;
}

export function renderQueuedPromptsHtml(): string {
  const conversationId = appState.activeConversationId;
  const items = conversationId ? appState.queuedPromptsBySession.get(conversationId) || [] : [];
  if (items.length === 0) return '';
  return `
    <div class="queued-prompts" id="queued-prompts" aria-label="等待发送的追问">
      <div class="queued-prompts-header">
        <span>等待发送 · ${items.length}</span>
        <button type="button" class="queued-prompts-clear" data-queue-clear>清空</button>
      </div>
      <div class="queued-prompts-list">
        ${items.map((item) => `
          <div class="queued-prompt-item" data-queue-id="${escapeHtml(item.id)}">
            <span class="queued-prompt-index" aria-hidden="true">${items.indexOf(item) + 1}</span>
            <span class="queued-prompt-content" title="${escapeHtml(item.messageContent)}">${escapeHtml(item.messageContent)}</span>
            ${item.model ? `<span class="queued-prompt-model">${escapeHtml(item.model)}</span>` : ''}
            <button type="button" class="queued-prompt-remove" data-queue-remove="${escapeHtml(item.id)}" aria-label="删除排队消息">×</button>
          </div>
        `).join('')}
      </div>
    </div>
  `;
}

export function syncQueuedPromptsUI(): void {
  const inputArea = document.querySelector('.input-area');
  if (!inputArea) return;
  document.querySelector('#queued-prompts')?.remove();
  const html = renderQueuedPromptsHtml();
  if (!html) return;
  const interactionHost = inputArea.querySelector('#interaction-host');
  interactionHost?.insertAdjacentHTML('afterend', html);
  bindQueuedPromptEvents();
}

export function bindQueuedPromptEvents(): void {
  const panel = document.querySelector<HTMLElement>('#queued-prompts');
  if (!panel || panel.dataset.bound === 'true') return;
  panel.dataset.bound = 'true';
  panel.addEventListener('click', (event) => {
    const target = event.target as HTMLElement;
    const conversationId = appState.activeConversationId;
    if (!conversationId) return;
    const remove = target.closest<HTMLButtonElement>('[data-queue-remove]');
    if (remove?.dataset.queueRemove) {
      remove.disabled = true;
      void api.removeQueuedPrompt(conversationId, remove.dataset.queueRemove).catch((error) => {
        console.error('删除排队消息失败:', error);
        remove.disabled = false;
      });
      return;
    }
    const clear = target.closest<HTMLButtonElement>('[data-queue-clear]');
    if (clear) {
      clear.disabled = true;
      void api.clearQueuedPrompts(conversationId).catch((error) => {
        console.error('清空排队消息失败:', error);
        clear.disabled = false;
      });
    }
  });
}

export function renderInputComposerHtml(): string {
  const mode = getPermissionMode();
  return `
    <div class="input-area">
      <div id="interaction-host" class="interaction-host" hidden></div>
      ${renderQueuedPromptsHtml()}
      ${renderTodoPanelHtml()}
      <div id="paste-attachments-bar" class="paste-attachments-bar" style="display:none"></div>
      <div id="imported-file-bar" class="imported-file-bar" style="display:none"></div>
      <div class="input-composer">
        <textarea
          id="message-input"
          class="input-composer-textarea"
          rows="1"
          placeholder="输入你的问题，Enter 发送，Shift+Enter 换行，@ 引用文件，粘贴图片..."
        ></textarea>
        <div id="file-suggestions" class="file-suggestions" style="display:none"></div>
        <div class="input-composer-toolbar">
          <div class="input-composer-toolbar-start"><!-- 撑开剩余空间，把状态条与发送按钮推到右侧 --></div>
          <div class="input-composer-toolbar-end">
            <div class="composer-status-row" id="composer-status-row" hidden>
              <span class="composer-status-dot" aria-hidden="true"></span>
              <span class="composer-status-text" id="composer-status-text" role="status"></span>
              <span class="composer-status-elapsed" id="composer-status-elapsed"></span>
            </div>
            ${renderSendButtonHtml()}
          </div>
        </div>
      </div>
      <div class="composer-below-row">
        <div class="composer-below-left">
          <button
            id="btn-import"
            class="toolbar-icon-btn import-btn"
            type="button"
            title="导入外部文件 / 文件夹"
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/>
              <polyline points="17 8 12 3 7 8"/>
              <line x1="12" y1="3" x2="12" y2="15"/>
            </svg>
          </button>
          <div class="permission-mode-bar" role="radiogroup" aria-label="工具权限模式">
            <label class="permission-mode-chip${mode === 'ask' ? ' is-selected' : ''}" title="同工具类型首次询问，之后本会话自动放行">
              <input type="radio" name="permission-mode" value="ask"${mode === 'ask' ? ' checked' : ''} />
              <span>每次询问</span>
            </label>
            <label class="permission-mode-chip${mode === 'silent' ? ' is-selected' : ''}" title="自动允许工具请求，不再询问">
              <input type="radio" name="permission-mode" value="silent"${mode === 'silent' ? ' checked' : ''} />
              <span>静默授权</span>
            </label>
          </div>
          ${renderChatModelPickerHtml()}
        </div>
        <div class="composer-usage-bar" id="composer-usage-bar">
          ${renderCostIndicatorHtml()}
          ${renderContextIndicatorHtml()}
        </div>
      </div>
    </div>
  `;
}

