import { appState } from '../../state';
import { shellApi } from '../../app/shell/api';
import * as api from '../../api';
import { toMillis } from '../../utils';
import { showCopyToastMsg, showToast } from '../../ui';
import type { Conversation } from '../../types';
import { normalizeConversation } from './normalize';
export function sanitizeFileName(name: string): string {
  const cleaned = name.replace(/[\\/:*?"<>|\r\n]+/g, '_').replace(/\s+/g, ' ').trim();
  return (cleaned || 'conversation').slice(0, 80);
}

/** 把会话内容拼成 Markdown 文本 */
export function buildConversationMarkdown(c: Conversation): string {
  const lines: string[] = [`# ${c.title || '未命名会话'}`, ''];

  lines.push(`- 会话 ID: \`${c.id}\``);
  if (c.project_dir) lines.push(`- 工作目录: \`${c.project_dir}\``);
  if (c.last_model) lines.push(`- 模型: \`${c.last_model}\``);
  if (c.created_at) lines.push(`- 创建时间: ${new Date(toMillis(c.created_at)).toLocaleString()}`);
  if (c.updated_at) lines.push(`- 更新时间: ${new Date(toMillis(c.updated_at)).toLocaleString()}`);
  lines.push('', '---', '');

  for (const msg of c.messages ?? []) {
    const role = msg.role === 'user' ? '用户' : msg.role === 'assistant' ? '助手' : msg.role;
    lines.push(`## ${role}`, '');

    if (msg.thinking?.trim()) {
      lines.push('<details><summary>思考过程</summary>', '', msg.thinking.trim(), '', '</details>', '');
    }
    if (msg.toolData?.toolName) {
      lines.push(`> 工具调用：\`${msg.toolData.toolName}\``, '');
    }
    if (msg.content?.trim()) {
      lines.push(msg.content.trim(), '');
    }
  }

  return lines.join('\n');
}

/** 导出单个会话为 Markdown 文件 */
import { isConversationInstance } from './normalize';
export async function exportConversationToMarkdown(
  id: string,
  sourcePath: string | null = null,
): Promise<void> {
  const conversation = appState.conversations.find((candidate) =>
    isConversationInstance(candidate, id, sourcePath),
  );
  if (!conversation) return;

  // 列表中的会话可能没有完整消息，导出前先从后端取一次
  let full = conversation;
  try {
    const raw = await api.getConversation(id, conversation.source_path ?? null);
    if (raw) full = normalizeConversation(raw);
  } catch (e) {
    console.warn('Failed to load full conversation for export:', e);
  }

  try {
    const saved = await api.exportMarkdown(
      `${sanitizeFileName(full.title)}.md`,
      buildConversationMarkdown(full),
    );
    if (saved) showCopyToastMsg('已导出会话');
  } catch (e) {
    console.error('Failed to export conversation:', e);
    showToast('导出会话失败: ' + String(e));
  }
}

// 编辑会话功能
export function startEdit(id: string, sourcePath: string | null = null) {
  appState.editingConversationId = id;
  appState.editingConversationSourcePath = sourcePath;
  shellApi.render();
}

export function cancelEdit() {
  appState.editingConversationId = null;
  appState.editingConversationSourcePath = null;
  shellApi.render();
}

export async function saveEdit(id: string, sourcePath: string | null = null) {
  const input = [...document.querySelectorAll<HTMLInputElement>('.edit-input')].find(
    (candidate) =>
      candidate.id === `edit-input-${id}` &&
      (candidate.dataset.sourcePath || null) === sourcePath,
  );
  if (!input) return;

  const conversation = appState.conversations.find((candidate) =>
    isConversationInstance(candidate, id, sourcePath),
  );
  const newTitle = input.value.trim();
  if (!newTitle) {
    cancelEdit();
    return;
  }

  try {
    await api.updateConversationTitle({
      conversationId: id,
      title: newTitle,
      sourcePath: conversation?.source_path ?? null,
    });

    if (conversation) {
      conversation.title = newTitle;
    }

    appState.editingConversationId = null;
    appState.editingConversationSourcePath = null;
    shellApi.render();
  } catch (e) {
    console.error('Failed to update title:', e);
    showToast('修改标题失败: ' + String(e));
  }
}

export function handleEditKeydown(e: KeyboardEvent, id: string, sourcePath: string | null = null) {
  if (e.key === 'Enter') {
    e.preventDefault();
    void saveEdit(id, sourcePath);
  } else if (e.key === 'Escape') {
    e.preventDefault();
    cancelEdit();
  }
}

