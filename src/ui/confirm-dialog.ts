import { escapeHtml } from '../utils/escape-html';

export interface ConfirmDialogOptions {
  title: string;
  message: string;
  sub?: string;
  confirmLabel?: string;
}

export function showConfirmDialog(options: ConfirmDialogOptions): Promise<boolean> {
  return new Promise((resolve) => {
    const overlay = document.createElement('div');
    overlay.className = 'confirm-overlay';
    overlay.innerHTML = `
      <div class="confirm-dialog" role="dialog" aria-modal="true">
        <h3 class="confirm-title">${escapeHtml(options.title)}</h3>
        <p class="confirm-message">${options.message}</p>
        ${options.sub ? `<p class="confirm-sub">${escapeHtml(options.sub)}</p>` : ''}
        <div class="confirm-actions">
          <button type="button" class="confirm-btn cancel">取消</button>
          <button type="button" class="confirm-btn danger">${escapeHtml(options.confirmLabel || '确认')}</button>
        </div>
      </div>
    `;

    const cleanup = (result: boolean) => {
      overlay.remove();
      resolve(result);
    };

    overlay.querySelector('.confirm-btn.cancel')?.addEventListener('click', () => cleanup(false));
    overlay.querySelector('.confirm-btn.danger')?.addEventListener('click', () => cleanup(true));
    overlay.addEventListener('click', (event) => {
      if (event.target === overlay) cleanup(false);
    });

    document.body.appendChild(overlay);
    (overlay.querySelector('.confirm-btn.danger') as HTMLButtonElement | null)?.focus();
  });
}

export function showDeleteConfirm(title: string): Promise<boolean> {
  return showConfirmDialog({
    title: '删除会话',
    message: `确定要删除「${escapeHtml(title)}」吗？`,
    sub: '此操作将永久删除本地会话记录，且不可恢复。',
    confirmLabel: '删除',
  });
}
