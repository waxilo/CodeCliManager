import { describe, expect, it, beforeEach } from 'vitest';
import { showCloseDialog } from './close-dialog';

function mountDialog() {
  const promise = showCloseDialog();
  const overlay = document.querySelector<HTMLElement>('.confirm-overlay');
  if (!overlay) throw new Error('弹窗未挂载');
  return { promise, overlay };
}

/** 真实按键的目标是当前聚焦元素，这里照实模拟，才能验证捕获阶段是否拦得住外层监听。 */
function pressEscape() {
  const target = document.activeElement instanceof HTMLElement ? document.activeElement : document.body;
  target.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
}

describe('关闭询问弹窗', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  it('默认落在「最小化到托盘」上，且未勾选记住', async () => {
    const { overlay } = mountDialog();
    const primary = overlay.querySelector('.confirm-btn.primary');
    expect(primary?.textContent).toBe('最小化到托盘');
    expect(document.activeElement).toBe(primary);
    expect(overlay.querySelector<HTMLInputElement>('.resident-remember-checkbox')?.checked).toBe(false);
  });

  it('点「最小化到托盘」返回 tray 选择', async () => {
    const { promise, overlay } = mountDialog();
    overlay.querySelector<HTMLButtonElement>('.confirm-btn.primary')?.click();
    await expect(promise).resolves.toEqual({ choice: 'tray', remember: false });
    expect(document.querySelector('.confirm-overlay')).toBeNull();
  });

  it('点「直接退出」返回 exit 选择', async () => {
    const { promise, overlay } = mountDialog();
    overlay.querySelector<HTMLButtonElement>('.confirm-btn.danger')?.click();
    await expect(promise).resolves.toEqual({ choice: 'exit', remember: false });
  });

  it('勾选「记住我的选择」后一并带出 remember=true', async () => {
    const { promise, overlay } = mountDialog();
    const checkbox = overlay.querySelector<HTMLInputElement>('.resident-remember-checkbox');
    if (!checkbox) throw new Error('复选框缺失');
    checkbox.checked = true;
    overlay.querySelector<HTMLButtonElement>('.confirm-btn.danger')?.click();
    await expect(promise).resolves.toEqual({ choice: 'exit', remember: true });
  });

  it('点「取消」/ 按 Escape / 点遮罩都返回 null（窗口保持打开）', async () => {
    const cancelActions = [
      (overlay: HTMLElement) => overlay.querySelector<HTMLButtonElement>('.confirm-btn.cancel')?.click(),
      () => pressEscape(),
      (overlay: HTMLElement) => overlay.click(),
    ];
    for (const cancel of cancelActions) {
      document.body.innerHTML = '';
      const { promise, overlay } = mountDialog();
      cancel(overlay);
      await expect(promise).resolves.toBeNull();
      expect(document.querySelector('.confirm-overlay')).toBeNull();
    }
  });

  it('Escape 在捕获阶段被拦下，不再冒泡给外层视图', async () => {
    const { promise } = mountDialog();
    let bubbled = false;
    const onBubble = () => {
      bubbled = true;
    };
    document.addEventListener('keydown', onBubble);
    pressEscape();
    document.removeEventListener('keydown', onBubble);
    await promise;
    expect(bubbled).toBe(false);
  });
});
