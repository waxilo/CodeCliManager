import { escapeHtml } from '../utils/escape-html';

export type ToastVariant = 'success' | 'error';

const TOAST_ICONS: Record<ToastVariant, string> = {
  success: `
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
      <polyline points="20 6 9 17 4 12"/>
    </svg>`,
  error: `
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
      <line x1="18" y1="6" x2="6" y2="18"/>
      <line x1="6" y1="6" x2="18" y2="18"/>
    </svg>`,
};

/**
 * 通用 toast。默认错误样式（用于替代原生 alert），成功提示用 success 变体。
 * 同一时刻只显示一条，新 toast 顶掉旧 toast。
 */
export function showToast(
  msg: string,
  variant: ToastVariant = 'error',
  duration = 2500,
): void {
  const existing = document.querySelector('.copy-toast');
  if (existing) existing.remove();

  const toast = document.createElement('div');
  toast.className = variant === 'error' ? 'copy-toast copy-toast--error' : 'copy-toast';
  toast.innerHTML = `${TOAST_ICONS[variant]}${escapeHtml(msg)}`;
  document.body.appendChild(toast);

  requestAnimationFrame(() => {
    toast.classList.add('copy-toast--visible');
  });

  setTimeout(() => {
    toast.classList.remove('copy-toast--visible');
    setTimeout(() => toast.remove(), 300);
  }, duration);
}

/** 成功提示（复制、保存成功等），保持旧 API 不变。 */
export function showCopyToastMsg(msg: string): void {
  showToast(msg, 'success', 2000);
}
