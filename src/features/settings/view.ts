import { appState } from '../../state';
import { shouldShowAppUpdateBadge, renderAppUpdateIcon } from '../updates/app-update';
import { shouldShowClaudeUpdateBadge, renderClaudeUpdateIcon } from '../updates/claude-update';
import { renderAppUpdatePopoverBody } from '../updates/app-update';
import { renderClaudeUpdatePopoverBody } from '../updates/claude-update';
import { renderGlobalConfigSectionHtml } from './global-config';
import { renderDshSectionHtml } from '../dsh/settings-section';
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
        <button type="button" class="settings-section-item${appState.settingsSection === 'dsh' ? ' is-active' : ''}" data-settings-section="dsh">
          <span class="settings-section-item-icon">
            <svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <rect x="2" y="4" width="20" height="14" rx="2"/>
              <path d="M8 21h8M12 18v3"/>
            </svg>
          </span>
          <span>DSH 更新</span>
        </button>
        <div class="settings-section-divider" role="separator"></div>
        <button type="button" class="settings-section-item${appState.settingsSection === 'global-config' ? ' is-active' : ''}" data-settings-section="global-config">
          <span class="settings-section-item-icon">
            <svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <path d="M4 6a2 2 0 0 1 2-2h4l2 2h6a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6z"/>
              <path d="M9 14l2 2 4-4"/>
            </svg>
          </span>
          <span>全局 Skills 与提示词</span>
        </button>
      </div>
    </div>
  `;
}

export function renderSettingsViewHtml(): string {
  if (appState.settingsSection === 'claude-update') {
    return `<div class="settings-update-view" id="settings-claude-update-view">${renderClaudeUpdatePopoverBody()}</div>`;
  }
  if (appState.settingsSection === 'global-config') {
    return renderGlobalConfigSectionHtml();
  }
  if (appState.settingsSection === 'dsh') {
    return renderDshSectionHtml();
  }
  return `<div class="settings-update-view" id="settings-app-update-view">${renderAppUpdatePopoverBody()}</div>`;
}

export function getSettingsProfileListEl(): HTMLElement | null {
  return document.querySelector('.settings-profile-list');
}

