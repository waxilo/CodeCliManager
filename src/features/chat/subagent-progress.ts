import { appState } from '../../state';
import { escapeHtml, formatDuration } from '../../utils';
import type { ActiveToolState, Conversation } from '../../types';
import { getActiveConversation } from '../conversations/normalize';
import { processToolMessages } from './render-messages';
import { renderMarkdownCached as renderMarkdown } from '../../markdown';
import {
  updateSubagentBadge,
  notifySubagentActivity,
  getActiveSidebarTab,
  refreshActiveTabContent,
} from '../sidebar/sidebar-tabs';

/** 子代理工具名：Claude Agent SDK 用 Agent，旧版 CLI 用 Task */
const SUBAGENT_TOOL_NAMES = new Set(['Agent', 'Task']);

export function getRunningTasks(sessionId: string): ActiveToolState[] {
  const map = appState.activeToolsBySession.get(sessionId);
  if (!map || map.size === 0) return [];
  return [...map.values()].filter((tool) => tool.toolName === 'Task');
}

/** 无 tool_result 的任务：会话仍在跑视为进行中，否则视为中断（未完成） */
function historyTaskStatus(
  hasResult: boolean,
  isError: boolean,
  sessionRunning: boolean,
): ActiveToolState['status'] {
  if (hasResult) return isError ? 'failed' : 'done';
  return sessionRunning ? 'running' : 'failed';
}

/**
 * 从会话消息历史提取子代理（Agent / Task 工具调用）。
 * 覆盖「会话已结束 / 从磁盘加载」时 activeToolsBySession 为空、
 * 子代理 tab 无实时进度可展示的场景。
 */
export function getSubagentsFromHistory(
  conversation: Conversation | undefined,
): ActiveToolState[] {
  if (!conversation) return [];
  const sessionRunning = appState.runningSessions.has(conversation.id);
  const result: ActiveToolState[] = [];
  for (const m of processToolMessages(conversation.messages)) {
    if (m.role !== 'tool' || !m.toolData) continue;
    const toolName = m.toolData.toolName || '';
    if (!SUBAGENT_TOOL_NAMES.has(toolName)) continue;
    const input = m.toolData.toolInput || {};
    const hasResult = m.toolData.toolResult !== undefined;
    const isError = hasResult ? Boolean(m.toolData.isError) : false;
    // history 合并的 <task-notification>：给出权威终态 + 完整报告
    const tn = m.toolData.taskNotification;
    let status = historyTaskStatus(hasResult, isError, sessionRunning);
    if (tn?.status) {
      const failed =
        tn.status === 'failed' || tn.status === 'error' || tn.status === 'stopped';
      status = failed ? 'failed' : 'done';
    }
    result.push({
      toolUseId: m.toolData.toolUseId || m.id,
      toolName,
      input,
      status,
      isError: status === 'failed',
      startedAt: 0,
      description: String(input.description || input.prompt || ''),
      summary: tn?.summary,
      report: tn?.result,
      progress: tn?.status
        ? {
            status: tn.status,
            totalTokens: tn.total_tokens,
            toolUses: tn.tool_uses,
            durationMs: tn.duration_ms,
          }
        : undefined,
    });
  }
  return result;
}

function describeTask(task: ActiveToolState): string {
  const input = task.input || {};
  const raw = String(
    task.description ||
      (input as { description?: unknown })?.description ||
      (input as { prompt?: unknown })?.prompt ||
      '',
  );
  const trimmed = raw.trim();
  return trimmed.length > 64 ? trimmed.slice(0, 64) + '…' : trimmed;
}

