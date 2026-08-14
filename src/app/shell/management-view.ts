/**
 * 管理页（API 配置 / 设置 / MCP）的增量进出切换。
 *
 * 原实现：openXxxView / closeXxxView 都走 shellApi.render() → 整棵 app.innerHTML 重建。
 * 返回主页面时 performRender 会重渲染完整会话列表 + 当前会话全部消息（绕过渲染缓存），
 * 拼出 MB 级 innerHTML 让 WebView2 整体解析，Windows 上就是秒级卡顿。
 *
 * 本模块改为「双向摘挂」：
 *  - 进入管理页：把主视图四块 DOM（侧栏 / 主内容 / 子代理面板 / 余额状态栏）摘下保存，
 *    返回时原样挂回（DOM 移动保留全部事件监听 → 零重建、零重绑）。
 *  - 同时把上次构建的管理壳节点缓存（stashedMgmtDom）：同页面二次进入直接挂回缓存节点，
 *    跳过 sidebar/main-content 的 innerHTML 重建，表单值 / MCP 弹窗 / 滚动位置全部保留；
 *    挂载函数仅在首次构建时做完整绑定，二次挂载只重绑 Escape（见 dataset 守卫）。
 */
import type { SettingsSection } from '../../types';
import { appState } from '../../state';
import { shellApi } from './api';
import { scheduleUiRefresh } from '../../ui';
import { renderApiConfigSidebarHtml, renderSettingsSidebarHtml } from '../../features/settings/view';
import { renderApiConfigViewHtml, mountApiConfigView } from '../../features/api-config';
import { renderSettingsViewHtml, mountSettingsView } from '../../features/settings';
import { renderMcpViewHtml, mountMcpView } from '../../features/mcp';
import { bindAppUpdatePopoverEvents, checkAppUpdate } from '../../features/updates/app-update';
import { bindClaudeUpdatePopoverEvents } from '../../features/updates/claude-update';
import { syncSubagentProgressUI } from '../../features/chat/subagent-progress';
import { remountActiveInteractionPanel } from '../../features/permissions';
import { startMainBalanceBarAutoRefresh } from '../../features/status-bar';
import { refreshStreamingUI } from '../../features/chat/streaming';
import {
  resetChatRenderKey,
  getLastChatRenderKey,
  getCurrentChatRenderKey,
} from '../../features/chat/refresh';

export type ManagementViewKind = 'api-config' | 'settings' | 'mcp';

interface StashedMainDom {
  sidebar: HTMLElement | null;
  mainContent: HTMLElement | null;
  subagentProgress: HTMLElement | null;
  statusBar: HTMLElement | null;
  /** stash 时主视图聊天区 DOM 所对应的内容指纹：退出时据此判断内容是否变化 */
  chatRenderKeyAtStash: string;
}

interface StashedMgmtDom {
  kind: ManagementViewKind;
  sidebar: HTMLElement;
  mainContent: HTMLElement;
}

/**
 * 被摘下保存的主视图 / 管理壳 DOM。任意全量 performRender 都会清空它们——
 * 全量渲染重建了整个 #app，旧引用即失效。stash 只在「增量进出管理页」期间有效。
 * 不变量：主视图可见时 stashedMainDom 为 null；管理页可见时 stashedMgmtDom 为 null。
 */
let stashedMainDom: StashedMainDom | null = null;
let stashedMgmtDom: StashedMgmtDom | null = null;

export function clearStashedMainDom(): void {
  stashedMainDom = null;
  stashedMgmtDom = null;
}

function isManagementShellPresent(appContainer: Element): boolean {
  const main = appContainer.querySelector('.main-content');
  return Boolean(
    main?.classList.contains('is-api-config') || main?.classList.contains('is-mcp'),
  );
}

/** 从当前 DOM 反推管理页类型（退出时 flags 已被 dismiss 清空，不能依赖 appState） */
function detectManagementKind(): ManagementViewKind {
  const main = document.querySelector('.main-content');
  if (main?.classList.contains('is-mcp')) return 'mcp';
  if (document.querySelector('#api-config-view')) return 'api-config';
  return 'settings';
}

/** 设置侧栏分类导航：点击切换设置页内容（增量换 main-content，不整页重绘） */
export function bindSettingsSectionNav(): void {
  document.querySelectorAll<HTMLButtonElement>('[data-settings-section]').forEach((btn) => {
    if ((btn as HTMLElement).dataset.bound === '1') return;
    (btn as HTMLElement).dataset.bound = '1';
    btn.addEventListener('click', () => {
      const section = btn.dataset.settingsSection as SettingsSection | undefined;
      if (!section || section === appState.settingsSection) return;
      appState.settingsSection = section;

      if (
        appState.isSettingsViewActive &&
        document.querySelector('.app-container')?.classList.contains('is-api-config')
      ) {
        // 增量路径：只换主区设置内容 + 同步侧栏激活态，保留已 stash 的主视图
        document.querySelectorAll<HTMLElement>('[data-settings-section]').forEach((el) => {
          el.classList.toggle('is-active', el.dataset.settingsSection === section);
        });
        const main = document.querySelector('.main-content');
        if (main) {
          main.innerHTML = renderSettingsViewHtml();
          mountActiveManagementView();
          return;
        }
      }
      shellApi.render();
      if (
        section === 'app-update' &&
        appState.appUpdateInfo.updateAvailable &&
        !appState.appUpdate &&
        appState.appUpdateCheckStatus !== 'checking' &&
        appState.appUpdateCheckStatus !== 'downloading'
      ) {
        void checkAppUpdate(true);
      }
    });
  });
}

