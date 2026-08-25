import { appState } from '../../state';
import { escapeHtml } from '../../utils';
import type { ActiveToolState } from '../../types';
import { formatSubagentUsage } from './subagent-usage';

/**
 * 输入框上方的「进行中的子代理」展示区。
 * 只展示仍在运行（status === 'running'）的 Task / Agent：一行一个（状态点 + 描述 + 进度），
 * 完成/失败后自动从该区域消失；主消息流里的子代理实时卡与历史卡照常展示。
 * 侧边栏「子代理」页签已移除。
 */

/** 子代理工具名：Claude Agent SDK 用 Agent，旧版 CLI 用 Task */
const SUBAGENT_TOOL_NAMES = new Set(['Agent', 'Task']);

/** 当前会话仍在运行中的子代理（Task/Agent，status === 'running'） */
export function getRunningSubagents(sessionId: string): ActiveToolState[] {
  const map = appState.activeToolsBySession.get(sessionId);
  if (!map || map.size === 0) return [];
  return [...map.values()].filter(
    (tool) => SUBAGENT_TOOL_NAMES.has(tool.toolName) && tool.status === 'running',
  );
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

function buildRunningRowHtml(task: ActiveToolState): string {
  const metaStr = formatSubagentUsage({
    totalTokens: task.progress?.totalTokens,
    toolUses: task.progress?.toolUses,
    durationMs: task.progress?.durationMs,
  });
  const meta = metaStr
    ? `<span class="subagent-meta">${escapeHtml(metaStr)}</span>`
    : '';
  const desc = describeTask(task);
  return `
    <div class="running-subagent-item subagent-row" data-tool-use-id="${escapeHtml(task.toolUseId)}">
      <span class="subagent-status-dot is-running" aria-hidden="true"></span>
      <span class="subagent-desc" title="${escapeHtml(desc)}">${escapeHtml(desc || '子代理')}</span>
      <span class="subagent-status-text">执行中</span>
      ${meta}
    </div>`;
}

/**
 * 同步输入框上方的「进行中的子代理」展示区：
 * 只显示运行中的 Task/Agent（完成/失败即移除），无运行中的子代理时隐藏。
 * 幂等；由调度器 subagent 标志 / 工具事件 / 会话事件触发。
 */
export function syncRunningSubagentsUI(): void {
  const host = document.querySelector<HTMLElement>('#running-subagents-host');
  if (!host) return;
  const sessionId = appState.activeConversationId;
  const running = sessionId ? getRunningSubagents(sessionId) : [];
  if (running.length === 0) {
    host.hidden = true;
    host.innerHTML = '';
    return;
  }
  host.hidden = false;
  host.innerHTML = running.map(buildRunningRowHtml).join('');
}
