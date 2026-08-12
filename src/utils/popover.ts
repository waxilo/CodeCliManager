/**
 * 将弹层挂到 body，点击遮罩或关闭按钮时移除。
 * @returns cleanup 函数
 */
export function mountPopover(options: {
  overlayClass: string;
  html: string;
  onClose?: () => void;
}): { overlay: HTMLElement; cleanup: () => void } {
  document.querySelector(`.${options.overlayClass}`)?.remove();
  const overlay = document.createElement('div');
  overlay.className = options.overlayClass;
  overlay.innerHTML = options.html;
  const cleanup = () => {
    overlay.remove();
    options.onClose?.();
  };
  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) cleanup();
  });
  document.body.appendChild(overlay);
  return { overlay, cleanup };
}
