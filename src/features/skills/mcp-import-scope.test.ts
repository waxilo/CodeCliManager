import { beforeEach, describe, expect, it, vi } from 'vitest';
import { appState } from '../../state';
import { openMcpImportDialog } from './mcp-import-dialog';

const upsertScopedMock = vi.fn();

vi.mock('./mcp-api', () => ({
  upsertScopedMcpServer: (...args: unknown[]) => upsertScopedMock(...args),
}));

describe('MCP 项目作用域导入', () => {
  beforeEach(() => {
    document.body.innerHTML = '<div id="mcp-list"></div>';
    appState.skillsScope = 'project';
    appState.skillsProjectDir = '/projects/a';
    appState.mcpServers = [];
    appState.mcpConfigPath = '/projects/a/.mcp.json';
    upsertScopedMock.mockReset();
    upsertScopedMock.mockResolvedValue({
      servers: [],
      configPath: '/projects/a/.mcp.json',
    });
  });

  it('所有导入条目使用打开对话框时的项目目标', async () => {
    openMcpImportDialog();
    const overlay = document.querySelector<HTMLElement>('.mcp-dialog-overlay')!;
    overlay.querySelector<HTMLTextAreaElement>('.mcp-import-textarea')!.value = JSON.stringify({
      mcpServers: {
        first: { command: 'first-server' },
        second: { command: 'second-server' },
      },
    });
    overlay.querySelector<HTMLButtonElement>('.mcp-import-parse')!.click();
    overlay.querySelector<HTMLButtonElement>('.mcp-import-confirm')!.click();
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(upsertScopedMock).toHaveBeenCalledTimes(2);
    for (const call of upsertScopedMock.mock.calls) {
      expect(call[0]).toEqual({ scope: 'project', projectDir: '/projects/a' });
    }
  });
});
