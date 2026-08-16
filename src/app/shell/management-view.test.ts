import { describe, expect, it, beforeEach, vi } from 'vitest';
import { appState } from '../../state';
import {
  enterManagementView,
  exitManagementView,
  clearStashedMainDom,
} from './management-view';
import { syncRunningSubagentsUI } from '../../features/chat/subagent-progress';
import * as refresh from '../../features/chat/refresh';
import type { ActiveToolState } from '../../types';

// 测试不触发真实余额刷新（status-bar 其余导出保持原样，仅替换这一入口）
vi.mock('../../features/status-bar', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../features/status-bar')>();
  return { ...actual, startMainBalanceBarAutoRefresh: vi.fn() };
});

// 避免 mcp 挂载触发的 loadMcpServers() 在 jsdom 下 Tauri invoke 未处理拒绝
vi.mock('../../features/mcp', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../features/mcp')>();
  return { ...actual, mountMcpView: vi.fn(async () => {}) };
});

// 控制内容指纹与指纹重置调用，验证退出时的「内容未变跳过重建 / 内容变化强制重建」
// 门控用的是「已提交内容」指纹（不含工具签名）：工具转态不应触发整列表重建。
vi.mock('../../features/chat/refresh', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../features/chat/refresh')>();
  return {
    ...actual,
    getLastCommittedChatRenderKey: vi.fn(() => 'K'),
    getCurrentCommittedChatRenderKey: vi.fn(() => 'K'),
    resetChatRenderKey: vi.fn(),
  };
});

function buildMainShell(): void {
  document.body.innerHTML = `
    <div id="app">
      <div class="app-shell">
        <header class="app-titlebar">
          <div class="app-titlebar-leading"><button class="toolbar-icon-btn sidebar-toggle-btn" id="sidebar-toggle-btn"></button></div>
          <div class="app-titlebar-drag"></div>
          <div class="app-titlebar-actions"></div>
        </header>
        <div class="app-container">
          <div class="sidebar">
            <div class="sidebar-header">主侧栏</div>
            <div class="conversation-list" id="conversation-list">会话列表</div>
          </div>
          <div class="sidebar-resizer" id="sidebar-resizer"></div>
          <div class="main-content">
            <div class="drop-zone-overlay"></div>
            <div class="main-topbar"></div>
            <div class="message-list" id="message-list">消息</div>
            <div class="input-area"></div>
          </div>
        </div>
        <div id="balance-status-bar" class="balance-status-bar">余额</div>
      </div>
    </div>
  `;
}

