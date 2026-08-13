import { appState } from '../../state';
import { shellApi } from '../../app/shell/api';
import * as api from '../../api';
import { showConfirmDialog, showDeleteConfirm, showCopyToastMsg } from '../../ui';
import { clearStreamingState } from '../chat/streaming';
import { loadData } from './load';
import { groupConversationsByWorkspace } from '../sidebar/workspace-grouping';
import { escapeHtml } from '../../utils';
import { isConversationInstance } from './normalize';
export async function deleteConversation(id: string, sourcePath: string | null = null) {
  const conversation = appState.conversations.find((candidate) =>
    isConversationInstance(candidate, id, sourcePath),
  );
  if (!conversation) return;

  const confirmed = await showDeleteConfirm(conversation.title);
  if (!confirmed) return;

  try {
    await api.deleteConversation({
      conversationId: id,
      sourcePath: conversation.source_path ?? null,
    });

    const deletedSourcePath = conversation.source_path ?? null;
    clearStreamingState(id);
    appState.runningSessions.delete(id);
    appState.abortingSessions.delete(id);
    void api.abortSession({ conversationId: id, force: true }).catch(() => {});
    appState.pendingUserMessage = null;
    appState.pendingUserMessageConvId = null;
    appState.conversations = appState.conversations.filter(
      (candidate) => candidate.id !== id || (candidate.source_path ?? null) !== deletedSourcePath,
    );

    if (
      appState.activeConversationId === id &&
      appState.activeConversationSourcePath === deletedSourcePath
    ) {
      const next = appState.conversations[0];
      appState.activeConversationId = next?.id || '';
      appState.activeConversationSourcePath = next?.source_path ?? null;
    }

    shellApi.render();
  } catch (e) {
    console.error('Failed to delete conversation:', e);
    alert('删除会话失败: ' + String(e));
    await loadData();
    shellApi.render();
  }
}

export async function deleteWorkspaceConversations(workspacePath: string) {
  const { workspaces } = groupConversationsByWorkspace();
  const ws = workspaces.find((w) => w.path === workspacePath);
  console.log('[deleteWorkspace] path:', workspacePath, 'found:', !!ws, 'count:', ws?.conversations.length);
  if (!ws || ws.conversations.length === 0) return;

  const count = ws.conversations.length;
  const confirmed = await showConfirmDialog({
    title: '删除目录下所有会话',
    message: `确定要删除「${escapeHtml(ws.displayName)}」下的全部 ${count} 个会话吗？`,
    sub: `目录路径: ${escapeHtml(workspacePath)}\n此操作将永久删除所有会话记录及对应的 Claude 会话文件，且不可恢复。`,
    confirmLabel: '全部删除',
  });
  if (!confirmed) return;

  try {
    const deletedCount = await api.deleteWorkspaceConversations({
      projectDir: workspacePath,
    });
    console.log('[deleteWorkspace] deletedCount:', deletedCount);

    // 清理已删除会话的流式状态
    for (const conv of ws.conversations) {
      clearStreamingState(conv.id);
      appState.runningSessions.delete(conv.id);
    }

    // 如果当前活跃会话属于被删除的工作区，切换到其他会话
    const deletedIds = new Set(ws.conversations.map((c) => c.id));
    if (appState.activeConversationId && deletedIds.has(appState.activeConversationId)) {
      appState.activeConversationId = '';
      appState.activeConversationSourcePath = null;
      appState.pendingUserMessage = null;
      appState.pendingUserMessageConvId = null;
      appState.transientSessionError = null;
    }

    await loadData();
    shellApi.render();
    showCopyToastMsg(`已删除 ${deletedCount} 个会话`);
  } catch (e) {
    console.error('Failed to delete workspace conversations:', e);
    alert('删除目录会话失败: ' + String(e));
    await loadData();
    shellApi.render();
  }
}

