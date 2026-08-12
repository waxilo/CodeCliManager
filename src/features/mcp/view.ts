import { appState } from '../../state';
import { escapeHtml } from '../../utils';
export function renderMcpViewHtml(): string {
  return `
    <div class="mcp-view" id="mcp-view">
      <div class="settings-header mcp-view-header">
        <div>
          <h3 class="settings-title">MCP 服务器管理</h3>
          <p class="settings-subtitle">管理 Claude Code 用户级 MCP 服务器，配置写入 ~/.claude.json</p>
        </div>
        <button type="button" class="settings-close-btn" aria-label="返回聊天">✕</button>
      </div>
      <div class="mcp-toolbar">
        <button type="button" class="settings-btn-primary mcp-add-btn" id="mcp-add-btn">+ 添加服务器</button>
        <span class="mcp-config-path" title="${escapeHtml(appState.mcpConfigPath)}">${escapeHtml(appState.mcpConfigPath ? `配置文件：${appState.mcpConfigPath}` : '')}</span>
      </div>
      <div class="mcp-list" id="mcp-list">
        <div class="mcp-loading">加载中…</div>
      </div>
    </div>
  `;
}

