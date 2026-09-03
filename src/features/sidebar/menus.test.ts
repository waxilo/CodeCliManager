import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import {
  handleConversationListContextMenu,
  closeConversationMenu,
  closeWorkspaceContextMenu,
} from './menus';
import { newChatInWorkspace } from './workspace-grouping';
import { appState } from '../../state';

/** rAF 同步执行，保证菜单定位在 dispatch 后立即可断言 */
function stubRafSync(): void {
  vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => {
    cb(0);
    return 0;
  });
}

function fireContextMenu(target: Element, x: number, y: number): void {
  const ev = new MouseEvent('contextmenu', {
    bubbles: true,
    cancelable: true,
    clientX: x,
    clientY: y,
  });
  target.dispatchEvent(ev);
}

describe('侧边栏右键菜单', () => {
  beforeEach(() => {
    stubRafSync();
    document.body.innerHTML = `
      <div id="conversation-list">
        <div class="conversation-item" data-id="conv-1" data-source-path="/proj/1.jsonl">
          <span class="conversation-row"></span>
        </div>
        <section class="workspace-card" data-workspace-key="/proj">
          <div class="workspace-header" data-action="toggle-workspace" data-workspace="/proj">
            <span class="workspace-main"></span>
          </div>
        </section>
      </div>
    `;
    document
      .querySelector('#conversation-list')!
      .addEventListener('contextmenu', handleConversationListContextMenu);
  });

  afterEach(() => {
    closeConversationMenu();
    closeWorkspaceContextMenu();
    appState.runningSessions.clear();
    appState.streamingBySession.clear();
    appState.activeConversationId = '';
    appState.activeConversationSourcePath = null;
    appState.activePendingSessionKey = '';
    appState.pendingProjectDir = null;
    vi.unstubAllGlobals();
    document.body.innerHTML = '';
  });

  it('会话条目右键弹出会话操作菜单，锚定鼠标位置', () => {
    const item = document.querySelector<HTMLElement>('.conversation-item')!;
    fireContextMenu(item, 120, 80);

    const overlay = document.querySelector<HTMLElement>('.conv-menu-overlay');
    expect(overlay).not.toBeNull();
    const dropdown = overlay!.querySelector<HTMLElement>('.conv-menu-dropdown')!;
    const labels = Array.from(dropdown.querySelectorAll('.conv-menu-item')).map(
      (b) => b.textContent,
    );
    expect(labels).toEqual(['重命名', '导出为 Markdown', '删除']);

    // 菜单项带会话标识，供点击后执行对应操作
    expect(dropdown.querySelector('[data-action="delete"]')?.getAttribute('data-id')).toBe('conv-1');

    expect(dropdown.style.left).toBe('120px');
    expect(dropdown.style.top).toBe('80px');
  });

  it('工作区 header 右键弹出项目菜单（原有行为不回归）', () => {
    const header = document.querySelector<HTMLElement>('.workspace-header')!;
    fireContextMenu(header, 200, 150);

    const overlay = document.querySelector<HTMLElement>('.ws-menu-overlay');
    expect(overlay).not.toBeNull();
    const labels = Array.from(overlay!.querySelectorAll('.conv-menu-item')).map(
      (b) => b.textContent,
    );
    expect(labels).toContain('在此目录新建会话');
    expect(labels).toContain('删除目录下所有会话');

    const dropdown = overlay!.querySelector<HTMLElement>('.ws-menu-dropdown')!;
    expect(dropdown.style.left).toBe('200px');
    expect(dropdown.style.top).toBe('150px');
  });

  it('运行中新建会话不会终止后台会话', async () => {
    appState.activeConversationId = 'conv-running';
    appState.activeConversationSourcePath = '/proj/running.jsonl';
    appState.runningSessions.add('conv-running');
    appState.streamingBySession.set('conv-running', {
      blocks: [{ type: 'text', content: '仍在生成', finalized: false }],
      thinkingDone: true,
      currentBlockIdx: 0,
    });

    await newChatInWorkspace('/other-project');

    expect(appState.runningSessions.has('conv-running')).toBe(true);
    expect(appState.streamingBySession.get('conv-running')?.blocks[0].content).toBe('仍在生成');
    expect(appState.activeConversationId).toBe('');
    expect(appState.activePendingSessionKey).toBe('');
    expect(appState.pendingProjectDir).toBe('/other-project');
    expect(document.querySelector('.confirm-overlay')).toBeNull();
  });

  it('非会话条目 / 非 header 区域右键不弹菜单', () => {
    const list = document.querySelector('#conversation-list')!;
    fireContextMenu(list, 50, 50);

    expect(document.querySelector('.conv-menu-overlay')).toBeNull();
    expect(document.querySelector('.ws-menu-overlay')).toBeNull();
  });
});
