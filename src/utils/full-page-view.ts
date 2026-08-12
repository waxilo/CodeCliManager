/**
 * 全屏管理页（API / Settings / MCP）的 open / dismiss / close / escape / mountToken 共用模式。
 */
export interface FullPageViewController {
  isActive: () => boolean;
  setActive: (v: boolean) => void;
  getMountToken: () => number;
  bumpMountToken: () => number;
  getEscapeHandler: () => ((event: KeyboardEvent) => void) | null;
  setEscapeHandler: (h: ((event: KeyboardEvent) => void) | null) => void;
  onDismissExtra?: () => void;
}

export function dismissFullPageView(ctrl: FullPageViewController): void {
  if (!ctrl.isActive() && !ctrl.getEscapeHandler()) return;
  const handler = ctrl.getEscapeHandler();
  if (handler) {
    document.removeEventListener('keydown', handler);
    ctrl.setEscapeHandler(null);
  }
  ctrl.bumpMountToken();
  ctrl.onDismissExtra?.();
  ctrl.setActive(false);
}

export function registerFullPageEscape(
  ctrl: FullPageViewController,
  onEscape: (event: KeyboardEvent) => void
): void {
  const prev = ctrl.getEscapeHandler();
  if (prev) document.removeEventListener('keydown', prev);
  ctrl.setEscapeHandler(onEscape);
  document.addEventListener('keydown', onEscape);
}
