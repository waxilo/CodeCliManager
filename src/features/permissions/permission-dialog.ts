import { appState } from '../../state';
import * as api from '../../api';
import type { PermissionRequestPayload } from '../../types';
import { escapeHtml } from '../../utils';
import { mountInteractionPanel, unmountActiveInteractionPanel, getInteractionHost, clearInteractionHostUi } from './interaction-panel';
import { parseAskUserQuestionInput, showQuestionDialog } from './ask-question';
import { getActiveSessionKey } from '../chat/session-context';
import { formatPermissionInput } from './interaction-panel';
export function showPermissionDialog(payload: PermissionRequestPayload): Promise<'allow' | 'deny'> {
  return new Promise((resolve) => {
    const toolName = payload.toolName || 'Tool';
    const description = (payload.description || '').trim();
    const inputText = formatPermissionInput(payload.input);
    const panel = document.createElement('div');
    panel.className = 'interaction-panel interaction-panel-permission';
    if (payload.conversationId) {
      panel.dataset.conversationId = payload.conversationId;
    }
    panel.innerHTML = `
      <div class="interaction-panel-header">
        <div class="interaction-panel-title-wrap">
          <span class="interaction-panel-badge">权限</span>
          <h3 class="interaction-panel-title">请求使用 <strong>${escapeHtml(toolName)}</strong></h3>
        </div>
        <div class="interaction-panel-actions">
          <button type="button" class="interaction-btn ghost" data-action="deny">拒绝</button>
          <button type="button" class="interaction-btn primary" data-action="allow">允许</button>
        </div>
      </div>
      ${description ? `<p class="interaction-panel-desc">${escapeHtml(description)}</p>` : ''}
      <details class="interaction-details">
        <summary>查看参数</summary>
        <pre class="interaction-pre" tabindex="0">${escapeHtml(inputText)}</pre>
      </details>
    `;

    let settled = false;
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      const currentPanel = appState.interactionPanelsBySession.get(getActiveSessionKey());
      if (currentPanel?.element !== panel) return;
      event.preventDefault();
      cleanup('deny');
    };

    const cleanup = (result: 'allow' | 'deny') => {
      if (settled) return;
      settled = true;
      document.removeEventListener('keydown', onKey);
      unmountActiveInteractionPanel(panel);
      resolve(result);
    };

    (panel as HTMLElement & { __permissionCleanup?: (r: 'allow' | 'deny') => void }).__permissionCleanup =
      cleanup;

    panel.querySelector('[data-action="deny"]')?.addEventListener('click', () => cleanup('deny'));
    panel.querySelector('[data-action="allow"]')?.addEventListener('click', () => cleanup('allow'));
    document.addEventListener('keydown', onKey);

    mountInteractionPanel(panel, payload.conversationId || '', cleanup);
    if (getActiveSessionKey() === payload.conversationId) {
      (panel.querySelector('[data-action="allow"]') as HTMLButtonElement | null)?.focus();
    }
  });
}

export function closePermissionDialogs(conversationId?: string): void {
  // 结束对话流内进行中的问答选择卡：按会话精确 deny，并发多卡互不影响。
  // 未指定会话时关闭全部待作答问卡。
  for (const state of [...appState.pendingAskQuestions.values()]) {
    if (!state.finish) continue;
    if (!conversationId || state.conversationId === conversationId) {
      state.finish({ action: 'deny' });
    }
  }

  if (!conversationId) {
    for (const panel of [...appState.interactionPanelsBySession.values()]) {
      panel.cleanup('deny');
    }
    return;
  }

  const activePanel = appState.interactionPanelsBySession.get(conversationId);
  if (activePanel) {
    activePanel.cleanup('deny');
    return;
  }

  document.querySelectorAll<HTMLElement>('.interaction-panel').forEach((panel) => {
    if (panel.dataset.conversationId !== conversationId) return;
    const cleanup = (
      panel as HTMLElement & { __permissionCleanup?: (r: 'allow' | 'deny') => void }
    ).__permissionCleanup;
    if (cleanup) {
      cleanup('deny');
    } else {
      panel.remove();
      if (getInteractionHost()?.childElementCount === 0) {
        clearInteractionHostUi();
      }
    }
  });
}

export async function handlePermissionRequest(raw: PermissionRequestPayload): Promise<void> {
  const anyRaw = raw as PermissionRequestPayload & {
    conversation_id?: string;
    request_id?: string;
    tool_name?: string;
  };
  const normalized: PermissionRequestPayload = {
    conversationId: raw.conversationId || anyRaw.conversation_id || '',
    requestId: raw.requestId || anyRaw.request_id || '',
    toolName: raw.toolName || anyRaw.tool_name || 'Tool',
    input: raw.input,
    description: raw.description ?? null,
  };
  if (!normalized.requestId) return;

  // 新进程已到权限确认：切模型重启保护结束
  if (normalized.conversationId) {
    appState.modelRestartingSessions.delete(normalized.conversationId);
  }

  // 正在停止该会话时，不再弹窗
  if (appState.abortingSessions.has(normalized.conversationId)) {
    try {
      await api.respondToolPermission({
        requestId: normalized.requestId,
        behavior: 'deny',
        message: '用户取消了会话',
        updatedInput: null,
      });
    } catch {
      // 后端可能已清理
    }
    return;
  }

  // AskUserQuestion：必须展示选项 UI（静默授权不适用）
  if (normalized.toolName === 'AskUserQuestion') {
    const parsed = parseAskUserQuestionInput(normalized.input);
    if (!parsed) {
      try {
        await api.respondToolPermission({
          requestId: normalized.requestId,
          behavior: 'deny',
          message: '无法解析问题选项',
          updatedInput: null,
        });
      } catch {
        // ignore
      }
      return;
    }

    const result = await showQuestionDialog(normalized, parsed);
    try {
      if (result.action === 'submit') {
        await api.respondToolPermission({
          requestId: normalized.requestId,
          behavior: 'allow',
          message: null,
          updatedInput: {
            questions: parsed.questions,
            answers: result.answers,
          },
        });
      } else {
        await api.respondToolPermission({
          requestId: normalized.requestId,
          behavior: 'deny',
          message: '用户跳过了问题',
          updatedInput: null,
        });
      }
    } catch (e) {
      if (!appState.abortingSessions.has(normalized.conversationId)) {
        console.error('[question] 回写失败:', e);
      }
    }
    return;
  }

  // 普通工具：静默 / 同类型已允许 已在 Rust 侧直接放行，能走到这里说明需要询问
  const decision = await showPermissionDialog(normalized);
  try {
    await api.respondToolPermission({
      requestId: normalized.requestId,
      behavior: decision,
      message: decision === 'deny' ? '用户拒绝' : null,
      updatedInput: decision === 'allow' ? normalized.input : null,
    });
  } catch (e) {
    // abort 时后端已 deny 并移除请求，属预期
    if (!appState.abortingSessions.has(normalized.conversationId)) {
      console.error('[permission] 回写失败:', e);
    }
  }
}
