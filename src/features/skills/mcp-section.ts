import { appState } from '../../state';
import { escapeHtml } from '../../utils';

/** 「技能」页 MCP 分区：服务器列表 + 添加/导入入口 */
export function renderMcpSectionHtml(): string {
  return `
    <div class="settings-update-view mcp-section" id="skills-mcp-section">
      <div class="mcp-toolbar">
        <div class="mcp-toolbar-actions">
          <button type="button" class="settings-btn-primary mcp-add-btn" id="mcp-add-btn">+ 添加服务器</button>
          <button type="button" class="mcp-import-btn" id="mcp-import-btn" title="粘贴 Claude Code 格式的 mcpServers JSON 批量导入">导入 JSON</button>
        </div>
        <span class="mcp-config-path" title="${escapeHtml(appState.mcpConfigPath)}">${escapeHtml(appState.mcpConfigPath ? `配置文件：${appState.mcpConfigPath}` : '')}</span>
      </div>
      <div class="mcp-list" id="mcp-list">
        <div class="mcp-loading">加载中…</div>
      </div>
    </div>
  `;
}
