import { appState } from '../../state';
import { escapeHtml, toMillis, formatRelativeTime, formatCompactTime } from '../../utils';
import type { Conversation } from '../../types';
import { groupConversationsByWorkspace, getWorkspaceHue, getWorkspaceInitials, formatModelLabel, saveExpandedWorkspaces } from './workspace-grouping';

/** 未分类分组的固定 key */
export const UNCATEGORIZED_WORKSPACE_KEY = '__uncategorized__';

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
  const isActive = c.id === appState.activeConversationId;
  const isEditing = appState.editingConversationId === c.id;
  const isRunning = appState.runningSessions.has(c.id);
  const isNew = appState.newConversationIds.has(c.id);

  const classNames = [
    'conversation-item',
    isActive ? 'active' : '',
    isEditing ? 'editing' : '',
    isRunning ? 'running' : '',
    isNew ? 'is-new' : '',
  ].filter(Boolean).join(' ');

  const time = formatCompactTime(c.updated_at || c.created_at);
  const stateIcon = isRunning ? CONVERSATION_RUNNING_DOT_HTML : CONVERSATION_CHAT_ICON_SVG;

  return `
    <div class="${classNames}" data-id="${c.id}" title="${escapeHtml(c.title)}">
      <span class="conversation-rail" aria-hidden="true"></span>
      ${isEditing ? `
        <div class="conversation-edit-row">
          <input type="text"
                 class="edit-input"
                 id="edit-input-${c.id}"
                 value="${escapeHtml(c.title)}"
          />
          <div class="edit-action-buttons">
            <button type="button" class="edit-action-btn save" data-action="save-edit" data-id="${c.id}" title="保存">✓</button>
            <button type="button" class="edit-action-btn cancel" data-action="cancel-edit" title="取消">✕</button>
          </div>
        </div>
      ` : `
        <span class="conversation-row">
          ${stateIcon}
          <span class="conversation-title">${escapeHtml(c.title)}</span>
          ${time ? `<span class="conversation-time">${escapeHtml(time)}</span>` : ''}
          <button type="button" class="conv-more-btn" data-action="more" data-id="${c.id}" title="更多操作" aria-label="更多操作">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><circle cx="12" cy="5" r="2"/><circle cx="12" cy="12" r="2"/><circle cx="12" cy="19" r="2"/></svg>
          </button>
        </span>
      `}
    </div>
  `;
}

