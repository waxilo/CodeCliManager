import { appState } from '../../state';
import { shellApi } from '../../app/shell/api';
import * as api from '../../api';
import type { FileRef, WorkspaceGroup, PreparedCommand } from '../../types';
import { escapeHtml } from '../../utils';
import { showCopyToastMsg, showToast, scheduleUiRefresh } from '../../ui';
import { open } from '@tauri-apps/plugin-dialog';
import { getActiveChatModel } from './model-picker';
import { getEffectiveProjectDir, setSendButtonLoading, setAbortingUi, updateSendButtonState, isSendButtonLoading, syncMessageInputPlaceholder } from './session-context';
import { resolveFileReferences, disposePasteAttachments, invalidateFileCache, restoreComposerDraftSnapshot, stashComposerDraft, takeComposerDraftSnapshot } from '../files';
import { closePermissionDialogs } from '../permissions';
import { groupConversationsByWorkspace } from '../sidebar';
import { findConversationById } from '../conversations/normalize';
import { clearStreamingState, commitStreamingAssistantToConversation } from './streaming';
import { dismissApiConfigViewState } from '../api-config/view-lifecycle';
import { refreshModelInfo } from './render-chat';
import { hideSendingState } from './retry';
import { isImageFile, stripFileRefTags, unwrapFileRef } from '../files/index';
import { dismissMcpViewState } from '../mcp/mount';
import { normalizeModelKey } from '../permissions/permission-mode';
import { dismissSettingsViewState } from '../settings/mount';
import { dismissKiroViewState } from '../kiro/mount';
import { updateConversationListSpinner } from '../sidebar/render-list';
import { newChatInWorkspace } from '../sidebar/workspace-grouping';

let isPreparingKiroSend = false;

/** 发送前 Kiro 预检的可见反馈，避免用户误以为卡死 */
function setKiroPrepareUi(active: boolean, input: HTMLTextAreaElement, sendBtn: HTMLButtonElement | null): void {
  const composer = document.querySelector('.input-composer');
  composer?.classList.toggle('is-checking-kiro', active);

  const toolbarStart = document.querySelector('.input-composer-toolbar-start');
  let hint = document.querySelector('#kiro-prepare-hint') as HTMLElement | null;
  if (active) {
    if (!hint && toolbarStart) {
      hint = document.createElement('span');
      hint.id = 'kiro-prepare-hint';
      hint.className = 'kiro-prepare-hint';
      hint.setAttribute('role', 'status');
      hint.setAttribute('aria-live', 'polite');
      hint.textContent = '正在检查 Kiro 代理…';
      toolbarStart.appendChild(hint);
    } else if (hint) {
      hint.hidden = false;
    }
  } else {
    hint?.remove();
  }

  if (sendBtn) {
    if (active) {
      sendBtn.dataset.checkingKiro = 'true';
    } else {
      delete sendBtn.dataset.checkingKiro;
    }
  }

  if (active) {
    input.placeholder = '正在检查 Kiro 代理，请稍候…';
  } else {
    syncMessageInputPlaceholder();
  }

  updateSendButtonState();
}

/**
 * 消息发送前确认 Kiro 可用。检查期间不读取或清空输入内容/附件，
 * 因此自动恢复失败时用户草稿会完整留在输入框。
 */
async function prepareKiroBeforeSend(
  input: HTMLTextAreaElement,
  sendBtn: HTMLButtonElement | null,
): Promise<boolean> {
  if (isPreparingKiroSend) return false;
  isPreparingKiroSend = true;
  setKiroPrepareUi(true, input, sendBtn);

  try {
    const status = await api.kiroPrepareSend();
    appState.kiroStatus = status;
    return true;
  } catch (error) {
    console.error('[kiro] 发送前检查失败:', error);
    showToast(`Kiro 代理不可用，消息未发送：${String(error)}`);
    input.focus();
    return false;
  } finally {
    isPreparingKiroSend = false;
    setKiroPrepareUi(false, input, sendBtn);
  }
}

export function newChat() {
  toggleNewChatDropdown();
}

/** 关闭 New Chat 下拉框 */
export function closeNewChatDropdown() {
  document.querySelector('.new-chat-overlay')?.remove();
  document.querySelector('.new-chat-dropdown')?.remove();
}

