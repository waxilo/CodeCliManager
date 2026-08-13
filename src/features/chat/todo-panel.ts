import { appState } from '../../state';
import { escapeHtml } from '../../utils';
import { extractToolName, extractToolInput } from './render-messages';
import type { Message, TodoItem } from '../../types';

/** 从历史消息取最后一条 TodoWrite 的完整 todos（重启恢复用） */
export function extractLatestTodos(messages: Message[]): TodoItem[] {
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    // 本地已处理的消息带 toolData；历史原始消息为 role=tool_use 的 JSON 内容
    const td = msg.toolData;
    if (td?.toolName === 'TodoWrite') {
      const todos = (td.toolInput as { todos?: unknown })?.todos;
      if (Array.isArray(todos)) return todos as TodoItem[];
      continue;
    }
    if (msg.role === 'tool_use' && extractToolName(msg.content) === 'TodoWrite') {
      const input = extractToolInput(msg.content);
      const todos = (input as { todos?: unknown })?.todos;
      if (Array.isArray(todos)) return todos as TodoItem[];
    }
  }
  return [];
}

function statusClass(status: string): string {
  if (status === 'completed') return 'is-completed';
  if (status === 'in_progress') return 'is-in-progress';
  return '';
}

function statusIcon(status: string): string {
  if (status === 'completed') return '✓';
  if (status === 'in_progress') return '⟳';
  return '';
}

/** 输入区上方的常驻 TodoList 清单面板（TodoWrite 整表替换） */
export function renderTodoPanelHtml(): string {
  const sessionId = appState.activeConversationId;
  if (!sessionId) return '';
  const todos = appState.todosBySession.get(sessionId);
  if (!todos || todos.length === 0) return '';

  const completed = todos.filter((t) => t.status === 'completed').length;
  const rows = todos
    .map((todo) => {
      const cls = statusClass(todo.status || 'pending');
      const icon = statusIcon(todo.status || 'pending');
      const content = String(todo.content || '').trim() || '（空任务）';
      return `
        <div class="todo-row ${cls}">
          <span class="todo-check" aria-hidden="true">${icon}</span>
          <span class="todo-content" title="${escapeHtml(content)}">${escapeHtml(content)}</span>
        </div>`;
    })
    .join('');

  return `
    <div class="todo-panel" id="todo-panel">
      <div class="todo-panel-header"><span>📋 任务清单 · ${completed}/${todos.length}</span></div>
      <div class="todo-panel-list">${rows}</div>
    </div>`;
}

/** 重建输入区上方的 TodoList 面板（子代理面板之下） */
export function syncTodoPanelUI(): void {
  const inputArea = document.querySelector('.input-area');
  if (!inputArea) return;
  document.querySelector('#todo-panel')?.remove();
  const html = renderTodoPanelHtml();
  if (!html) return;
  const ref =
    (document.querySelector('#subagent-progress') as HTMLElement) ||
    (document.querySelector('#queued-prompts') as HTMLElement) ||
    (document.querySelector('#interaction-host') as HTMLElement);
  ref?.insertAdjacentHTML('afterend', html);
}
