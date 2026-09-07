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
    appState.isSkillsViewActive = false;
    appState.isKiroViewActive = false;
  });

  it('页签条渲染：活跃会话 + 归档会话两个 tab（子代理 tab 已移除）', () => {
    buildDom();
    const buttons = document.querySelectorAll('.sidebar-tab');
    expect(buttons.length).toBe(2);
    expect(
      Array.from(buttons).map((b) => b.getAttribute('data-tab')),
    ).toEqual(['active', 'archived']);
    expect(document.querySelector('#subagent-tab-badge')).toBeNull();
    expect(
      document.querySelector('.sidebar-tab.is-active')?.getAttribute('data-tab'),
    ).toBe('active');
  });

  it('点击页签切换：activeTab 更新、is-active 迁移、内容替换', () => {
    buildDom();
    const archTab = document.querySelector(
      '.sidebar-tab[data-tab="archived"]',
    ) as HTMLElement;
    archTab.click();

    expect(getActiveSidebarTab()).toBe('archived');
    expect(
      document.querySelector('.sidebar-tab.is-active')?.getAttribute('data-tab'),
    ).toBe('archived');
    // 内容容器已替换为归档会话视图（无会话时为空态）
    expect(document.querySelector('#conversation-list')?.textContent).toContain('还没有会话');
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

  it('旧版 subagents tab（已移除）迁移为活跃会话', async () => {
    localStorage.setItem('codemanager-sidebar-tab', 'subagents');
    vi.resetModules();
    const mod = await import('./sidebar-tabs');
    expect(mod.getActiveSidebarTab()).toBe('active');
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
    appState.isSkillsViewActive = false;
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

  it('24h 内不足 10 条时，活跃 tab 补足最近 10 条并按更新时间降序', () => {
    const now = Date.now();
    appState.conversations = Array.from({ length: 12 }, (_, index) =>
      conv(`item-${index}`, now - (index + 1) * 6 * HOUR),
    );
    renderCurrentTab();
    expect(getActiveSidebarTab()).toBe('active');
    const html = document.querySelector('#conversation-list')!.innerHTML;
    expect(html).toContain('10 个会话');
    expect(html).toContain('会话-item-0');
    expect(html).toContain('会话-item-9');
    expect(html).not.toContain('会话-item-10');
    expect(html.indexOf('会话-item-0')).toBeLessThan(html.indexOf('会话-item-9'));
  });

  it('24h 内超过 10 条时，活跃 tab 展示 24h 内的全部会话', () => {
    const now = Date.now();
    appState.conversations = [
      ...Array.from({ length: 11 }, (_, index) =>
        conv(`recent-${index}`, now - (index + 1) * HOUR),
      ),
      conv('old', now - 30 * HOUR),
    ];
    renderCurrentTab();
    const html = document.querySelector('#conversation-list')!.innerHTML;
    expect(html).toContain('11 个会话');
    expect(html).toContain('会话-recent-10');
    expect(html).not.toContain('会话-old');
  });

  it('活跃 tab 按文件夹分组展示：不同工作区各成一卡', () => {
    const now = Date.now();
    appState.conversations = [
      conv('a', now - 1 * HOUR),
      { ...conv('b', now - 1 * HOUR), project_dir: '/other' },
    ];
    renderCurrentTab();
    expect(getActiveSidebarTab()).toBe('active');
    const html = document.querySelector('#conversation-list')!.innerHTML;
    // 工作区显示名来自 project_dir 末段
    expect(html).toContain('proj');
    expect(html).toContain('other');
    // 两个会话分别挂在各自文件夹卡片下
    expect(html).toContain('会话-a');
    expect(html).toContain('会话-b');
    expect(document.querySelectorAll('.workspace-card').length).toBe(2);
  });

  it('归档 tab 只列活跃集合之外的会话，补入的最近 10 条不重复出现', () => {
    const now = Date.now();
    appState.conversations = Array.from({ length: 12 }, (_, index) =>
      conv(`item-${index}`, now - (index + 1) * 6 * HOUR),
    );
    buildDom();
    setActiveSidebarTab('archived');
    const html = document.querySelector('#conversation-list')!.innerHTML;
    expect(html).toContain('归档会话');
    expect(html).toContain('会话-item-10');
    expect(html).toContain('会话-item-11');
    expect(html).not.toContain('会话-item-9');
  });

  it('活跃 tab 空态：没有任何会话', () => {
    renderCurrentTab();
    expect(getActiveSidebarTab()).toBe('active');
    expect(document.querySelector('#conversation-list')?.textContent).toContain('还没有会话');
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
    const nowSec = Math.floor(Date.now() / 1000);
    appState.conversations = [
      ...Array.from({ length: 11 }, (_, index) =>
        conv(`sec-recent-${index}`, nowSec - (index + 1) * 3600),
      ),
      conv('sec-old', nowSec - 30 * 3600),
    ];
    renderCurrentTab();
    const html = document.querySelector('#conversation-list')!.innerHTML;
    expect(html).toContain('会话-sec-recent-10');
    expect(html).not.toContain('会话-sec-old');
  });

  it('工作区卡片右端状态：无运行会话显示数量，有运行会话显示「运行中」', () => {
    const now = Date.now();
    appState.runningSessions.clear();
    appState.conversations = [conv('a', now - 1 * HOUR), conv('b', now - 1 * HOUR)];
    renderCurrentTab();

    let badge = document.querySelector<HTMLElement>('.workspace-count')!;
    expect(badge.textContent).toBe('2');
    expect(badge.classList.contains('is-live')).toBe(false);

    // 出现运行中会话：右端状态切换为「运行中」并带 is-live 徽标
    appState.runningSessions.add('a');
    renderCurrentTab();
    badge = document.querySelector<HTMLElement>('.workspace-count')!;
    expect(badge.textContent).toBe('运行中');
    expect(badge.classList.contains('is-live')).toBe(true);
  });
});
