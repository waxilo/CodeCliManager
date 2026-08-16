import { appState, EXPANDED_WORKSPACES_KEY } from '../../state';
import type { Conversation, WorkspaceGroup } from '../../types';
import { shellApi } from '../../app/shell/api';
import * as api from '../../api';
import { showConfirmDialog } from '../../ui';
import { dismissApiConfigViewState } from '../api-config/view-lifecycle';
import { refreshModelInfo } from '../chat/model-picker';
import { invalidateFileCache, stashComposerDraft } from '../files/index';
import { dismissMcpViewState } from '../mcp/mount';
import { dismissSettingsViewState } from '../settings/mount';
import { dismissKiroViewState } from '../kiro/mount';
export function getWorkspaceDisplayName(path: string): string {
  const normalized = path.replace(/[\\/]+$/, '');
  const parts = normalized.split(/[\\/]/);
  return parts[parts.length - 1] || path;
}

// ── 侧边栏展示辅助（项目 icon / 时间 / 模型标签）─────────────────────

/** 稳定字符串哈希，用于给项目 icon 分配固定色相 */
export function hashString(input: string): number {
  let hash = 0;
  for (let i = 0; i < input.length; i++) {
    hash = (hash << 5) - hash + input.charCodeAt(i);
    hash |= 0;
  }
  return Math.abs(hash);
}

/** 项目 icon 色相：同一路径始终得到同一颜色 */
export function getWorkspaceHue(path: string): number {
  return hashString(path) % 360;
}

/** 项目 icon 文字：取目录名的 1~2 个有效字符 */
export function getWorkspaceInitials(displayName: string): string {
  const cleaned = displayName.replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
  if (!cleaned) return '#';

  const words = cleaned.split(/\s+/);
  if (words.length >= 2) {
    return (words[0][0] + words[1][0]).toUpperCase();
  }

  const word = words[0];
  // CamelCase：取首字母 + 第二个大写字母（CodeCliManager → CC）
  const camel = word.match(/^(\p{Lu})[\p{Ll}\p{N}]*(\p{Lu})/u);
  if (camel) {
    return (camel[1] + camel[2]).toUpperCase();
  }
  // 中文取首字，其他取前两位
  return /\p{Script=Han}/u.test(word) ? word[0] : word.slice(0, 2).toUpperCase();
}

/** 把模型 ID 压缩成短标签：claude-sonnet-4-5-20250929 → Sonnet 4.5 */
export function formatModelLabel(model: string | null | undefined): string {
  const raw = model?.trim();
  if (!raw) return '';

  // 去掉日期后缀与厂商前缀
  let id = raw.replace(/[-_]?\d{8}$/, '');
  id = id.replace(/^(anthropic|openai|google|deepseek|qwen|moonshot)[/-]/i, '');

  const family = id.match(/(opus|sonnet|haiku|gpt|o\d|gemini|deepseek|qwen|kimi|glm|grok)/i);
  const version = id.match(/(\d+(?:[.-]\d+)?)/);

  if (family) {
    const name = family[1].toLowerCase();
    const pretty = name.charAt(0).toUpperCase() + name.slice(1);
    const ver = version ? ` ${version[1].replace('-', '.')}` : '';
    return `${pretty}${ver}`.trim();
  }

  return id.length > 18 ? `${id.slice(0, 17)}…` : id;
}

/** 将工作区展开状态持久化到 localStorage */
export function saveExpandedWorkspaces(): void {
  try {
    localStorage.setItem(EXPANDED_WORKSPACES_KEY, JSON.stringify(Array.from(appState.expandedWorkspaces)));
  } catch (e) {
    console.warn('Failed to save expanded workspaces:', e);
  }
}

/** 按 project_dir 将对话分组为工作区，返回工作区列表和未分类对话。
 *  默认分组全部会话；传入 convs 时只分组该子集（如归档会话）。 */
export function groupConversationsByWorkspace(
  convs: Conversation[] = appState.conversations,
): { workspaces: WorkspaceGroup[]; uncategorized: Conversation[] } {
  const workspaceMap = new Map<string, Conversation[]>();
  const uncategorized: Conversation[] = [];

  for (const conv of convs) {
    const dir = conv.project_dir?.trim();
    if (dir) {
      const list = workspaceMap.get(dir) || [];
      list.push(conv);
      workspaceMap.set(dir, list);
    } else {
      uncategorized.push(conv);
    }
  }

  // 构建工作区数组，按对话创建时间降序排列
  const workspaces: WorkspaceGroup[] = Array.from(workspaceMap.entries()).map(([path, convs]) => ({
    path,
    displayName: getWorkspaceDisplayName(path),
  conversations: convs.sort((a, b) => b.created_at - a.created_at),
  }));
  workspaces.sort((a, b) => {
    const aLatest = a.conversations[0]?.created_at ?? 0;
    const bLatest = b.conversations[0]?.created_at ?? 0;
    return bLatest - aLatest;
  });

  // 未分类对话也按创建时间降序
  uncategorized.sort((a, b) => b.created_at - a.created_at);

  return { workspaces, uncategorized };
}

/** 在指定工作区快速新建对话（预设工作目录，跳过选目录步骤） */
export async function newChatInWorkspace(workspacePath: string): Promise<void> {
  // 有正在运行的会话时先确认，避免静默强杀丢弃正在生成的回答
  if (appState.runningSessions.size > 0) {
    const confirmed = await showConfirmDialog({
      title: '新建会话',
      message: '当前有正在运行的会话，新建会话将终止它。是否继续？',
      sub: `工作区：${workspacePath}`,
      confirmLabel: '终止并新建',
    });
    if (!confirmed) return;
  }
  dismissApiConfigViewState();
  dismissSettingsViewState();
  dismissMcpViewState();
  dismissKiroViewState();
  // 清除会话状态前保存当前输入草稿（对齐 pickNewWorkspaceDirectory）
  stashComposerDraft();
  appState.activeConversationId = '';
  appState.activeConversationSourcePath = null;
  invalidateFileCache();
  appState.pendingUserMessage = null;
  appState.pendingUserMessageConvId = null;
  appState.transientSessionError = null;
  appState.pendingProjectDir = workspacePath;
  void api.abortSession({ force: true }).catch(() => {});
  shellApi.render();
  void refreshModelInfo();

  setTimeout(() => {
    const input = document.querySelector<HTMLTextAreaElement>('#message-input');
    if (input) input.focus();
  }, 100);
}

