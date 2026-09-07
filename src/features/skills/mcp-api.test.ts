import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  deleteScopedMcpServer,
  getScopedMcpServers,
  upsertScopedMcpServer,
} from './mcp-api';

const getGlobalMock = vi.fn();
const getProjectMock = vi.fn();
const upsertGlobalMock = vi.fn();
const upsertProjectMock = vi.fn();
const deleteGlobalMock = vi.fn();
const deleteProjectMock = vi.fn();

vi.mock('../../api', () => ({
  getMcpServers: (...args: unknown[]) => getGlobalMock(...args),
  getProjectMcpServers: (...args: unknown[]) => getProjectMock(...args),
  upsertMcpServer: (...args: unknown[]) => upsertGlobalMock(...args),
  upsertProjectMcpServer: (...args: unknown[]) => upsertProjectMock(...args),
  deleteMcpServer: (...args: unknown[]) => deleteGlobalMock(...args),
  deleteProjectMcpServer: (...args: unknown[]) => deleteProjectMock(...args),
}));

describe('MCP 作用域 API', () => {
  beforeEach(() => vi.clearAllMocks());

  it('全局作用域使用全局 API', async () => {
    getGlobalMock.mockResolvedValue({ servers: [], configPath: '/home/.claude.json' });
    upsertGlobalMock.mockResolvedValue({ servers: [], configPath: '/home/.claude.json' });
    deleteGlobalMock.mockResolvedValue({ servers: [], configPath: '/home/.claude.json' });
    const target = { scope: 'global' as const, projectDir: null };
    const config = { type: 'stdio', command: 'node', args: [], env: {} };

    await getScopedMcpServers(target);
    await upsertScopedMcpServer(target, { name: 'demo', config });
    await deleteScopedMcpServer(target, 'demo');

    expect(getGlobalMock).toHaveBeenCalledOnce();
    expect(upsertGlobalMock).toHaveBeenCalledWith({ name: 'demo', config });
    expect(deleteGlobalMock).toHaveBeenCalledWith('demo');
  });

  it('项目作用域把固定项目目录传给所有 API', async () => {
    getProjectMock.mockResolvedValue({ servers: [], configPath: '/projects/a/.mcp.json' });
    upsertProjectMock.mockResolvedValue({ servers: [], configPath: '/projects/a/.mcp.json' });
    deleteProjectMock.mockResolvedValue({ servers: [], configPath: '/projects/a/.mcp.json' });
    const target = { scope: 'project' as const, projectDir: '/projects/a' };
    const config = { type: 'stdio', command: 'node', args: ['server.js'], env: {} };

    await getScopedMcpServers(target);
    await upsertScopedMcpServer(target, { name: 'demo', config });
    await deleteScopedMcpServer(target, 'demo');

    expect(getProjectMock).toHaveBeenCalledWith('/projects/a');
    expect(upsertProjectMock).toHaveBeenCalledWith({
      projectDir: '/projects/a',
      name: 'demo',
      config,
    });
    expect(deleteProjectMock).toHaveBeenCalledWith('/projects/a', 'demo');
  });
});
