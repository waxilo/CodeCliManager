import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import { appState } from '../../state';
import type { Conversation } from '../../types';

import {
  renderSidebarTabsHtml,
  bindSidebarTabs,
  resetSidebarTabState,
  setActiveSidebarTab,
  getActiveSidebarTab,
  refreshActiveTabContent,
  notifySubagentActivity,
} from './sidebar-tabs';

const HOUR = 3600 * 1000;

function conv(id: string, updatedAt: number): Conversation {
  return {
    id,
    title: `会话-${id}`,
    messages: [],
    platform: 'claude',
    project_dir: '/proj',
    source_path: null,
    created_at: updatedAt - 60 * 1000,
    updated_at: updatedAt,
    context_tokens: null,
    last_model: null,
    usage: null,
  };
}

/** 侧栏 fixture：页签条 + 内容容器 */
function buildDom(): void {
  document.body.innerHTML = `
    <div class="app-container">
      <div class="sidebar is-active">
        <div class="sidebar-header"></div>
        ${renderSidebarTabsHtml()}
        <div class="conversation-list" id="conversation-list"></div>
      </div>
    </div>
  `;
  bindSidebarTabs();
}

describe('侧边栏多视图页签', () => {
  beforeEach(() => {
    localStorage.clear();
    resetSidebarTabState();
    document.body.innerHTML = '';
    appState.conversations = [];
    appState.activeConversationId = '';
    appState.pendingProjectDir = '';
    appState.isApiConfigViewActive = false;
    appState.isSettingsViewActive = false;
    appState.isMcpViewActive = false;
    appState.isKiroViewActive = false;
  });

  it('页签条渲染：活跃会话 + 归档会话 + 子代理三个 tab，角标默认隐藏', () => {
    buildDom();
    const buttons = document.querySelectorAll('.sidebar-tab');
    expect(buttons.length).toBe(3);
    expect(
      Array.from(buttons).map((b) => b.getAttribute('data-tab')),
    ).toEqual(['active', 'archived', 'subagents']);
    const badge = document.querySelector('#subagent-tab-badge') as HTMLElement;
    expect(badge.hidden).toBe(true);
    expect(
      document.querySelector('.sidebar-tab.is-active')?.getAttribute('data-tab'),
    ).toBe('active');
  });

  it('点击页签切换：activeTab 更新、is-active 迁移、内容替换', () => {
    buildDom();
    const subTab = document.querySelector(
      '.sidebar-tab[data-tab="subagents"]',
    ) as HTMLElement;
    subTab.click();

    expect(getActiveSidebarTab()).toBe('subagents');
    expect(
      document.querySelector('.sidebar-tab.is-active')?.getAttribute('data-tab'),
    ).toBe('subagents');
    // 内容容器已替换为子代理 tab 的空态
    expect(document.querySelector('#conversation-list')?.textContent).toContain('暂无子代理');
  });

  it('tab 选择持久化到 localStorage，且重置回默认活跃会话', () => {
    buildDom();
    setActiveSidebarTab('archived');
    expect(localStorage.getItem('codemanager-sidebar-tab')).toBe('archived');

    resetSidebarTabState();
    expect(getActiveSidebarTab()).toBe('active');
  });

  it('旧版 workspace tab 迁移为归档会话', async () => {
    localStorage.setItem('codemanager-sidebar-tab', 'workspace');
    vi.resetModules();
    const mod = await import('./sidebar-tabs');
    expect(mod.getActiveSidebarTab()).toBe('archived');
  });

  it('从 localStorage 恢复上次的 tab', async () => {
    localStorage.setItem('codemanager-sidebar-tab', 'subagents');
    vi.resetModules();
    const mod = await import('./sidebar-tabs');
    expect(mod.getActiveSidebarTab()).toBe('subagents');
  });

  it('子代理自动切换状态机：0→n 自动切到子代理，n→0 切回；手动切换打断恢复', () => {
    buildDom();
    notifySubagentActivity(true);
    expect(getActiveSidebarTab()).toBe('subagents');

    notifySubagentActivity(false);
    expect(getActiveSidebarTab()).toBe('active');

    // 运行中手动切回活跃会话，结束后不被打回子代理
    notifySubagentActivity(true);
    expect(getActiveSidebarTab()).toBe('subagents');
    setActiveSidebarTab('active');
    notifySubagentActivity(false);
    expect(getActiveSidebarTab()).toBe('active');
  });
});

describe('活跃 / 归档会话拆分', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-14T12:00:00Z'));
    localStorage.clear();
    resetSidebarTabState();
    appState.conversations = [];
    appState.activeConversationId = '';
    appState.pendingProjectDir = '';
    appState.isApiConfigViewActive = false;
    appState.isSettingsViewActive = false;
    appState.isMcpViewActive = false;
    appState.isKiroViewActive = false;
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  /** 重建 DOM 并立即按当前 tab 渲染内容 */
  function renderCurrentTab(): void {
    document.body.innerHTML = '';
    buildDom();
    refreshActiveTabContent();
  }

  it('活跃 tab 只列近 24h 更新的会话，按最近更新降序', () => {
    const now = Date.now();
    appState.conversations = [
      conv('old', now - 30 * HOUR),
      conv('newer', now - 2 * HOUR),
      conv('newest', now - 1 * HOUR),
    ];
    renderCurrentTab();
    expect(getActiveSidebarTab()).toBe('active');
    const html = document.querySelector('#conversation-list')!.innerHTML;
    expect(html).toContain('会话-newest');
    expect(html).toContain('会话-newer');
    expect(html).not.toContain('会话-old');
    expect(html.indexOf('会话-newest')).toBeLessThan(html.indexOf('会话-newer'));
  });

  it('归档 tab 只列超过 24h 的会话，按工作区分组展示', () => {
    const now = Date.now();
    appState.conversations = [
      conv('old', now - 30 * HOUR),
      conv('recent', now - 2 * HOUR),
    ];
    buildDom();
    setActiveSidebarTab('archived');
    const html = document.querySelector('#conversation-list')!.innerHTML;
    expect(html).toContain('归档会话');
    expect(html).toContain('会话-old');
    expect(html).not.toContain('会话-recent');
  });

  it('活跃 tab 空态：近一天没有新会话', () => {
    const now = Date.now();
    appState.conversations = [conv('old', now - 30 * HOUR)];
    renderCurrentTab();
    expect(getActiveSidebarTab()).toBe('active');
    expect(document.querySelector('#conversation-list')?.textContent).toContain(
      '近一天没有新会话',
    );
  });

  it('全部为活跃会话时归档 tab 显示「暂无归档会话」', () => {
    const now = Date.now();
    appState.conversations = [conv('recent', now - 1 * HOUR)];
    buildDom();
    setActiveSidebarTab('archived');
    expect(document.querySelector('#conversation-list')?.textContent).toContain(
      '暂无归档会话',
    );
  });

  it('后端秒级 updated_at 同样正确判定活跃/归档（单位归一化）', () => {
    const nowSec = Math.floor(Date.now() / 1000); // 后端 chrono timestamp() 为秒级
    appState.conversations = [
      conv('sec-recent', nowSec - 2 * 3600),
      conv('sec-old', nowSec - 30 * 3600),
    ];
    renderCurrentTab();
    const html = document.querySelector('#conversation-list')!.innerHTML;
    expect(html).toContain('会话-sec-recent');
    expect(html).not.toContain('会话-sec-old');
  });
});
