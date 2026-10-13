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

  it('只有两个按钮：直接退出 + 最小化到托盘，默认聚焦较安全的一项', () => {
    const { overlay } = mountDialog();
    const buttons = [...overlay.querySelectorAll('.confirm-btn')];
    expect(buttons.map((b) => b.textContent)).toEqual(['直接退出', '最小化到托盘']);
    expect(overlay.querySelector('.confirm-btn.cancel')).toBeNull();
    expect(document.activeElement).toBe(overlay.querySelector('.confirm-btn.primary'));
  });

  it('不提供「记住我的选择」复选框，也不再有第二行进程说明', () => {
    const { overlay } = mountDialog();
    expect(overlay.querySelector('.resident-remember-checkbox')).toBeNull();
    expect(overlay.querySelector('.confirm-sub')).toBeNull();
  });

  it('点「最小化到托盘」返回 tray', async () => {
    const { promise, overlay } = mountDialog();
    overlay.querySelector<HTMLButtonElement>('.confirm-btn.primary')?.click();
    await expect(promise).resolves.toBe('tray');
    expect(document.querySelector('.confirm-overlay')).toBeNull();
  });

  it('点「直接退出」返回 exit', async () => {
    const { promise, overlay } = mountDialog();
    overlay.querySelector<HTMLButtonElement>('.confirm-btn.danger')?.click();
    await expect(promise).resolves.toBe('exit');
    expect(document.querySelector('.confirm-overlay')).toBeNull();
  });

  it('Escape 与点遮罩都归为「最小化到托盘」，不会误触退出', async () => {
    const dismissals = [
      () => pressEscape(),
      (overlay: HTMLElement) => overlay.click(),
    ];
    for (const dismiss of dismissals) {
      document.body.innerHTML = '';
      const { promise, overlay } = mountDialog();
      dismiss(overlay);
      await expect(promise).resolves.toBe('tray');
      expect(document.querySelector('.confirm-overlay')).toBeNull();
    }
  });

  it('弹窗永不 resolve 为 null —— 没有「什么都不做」的逃逸路径', async () => {
    const { promise, overlay } = mountDialog();
    overlay.querySelector<HTMLButtonElement>('.confirm-btn.primary')?.click();
    const result = await promise;
    expect(result).not.toBeNull();
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
