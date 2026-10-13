type CloseChoice = 'tray' | 'exit';

/**
 * 关闭窗口询问弹窗。
 *
 * 弹窗只在一件事上不可省略：让用户在「最小化到托盘」与「直接退出」之间做选择。
 * 因此没有「取消」—— Esc 与点遮罩都归为**最小化到托盘**（两害相权取其轻：
 * 误触遮罩不该导致退出流程，而最小化可随时从托盘唤回）。
 *
 * 不提供「记住我的选择」：偏好由托盘右键菜单的「关闭窗口时」子菜单统一管理，
 * 弹窗只负责当次裁决，避免两个入口都能改偏好却互不感知。
 *
 * 复用 `.confirm-overlay` / `.confirm-dialog` 版式：一是主题一致，
 * 二是设置页等处的 Escape 处理已经把 `.confirm-overlay` 视为「有弹窗打开」。
 */
export function showCloseDialog(): Promise<CloseChoice> {
  return new Promise((resolve) => {
    const overlay = document.createElement('div');
    overlay.className = 'confirm-overlay';
    overlay.innerHTML = `
      <div class="confirm-dialog confirm-dialog-wide" role="dialog" aria-modal="true" aria-labelledby="resident-close-title">
        <h3 class="confirm-title" id="resident-close-title">关闭 CodeCliManager？</h3>
        <p class="confirm-message">最小化到托盘后，Kiro 代理与后台会话会继续运行。</p>
        <div class="confirm-actions">
          <button type="button" class="confirm-btn danger">直接退出</button>
          <button type="button" class="confirm-btn primary">最小化到托盘</button>
        </div>
      </div>
    `;

    const previouslyFocused =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;

    const cleanup = (choice: CloseChoice) => {
      overlay.remove();
      document.removeEventListener('keydown', onKeydown, true);
      previouslyFocused?.focus();
      resolve(choice);
    };

    function onKeydown(event: KeyboardEvent) {
      if (event.key !== 'Escape') return;
      // 捕获阶段拦下：避免设置页等处的 Escape 处理连带关闭当前视图
      event.preventDefault();
      event.stopPropagation();
      // Esc 无「取消」语义，归为最安全的一项：不结束进程
      cleanup('tray');
    }

    overlay.querySelector('.confirm-btn.danger')?.addEventListener('click', () => cleanup('exit'));
    overlay.querySelector('.confirm-btn.primary')?.addEventListener('click', () => cleanup('tray'));
    // 点遮罩同样归为最小化到托盘，而不是无声地什么都不做
    overlay.addEventListener('click', (event) => {
      if (event.target === overlay) cleanup('tray');
    });
    document.addEventListener('keydown', onKeydown, true);

    document.body.appendChild(overlay);
    overlay.querySelector<HTMLButtonElement>('.confirm-btn.primary')?.focus();
  });
}