/** 切换 New Chat 下拉框显示/隐藏 */
export function toggleNewChatDropdown() {
  if (document.querySelector('.new-chat-dropdown')) {
    closeNewChatDropdown();
    return;
  }

  const btnWrapper = document.querySelector('#new-chat-btn')?.parentElement;
  if (!btnWrapper) return;

  const { workspaces } = groupConversationsByWorkspace();

  const overlay = document.createElement('div');
  overlay.className = 'new-chat-overlay';
  overlay.addEventListener('click', closeNewChatDropdown);

  const dropdown = document.createElement('div');
  dropdown.className = 'new-chat-dropdown';
  dropdown.innerHTML = renderNewChatDropdownContent(workspaces);

  document.body.appendChild(overlay);
  document.body.appendChild(dropdown);

  // 定位下拉框
  requestAnimationFrame(() => {
    const btnRect = btnWrapper.getBoundingClientRect();
    dropdown.style.top = `${btnRect.bottom + 4}px`;
    dropdown.style.left = `${btnRect.left}px`;
    // 确保不超出右边界
    const dRect = dropdown.getBoundingClientRect();
    if (dRect.right > window.innerWidth - 8) {
      dropdown.style.left = `${Math.max(8, window.innerWidth - dRect.width - 8)}px`;
    }
    // 确保不超出下边界
    if (dRect.bottom > window.innerHeight - 8) {
      dropdown.style.top = `${Math.max(8, btnRect.top - dRect.height - 4)}px`;
    }
  });

  // 监听点击事件
  dropdown.addEventListener('click', (e) => {
    const target = (e.target as HTMLElement).closest('[data-action]') as HTMLElement | null;
    if (!target) return;
    const action = target.dataset.action;
    const workspacePath = target.dataset.workspace;

    if (action === 'pick-new-dir') {
      closeNewChatDropdown();
      void pickNewWorkspaceDirectory();
    } else if (action === 'new-chat-in-dropdown' && workspacePath) {
      closeNewChatDropdown();
      newChatInWorkspace(workspacePath);
    }
  });
}

/** 选择新的工作目录并创建新会话 */
export async function pickNewWorkspaceDirectory(): Promise<void> {
  try {
    const selected = await open({
      directory: true,
      multiple: false,
      title: '选择工作目录',
    });
    if (typeof selected !== 'string' || !selected.trim()) {
      return;
    }
    const trimmed = selected.trim();
    appState.pendingProjectDir = trimmed;
    invalidateFileCache();
  } catch (e) {
    console.error('Failed to pick project directory:', e);
    return;
  }
  // 完成选目录后执行创建新会话
  dismissApiConfigViewState();
  dismissSettingsViewState();
  dismissMcpViewState();
  dismissKiroViewState();
  stashComposerDraft();
  appState.activeConversationId = '';
  appState.activeConversationSourcePath = null;
  invalidateFileCache();
  appState.pendingUserMessage = null;
  appState.pendingUserMessageConvId = null;
  appState.transientSessionError = null;
  shellApi.render();
  void refreshModelInfo();

  setTimeout(() => {
    const input = document.querySelector<HTMLTextAreaElement>('#message-input');
    if (input) input.focus();
  }, 100);
}

