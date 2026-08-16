import { appState } from '../../state';
import { escapeHtml, toMillis, formatCompactTime } from '../../utils';
import type { Conversation } from '../../types';
import { isConversationInstance } from '../conversations/normalize';
import { groupConversationsByWorkspace, formatModelLabel, saveExpandedWorkspaces } from './workspace-grouping';
import { refreshActiveTabContent } from './sidebar-tabs';

/** 未分类分组的固定 key */
export const UNCATEGORIZED_WORKSPACE_KEY = '__uncategorized__';

/** 活跃会话的时间窗口：updated_at 在最近 N 小时内 */
export const RECENT_HOURS = 24;

/** 判定会话是否属于「活跃」（最近 RECENT_HOURS 小时内有更新） */
export function isRecentConversation(conv: Conversation, now = Date.now()): boolean {
  // updated_at 后端为秒级（timestamp()），本地乐观气泡可能为毫秒；统一经 toMillis 归一化
  return toMillis(conv.updated_at) >= now - RECENT_HOURS * 3600 * 1000;
}

/** 活跃会话列表：近 24 小时更新的会话，按最近更新降序 */
export function getRecentConversations(now = Date.now()): Conversation[] {
  return appState.conversations
    .filter((c) => isRecentConversation(c, now))
    .sort((a, b) => b.updated_at - a.updated_at);
}

export interface SidebarWorkspaceView {
  key: string;
  path: string;
  displayName: string;
  conversations: import('../../types').Conversation[];
  latestActivity: number;
  modelLabel: string;
  hasActive: boolean;
  runningCount: number;
  isUncategorized: boolean;
}

export function renderConversationItemHtml(c: Conversation): string {
  const isActive = isConversationInstance(
    c,
    appState.activeConversationId,
    appState.activeConversationSourcePath,
  );
  const isEditing = isConversationInstance(
    c,
    appState.editingConversationId || '',
    appState.editingConversationSourcePath,
  );
  const isRunning = appState.runningSessions.has(c.id);
  const isNew = appState.newConversationIds.has(c.id);
  const sourcePath = escapeHtml(c.source_path || '');
  // c.id 也统一转义：会话 ID 虽来自后端，但需与其他属性转义一致，防止未来 ID 含引号时破坏 HTML
  const idAttr = escapeHtml(c.id);

  const classNames = [
    'conversation-item',
    isActive ? 'active' : '',
    isEditing ? 'editing' : '',
    isRunning ? 'running' : '',
    isNew ? 'is-new' : '',
  ].filter(Boolean).join(' ');

  const time = formatCompactTime(c.updated_at || c.created_at);

  return `
    <div class="${classNames}" data-id="${idAttr}" data-source-path="${sourcePath}" title="${escapeHtml(c.title)}">
      <span class="conversation-rail" aria-hidden="true"></span>
      ${isEditing ? `
        <div class="conversation-edit-row">
          <input type="text"
                 class="edit-input"
                 id="edit-input-${idAttr}"
                 data-source-path="${sourcePath}"
                 value="${escapeHtml(c.title)}"
          />
          <div class="edit-action-buttons">
            <button type="button" class="edit-action-btn save" data-action="save-edit" data-id="${idAttr}" data-source-path="${sourcePath}" title="保存">✓</button>
            <button type="button" class="edit-action-btn cancel" data-action="cancel-edit" title="取消">✕</button>
          </div>
        </div>
      ` : `
        <span class="conversation-row">
          ${CONVERSATION_STATE_ICON}
          <span class="conversation-title">${escapeHtml(c.title)}</span>
          ${time ? `<span class="conversation-time">${escapeHtml(time)}</span>` : ''}
          <button type="button" class="conv-more-btn" data-action="more" data-id="${idAttr}" data-source-path="${sourcePath}" title="更多操作" aria-label="更多操作">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><circle cx="12" cy="5" r="2"/><circle cx="12" cy="12" r="2"/><circle cx="12" cy="19" r="2"/></svg>
          </button>
        </span>
      `}
    </div>
  `;
}

export function buildSidebarWorkspaceViews(
  convs: Conversation[] = appState.conversations,
): SidebarWorkspaceView[] {
  const { workspaces, uncategorized } = groupConversationsByWorkspace(convs);

  const toView = (
    key: string,
    path: string,
    displayName: string,
    convs: Conversation[],
    isUncategorized: boolean,
  ): SidebarWorkspaceView | null => {
    const matched = convs;

    if (matched.length === 0) return null;

    const latestActivity = matched.reduce(
      (max, c) => Math.max(max, toMillis(c.updated_at), toMillis(c.created_at)),
      0,
    );
    // 模型标签取最近活动会话上记录的模型
    const newest = [...matched].sort(
      (a, b) => toMillis(b.updated_at || b.created_at) - toMillis(a.updated_at || a.created_at),
    )[0];

    return {
      key,
      path,
      displayName,
  conversations: matched,
      latestActivity,
      modelLabel: formatModelLabel(matched.find((c) => c.last_model)?.last_model ?? newest?.last_model),
      hasActive: matched.some((conversation) =>
        isConversationInstance(
          conversation,
          appState.activeConversationId,
          appState.activeConversationSourcePath,
        ),
      ),
      runningCount: matched.filter((c) => appState.runningSessions.has(c.id)).length,
      isUncategorized,
    };
  };

  const views = workspaces
    .map((ws) => toView(ws.path, ws.path, ws.displayName, ws.conversations, false))
    .filter((v): v is SidebarWorkspaceView => v !== null)
    // 按最近活动时间降序，让常用项目始终靠前
    .sort((a, b) => b.latestActivity - a.latestActivity);

  const uncatView = uncategorized.length
    ? toView(UNCATEGORIZED_WORKSPACE_KEY, '', '未分类', uncategorized, true)
    : null;
  if (uncatView) views.push(uncatView);

  return views;
}