/** 根据当前 state flags 挂载管理页（Escape 处理 / 更新面板绑定等）；全量渲染与增量路径共用 */
export function mountActiveManagementView(): void {
  if (appState.isApiConfigViewActive) {
    void mountApiConfigView();
  } else if (appState.isSettingsViewActive) {
    const updatePanel = document.querySelector('.settings-update-view');
    if (updatePanel && appState.settingsSection === 'app-update') {
      bindAppUpdatePopoverEvents(updatePanel);
      if (
        appState.appUpdateInfo.updateAvailable &&
        !appState.appUpdate &&
        appState.appUpdateCheckStatus !== 'checking' &&
        appState.appUpdateCheckStatus !== 'downloading'
      ) {
        void checkAppUpdate(true);
      }
    } else if (updatePanel && appState.settingsSection === 'claude-update') {
      bindClaudeUpdatePopoverEvents(updatePanel);
    }
    mountSettingsView();
  } else if (appState.isMcpViewActive) {
    void mountMcpView();
  }
}

function renderManagementSidebarHtml(kind: ManagementViewKind): string {
  if (kind === 'api-config') return renderApiConfigSidebarHtml();
  if (kind === 'settings') return renderSettingsSidebarHtml();
  return '';
}

function renderManagementViewHtml(kind: ManagementViewKind): string {
  if (kind === 'api-config') return renderApiConfigViewHtml();
  if (kind === 'settings') return renderSettingsViewHtml();
  return renderMcpViewHtml();
}

function applyManagementShellState(kind: ManagementViewKind, appContainer: Element): void {
  appContainer.classList.toggle('is-api-config', kind !== 'mcp');
  appContainer.classList.toggle('is-mcp', kind === 'mcp');
  appContainer.classList.remove('has-subagent-panel');
}

function buildManagementShell(kind: ManagementViewKind, appContainer: Element): void {
  const resizer = appContainer.querySelector('.sidebar-resizer');

  const sidebar = document.createElement('div');
  sidebar.className = `sidebar${kind === 'mcp' ? '' : ' is-api-config'}`;
  sidebar.innerHTML = renderManagementSidebarHtml(kind);
  if (resizer) resizer.before(sidebar);
  else appContainer.appendChild(sidebar);

  const mainContent = document.createElement('div');
  mainContent.className = `main-content${kind === 'mcp' ? ' is-mcp' : ' is-api-config'}`;
  mainContent.innerHTML = renderManagementViewHtml(kind);
  if (resizer) resizer.after(mainContent);
  else appContainer.appendChild(mainContent);

  applyManagementShellState(kind, appContainer);
  bindSettingsSectionNav();
  mountActiveManagementView();
  shellApi.syncTitlebarActions();
}

/** 管理页互斥切换（已在管理壳内）：只换管理侧栏 + 主区内容，主视图 stash 原样保留 */
function swapManagementShell(kind: ManagementViewKind): void {
  const appContainer = document.querySelector('.app-container');
  if (!appContainer) {
    shellApi.render();
    return;
  }
  const sidebar = appContainer.querySelector<HTMLElement>('.sidebar');
  const mainContent = appContainer.querySelector<HTMLElement>('.main-content');
  if (sidebar) {
    sidebar.className = `sidebar${kind === 'mcp' ? '' : ' is-api-config'}`;
    sidebar.innerHTML = renderManagementSidebarHtml(kind);
  }
  if (mainContent) {
    mainContent.className = `main-content${kind === 'mcp' ? ' is-mcp' : ' is-api-config'}`;
    mainContent.innerHTML = renderManagementViewHtml(kind);
  }
  applyManagementShellState(kind, appContainer);
  bindSettingsSectionNav();
  mountActiveManagementView();
  shellApi.syncTitlebarActions();
}

