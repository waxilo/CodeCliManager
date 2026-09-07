import { beforeEach, describe, expect, it, vi } from 'vitest';
import { appState } from '../../state';
import { loadMcpServers, openMcpEditorDialog, deleteMcpServer } from './mcp-editor-dialog';

const getScopedMock = vi.fn();
const upsertScopedMock = vi.fn();
const deleteScopedMock = vi.fn();

vi.mock('./mcp-api', () => ({
  getScopedMcpServers: (...args: unknown[]) => getScopedMock(...args),
  upsertScopedMcpServer: (...args: unknown[]) => upsertScopedMock(...args),
  deleteScopedMcpServer: (...args: unknown[]) => deleteScopedMock(...args),
}));

describe('MCP 项目作用域加载', () => {
  beforeEach(() => {
    document.body.innerHTML = `
      <span class="mcp-config-path"></span>
      <div id="mcp-list"></div>
    `;
    appState.skillsScope = 'project';
    appState.skillsProjectDir = '/projects/a';
    appState.mcpServers = [];
    appState.mcpConfigPath = '';
    getScopedMock.mockReset();
    upsertScopedMock.mockReset();
    deleteScopedMock.mockReset();
  });

  it('项目切换后旧请求不能覆盖新项目列表和路径', async () => {
    let resolveOld: (value: unknown) => void = () => {};
    getScopedMock
      .mockImplementationOnce(() => new Promise((resolve) => { resolveOld = resolve; }))
      .mockResolvedValueOnce({
        servers: [{ name: 'project-b', config: { type: 'stdio', command: 'b' } }],
        configPath: '/projects/b/.mcp.json',
      });

    const oldLoad = loadMcpServers();
    appState.skillsProjectDir = '/projects/b';
    const newLoad = loadMcpServers();
    await newLoad;
    resolveOld({
      servers: [{ name: 'project-a', config: { type: 'stdio', command: 'a' } }],
      configPath: '/projects/a/.mcp.json',
    });
    await oldLoad;

    expect(appState.mcpServers.map((server) => server.name)).toEqual(['project-b']);
    expect(appState.mcpConfigPath).toBe('/projects/b/.mcp.json');
    expect(document.querySelector('.mcp-config-path')?.textContent).toContain('/projects/b/.mcp.json');
    expect(document.querySelector('#mcp-list')?.textContent).toContain('project-b');
    expect(document.querySelector('#mcp-list')?.textContent).not.toContain('project-a');
  });

  it('新增服务器时快照当前项目目标', async () => {
    upsertScopedMock.mockResolvedValue({
      servers: [{ name: 'demo', config: { type: 'stdio', command: 'node', args: [], env: {} } }],
      configPath: '/projects/a/.mcp.json',
    });

    openMcpEditorDialog(null);
    document.querySelector<HTMLInputElement>('input[name="name"]')!.value = 'demo';
    document.querySelector<HTMLInputElement>('input[name="command"]')!.value = 'node';
    document.querySelector<HTMLFormElement>('#mcp-dialog-form')!.dispatchEvent(
      new Event('submit', { bubbles: true, cancelable: true }),
    );
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(upsertScopedMock).toHaveBeenCalledWith(
      { scope: 'project', projectDir: '/projects/a' },
      {
        name: 'demo',
        config: { type: 'stdio', command: 'node', args: [], env: {} },
      },
    );
  });

  it('确认删除时快照当前项目目标', async () => {
    deleteScopedMock.mockResolvedValue({ servers: [], configPath: '/projects/a/.mcp.json' });

    const deleting = deleteMcpServer('demo');
    document.querySelector<HTMLButtonElement>('.confirm-btn.danger')!.click();
    await deleting;

    expect(deleteScopedMock).toHaveBeenCalledWith(
      { scope: 'project', projectDir: '/projects/a' },
      'demo',
    );
  });
});