const CHEVRON_SVG =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="9 18 15 12 9 6"/></svg>';

/** 简单文件夹标签（线性图标，替代原色块头像） */
const WORKSPACE_FOLDER_SVG =
  '<svg class="workspace-folder-svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 7a2 2 0 0 1 2-2h4l2 3h8a2 2 0 0 1 2 2v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7z"/></svg>';

const CONVERSATION_RUNNING_DOT_HTML =
  '<span class="conversation-status-dot" title="运行中" aria-label="运行中"></span>';

/** 状态图标常驻容器：仅运行圆点；非运行态整容器不占位（CSS 控制），
 *  避免运行时 outerHTML 替换节点触发侧栏行样式重算。 */
const CONVERSATION_STATE_ICON =
  `<span class="conversation-state-icon">${CONVERSATION_RUNNING_DOT_HTML}</span>`;

/** 项目卡片元信息（仅运行中状态；最近使用时间不再展示，保持分组简洁） */
export function renderWorkspaceMetaInnerHtml(ws: SidebarWorkspaceView): string {
  return ws.runningCount > 0
    ? `<span class="workspace-live"><i class="workspace-live-dot" aria-hidden="true"></i>${ws.runningCount} 运行中</span>`
    : '';
}

/** 渲染单个工作区卡片 */
export function renderWorkspaceCardHtml(ws: SidebarWorkspaceView, isExpanded: boolean): string {
  const key = escapeHtml(ws.key);
  const cardClasses = [
    'workspace-card',
    isExpanded ? 'is-expanded' : '',
    ws.hasActive ? 'has-active' : '',
    ws.isUncategorized ? 'is-uncategorized' : '',
  ].filter(Boolean).join(' ');

  const titleAttr = ws.isUncategorized ? '未归属工作目录的会话' : ws.path;

  // 文件夹图标 + 展开箭头合并到同一占位：默认显示文件夹标签，悬浮/展开时切换为箭头。
  return `
    <section class="${cardClasses}" data-workspace-key="${key}">
      <div
        class="workspace-header"
        data-action="toggle-workspace"
        data-workspace="${key}"
        role="button"
        tabindex="0"
        aria-expanded="${isExpanded}"
        title="${escapeHtml(titleAttr)}"
      >
        <span class="workspace-icon-slot" aria-hidden="true">
          <span class="workspace-folder-icon">${WORKSPACE_FOLDER_SVG}</span>
          <span class="workspace-arrow${isExpanded ? ' expanded' : ''}">${CHEVRON_SVG}</span>
        </span>
        <span class="workspace-main">
          <span class="workspace-name-row">
            <span class="workspace-name">${escapeHtml(ws.displayName)}</span>
          </span>
          <span class="workspace-meta">${renderWorkspaceMetaInnerHtml(ws)}</span>
        </span>
        <span class="workspace-actions">
          <span class="workspace-count">${ws.conversations.length}</span>
          <button type="button" class="ws-icon-btn" data-action="workspace-more" data-workspace="${key}" title="项目操作" aria-label="项目操作">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><circle cx="12" cy="5" r="2"/><circle cx="12" cy="12" r="2"/><circle cx="12" cy="19" r="2"/></svg>
          </button>
        </span>
      </div>
      <div class="workspace-body">
        <div class="workspace-conversations">
          ${ws.conversations.map((c) => renderConversationItemHtml(c)).join('')}
        </div>
      </div>
    </section>
  `;
}

function renderSidebarEmptyHtml(title: string, hint: string): string {
  return `
    <div class="sidebar-empty">
      <span class="sidebar-empty-icon" aria-hidden="true">
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>
      </span>
      <span class="sidebar-empty-title">${escapeHtml(title)}</span>
      <span class="sidebar-empty-hint">${escapeHtml(hint)}</span>
    </div>
  `;
}

/** 活跃会话 tab：近 RECENT_HOURS 小时内更新的会话平铺展示（按最近更新降序） */
export function renderActiveConversations(): string {
  const recent = getRecentConversations();

  if (recent.length === 0) {
    appState.newConversationIds.clear();
    return renderSidebarEmptyHtml('近一天没有新会话', '开始一段新对话后，会话会显示在这里');
  }

  const label = `<div class="sidebar-section-label"><span>活跃会话</span><span class="sidebar-section-label-count">${recent.length} 个会话</span></div>`;
  const rows = recent.map((c) => renderConversationItemHtml(c)).join('');
  appState.newConversationIds.clear();

  return label + `<div class="active-conversations">${rows}</div>`;
}

