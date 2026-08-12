import { escapeHtml } from '../utils/escape-html';

export function showCopyToastMsg(msg: string): void {
  const existing = document.querySelector('.copy-toast');
  if (existing) existing.remove();

  const toast = document.createElement('div');
  toast.className = 'copy-toast';
  toast.innerHTML = `
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
      <polyline points="20 6 9 17 4 12"/>
    </svg>
    ${escapeHtml(msg)}
  `;
  document.body.appendChild(toast);

  requestAnimationFrame(() => {
    toast.classList.add('copy-toast--visible');
  });

  setTimeout(() => {
    toast.classList.remove('copy-toast--visible');
    setTimeout(() => toast.remove(), 300);
  }, 2000);
}