describe('management-view 增量进出', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
    appState.isSettingsViewActive = false;
    appState.isApiConfigViewActive = false;
    appState.isMcpViewActive = false;
    appState.activeConversationId = '';
    appState.activeToolsBySession.clear();
    clearStashedMainDom();
    vi.clearAllMocks();
  });

  it('进入管理页摘取主视图并构建管理壳，退出时原节点挂回', () => {
    buildMainShell();
    const mainSidebar = document.querySelector('.sidebar') as HTMLElement;
    const mainContent = document.querySelector('.main-content') as HTMLElement;
    const mainStatusBar = document.querySelector('.balance-status-bar') as HTMLElement;

    enterManagementView('settings');

    // 主视图节点被摘下，不在 DOM
    expect(document.body.contains(mainSidebar)).toBe(false);
    expect(document.body.contains(mainContent)).toBe(false);
    expect(document.body.contains(mainStatusBar)).toBe(false);

    // 管理壳已就位（settings：is-api-config 类 + 设置主区）
    const mgmtSidebar = document.querySelector('.sidebar') as HTMLElement;
    const mgmtMain = document.querySelector('.main-content') as HTMLElement;
    expect(mgmtSidebar.classList.contains('is-api-config')).toBe(true);
    expect(mgmtMain.classList.contains('is-api-config')).toBe(true);
    expect(mgmtMain.querySelector('.settings-update-view')).not.toBeNull();
    expect(mgmtSidebar.querySelector('[data-settings-section]')).not.toBeNull();
    expect(document.querySelector('.app-container')?.classList.contains('is-api-config')).toBe(true);

    // 退出：管理壳移除，主视图原节点挂回（同一引用 → 事件监听天然保留）
    expect(exitManagementView()).toBe(true);
    expect(document.querySelector('.sidebar')).toBe(mainSidebar);
    expect(document.querySelector('.main-content')).toBe(mainContent);
    expect(document.querySelector('.balance-status-bar')).toBe(mainStatusBar);
    expect(document.querySelector('.app-container')?.classList.contains('is-api-config')).toBe(false);
    expect(document.querySelector('.app-container')?.classList.contains('is-mcp')).toBe(false);
    expect(document.querySelector('.settings-update-view')).toBeNull();
  });

  it('挂回后原节点上的事件监听仍然有效（DOM 移动不丢监听）', () => {
    buildMainShell();
    const mainContent = document.querySelector('.main-content') as HTMLElement;
    const clicked = vi.fn();
    mainContent.addEventListener('click', clicked);

    enterManagementView('settings');
    expect(document.body.contains(mainContent)).toBe(false);

    expect(exitManagementView()).toBe(true);
    expect(document.querySelector('.main-content')).toBe(mainContent);

    (document.querySelector('.main-content') as HTMLElement).click();
    expect(clicked).toHaveBeenCalledTimes(1);
  });

  it('右侧子代理面板已移除：有子代理时退出也不产生 #subagent-progress 节点', () => {
    buildMainShell();

    appState.activeConversationId = 'conv-1';
    const task: ActiveToolState = {
      toolUseId: 't1',
      toolName: 'Task',
      input: { description: '子任务' },
      status: 'running',
      startedAt: 1_000,
    };
    appState.activeToolsBySession.set('conv-1', new Map([['t1', task]]));

    expect(document.querySelector('#subagent-progress')).toBeNull();

    enterManagementView('settings');
    expect(exitManagementView()).toBe(true);
    // 子代理由侧栏「子代理」tab 承载，不再挂右侧面板节点
    expect(document.querySelector('#subagent-progress')).toBeNull();
    expect(document.querySelector('.app-container')?.classList.contains('has-subagent-panel')).toBe(false);

    // 无子代理时同步同样不产生任何面板节点
    appState.activeToolsBySession.clear();
    syncRunningSubagentsUI();
    expect(document.querySelector('#subagent-progress')).toBeNull();
  });

  it('无有效 stash（已被全量重绘清空）时回退全量 render 并返回 false', () => {
    buildMainShell();
    clearStashedMainDom();
    expect(exitManagementView()).toBe(false);
  });

  it('同页面二次进入复用缓存管理壳：不重建、DOM 状态保留', () => {
    buildMainShell();
    const mainContent = document.querySelector('.main-content') as HTMLElement;

    appState.isSettingsViewActive = true;
    enterManagementView('settings');
    const settingsView1 = document.querySelector('.settings-update-view') as HTMLElement;
    expect(settingsView1).not.toBeNull();

    // 模拟用户留下的 DOM 状态（输入值 / 滚动等不写入 appState 的现场）
    const marker = document.createElement('div');
    marker.id = 'mgmt-marker';
    settingsView1.appendChild(marker);

    appState.isSettingsViewActive = false;
    expect(exitManagementView()).toBe(true);
    // 退出后管理壳被缓存摘走，主视图挂回
    expect(document.querySelector('.main-content')).toBe(mainContent);
    expect(document.querySelector('.settings-update-view')).toBeNull();

    // 同页面二次进入：直接挂回缓存节点，不重建 innerHTML
    appState.isSettingsViewActive = true;
    enterManagementView('settings');
    const settingsView2 = document.querySelector('.settings-update-view') as HTMLElement;
    expect(settingsView2).toBe(settingsView1); // 同一节点引用
    expect(document.querySelector('#mgmt-marker')).not.toBeNull(); // DOM 现场保留
    expect(document.querySelector('.main-content')).not.toBe(mainContent); // 主视图仍被摘走

    appState.isSettingsViewActive = false;
    expect(exitManagementView()).toBe(true);
    expect(document.querySelector('.main-content')).toBe(mainContent);
  });

  it('切换管理页时丢弃旧缓存并重建（缓存按 kind 隔离）', () => {
    buildMainShell();
    const mainContent = document.querySelector('.main-content') as HTMLElement;

    appState.isSettingsViewActive = true;
    enterManagementView('settings');
    const settingsView = document.querySelector('.settings-update-view') as HTMLElement;
    expect(settingsView).not.toBeNull();

    appState.isSettingsViewActive = false;
    expect(exitManagementView()).toBe(true);
    expect(document.querySelector('.main-content')).toBe(mainContent);

    // 进入不同页面：缓存 kind 不匹配 → 重建
    appState.isMcpViewActive = true;
    enterManagementView('mcp');
    expect(document.querySelector('.settings-update-view')).toBeNull();
    const mgmtMain = document.querySelector('.main-content') as HTMLElement;
    expect(mgmtMain.classList.contains('is-mcp')).toBe(true);
    expect(mgmtMain).not.toBe(mainContent);
    expect(mgmtMain.querySelector('#mcp-view')).not.toBeNull();
  });

  it('管理页互斥切换：settings → mcp 只换管理内容，主视图 stash 保留', () => {
    buildMainShell();
    const mainContent = document.querySelector('.main-content') as HTMLElement;

    enterManagementView('settings');
    expect(document.querySelector('.app-container')?.classList.contains('is-api-config')).toBe(true);

    // settings → mcp 互斥切换（进入 mcp 时 settings 已被 dismiss，flag 仅 mcp）
    appState.isMcpViewActive = true;
    enterManagementView('mcp');
    const mgmtMain = document.querySelector('.main-content') as HTMLElement;
    expect(mgmtMain.classList.contains('is-mcp')).toBe(true);
    expect(document.querySelector('.app-container')?.classList.contains('is-mcp')).toBe(true);
    expect(document.querySelector('.app-container')?.classList.contains('is-api-config')).toBe(false);
    // 主视图仍未挂回
    expect(document.body.contains(mainContent)).toBe(false);

    expect(exitManagementView()).toBe(true);
    expect(document.querySelector('.main-content')).toBe(mainContent);
  });

  it('设置分类切换只换主区内容，不动已 stash 的主视图', () => {
    buildMainShell();
    const mainContent = document.querySelector('.main-content') as HTMLElement;

    appState.isSettingsViewActive = true;
    appState.settingsSection = 'app-update';
    enterManagementView('settings');

    const sectionBtn = document.querySelector('[data-settings-section="claude-update"]') as HTMLElement;
    sectionBtn.click();
    expect(appState.settingsSection).toBe('claude-update');
    // 主区已切成 claude-update 面板
    expect(document.querySelector('#settings-claude-update-view')).not.toBeNull();
    expect(document.querySelector('#settings-app-update-view')).toBeNull();
    // 主视图仍被摘下保存
    expect(document.body.contains(mainContent)).toBe(false);

    appState.isSettingsViewActive = false;
    expect(exitManagementView()).toBe(true);
    expect(document.querySelector('.main-content')).toBe(mainContent);
  });

  it('已提交内容未变时退出不重置聊天指纹（保留挂回 DOM，跳过整列表重建）', () => {
    buildMainShell();
    vi.mocked(refresh.getLastCommittedChatRenderKey).mockReturnValue('K');
    vi.mocked(refresh.getCurrentCommittedChatRenderKey).mockReturnValue('K');

    enterManagementView('settings');
    expect(exitManagementView()).toBe(true);
    expect(refresh.resetChatRenderKey).not.toHaveBeenCalled();
  });

  it('已提交内容变化时退出重置聊天指纹（强制重建到最新内容）', () => {
    buildMainShell();
    vi.mocked(refresh.getLastCommittedChatRenderKey).mockReturnValue('K');
    vi.mocked(refresh.getCurrentCommittedChatRenderKey).mockReturnValue('K2');

    enterManagementView('settings');
    expect(exitManagementView()).toBe(true);
    expect(refresh.resetChatRenderKey).toHaveBeenCalledTimes(1);
  });

  it('运行中会话仅工具转态（提交内容指纹未变）时退出不重建聊天区', () => {
    // 模拟：管理页停留期间工具签名变化，但「已提交内容」指纹保持 K——
    // 门控只看提交内容，工具卡片由增量恢复/下次落盘重建，避免每次退出强制整列表重建。
    buildMainShell();
    vi.mocked(refresh.getLastCommittedChatRenderKey).mockReturnValue('K');
    vi.mocked(refresh.getCurrentCommittedChatRenderKey).mockReturnValue('K');

    appState.activeConversationId = 'conv-1';
    appState.runningSessions.add('conv-1');

    enterManagementView('settings');
    expect(exitManagementView()).toBe(true);
    expect(refresh.resetChatRenderKey).not.toHaveBeenCalled();
  });
});
