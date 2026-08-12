import { appState } from '../../state';
import { shouldShowAppUpdateBadge, renderAppUpdateIcon } from '../updates/app-update';
import { shouldShowClaudeUpdateBadge, renderClaudeUpdateIcon } from '../updates/claude-update';
import { renderAppUpdatePopoverBody } from '../updates/app-update';
import { renderClaudeUpdatePopoverBody } from '../updates/claude-update';
export function renderApiConfigSidebarHtml(): string {
  return `
    <div class="api-config-sidebar settings-sidebar">
      <div class="settings-profiles-header">
        <span>已保存配置</span>
        <span class="settings-profiles-hint">左键查看 · 右键应用 / 删除</span>
      </div>
      <div class="settings-profile-list"></div>
      <div class="api-config-sidebar-actions">
        <button type="button" class="settings-add-profile">+ 新建</button>
        <button type="button" class="settings-import-cc-switch">从 CC Switch 导入</button>
      </div>
    </div>
  `;
}

export function renderSettingsSidebarHtml(): string {
  return `
    <div class="api-config-sidebar settings-sidebar">
      <div class="settings-section-nav" role="navigation" aria-label="设置分类">
        <button type="button" class="settings-section-item${appState.settingsSection === 'app-update' ? ' is-active' : ''}" data-settings-section="app-update">
          <span class="settings-section-item-icon">${renderAppUpdateIcon()}</span>
          <span>CCM 更新</span>
          ${shouldShowAppUpdateBadge() ? '<span class="settings-section-item-dot" aria-label="有更新"></span>' : ''}
        </button>
        <button type="button" class="settings-section-item${appState.settingsSection === 'claude-update' ? ' is-active' : ''}" data-settings-section="claude-update">
          <span class="settings-section-item-icon">${renderClaudeUpdateIcon()}</span>
          <span>Claude Code 更新</span>
          ${shouldShowClaudeUpdateBadge() ? '<span class="settings-section-item-dot" aria-label="有更新"></span>' : ''}
        </button>
      </div>
    </div>
  `;
}

export function renderSettingsViewHtml(): string {
  if (appState.settingsSection === 'claude-update') {
    return `<div class="settings-update-view" id="settings-claude-update-view">${renderClaudeUpdatePopoverBody()}</div>`;
  }
  return `<div class="settings-update-view" id="settings-app-update-view">${renderAppUpdatePopoverBody()}</div>`;
}

export function getSettingsProfileListEl(): HTMLElement | null {
  return document.querySelector('.settings-profile-list');
}

