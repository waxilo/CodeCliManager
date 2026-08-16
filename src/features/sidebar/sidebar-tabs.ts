import { appState } from '../../state';
import { renderActiveConversations, renderArchivedConversationList } from './render-list';
import { scheduleHighlighting } from '../../markdown';

/**
 * 侧边栏多视图页签：活跃会话 / 归档会话。
 *
 * - `#conversation-list` 是唯一的内容容器：切换 tab 只替换它的 innerHTML，
 *   render.ts 上对它的事件委托（会话点击/上下文菜单）与 select.ts 的存在性判断都不受影响。
 * - 活跃 = 近 24 小时更新的会话平铺；归档 = 更早的会话按工作区分组。
 * - 进行中的子代理在输入框上方实时展示（见 subagent-progress.ts），侧边栏不再有子代理页签。
 */

export type SidebarTab = 'active' | 'archived';

const SIDEBAR_TAB_STORAGE_KEY = 'codemanager-sidebar-tab';

const TAB_ITEMS: { key: SidebarTab; label: string }[] = [
  { key: 'active', label: '活跃会话' },
  { key: 'archived', label: '归档会话' },
];

function loadSidebarTab(): SidebarTab {
  try {
    const stored = localStorage.getItem(SIDEBAR_TAB_STORAGE_KEY);
    // 旧版 'workspace'（工作区分组视图）迁移为归档会话；'subagents' 页签已移除
    if (stored === 'workspace') return 'archived';
    if (stored === 'active' || stored === 'archived') {
      return stored;
    }
  } catch {
    // ignore invalid storage
  }
  return 'active';
}

let activeTab: SidebarTab = loadSidebarTab();

export function getActiveSidebarTab(): SidebarTab {
  return activeTab;
}

/** 重置全部模块状态（测试用；应用初始化可安全调用）。不写 localStorage。 */
export function resetSidebarTabState(): void {
  activeTab = 'active';
}

/** 设置当前 tab。persist=false 用于程序化切换（不写 localStorage）。 */
export function setActiveSidebarTab(
  tab: SidebarTab,
  opts: { persist?: boolean; isAuto?: boolean } = {},
): void {
  const { persist = true } = opts;
  if (tab === activeTab) return;
  activeTab = tab;
  if (persist) {
    try {
      localStorage.setItem(SIDEBAR_TAB_STORAGE_KEY, tab);
    } catch {
      // ignore
    }
  }
  applyTabBarDom();
  refreshActiveTabContent();
}

function applyTabBarDom(): void {
  document.querySelectorAll<HTMLElement>('.sidebar-tab[data-tab]').forEach((btn) => {
    const active = btn.dataset.tab === activeTab;
    btn.classList.toggle('is-active', active);
    btn.setAttribute('aria-selected', String(active));
    btn.setAttribute('tabindex', active ? '0' : '-1');
  });
  const sidebar = document.querySelector('.sidebar');
  if (sidebar) {
    sidebar.classList.remove('is-active', 'is-archived', 'is-subagents');
    sidebar.classList.add(`is-${activeTab}`);
  }
}

/** 横向页签条 HTML（在 sidebar-header 与内容容器之间） */
export function renderSidebarTabsHtml(): string {
  return `
    <div class="sidebar-tabs" id="sidebar-tabs" role="tablist" aria-label="侧边栏视图">
      ${TAB_ITEMS.map(
        (t) => `
        <button
          type="button"
          class="sidebar-tab${activeTab === t.key ? ' is-active' : ''}"
          data-tab="${t.key}"
          role="tab"
          aria-selected="${activeTab === t.key}"
          tabindex="${activeTab === t.key ? '0' : '-1'}"
        >
          ${t.label}
        </button>`,
      ).join('')}
    </div>
  `;
}

export function bindSidebarTabs(): void {
  const tabsBar = document.querySelector<HTMLElement>('#sidebar-tabs');
  if (!tabsBar) return;
  if (tabsBar.dataset.bound === '1') return;
  tabsBar.dataset.bound = '1';

  tabsBar.addEventListener('click', (e) => {
    const btn = (e.target as HTMLElement).closest<HTMLElement>('.sidebar-tab[data-tab]');
    if (!btn) return;
    setActiveSidebarTab(btn.dataset.tab as SidebarTab);
  });
}

/** 按当前 tab 渲染内容 HTML */
export function renderActiveTabContent(): string {
  if (activeTab === 'archived') return renderArchivedConversationList();
  return renderActiveConversations();
}

/** 局部重渲染侧边栏当前 tab 的内容（含管理页守卫与 tab 条状态同步） */
export function refreshActiveTabContent(): void {
  if (
    appState.isApiConfigViewActive ||
    appState.isSettingsViewActive ||
    appState.isMcpViewActive ||
    appState.isKiroViewActive
  ) {
    return;
  }
  const list = document.querySelector<HTMLElement>('#conversation-list');
  if (!list) return;
  list.innerHTML = renderActiveTabContent();
  applyTabBarDom();
  // 子代理 tab 的报告含代码块（data-hl-lang 占位），与消息流一致走延迟高亮
  scheduleHighlighting(list);
}
