import { appState } from '../../state';
import { escapeHtml } from '../../utils';
import { syncSidebarForSubagents } from '../../ui';
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

function buildSubagentPanelInnerHtml(tasks: ActiveToolState[]): string {
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
    <div class="subagent-panel-header">
      <span class="subagent-panel-title">${label}</span>
    </div>
    <div class="subagent-progress-list">${rows}</div>`;
}

/** 右侧子代理清单栏（有 Task 时显示；全量 render 时嵌入） */
export function renderSubagentProgressHtml(): string {
  const sessionId = appState.activeConversationId;
  if (!sessionId) return '';
  const tasks = getRunningTasks(sessionId);
  if (tasks.length === 0) return '';

  return `
    <aside class="subagent-panel" id="subagent-progress" aria-label="子代理执行清单">
      ${buildSubagentPanelInnerHtml(tasks)}
    </aside>`;
}

/**
 * 面板是否可见：有子代理即展示（右侧子代理清单栏是子代理的唯一主页面载体）。
 * 传入的 hasSubagents 决定面板 DOM 的增删与布局 class 的显隐。
 */
function applySubagentLayoutState(hasSubagents: boolean): void {
  document
    .querySelector('.app-container')
    ?.classList.toggle('has-subagent-panel', hasSubagents);
  syncSidebarForSubagents(hasSubagents);
}

/** 增量同步右侧子代理清单栏，并联动收起/恢复左侧会话栏 */
export function syncSubagentProgressUI(): void {
  const container = document.querySelector('.app-container');
  if (!container) return;

  const sessionId = appState.activeConversationId;
  const tasks = sessionId ? getRunningTasks(sessionId) : [];
  const hasSubagents = tasks.length > 0;
  const existing = document.querySelector('#subagent-progress');

  if (!hasSubagents) {
    existing?.remove();
    applySubagentLayoutState(false);
    return;
  }

  const inner = buildSubagentPanelInnerHtml(tasks);
  if (existing) {
    existing.innerHTML = inner;
  } else {
    const main = container.querySelector('.main-content');
    if (!main) return;
    main.insertAdjacentHTML(
      'afterend',
      `<aside class="subagent-panel" id="subagent-progress" aria-label="子代理执行清单">${inner}</aside>`,
    );
    // 强制重排：让刚插入的面板先以收起态（width:0）完成布局，
    // 再统一加 has-subagent-panel / 收起侧边栏，触发两侧宽度过渡动画。
    void (container as HTMLElement).offsetWidth;
  }
  applySubagentLayoutState(hasSubagents);
}
