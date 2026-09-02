import { loadMcpServers, openMcpEditorDialog } from './mcp-editor-dialog';
import { openMcpImportDialog } from './mcp-import-dialog';

/** 挂载「技能」页 MCP 分区：绑定添加/导入按钮 + 拉取服务器列表（dataset 守卫，避免重复绑定） */
export async function mountMcpSection(): Promise<void> {
  const section = document.querySelector<HTMLElement>('#skills-mcp-section');
  if (!section) return;

  if (section.dataset.mcpSectionMounted !== '1') {
    section.dataset.mcpSectionMounted = '1';
    section.querySelector('#mcp-add-btn')?.addEventListener('click', () => openMcpEditorDialog(null));
    section.querySelector('#mcp-import-btn')?.addEventListener('click', () => openMcpImportDialog());
  }

  await loadMcpServers();
}
