import { appState } from '../../state';
import { escapeHtml } from '../../utils';
import type { ActiveToolState } from '../../types';

function getRunningTasks(sessionId: string): ActiveToolState[] {
  const map = appState.activeToolsBySession.get(sessionId);
  if (!map || map.size === 0) return [];
  return [...map.values()].filter((tool) => tool.toolName === 'Task');
}

function formatDuration(ms: number): string {
  if (!ms || ms <= 0) return '';
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
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

/** 输入区上方的子代理进度面板（Task 子代理运行 / 完成计数 + 每行状态） */
export function renderSubagentProgressHtml(): string {
  const sessionId = appState.activeConversationId;
  if (!sessionId) return '';
  const tasks = getRunningTasks(sessionId);
  if (tasks.length === 0) return '';

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
      return `
        <div class="subagent-row" data-tool-use-id="${escapeHtml(task.toolUseId)}">
          <span class="subagent-status-dot ${statusClass}" aria-hidden="true"></span>
          <span class="subagent-desc" title="${escapeHtml(desc)}">${escapeHtml(desc || '子代理')}</span>
          <span class="subagent-status-text">${statusText}</span>
          ${meta}
        </div>`;
    })
    .join('');

  return `
    <div class="subagent-progress" id="subagent-progress">
      <div class="subagent-progress-header"><span>${label}</span></div>
      <div class="subagent-progress-list">${rows}</div>
    </div>`;
}

/** 重建输入区上方的子代理进度面板（remove + insert，仿 syncQueuedPromptsUI） */
export function syncSubagentProgressUI(): void {
  const inputArea = document.querySelector('.input-area');
  if (!inputArea) return;
  document.querySelector('#subagent-progress')?.remove();
  const html = renderSubagentProgressHtml();
  if (!html) return;
  const ref =
    (document.querySelector('#queued-prompts') as HTMLElement) ||
    (document.querySelector('#interaction-host') as HTMLElement);
  ref?.insertAdjacentHTML('afterend', html);
}