/** 进入管理页：摘取并保存主视图 DOM，改为增量构建管理壳 */
export function enterManagementView(kind: ManagementViewKind): void {
  const appContainer = document.querySelector('.app-container');
  if (!appContainer) {
    shellApi.render();
    return;
  }
  // 已在管理壳内（互斥切换）：直接换管理内容，不重复摘主视图
  if (isManagementShellPresent(appContainer)) {
    swapManagementShell(kind);
    return;
  }

  const shell = document.querySelector('.app-shell');
  if (!shell) {
    shellApi.render();
    return;
  }

  const sidebar = appContainer.querySelector<HTMLElement>('.sidebar');
  const mainContent = appContainer.querySelector<HTMLElement>('.main-content');
  // 生产 HTML 中面板类名是 subagent-panel、id 是 subagent-progress（见 renderSubagentProgressHtml）
  const subagentProgress = appContainer.querySelector<HTMLElement>('#subagent-progress');
  const statusBar = shell.querySelector<HTMLElement>('.balance-status-bar');

  stashedMainDom = {
    sidebar,
    mainContent,
    subagentProgress,
    statusBar,
    // 摘下时 DOM 所反映的内容指纹（最近一次 refreshChatContent 写入的 key）
    chatRenderKeyAtStash: getLastChatRenderKey(),
  };
  sidebar?.remove();
  mainContent?.remove();
  subagentProgress?.remove();
  statusBar?.remove();

  // 同页面二次进入：直接挂回缓存的管理壳，跳过 sidebar/main 的 innerHTML 重建
  if (stashedMgmtDom && stashedMgmtDom.kind === kind) {
    const resizer = appContainer.querySelector('.sidebar-resizer');
    if (resizer) {
      resizer.before(stashedMgmtDom.sidebar);
      resizer.after(stashedMgmtDom.mainContent);
    } else {
      appContainer.appendChild(stashedMgmtDom.sidebar);
      appContainer.appendChild(stashedMgmtDom.mainContent);
    }
    stashedMgmtDom = null;
    applyManagementShellState(kind, appContainer);
    // 缓存节点监听已在首次挂载绑定；mount 仅重绑 Escape，数据拉取被 dataset 守卫跳过
    mountActiveManagementView();
    shellApi.syncTitlebarActions();
    return;
  }

  // 切换了管理页：丢弃旧缓存，重建管理壳
  stashedMgmtDom = null;
  buildManagementShell(kind, appContainer);
}

/**
 * 退出管理页：管理壳节点摘走缓存，主视图 DOM 原样挂回（保留监听，零重建）。
 * @returns true = 增量恢复成功；false = 无有效 stash，已回退全量 render
 */
export function exitManagementView(): boolean {
  const appContainer = document.querySelector('.app-container');
  const shell = document.querySelector('.app-shell');
  if (!stashedMainDom || !appContainer || !shell) {
    shellApi.render();
    return false;
  }

  const resizer = appContainer.querySelector('.sidebar-resizer');
  const chatKeyAtStash = stashedMainDom.chatRenderKeyAtStash;

  // 摘走当前管理壳并缓存（节点保留全部监听，二次进入直接复用）
  const mgmtSidebar = appContainer.querySelector<HTMLElement>('.sidebar');
  const mgmtMain = appContainer.querySelector<HTMLElement>('.main-content');
  if (mgmtSidebar && mgmtMain) {
    stashedMgmtDom = {
      kind: detectManagementKind(),
      sidebar: mgmtSidebar,
      mainContent: mgmtMain,
    };
    mgmtSidebar.remove();
    mgmtMain.remove();
  } else {
    stashedMgmtDom = null;
  }

  if (stashedMainDom.sidebar && resizer) resizer.before(stashedMainDom.sidebar);
  if (stashedMainDom.mainContent && resizer) resizer.after(stashedMainDom.mainContent);
  if (stashedMainDom.subagentProgress) {
    appContainer.appendChild(stashedMainDom.subagentProgress);
  }
  if (stashedMainDom.statusBar) shell.appendChild(stashedMainDom.statusBar);

  appContainer.classList.remove('is-api-config', 'is-mcp');
  stashedMainDom = null;

  // 管理页期间会话可能推进。只有内容指纹真变了才强制重建聊天区——
  // 未变时主视图 DOM 原样挂回即是最新，跳过整列表 innerHTML 重建（Win 卡顿主因）。
  const contentChanged = getCurrentChatRenderKey() !== chatKeyAtStash;

  syncSubagentProgressUI();
  remountActiveInteractionPanel();
  shellApi.syncTitlebarActions();
  startMainBalanceBarAutoRefresh();
  if (contentChanged) {
    // 内容已变：重置指纹强制重建一次（管理页期间的 refresh 已把新内容写入渲染缓存，
    // 重建走缓存命中，几乎跳过整条渲染管线）。
    resetChatRenderKey();
    scheduleUiRefresh({ chat: true, sidebar: true });
  } else {
    // 内容未变：保留挂回的 DOM，不重建聊天区。
    // 仅当会话仍在流式时增量恢复流式块（离开期间可能持续推进）。
    scheduleUiRefresh({ sidebar: true });
    const sid = appState.activeConversationId;
    if (sid && appState.streamingBySession.has(sid)) {
      refreshStreamingUI(sid);
    }
  }
  return true;
}