export function buildSubagentPanelInnerHtml(tasks: ActiveToolState[]): string {
  const done = tasks.filter((t) => t.status === 'done').length;
  const failed = tasks.filter((t) => t.status === 'failed').length;
  const running = tasks.length - done - failed;
  const label =
    running > 0
      ? `子代理执行中 · 完成 ${done}/${tasks.length}`
      : failed > 0
        ? `子代理完成 · ${done}/${tasks.length}（${failed} 失败）`
        : `子代理完成 · ${done}/${tasks.length}`;

  const rows = tasks
    .map((task) => {
      const statusClass =
        task.status === 'failed'
          ? 'is-failed'
          : task.status === 'done'
            ? 'is-done'
            : 'is-running';
      const statusText =
        task.status === 'failed' ? '失败' : task.status === 'done' ? '完成' : '执行中';
      const metaParts: string[] = [];
      if (task.progress?.totalTokens) metaParts.push(`${task.progress.totalTokens} tokens`);
      if (task.progress?.toolUses) metaParts.push(`${task.progress.toolUses} 次工具`);
      if (task.progress?.durationMs) metaParts.push(formatDuration(task.progress.durationMs));
      const meta = metaParts.length
        ? `<span class="subagent-meta">${metaParts.join(' · ')}</span>`
        : '';
      const desc = describeTask(task);
      const rowInner = `
          <span class="subagent-status-dot ${statusClass}" aria-hidden="true"></span>
          <span class="subagent-desc" title="${escapeHtml(desc)}">${escapeHtml(desc || '子代理')}</span>
          <span class="subagent-status-text">${statusText}</span>
          ${meta}`;
      const report = task.report?.trim();
      if (report) {
        // 有完成报告：整行可点击展开（<details>/<summary> 原生切换），报告按 Markdown 渲染；
        // 顶部放一行 muted 摘要（taskNotification.summary，如 `Agent "…" finished`）作为来源标注
        const summaryLine = task.summary?.trim()
          ? `<div class="subagent-report-summary">${escapeHtml(task.summary.trim())}</div>`
          : '';
        return `
        <details class="subagent-item" data-tool-use-id="${escapeHtml(task.toolUseId)}">
          <summary class="subagent-row">${rowInner}<span class="subagent-report-chevron" aria-hidden="true">▸</span></summary>
          <div class="subagent-report">${summaryLine}${renderMarkdown(report)}</div>
        </details>`;
      }
      return `
        <div class="subagent-item" data-tool-use-id="${escapeHtml(task.toolUseId)}">
          <div class="subagent-row">${rowInner}</div>
        </div>`;
    })
    .join('');

  return `
    <div class="subagent-panel-header">
      <span class="subagent-panel-title">${label}</span>
    </div>
    <div class="subagent-progress-list">${rows}</div>`;
}

/** 侧边栏「子代理」tab 内容（无任务时展示空态） */
export function renderSubagentTabContent(): string {
  // 实时路径按 activeConversationId 直查（会话对象暂不在列表时也要能展示）；
  // 会话结束 / 从磁盘加载（无实时状态）时回退到历史中的子代理调用。
  const sessionId = appState.activeConversationId;
  const liveTasks = sessionId ? getRunningTasks(sessionId) : [];
  const tasks =
    liveTasks.length > 0
      ? liveTasks
      : getSubagentsFromHistory(getActiveConversation());
  if (tasks.length === 0) {
    return `
      <div class="sidebar-empty">
        <span class="sidebar-empty-icon" aria-hidden="true">⟳</span>
        <span class="sidebar-empty-title">暂无子代理</span>
        <span class="sidebar-empty-hint">启动子代理后将在此显示进度</span>
      </div>`;
  }
  return buildSubagentPanelInnerHtml(tasks);
}

/**
 * 同步侧边栏「子代理」tab：更新角标、驱动自动切换、刷新进行中的行内容。
 * 签名保持 () => void，bootstrap / session-events / management-view 的调用点不变。
 */
export function syncSubagentProgressUI(): void {
  const sessionId = appState.activeConversationId;
  const tasks = sessionId ? getRunningTasks(sessionId) : [];
  const runningCount = tasks.filter((t) => t.status === 'running').length;
  updateSubagentBadge(runningCount);
  notifySubagentActivity(tasks.length > 0);
  if (getActiveSidebarTab() === 'subagents') {
    refreshActiveTabContent();
  }
}