export function buildSidebarWorkspaceViews(): SidebarWorkspaceView[] {
  const { workspaces, uncategorized } = groupConversationsByWorkspace();
  const query = appState.sidebarSearchQuery.trim().toLowerCase();

  const toView = (
    key: string,
    path: string,
    displayName: string,
    convs: Conversation[],
    isUncategorized: boolean,
  ): SidebarWorkspaceView | null => {
    // 目录名/路径命中时保留全部会话，否则只保留标题命中的会话
    const workspaceHit =
      !!query && (displayName.toLowerCase().includes(query) || path.toLowerCase().includes(query));
    const matched = !query || workspaceHit
      ? convs
      : convs.filter((c) => c.title.toLowerCase().includes(query));

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
      hasActive: matched.some((c) => c.id === appState.activeConversationId),
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

const CONVERSATION_CHAT_ICON_SVG =
  '<svg class="conversation-chat-icon" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>';

const CONVERSATION_RUNNING_DOT_HTML =
  '<span class="conversation-status-dot" title="运行中" aria-label="运行中"></span>';

/** 项目卡片元信息（最近使用时间 / 运行中状态）的内部 HTML */
export function renderWorkspaceMetaInnerHtml(ws: SidebarWorkspaceView): string {
  const relTime = formatRelativeTime(ws.latestActivity);

  return [
    ws.runningCount > 0
      ? `<span class="workspace-live"><i class="workspace-live-dot" aria-hidden="true"></i>${ws.runningCount} 运行中</span>`
      : relTime
        ? `<span class="workspace-time">${escapeHtml(relTime)}</span>`
        : '',
  ].filter(Boolean).join('');
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

  const hue = ws.isUncategorized ? 220 : getWorkspaceHue(ws.path);
  const initials = ws.isUncategorized ? '·' : getWorkspaceInitials(ws.displayName);
  const titleAttr = ws.isUncategorized ? '未归属工作目录的会话' : ws.path;

  return `
    <section class="${cardClasses}" data-workspace-key="${key}" style="--ws-hue: ${hue}">
      <div
        class="workspace-header"
        data-action="toggle-workspace"
        data-workspace="${key}"
        role="button"
        tabindex="0"
        aria-expanded="${isExpanded}"
        title="${escapeHtml(titleAttr)}"
      >
        <span class="workspace-arrow${isExpanded ? ' expanded' : ''}">${CHEVRON_SVG}</span>
        <span class="workspace-avatar" aria-hidden="true">${escapeHtml(initials)}</span>
        <span class="workspace-main">
          <span class="workspace-name-row">
            <span class="workspace-name">${escapeHtml(ws.displayName)}</span>
            <span class="workspace-count">${ws.conversations.length}</span>
          </span>
          <span class="workspace-meta">${renderWorkspaceMetaInnerHtml(ws)}</span>
        </span>
        <span class="workspace-actions">
          <button type="button" class="ws-icon-btn" data-action="workspace-more" data-workspace="${key}" title="项目操作" aria-label="项目操作">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><circle cx="12" cy="5" r="2"/><circle cx="12" cy="12" r="2"/><circle cx="12" cy="19" r="2"/></svg>
          </button>
        </span>
      </div>
      <div class="workspace-body">
        <div class="workspace-appState.conversations">
          ${ws.conversations.map((c) => renderConversationItemHtml(c)).join('')}
        </div>
      </div>
    </section>
  `;
}

export function renderSidebarEmptyHtml(isSearching: boolean): string {
  const icon = isSearching
    ? '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="11" cy="11" r="7"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>'
    : '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>';

  return `
    <div class="sidebar-empty">
      <span class="sidebar-empty-icon">${icon}</span>
      <span class="sidebar-empty-title">${isSearching ? '没有匹配的会话' : '还没有会话'}</span>
      <span class="sidebar-empty-hint">${isSearching ? '试试其他关键词，或清空搜索条件' : '点击上方「新建会话」选择工作目录开始'}</span>
    </div>
  `;
}

export function renderConversationList(): string {
  const isSearching = appState.sidebarSearchQuery.trim().length > 0;
  const views = appState.conversations.length === 0 ? [] : buildSidebarWorkspaceViews();

  if (views.length === 0) {
    appState.newConversationIds.clear();
    return renderSidebarEmptyHtml(isSearching);
  }

  const totalConversations = views.reduce((sum, ws) => sum + ws.conversations.length, 0);
  const label = isSearching
    ? `<div class="sidebar-section-label"><span>搜索结果</span><span class="sidebar-section-label-count">${totalConversations} 个会话</span></div>`
    : `<div class="sidebar-section-label"><span>工作区</span><span class="sidebar-section-label-count">${views.length} 个项目</span></div>`;

  // 搜索时强制展开所有命中的卡片，方便直接定位会话
  const cards = views
    .map((ws) => renderWorkspaceCardHtml(ws, isSearching || appState.expandedWorkspaces.has(ws.key)))
    .join('');

  // 淡入动画只播放一次
  appState.newConversationIds.clear();

  return label + cards;
}

/** 局部重渲染侧边栏会话列表 */
export function refreshConversationListDom(): void {
  if (appState.isApiConfigViewActive || appState.isSettingsViewActive || appState.isMcpViewActive || appState.isKiroViewActive) return;
  const list = document.querySelector('#conversation-list');
  if (list) list.innerHTML = renderConversationList();
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

export function updateConversationListSpinner() {
  // 会话行：运行中显示脉冲点，否则回到聊天图标
  document.querySelectorAll<HTMLElement>('.conversation-item').forEach((item) => {
    const id = item.dataset.id;
    if (!id) return;

    const isRunning = appState.runningSessions.has(id);
    const wasRunning = item.classList.contains('running');
    item.classList.toggle('running', isRunning);
    if (isRunning === wasRunning) return;

    const icon = item.querySelector('.conversation-chat-icon, .conversation-status-dot');
    if (icon) {
      icon.outerHTML = isRunning ? CONVERSATION_RUNNING_DOT_HTML : CONVERSATION_CHAT_ICON_SVG;
    }
  });

  // 项目卡片：同步「运行中」标记与最近使用时间
  const cards = document.querySelectorAll<HTMLElement>('.workspace-card');
  if (cards.length === 0) return;

  const viewByKey = new Map(buildSidebarWorkspaceViews().map((ws) => [ws.key, ws]));
  cards.forEach((card) => {
    const ws = card.dataset.workspaceKey ? viewByKey.get(card.dataset.workspaceKey) : undefined;
    const meta = card.querySelector<HTMLElement>('.workspace-meta');
    if (ws && meta) meta.innerHTML = renderWorkspaceMetaInnerHtml(ws);
  });
}

