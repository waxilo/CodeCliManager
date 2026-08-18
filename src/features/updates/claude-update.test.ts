import { describe, expect, it, beforeEach } from 'vitest';
import { appState } from '../../state';
import {
  renderSettingsUpdateSectionIfOpen,
  refreshClaudeUpdatePopoverIfOpen,
  renderClaudeUpdatePopoverBody,
  bindClaudeUpdatePopoverEvents,
} from './claude-update';

describe('claude 更新弹层按钮（重建后事件不丢失）', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
    appState.claudeUpdateCheckStatus = 'idle';
    appState.claudeUpdateInfo = null;
    appState.claudeUpdateError = null;
    appState.claudeUpdateProgressText = '';
    appState.isSettingsViewActive = false;
    appState.settingsSection = 'app-update';
  });

  it('设置页渲染后「重新检查」可点击（委托绑定生效）', async () => {
    document.body.innerHTML = '<div class="settings-update-view" id="settings-claude-update-view"></div>';
    appState.isSettingsViewActive = true;
    appState.settingsSection = 'claude-update';
    renderSettingsUpdateSectionIfOpen();

    const view = document.querySelector('#settings-claude-update-view')!;
    const recheck = view.querySelector<HTMLButtonElement>('[data-action="recheck"]')!;
    expect(recheck).not.toBeNull();
    recheck.click();
    // handler 同步执行：进入 checking（随后 invoke 在无 Tauri 环境失败为 error，异步）
    expect(appState.claudeUpdateCheckStatus).toBe('checking');
    // 让异步 catch 跑完，避免悬挂
    await new Promise((r) => setTimeout(r, 20));
  });

  it('innerHTML 重建（refresh）后按钮事件不丢失', async () => {
    document.body.innerHTML = '<div class="settings-update-view" id="settings-claude-update-view"></div>';
    appState.isSettingsViewActive = true;
    appState.settingsSection = 'claude-update';
    renderSettingsUpdateSectionIfOpen();

    // 模拟检查完成/进度事件触发的重建
    refreshClaudeUpdatePopoverIfOpen();
    const view = document.querySelector('#settings-claude-update-view')!;
    const recheck = view.querySelector<HTMLButtonElement>('[data-action="recheck"]')!;
    expect(recheck).not.toBeNull();
    recheck.click();
    expect(appState.claudeUpdateCheckStatus).toBe('checking');
    await new Promise((r) => setTimeout(r, 20));
  });

  it('npm 镜像输入框 input 走委托，边输入边保存（重建不丢值）', () => {
    const host = document.createElement('div');
    host.innerHTML = renderClaudeUpdatePopoverBody();
    bindClaudeUpdatePopoverEvents(host);
    const input = host.querySelector<HTMLInputElement>('#claude-update-registry')!;
    input.value = 'https://registry.npmmirror.com';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    expect(localStorage.getItem('codemanager-npm-registry')).toBe('https://registry.npmmirror.com');
    localStorage.clear();
  });
});
