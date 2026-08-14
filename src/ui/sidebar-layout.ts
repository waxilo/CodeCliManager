const SIDEBAR_WIDTH_STORAGE_KEY = 'codemanager-sidebar-width';
const SIDEBAR_COLLAPSED_STORAGE_KEY = 'codemanager-sidebar-collapsed';
export const DEFAULT_SIDEBAR_WIDTH = 280;
/** 历史默认宽度：命中这些值时视为「用户从未手动调整」，自动迁移到新默认宽度 */
const LEGACY_DEFAULT_SIDEBAR_WIDTHS = [320, 184];
const MIN_SIDEBAR_WIDTH = 240;
const MIN_MAIN_CONTENT_WIDTH = 300;
const SIDEBAR_RESIZER_WIDTH = 4;
/** 窗口宽度低于该值时自动折叠侧边栏（响应式） */
const SIDEBAR_AUTO_COLLAPSE_WIDTH = 880;

let sidebarWidth = DEFAULT_SIDEBAR_WIDTH;
let isSidebarCollapsed = false;
/** 侧边栏当前是否处于「窄窗口自动折叠」状态（区别于用户手动折叠） */
let sidebarAutoCollapsed = false;
/** 上一次判定的窗口宽度区间，用于只在跨越断点时触发自动折叠 */
let sidebarWasNarrow: boolean | null = null;

export function getSidebarWidth(): number {
  return sidebarWidth;
}

export function getIsSidebarCollapsed(): boolean {
  return isSidebarCollapsed;
}

export function loadSidebarWidth(): number {
  try {
    const stored = localStorage.getItem(SIDEBAR_WIDTH_STORAGE_KEY);
    if (stored) {
      const parsed = Number.parseInt(stored, 10);
      if (!Number.isNaN(parsed)) {
        if (LEGACY_DEFAULT_SIDEBAR_WIDTHS.includes(parsed) || parsed < MIN_SIDEBAR_WIDTH) {
          return DEFAULT_SIDEBAR_WIDTH;
        }
        return parsed;
      }
    }
  } catch {
    // ignore invalid storage
  }
  return DEFAULT_SIDEBAR_WIDTH;
}

export function getMaxSidebarWidth(): number {
  const container = document.querySelector('.app-container');
  const containerWidth = container?.clientWidth ?? window.innerWidth;
  return containerWidth - MIN_MAIN_CONTENT_WIDTH - SIDEBAR_RESIZER_WIDTH;
}

export function clampSidebarWidth(width: number): number {
  const maxWidth = Math.max(MIN_SIDEBAR_WIDTH, getMaxSidebarWidth());
  return Math.round(Math.min(Math.max(width, MIN_SIDEBAR_WIDTH), maxWidth));
}

export function applySidebarWidth(width: number) {
  sidebarWidth = clampSidebarWidth(width);
  document.documentElement.style.setProperty('--sidebar-width', `${sidebarWidth}px`);
}

export function saveSidebarWidth(width: number) {
  localStorage.setItem(SIDEBAR_WIDTH_STORAGE_KEY, String(width));
}

export function initSidebarWidth() {
  applySidebarWidth(loadSidebarWidth());
}

export function bindSidebarResizer() {
  // 折叠状态下 resizer 已被 CSS 设为 pointer-events: none，这里仍然绑定，
  // 保证展开后无需重新 render 即可拖拽
  const resizer = document.querySelector('#sidebar-resizer') as HTMLElement | null;
  if (!resizer) return;

  const onPointerMove = (event: PointerEvent) => {
    applySidebarWidth(event.clientX);
  };

  const onPointerUp = (event: PointerEvent) => {
    resizer.releasePointerCapture(event.pointerId);
    resizer.classList.remove('is-dragging');
    document.body.classList.remove('is-sidebar-resizing');
    document.removeEventListener('pointermove', onPointerMove);
    document.removeEventListener('pointerup', onPointerUp);
    saveSidebarWidth(sidebarWidth);
  };

  resizer.addEventListener('pointerdown', (event: PointerEvent) => {
    if (event.button !== 0) return;
    event.preventDefault();
    resizer.setPointerCapture(event.pointerId);
    resizer.classList.add('is-dragging');
    document.body.classList.add('is-sidebar-resizing');
    document.addEventListener('pointermove', onPointerMove);
    document.addEventListener('pointerup', onPointerUp);
  });
}

export function loadSidebarCollapsed(): boolean {
  try {
    return localStorage.getItem(SIDEBAR_COLLAPSED_STORAGE_KEY) === '1';
  } catch {
    return false;
  }
}

export function saveSidebarCollapsed(collapsed: boolean) {
  localStorage.setItem(SIDEBAR_COLLAPSED_STORAGE_KEY, collapsed ? '1' : '0');
}

export function getSidebarToggleTitle(collapsed: boolean = isSidebarCollapsed): string {
  return collapsed ? '展开侧边栏' : '收起侧边栏';
}

export function getSidebarToggleIcon(collapsed: boolean = isSidebarCollapsed): string {
  if (collapsed) {
    return `<svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect width="18" height="18" x="3" y="3" rx="2"/><path d="M9 3v18"/><path d="m14 9 3 3-3 3"/></svg>`;
  }
  return `<svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect width="18" height="18" x="3" y="3" rx="2"/><path d="M9 3v18"/><path d="m16 15-3-3 3-3"/></svg>`;
}

export function updateSidebarToggleButtons() {
  const title = getSidebarToggleTitle();
  for (const btn of document.querySelectorAll<HTMLButtonElement>('.sidebar-toggle-btn')) {
    btn.title = title;
    btn.setAttribute('aria-label', title);
    btn.setAttribute('aria-expanded', String(!isSidebarCollapsed));
    btn.innerHTML = getSidebarToggleIcon();
  }
}

export function syncSidebarCollapsedUI() {
  document.querySelector('.app-container')?.classList.toggle('is-sidebar-collapsed', isSidebarCollapsed);
  updateSidebarToggleButtons();
}

export function setSidebarCollapsed(collapsed: boolean, persist = true) {
  isSidebarCollapsed = collapsed;
  if (persist) saveSidebarCollapsed(collapsed);
  syncSidebarCollapsedUI();
}

export function toggleSidebarCollapsed() {
  // 用户手动操作后放弃自动折叠的接管权，避免窗口变宽时被强行展开。
  sidebarAutoCollapsed = false;
  setSidebarCollapsed(!isSidebarCollapsed);
}

export function initSidebarCollapsed() {
  isSidebarCollapsed = loadSidebarCollapsed();
}

/**
 * 窄窗口自动折叠侧边栏；变宽后自动恢复。
 * 只在跨越断点时干预一次，用户之后的手动展开/折叠不会被覆盖。
 */
export function syncSidebarResponsiveState() {
  const isNarrow = window.innerWidth < SIDEBAR_AUTO_COLLAPSE_WIDTH;
  if (isNarrow === sidebarWasNarrow) return;
  sidebarWasNarrow = isNarrow;

  if (isNarrow) {
    if (!isSidebarCollapsed) {
      sidebarAutoCollapsed = true;
      setSidebarCollapsed(true, false);
    }
    return;
  }

  if (sidebarAutoCollapsed) {
    sidebarAutoCollapsed = false;
    // 恢复到用户持久化的偏好
    setSidebarCollapsed(loadSidebarCollapsed(), false);
  }
}

export function bindSidebarResponsive() {
  window.addEventListener('resize', () => {
    syncSidebarResponsiveState();
    applySidebarWidth(sidebarWidth);
  });
  syncSidebarResponsiveState();
}
