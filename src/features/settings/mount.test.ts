import { describe, expect, it, beforeEach } from 'vitest';
import { appState } from '../../state';
import { mountSettingsView } from './mount';

describe('设置页 Escape 处理', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
    appState.isSettingsViewActive = false;
  });

  it('无确认弹窗时 Escape 关闭设置页', () => {
    appState.isSettingsViewActive = true;
    mountSettingsView();
    document.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }),
    );
    expect(appState.isSettingsViewActive).toBe(false);
  });

  it('确认弹窗打开时 Escape 不关闭设置页（由弹窗自身处理）', () => {
    appState.isSettingsViewActive = true;
    mountSettingsView();
    const overlay = document.createElement('div');
    overlay.className = 'confirm-overlay';
    document.body.appendChild(overlay);
    document.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }),
    );
    expect(appState.isSettingsViewActive).toBe(true);
    expect(document.querySelector('.confirm-overlay')).not.toBeNull();
  });
});
