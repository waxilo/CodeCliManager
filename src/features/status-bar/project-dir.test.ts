import { describe, expect, it, beforeEach } from 'vitest';
import { appState } from '../../state';
import { syncActiveProjectDir, syncStatusBarSections } from './balance';

function mountBar(): void {
  document.body.innerHTML = `
    <div id="balance-status-bar" class="balance-status-bar">
      <span class="status-bar-dir" data-status-dir hidden>
        <span class="balance-status-bar-label">目录</span>
        <span class="status-bar-dir-value" data-project-dir></span>
      </span>
      <span class="status-bar-divider" data-status-divider="1" hidden></span>
      <span class="status-bar-git" hidden></span>
      <span class="status-bar-divider" data-status-divider="2" hidden></span>
      <span class="status-bar-balance" hidden></span>
    </div>`;
}

describe('底栏工作目录', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
    appState.conversations = [];
    appState.activeConversationId = '';
    appState.activeConversationSourcePath = null;
    appState.pendingProjectDir = '';
    appState.activeProjectDirCache = null;
  });

  it('点击会话后显示其工作目录', () => {
    mountBar();
    appState.conversations = [
      { id: 'c1', title: 't', platform: 'claude', messages: [], project_dir: '/proj/a', created_at: 1, updated_at: 1, source_path: null },
    ];
    appState.activeConversationId = 'c1';
    syncActiveProjectDir();
    const dirEl = document.querySelector('[data-project-dir]')!;
    expect(dirEl.textContent).toBe('/proj/a');
    expect(document.querySelector('.status-bar-dir')!.hasAttribute('hidden')).toBe(false);
  });

  it('pending 新会话：显示待选目录', () => {
    mountBar();
    appState.activeConversationId = '';
    appState.pendingProjectDir = '/proj/new';
    syncActiveProjectDir();
    const dirEl = document.querySelector('[data-project-dir]')!;
    expect(dirEl.textContent).toBe('/proj/new');
  });

  it('无会话且无待选目录：目录 section 隐藏', () => {
    mountBar();
    syncActiveProjectDir();
    const dirWrap = document.querySelector('.status-bar-dir')!;
    expect(dirWrap.hasAttribute('hidden')).toBe(true);
  });

  it('divider 只在可见相邻 section 之间显示', () => {
    mountBar();
    appState.conversations = [
      { id: 'c1', title: 't', platform: 'claude', messages: [], project_dir: '/proj/a', created_at: 1, updated_at: 1, source_path: null },
    ];
    appState.activeConversationId = 'c1';
    appState.gitBranchCache = { branch: 'main', projectDir: '/proj/a' };
    syncActiveProjectDir();
    syncStatusBarSections();
    const d1 = document.querySelector('[data-status-divider="1"]')!;
    const d2 = document.querySelector('[data-status-divider="2"]')!;
    expect(d1.hasAttribute('hidden')).toBe(false); // 目录+分支 都可见
    expect(d2.hasAttribute('hidden')).toBe(true); // 余额不可见
    appState.mainBalanceCache = { profileId: 'p', label: '余额', value: '10' };
    syncStatusBarSections();
    expect(d2.hasAttribute('hidden')).toBe(false);
  });
});