/** 渲染 New Chat 下拉框内容 */
export function renderNewChatDropdownContent(workspaces: WorkspaceGroup[]): string {
  const plusSvg = `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>`;
  const folderSvg = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/></svg>`;

  let html = `
    <button type="button" class="new-chat-dropdown-action" data-action="pick-new-dir">
      <span class="new-chat-dropdown-action-icon">${plusSvg}</span>
      <span class="new-chat-dropdown-item-label">选择新工作目录…</span>
    </button>
  `;

  if (workspaces.length > 0) {
    html += `<div class="new-chat-dropdown-separator"></div>`;
    html += `<div class="new-chat-dropdown-label">最近使用</div>`;
    for (const ws of workspaces) {
      html += `
        <button type="button" class="new-chat-dropdown-item" data-action="new-chat-in-dropdown" data-workspace="${escapeHtml(ws.path)}" title="${escapeHtml(ws.path)}">
          <span class="new-chat-dropdown-item-icon">${folderSvg}</span>
          <span class="new-chat-dropdown-item-label">${escapeHtml(ws.displayName)}</span>
        </button>
      `;
    }
  } else {
    html += `<div class="new-chat-dropdown-empty">暂无历史工作目录</div>`;
  }

  return html;
}

// 发送消息：通过 invoke 到后端，后端启动 shell 并通过事件推送更新
export async function sendMessage() {
  const input = document.querySelector<HTMLTextAreaElement>('#message-input');
  const sendBtn = document.querySelector<HTMLButtonElement>('#send-btn');
  if (!input) return;

  const conversationId = appState.activeConversationId || null;
  const projectDir = getEffectiveProjectDir();
  const draftKey = conversationId || `new:${projectDir}`;
  const hasPastedImages = appState.pasteAttachments.length > 0;
  const hasImportedFiles = appState.importedFileRefs.length > 0;
  if (!input.value.trim() && !hasPastedImages && !hasImportedFiles) return;
  if (sendBtn?.disabled) return;
  if (!conversationId && !projectDir) return;

  // 点击发送即固定源会话、目录、输入、附件与模型。后续预检/解析不再读取活动会话。
  const snapshot = takeComposerDraftSnapshot(draftKey);
  const model = getActiveChatModel() || undefined;
  let shouldRestore = true;

  try {
    if (!(await prepareKiroBeforeSend(input, sendBtn))) return;

    const content = snapshot.text.trim();
    const pasteRefs = snapshot.pasteAttachments.map((attachment) => ({ ...attachment }));
    const capturedImportedRefs = snapshot.importedFileRefs.map((entry) => entry.ref);
    let promptWithPaste = content;

    if (pasteRefs.length > 0) {
      const pasteRefStr = pasteRefs.map((attachment) => `@${attachment.path}`).join(' ');
      promptWithPaste = pasteRefStr + (content ? ' ' + content : '');
    }
    if (capturedImportedRefs.length > 0) {
      const importedRefStr = capturedImportedRefs.join(' ');
      promptWithPaste = importedRefStr + (promptWithPaste ? ' ' + promptWithPaste : '');
    }

    const allRefs: FileRef[] = [
      ...pasteRefs.map((attachment) => ({ path: attachment.path, isImage: true })),
      ...capturedImportedRefs.map((ref) => {
        const path = unwrapFileRef(ref).replace(/\/$/, '');
        return { path, isImage: isImageFile(path) };
      }),
    ];

    const fileRefTagStr = capturedImportedRefs.length > 0 ? capturedImportedRefs.join(' ') + ' ' : '';
    let promptForResolve = stripFileRefTags(promptWithPaste);
    for (const attachment of pasteRefs) {
      const escaped = attachment.path.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      promptForResolve = promptForResolve.replace(new RegExp(`@${escaped}\\s*`, 'g'), '');
    }
    promptForResolve = promptForResolve.trim();

    const { prompt: resolvedFromAtPaths, displayPrompt, refs: fileRefs } =
      await resolveFileReferences(promptForResolve, projectDir);
    for (const ref of fileRefs) {
      if (!allRefs.some((existing) => existing.path === ref.path)) allRefs.push(ref);
    }

    const pasteRefStr = pasteRefs.map((attachment) => `@${attachment.path}`).join(' ');
    const resolvedContent = [pasteRefStr, fileRefTagStr, resolvedFromAtPaths].filter(Boolean).join(' ');
    const displayContent = displayPrompt.trim();
    const pasteRefTagStr = pasteRefs.map((attachment) => `@File[${attachment.path}]`).join(' ');
    const messageContent = (
      (pasteRefTagStr ? pasteRefTagStr + ' ' : '') +
      fileRefTagStr +
      (displayContent || '')
    ).trim();

    const prepared: PreparedCommand = {
      prompt: resolvedContent,
      messageContent,
      refs: allRefs.length > 0 ? allRefs : undefined,
      model,
    };
    const sent = await executePreparedCommand(conversationId, prepared, projectDir);
    if (!sent) return;
    shouldRestore = false;
    disposePasteAttachments(snapshot.pasteAttachments);
  } catch (error) {
    console.error('Failed to prepare message:', error);
    showToast('Failed to send message: ' + String(error));
  } finally {
    if (shouldRestore) restoreComposerDraftSnapshot(draftKey, snapshot);
  }
}

/** 立即执行一条已准备好的指令（新建会话时 conversationId 可为 null） */
export async function executePreparedCommand(
  conversationId: string | null,
  command: PreparedCommand,
  projectDir = '',
): Promise<boolean> {
  const alreadyBusy = !!(
    conversationId && appState.runningSessions.has(conversationId)
  );

  try {
    const args: Record<string, string> = {
      prompt: command.prompt,
      messageContent: command.messageContent,
    };
    if (conversationId) {
      args.conversationId = conversationId;
    }
    if (command.model) {
      args.model = command.model;
    }
    if (!conversationId && projectDir) {
      args.projectDir = projectDir;
    }

    const result = await api.executePrompt(args);
    const runKey = conversationId || `new:${projectDir}`;
    if (result.runId) {
      appState.runIdsBySession.set(runKey, result.runId);
    }
    if (result.status === 'queued') {
      if (conversationId && result.item) {
        const items = appState.queuedPromptsBySession.get(conversationId) || [];
        if (!items.some((item) => item.id === result.item?.id)) {
          appState.queuedPromptsBySession.set(conversationId, [...items, result.item]);
        }
        shellApi.updateSendButtonState();
      }
      showCopyToastMsg('已加入追问队列');
      return true;
    }

    // 后端确认已实际发送后，才把用户消息加入正式会话气泡。
    appState.pendingUserMessage = command.messageContent;
    appState.pendingUserMessageConvId = conversationId;

    const nextModelKey = normalizeModelKey(command.model);
    if (conversationId) {
      const prevModelKey = appState.sessionProcessModels.get(conversationId);
      if (prevModelKey !== undefined && prevModelKey !== nextModelKey) {
        showCopyToastMsg('已切换模型，正在重启会话');
        appState.modelRestartingSessions.add(conversationId);
        window.setTimeout(() => appState.modelRestartingSessions.delete(conversationId), 60000);
      }
      appState.sessionProcessModels.set(conversationId, nextModelKey);
      appState.runningSessions.add(conversationId);

      const conv = findConversationById(conversationId);
      commitStreamingAssistantToConversation(conversationId);
      if (conv) {
        conv.messages.push({
          id: `user-${Date.now()}`,
          role: 'user',
          content: command.messageContent,
          refs: command.refs,
          timestamp: Math.floor(Date.now() / 1000),
        });
        conv.updated_at = Math.floor(Date.now() / 1000);
      }
      if (!alreadyBusy) {
        clearStreamingState(conversationId);
      }
      if (appState.activeConversationId === conversationId) {
        // 调度器执行器在聊天重建后自动恢复流式块，无需在此显式调用 refreshStreamingUI
        scheduleUiRefresh({ chat: true });
      }
    } else {
      appState.sessionProcessModels.set('pending', nextModelKey);
      appState.runningSessions.add('pending');
      shellApi.render();
    }

    if (!conversationId || conversationId === appState.activeConversationId) {
      setSendButtonLoading(true);
    }
    updateConversationListSpinner();
    return true;
  } catch (e) {
    console.error('Failed to send message:', e);
    showToast('Failed to send message: ' + String(e));
    appState.pendingUserMessage = null;
    appState.pendingUserMessageConvId = null;
    appState.runningSessions.delete(conversationId || 'pending');
    if (!conversationId || conversationId === appState.activeConversationId) {
      hideSendingState();
    }
    updateConversationListSpinner();
    return false;
  }
}

export async function abortSession() {
  if (!isSendButtonLoading() || appState.isAbortingActiveSession) return;

  try {
    const args: { conversationId?: string; runId?: string } = {};
    const activeConversationId = appState.activeConversationId;
    const newRunKey = `new:${getEffectiveProjectDir()}`;

    if (activeConversationId && appState.runningSessions.has(activeConversationId)) {
      args.conversationId = activeConversationId;
      const runId = appState.runIdsBySession.get(activeConversationId);
      if (runId) args.runId = runId;
    } else if (!activeConversationId && appState.runningSessions.has('pending')) {
      const runId = appState.runIdsBySession.get(newRunKey);
      if (!runId) return;
      args.runId = runId;
    } else {
      return;
    }

    const abortSessionId = activeConversationId || 'pending';
    appState.abortingSessions.add(abortSessionId);
    setAbortingUi(true);
    closePermissionDialogs(abortSessionId);

    await api.abortSession(args);

    // 点击停止后立即从运行集合中移除转圈，并清掉本地队列快照；后端也会同步空队列事件。
    appState.queuedPromptsBySession.delete(abortSessionId);
    appState.runningSessions.delete(abortSessionId);
    if (activeConversationId) appState.runIdsBySession.delete(activeConversationId);
    else appState.runIdsBySession.delete(newRunKey);
    updateConversationListSpinner();

    // 安全回退：如果 session-ended 在 5 秒内未到达，强制清理 UI（interrupt 友好停止可能稍慢）
    setTimeout(() => {
      if (!appState.abortingSessions.has(abortSessionId) && !appState.isAbortingActiveSession) {
        return;
      }
      console.warn('[abort] session-ended 未及时到达，强制清理 UI 状态');
      appState.abortingSessions.delete(abortSessionId);
      appState.runningSessions.delete(abortSessionId);
      clearStreamingState(abortSessionId);
      setAbortingUi(false);
      hideSendingState();
      updateConversationListSpinner();
      // 用户主动停止：不自动 drain 队列
    }, 5000);
  } catch (e) {
    console.error('Failed to abort session:', e);
    setAbortingUi(false);
    hideSendingState();
    updateConversationListSpinner();
  }
}

/** 重新生成或撤回消息的统一入口 */
