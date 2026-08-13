import { escapeHtml } from '../../utils';
import { appState } from '../../state';
import { getThemeToggleTitle, getThemeToggleIcon } from '../../ui';
import { shouldShowSettingsUpdateBadge } from '../../features/updates/app-update';
export function renderApiConfigIcon(): string {
  return `
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M4 4h16a1 1 0 0 1 1 1v4a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1zm0 8h16a1 1 0 0 1 1 1v4a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1v-4a1 1 0 0 1 1-1zm2 2.5a1.5 1.5 0 1 0 0 3 1.5 1.5 0 0 0 0-3zm0-8a1.5 1.5 0 1 0 0 3 1.5 1.5 0 0 0 0-3z"/>
    </svg>
  `;
}

export function renderMcpIcon(): string {
  return `
    <svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
      <rect x="2" y="3" width="20" height="14" rx="2"/>
      <line x1="8" y1="21" x2="16" y2="21"/>
      <line x1="12" y1="17" x2="12" y2="21"/>
      <path d="M7 7h2v2H7zM11 7h2v2h-2zM15 7h2v2h-2z"/>
    </svg>
  `;
}

export function renderSettingsIcon(): string {
  return `
    <svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
      <circle cx="12" cy="12" r="3"/>
      <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/>
    </svg>
  `;
}

export function renderKiroIcon(): string {
  return `
    <svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
      <path d="M12 3v3"/>
      <path d="M12 18v3"/>
      <path d="M3 12h3"/>
      <path d="M18 12h3"/>
      <circle cx="12" cy="12" r="4"/>
      <path d="M5.6 5.6 7.7 7.7"/>
      <path d="M16.3 16.3 18.4 18.4"/>
      <path d="M16.3 7.7 18.4 5.6"/>
      <path d="M5.6 18.4 7.7 16.3"/>
    </svg>
  `;
}

export function renderTitlebarActions(): string {
  const settingsTitle = shouldShowSettingsUpdateBadge() ? '设置（有可用更新）' : '设置';
  const showKiro = Boolean(appState.kiroStatus?.available);
  return `
    <button type="button" class="toolbar-settings-btn settings-btn${appState.isApiConfigViewActive ? ' is-active' : ''}" id="api-config-btn" title="管理 Claude Code API 配置" aria-label="API 配置" aria-pressed="${appState.isApiConfigViewActive}">
      <span class="toolbar-settings-btn-icon" aria-hidden="true">${renderApiConfigIcon()}</span>
      <span class="toolbar-settings-btn-label">API 配置</span>
    </button>
    ${showKiro ? `
    <button type="button" class="toolbar-settings-btn settings-btn${appState.isKiroViewActive ? ' is-active' : ''}" id="kiro-proxy-btn" title="${appState.kiroStatus?.running ? 'Kiro 代理运行中' : '管理本机 Kiro 代理'}" aria-label="${appState.kiroStatus?.running ? 'Kiro 代理（运行中）' : 'Kiro 代理'}" aria-pressed="${appState.isKiroViewActive}">
      <span class="toolbar-settings-btn-icon" aria-hidden="true">${renderKiroIcon()}</span>
      <span class="toolbar-settings-btn-label">Kiro 代理</span>
      ${appState.kiroStatus?.running ? '<span class="toolbar-kiro-running-dot" title="运行中" aria-hidden="true"></span>' : ''}
    </button>
    ` : ''}
    <button type="button" class="toolbar-settings-btn settings-btn${appState.isSettingsViewActive ? ' is-active' : ''}" id="settings-btn" title="${escapeHtml(settingsTitle)}" aria-label="${escapeHtml(settingsTitle)}" aria-pressed="${appState.isSettingsViewActive}">
      <span class="toolbar-settings-btn-icon" aria-hidden="true">${renderSettingsIcon()}</span>
      <span class="toolbar-settings-btn-label">设置</span>
      ${shouldShowSettingsUpdateBadge() ? '<span class="toolbar-settings-update-dot" aria-hidden="true"></span>' : ''}
    </button>
    <button type="button" class="toolbar-settings-btn settings-btn mcp-btn${appState.isMcpViewActive ? ' is-active' : ''}" id="mcp-btn" title="管理 Claude Code MCP 服务器" aria-label="MCP 管理" aria-pressed="${appState.isMcpViewActive}">
      <span class="toolbar-settings-btn-icon" aria-hidden="true">${renderMcpIcon()}</span>
      <span class="toolbar-settings-btn-label">MCP</span>
    </button>
    <button type="button" class="toolbar-icon-btn theme-toggle-btn" id="theme-toggle-btn" title="${escapeHtml(getThemeToggleTitle())}" aria-label="${escapeHtml(getThemeToggleTitle())}">
      ${getThemeToggleIcon()}
    </button>
  `;
}

/** 仅刷新标题栏按钮区（避免 Kiro 状态变化时全页 innerHTML 重绘导致 Win 端卡死） */
export function patchTitlebarActions(): boolean {
  const el = document.querySelector('.app-titlebar-actions');
  if (!el) return false;
  el.innerHTML = renderTitlebarActions();
  return true;
}