/** 归档会话 tab：超过 RECENT_HOURS 未更新的会话按工作区分组展示 */
export function renderArchivedConversationList(): string {
  const now = Date.now();
  const archived = appState.conversations.filter((c) => !isRecentConversation(c, now));
  const views = archived.length === 0 ? [] : buildSidebarWorkspaceViews(archived);

  if (views.length === 0) {
    appState.newConversationIds.clear();
    if (appState.conversations.length === 0) {
      return renderSidebarEmptyHtml('还没有会话', '点击上方「新建会话」选择工作目录开始');
    }
    return renderSidebarEmptyHtml('暂无归档会话', '近一天的会话在「活跃会话」tab');
  }

  const label = `<div class="sidebar-section-label"><span>归档会话</span><span class="sidebar-section-label-count">${views.length} 个项目</span></div>`;

  const cards = views
    .map((ws) => renderWorkspaceCardHtml(ws, appState.expandedWorkspaces.has(ws.key)))
    .join('');

  // 淡入动画只播放一次
  appState.newConversationIds.clear();

  return label + cards;
}

/** 局部重渲染侧边栏当前 tab 的内容（工作区 tab 即会话列表；守卫在 refreshActiveTabContent） */
export function refreshConversationListDom(): void {
  refreshActiveTabContent();
}

/** 展开 / 收起工作区卡片（带 200ms 高度过渡） */
export function toggleWorkspaceExpanded(key: string): void {
  const willExpand = !appState.expandedWorkspaces.has(key);
  if (willExpand) {
    appState.expandedWorkspaces.add(key);
  } else {
    appState.expandedWorkspaces.delete(key);
  }
  saveExpandedWorkspaces();

  const card = Array.from(document.querySelectorAll<HTMLElement>('.workspace-card'))
    .find((el) => el.dataset.workspaceKey === key);
  const body = card?.querySelector<HTMLElement>('.workspace-body');

  if (!card || !body) {
    refreshConversationListDom();
    return;
  }

  card.querySelector('.workspace-arrow')?.classList.toggle('expanded', willExpand);
  card.querySelector('.workspace-header')?.setAttribute('aria-expanded', String(willExpand));

  const targetHeight = body.scrollHeight;

  if (willExpand) {
    body.style.maxHeight = '0px';
    card.classList.add('is-expanded');
    void body.offsetHeight; // 强制 reflow，确保从 0 开始过渡
    body.style.maxHeight = `${targetHeight}px`;
    window.setTimeout(() => {
      // 过渡结束后交还给内容自适应高度
      if (card.classList.contains('is-expanded')) body.style.maxHeight = '';
    }, 220);
  } else {
    body.style.maxHeight = `${targetHeight}px`;
    void body.offsetHeight;
    card.classList.remove('is-expanded');
    body.style.maxHeight = ''; // 回落到 CSS 的 max-height: 0
  }
}

/** 每个 workspace 卡片最近写入的 meta HTML；无变化时跳过 innerHTML 写入，避免每次退出管理页全量重写 */
const lastWorkspaceMetaHtml = new Map<string, string>();

export function updateConversationListSpinner() {
  // 会话行：运行中显示脉冲点，否则回到聊天图标。
  // 图标已常驻 DOM（CONVERSATION_STATE_ICON），只切 .running class，
  // 由 CSS 控制显隐，不再 outerHTML 替换节点触发侧栏行样式重算。
  document.querySelectorAll<HTMLElement>('.conversation-item').forEach((item) => {
    const id = item.dataset.id;
    if (!id) return;
    item.classList.toggle('running', appState.runningSessions.has(id));
  });

  // 项目卡片：同步「运行中」标记与最近使用时间
  const cards = document.querySelectorAll<HTMLElement>('.workspace-card');
  if (cards.length === 0) return;

  const viewByKey = new Map(buildSidebarWorkspaceViews().map((ws) => [ws.key, ws]));
  cards.forEach((card) => {
    const ws = card.dataset.workspaceKey ? viewByKey.get(card.dataset.workspaceKey) : undefined;
    const meta = card.querySelector<HTMLElement>('.workspace-meta');
    if (!ws || !meta) return;
    const key = ws.key;
    const html = renderWorkspaceMetaInnerHtml(ws);
    // 内容未变时跳过：避免归档工作区多时每次切回主页面 O(cards) 次 innerHTML 写入 + 布局失效。
    // 空内容不覆盖 DOM：保留首渲已写入的时间/模型标签，避免瞬时空快照把 meta 刷没。
    if (!html && lastWorkspaceMetaHtml.get(key)) return;
    if (lastWorkspaceMetaHtml.get(key) === html) return;
    lastWorkspaceMetaHtml.set(key, html);
    meta.innerHTML = html;
  });

  // 清理已不存在工作区的缓存键，避免会话列表增删后 Map 无限残留
  for (const key of [...lastWorkspaceMetaHtml.keys()]) {
    if (!viewByKey.has(key)) lastWorkspaceMetaHtml.delete(key);
  }
}

