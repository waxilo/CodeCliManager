import { isTauri } from '@tauri-apps/api/core';
import { getCurrentWindow, type Window } from '@tauri-apps/api/window';

/**
 * 自绘窗口控制按钮（最小化 / 最大化-还原 / 关闭）。
 *
 * 为什么是自绘：Windows 上原生窗口装饰（标题栏 + 系统按钮）已由 Rust 侧
 * `window::apply_undecorated` 取消，三个入口改在这里实现，样式与标题栏其它图标按钮一致。
 *
 * 只在「Windows + Tauri 运行时」渲染，两个条件缺一不可：
 * - macOS 保留原生红绿灯（平台惯例，且标题栏为它预留了左侧留白）；
 * - 浏览器里 `isTauri()` 为 false —— dev 时用 Chrome 打开，UA 同样含 "win"，
 *   光看 `platform-windows` 会把按钮渲染出来，一点就抛错。
 */
export function shouldRenderWindowControls(): boolean {
  if (typeof document === 'undefined') return false;
  if (!document.documentElement.classList.contains('platform-windows')) return false;
  return isTauri();
}

/* 图标沿用标题栏既有语言：24 视图框、2px 描边、currentColor，尺寸交给 CSS 收敛到 16px */
const ICON_MINIMIZE = `
  <svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round">
    <line x1="5" y1="12" x2="19" y2="12"/>
  </svg>
`;

const ICON_MAXIMIZE = `
  <svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round">
    <rect x="5" y="5" width="14" height="14" rx="2"/>
  </svg>
`;

const ICON_RESTORE = `
  <svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round">
    <rect x="4" y="8" width="12" height="12" rx="2"/>
    <path d="M8.5 8V6a2 2 0 0 1 2-2h7a2 2 0 0 1 2 2v7a2 2 0 0 1-2 2h-2"/>
  </svg>
`;

const ICON_CLOSE = `
  <svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round">
    <line x1="6.5" y1="6.5" x2="17.5" y2="17.5"/>
    <line x1="17.5" y1="6.5" x2="6.5" y2="17.5"/>
  </svg>
`;

/**
 * 渲染窗口控制容器；不可用时返回空串（调用方直接插值即可，无需再判一次）。
 *
 * 两个图标都放进 DOM，靠 `is-maximized` 类切换显隐 —— 避免在状态同步时改 innerHTML。
 */
export function renderWindowControls(): string {
  if (!shouldRenderWindowControls()) return '';
  return `
    <div class="app-titlebar-window-controls">
      <button type="button" class="window-control-btn" id="window-min-btn" title="最小化" aria-label="最小化窗口">
        ${ICON_MINIMIZE}
      </button>
      <button type="button" class="window-control-btn" id="window-max-btn" title="最大化" aria-label="最大化窗口">
        <span class="wc-icon-max">${ICON_MAXIMIZE}</span>
        <span class="wc-icon-restore">${ICON_RESTORE}</span>
      </button>
      <button type="button" class="window-control-btn window-control-close" id="window-close-btn" title="关闭" aria-label="关闭窗口">
        ${ICON_CLOSE}
      </button>
    </div>
  `;
}

/** 窗口实例与「窗口级 resize 监听」只建一次；按钮点击则每次全量重绘后都要重绑（节点是新的）。 */
let appWindow: Window | null = null;
let resizedListenerAttached = false;

function currentWindow(): Window {
  if (!appWindow) appWindow = getCurrentWindow();
  return appWindow;
}

/** 按当前最大化状态切换「最大化 / 还原」图标与提示文案 */
async function syncMaximizeState(win: Window, maxBtn: HTMLElement): Promise<void> {
  try {
    const maximized = await win.isMaximized();
    maxBtn.classList.toggle('is-maximized', maximized);
    const label = maximized ? '还原' : '最大化';
    maxBtn.setAttribute('title', label);
    maxBtn.setAttribute('aria-label', `${label}窗口`);
  } catch {
    // 窗口可能正在关闭，读状态失败不影响其它操作
  }
}

/**
 * 绑定窗口控制事件。
 *
 * 两层守卫，职责不同：
 * - 节点级 `dataset.bound`：全量 render 会重建容器（无标记 ⇒ 自然重绑），
 *   但同一节点若被重复绑定就会叠加监听 —— 与 `#conversation-list` 用的是同一套防御。
 * - `resizedListenerAttached`：`onResized` 是窗口级监听、不随 DOM 重建，
 *   必须在模块内只挂一次，否则每次重绘都多留一个。
 */
export function bindWindowControls(): void {
  if (!shouldRenderWindowControls()) return;

  const container = document.querySelector<HTMLElement>('.app-titlebar-window-controls');
  if (!container) return;
  if (container.dataset.bound === '1') return;
  container.dataset.bound = '1';

  const minBtn = container.querySelector<HTMLButtonElement>('#window-min-btn');
  const maxBtn = container.querySelector<HTMLButtonElement>('#window-max-btn');
  const closeBtn = container.querySelector<HTMLButtonElement>('#window-close-btn');
  if (!minBtn || !maxBtn || !closeBtn) return;

  const win = currentWindow();

  minBtn.addEventListener('click', () => {
    void win.minimize();
  });
  maxBtn.addEventListener('click', () => {
    void win.toggleMaximize();
  });
  // 关闭必须走 close()：它会发出 CloseRequested，交给常驻模块决定
  //「最小化到托盘 / 直接退出 / 询问」，与点原生关闭完全同一条路径。
  // 不要换成 destroy() —— 那会绕过常驻逻辑直接销毁窗口。
  closeBtn.addEventListener('click', () => {
    void win.close();
  });

  // 新节点没有状态类，先按当前状态补一次图标与文案
  void syncMaximizeState(win, maxBtn);

  if (!resizedListenerAttached) {
    resizedListenerAttached = true;
    // 最大化/还原都会触发 resize；读状态比猜测事件来源可靠
    void win.onResized(() => {
      const btn = document.querySelector<HTMLElement>('#window-max-btn');
      if (btn) void syncMaximizeState(win, btn);
    });
  }
}
