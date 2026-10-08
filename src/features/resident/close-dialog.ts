export type CloseChoice = 'tray' | 'exit';

export interface CloseDialogResult {
  choice: CloseChoice;
  /** 用户勾了「记住我的选择」 */
  remember: boolean;
}

/**
 * 关闭窗口询问弹窗。
 *
 * - 返回 `null` 表示用户取消了关闭（Esc / 点遮罩 / 点取消），窗口应保持打开。
 * - 「记住我的选择」的落盘由调用方处理，弹窗只负责收集意图。
 *
 * 复用 `.confirm-overlay` / `.confirm-dialog` 版式：一是主题一致，
 * 二是设置页等处的 Escape 处理已经把 `.confirm-overlay` 视为「有弹窗打开」。
 */
export function showCloseDialog(): Promise<CloseDialogResult | null> {
  return new Promise((resolve) => {
    const overlay = document.createElement('div');
    overlay.className = 'confirm-overlay';
    overlay.innerHTML = `
      <div class="confirm-dialog confirm-dialog-wide" role="dialog" aria-modal="true" aria-labelledby="resident-close-title">
        <h3 class="confirm-title" id="resident-close-title">关闭 CodeCliManager？</h3>
        <p class="confirm-message">最小化到托盘后，Kiro 代理与后台会话会继续运行。</p>
        <p class="confirm-sub">选「直接退出」会先优雅关闭所有常驻会话与 DSH，再结束进程。</p>
        <label class="resident-remember">
          <input type="checkbox" class="resident-remember-checkbox" />
          <span>记住我的选择（可在托盘右键菜单里改回来）</span>
        </label>
        <div class="confirm-actions">
          <button type="button" class="confirm-btn cancel">取消</button>
          <button type="button" class="confirm-btn danger">直接退出</button>
          <button type="button" class="confirm-btn primary">最小化到托盘</button>
        </div>
      </div>
    `;

    const previouslyFocused =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;

    const cleanup = (result: CloseDialogResult | null) => {
      overlay.remove();
      document.removeEventListener('keydown', onKeydown, true);
      previouslyFocused?.focus();
      resolve(result);
    };

    const decide = (choice: CloseChoice) =>
      cleanup({
        choice,
        remember: Boolean(overlay.querySelector<HTMLInputElement>('.resident-remember-checkbox')?.checked),
      });

    function onKeydown(event: KeyboardEvent) {
      if (event.key !== 'Escape') return;
      // 捕获阶段拦下：避免设置页等处的 Escape 处理连带关闭当前视图
      event.preventDefault();
      event.stopPropagation();
      cleanup(null);
    }

    overlay.querySelector('.confirm-btn.cancel')?.addEventListener('click', () => cleanup(null));
    overlay.querySelector('.confirm-btn.danger')?.addEventListener('click', () => decide('exit'));
    overlay.querySelector('.confirm-btn.primary')?.addEventListener('click', () => decide('tray'));
    overlay.addEventListener('click', (event) => {
      if (event.target === overlay) cleanup(null);
    });
    document.addEventListener('keydown', onKeydown, true);

    document.body.appendChild(overlay);
    overlay.querySelector<HTMLButtonElement>('.confirm-btn.primary')?.focus();
  });
}
