import { describe, expect, it, beforeEach, vi } from 'vitest';
import { appState } from '../../state';
import { parseMcpServersJson, openMcpImportDialog } from './mcp-import-dialog';

const upsertMock = vi.fn();

vi.mock('../../api', () => ({
  upsertMcpServer: (...args: unknown[]) => upsertMock(...args),
  getMcpServers: vi.fn().mockResolvedValue({ servers: [], configPath: '' }),
  deleteMcpServer: vi.fn(),
}));

vi.mock('../../ui', () => ({
  showCopyToastMsg: vi.fn(),
  showToast: vi.fn(),
  showConfirmDialog: vi.fn().mockResolvedValue(true),
}));

describe('parseMcpServersJson（Claude Code mcpServers JSON 解析）', () => {
  it('标准形态：mcpServers 包裹', () => {
    const r = parseMcpServersJson(
      JSON.stringify({
        mcpServers: {
          'writer-demo': { command: 'writer-demo-mcp', args: [] },
        },
      }),
    );
    expect(r.errors).toEqual([]);
    expect(r.warnings).toEqual([]);
    expect(r.servers).toHaveLength(1);
    expect(r.servers[0].name).toBe('writer-demo');
    expect(r.servers[0].config).toEqual({ type: 'stdio', command: 'writer-demo-mcp', args: [], env: {} });
  });

  it('直接贴 servers 对象（无 mcpServers 包裹）也能解析', () => {
    const r = parseMcpServersJson(JSON.stringify({ cv: { command: 'npx', args: ['-y', '@waxilo/cv-mcp'] } }));
    expect(r.errors).toEqual([]);
    expect(r.servers[0].config).toEqual({
      type: 'stdio',
      command: 'npx',
      args: ['-y', '@waxilo/cv-mcp'],
      env: {},
    });
  });

  it('env 与远程 sse/http 解析；headers 记入 warnings', () => {
    const r = parseMcpServersJson(
      JSON.stringify({
        mcpServers: {
          local: { command: 'cmd', env: { API_KEY: 'sk-1' } },
          remote: { type: 'sse', url: 'https://example.com/mcp', headers: { Authorization: 'Bearer x' } },
          http1: { type: 'http', url: 'https://example.com/mcp2' },
        },
      }),
    );
    expect(r.servers).toHaveLength(3);
    expect(r.servers[0].config.env).toEqual({ API_KEY: 'sk-1' });
    expect(r.servers[1].config).toEqual({ type: 'sse', url: 'https://example.com/mcp', args: [], env: {} });
    expect(r.servers[2].config.type).toBe('http');
    // headers 不受支持：软警告，不阻断导入
    expect(r.errors).toEqual([]);
    expect(r.warnings.some((w) => w.includes('headers'))).toBe(true);
    expect(r.warnings.some((w) => w.includes('缺少服务器地址'))).toBe(false);
  });

  it('env: null 不崩溃，按软警告处理', () => {
    const r = parseMcpServersJson(
      JSON.stringify({ mcpServers: { s: { command: 'x', env: null } } }),
    );
    expect(r.servers).toHaveLength(1);
    expect(r.servers[0].config.env).toEqual({});
    expect(r.warnings.some((w) => w.includes('env'))).toBe(true);
  });

  it('已存在同名服务器标记 exists；名称 trim 归一', () => {
    const r = parseMcpServersJson(
      JSON.stringify({ mcpServers: { a: { command: 'x' }, ' b ': { command: 'y' } } }),
      ['b'],
    );
    expect(r.servers.find((s) => s.name === 'a')!.exists).toBe(false);
    expect(r.servers.find((s) => s.name === 'b')!.exists).toBe(true);
    expect(r.servers.find((s) => s.name === 'b')!.name).toBe('b');
  });

  it('无效输入给出错误且不产出服务器', () => {
    expect(parseMcpServersJson('').errors[0]).toContain('JSON');
    expect(parseMcpServersJson('not-json{{{').errors[0]).toContain('解析失败');
    expect(parseMcpServersJson('[1,2]').errors[0]).toContain('顶层');
    expect(parseMcpServersJson('{"mcpServers": []}').errors[0]).toContain('mcpServers');
    expect(parseMcpServersJson('{"mcpServers": null}').errors[0]).toContain('mcpServers');
    expect(parseMcpServersJson('{"mcpServers": {}}').errors[0]).toContain('为空');
    expect(parseMcpServersJson('x'.repeat(200001)).errors[0]).toContain('过大');
  });

  it('无效条目：缺 command/url、类型不支持、配置非对象 → 记录错误并跳过', () => {
    const r = parseMcpServersJson(
      JSON.stringify({
        mcpServers: {
          noCmd: { args: [] },
          badType: { type: 'websocket', url: 'wss://x' },
          notObj: 'hello',
          ok: { command: 'fine' },
        },
      }),
    );
    expect(r.servers.map((s) => s.name)).toEqual(['ok']);
    expect(r.errors.length).toBe(3);
    expect(r.errors.some((e) => e.includes('noCmd') && e.includes('command'))).toBe(true);
    expect(r.errors.some((e) => e.includes('badType') && e.includes('不受支持'))).toBe(true);
    expect(r.errors.some((e) => e.includes('notObj') && e.includes('对象'))).toBe(true);
  });

  it('空名称 / 保留名条目跳过并报错', () => {
    const r = parseMcpServersJson(
      JSON.stringify({ mcpServers: { '': { command: 'x' }, '  ': { command: 'y' }, ok: { command: 'z' } } }),
    );
    expect(r.servers.map((s) => s.name)).toEqual(['ok']);
    expect(r.errors.some((e) => e.includes('空名称'))).toBe(true);
    // __proto__ 需用字符串字面量构造（对象字面量会设置原型而非自身属性）
    const r2 = parseMcpServersJson('{"__proto__": {"command": "x"}, "ok": {"command": "z"}}');
    expect(r2.servers.map((s) => s.name)).toEqual(['ok']);
    expect(r2.errors.some((e) => e.includes('保留名'))).toBe(true);
  });

  it('args/env 类型错误：忽略字段并警告，不阻断该条目', () => {
    const r = parseMcpServersJson(
      JSON.stringify({ mcpServers: { s: { command: 'x', args: 'oops', env: ['a'] } } }),
    );
    expect(r.servers).toHaveLength(1);
    expect(r.servers[0].config.args).toEqual([]);
    expect(r.servers[0].config.env).toEqual({});
    expect(r.errors).toEqual([]);
    expect(r.warnings.some((w) => w.includes('args'))).toBe(true);
    expect(r.warnings.some((w) => w.includes('env'))).toBe(true);
  });

  it('远程意图（有 url 无 command 且无 type）给出引导性错误', () => {
    const r = parseMcpServersJson(JSON.stringify({ mcpServers: { s: { url: 'https://x/mcp' } } }));
    expect(r.servers).toHaveLength(0);
    expect(r.errors[0]).toContain('type: "sse"');
  });
});

describe('openMcpImportDialog（导入对话框流程）', () => {
  const applyUpsert = () => {
    upsertMock.mockImplementation(async (args: unknown) => {
      const { name, config } = args as { name: string; config: unknown };
      const idx = appState.mcpServers.findIndex((s) => s.name === name);
      const entry = { name, config };
      if (idx >= 0) appState.mcpServers[idx] = entry as never;
      else appState.mcpServers.push(entry as never);
      return { servers: appState.mcpServers, configPath: appState.mcpConfigPath };
    });
  };

  const mount = () => {
    document.body.innerHTML = `
      <button id="open-import">open</button>
      <div id="mcp-view">
        <div class="mcp-list" id="mcp-list"></div>
      </div>
    `;
    appState.mcpServers = [{ name: 'existing-srv', config: { type: 'stdio', command: 'old' } }];
    appState.mcpConfigPath = '/tmp/x.json';
    upsertMock.mockReset();
  };

  const openAndParse = (json: string) => {
    openMcpImportDialog();
    const overlay = document.querySelector('.mcp-dialog-overlay') as HTMLElement;
    const textarea = overlay.querySelector<HTMLTextAreaElement>('.mcp-import-textarea')!;
    textarea.value = json;
    (overlay.querySelector('.mcp-import-parse') as HTMLButtonElement).click();
    return overlay;
  };

  beforeEach(() => {
    mount();
  });

  it('打开对话框 → 粘贴 JSON → 解析出预览（含「将覆盖」标记）→ 导入调用 upsert', async () => {
    applyUpsert();
    const overlay = openAndParse(
      JSON.stringify({
        mcpServers: {
          'existing-srv': { command: 'new-cmd' },
          fresh: { command: 'fresh-cmd', args: ['--x'] },
        },
      }),
    );
    expect(overlay).not.toBeNull();

    const items = overlay.querySelectorAll('.mcp-import-item');
    expect(items.length).toBe(2);
    expect(overlay.textContent).toContain('将覆盖已有配置');
    expect(overlay.textContent).toContain('将导入 2 个服务器');

    (overlay.querySelector('.mcp-import-confirm') as HTMLButtonElement).click();
    await new Promise((r) => setTimeout(r, 10));
    expect(upsertMock).toHaveBeenCalledTimes(2);
    expect(upsertMock).toHaveBeenCalledWith({
      name: 'existing-srv',
      config: { type: 'stdio', command: 'new-cmd', args: [], env: {} },
    });
    expect(upsertMock).toHaveBeenCalledWith({
      name: 'fresh',
      config: { type: 'stdio', command: 'fresh-cmd', args: ['--x'], env: {} },
    });
    // 全部成功 → 对话框关闭，列表已刷新
    expect(document.querySelector('.mcp-dialog-overlay')).toBeNull();
    expect(document.querySelector('#mcp-list')!.children.length).toBeGreaterThan(0);
  });

  it('非法 JSON：显示错误（role=alert）且无导入按钮', () => {
    const overlay = openAndParse('{bad');
    expect(overlay.querySelector('.mcp-import-error')).not.toBeNull();
    expect(overlay.querySelector('.mcp-import-errors')!.getAttribute('role')).toBe('alert');
    expect(overlay.querySelector('.mcp-import-confirm')).toBeNull();
  });

  it('部分失败：对话框保留，逐条标注成败，重试只导入失败项', async () => {
    let badCalls = 0;
    upsertMock.mockImplementation(async (args: unknown) => {
      const { name, config } = args as { name: string; config: unknown };
      if (name === 'bad') {
        badCalls += 1;
        if (badCalls === 1) throw new Error('boom');
      }
      appState.mcpServers.push({ name, config: config as never });
      return { servers: appState.mcpServers, configPath: appState.mcpConfigPath };
    });
    const overlay = openAndParse(
      JSON.stringify({ mcpServers: { bad: { command: 'x' }, good: { command: 'y' } } }),
    );
    (overlay.querySelector('.mcp-import-confirm') as HTMLButtonElement).click();
    await new Promise((r) => setTimeout(r, 10));

    // 部分失败：对话框保留，展示结果与失败原因
    expect(document.querySelector('.mcp-dialog-overlay')).not.toBeNull();
    expect(overlay.textContent).toContain('导入结果：成功 1，失败 1');
    expect(overlay.textContent).toContain('✗ 失败');
    expect(overlay.textContent).toContain('boom');
    const retry = overlay.querySelector<HTMLButtonElement>('.mcp-import-retry');
    expect(retry).not.toBeNull();
    expect(retry!.textContent).toContain('重试失败项（1）');

    // 重试：只 upsert 失败项，成功后关闭
    retry!.click();
    await new Promise((r) => setTimeout(r, 10));
    expect(upsertMock).toHaveBeenCalledTimes(3);
    expect(upsertMock.mock.calls[2][0]).toEqual({ name: 'bad', config: expect.anything() });
    expect(document.querySelector('.mcp-dialog-overlay')).toBeNull();
  });

  it('全部失败：保留对话框可重试；重试成功才关闭', async () => {
    let calls = 0;
    upsertMock.mockImplementation(async () => {
      calls += 1;
      if (calls <= 2) throw new Error('down');
      return { servers: appState.mcpServers, configPath: appState.mcpConfigPath };
    });
    const overlay = openAndParse(
      JSON.stringify({ mcpServers: { a: { command: 'x' }, b: { command: 'y' } } }),
    );
    (overlay.querySelector('.mcp-import-confirm') as HTMLButtonElement).click();
    await new Promise((r) => setTimeout(r, 10));
    expect(overlay.textContent).toContain('成功 0，失败 2');
    expect(upsertMock).toHaveBeenCalledTimes(2);

    overlay.querySelector<HTMLButtonElement>('.mcp-import-retry')!.click();
    await new Promise((r) => setTimeout(r, 10));
    expect(upsertMock).toHaveBeenCalledTimes(4);
    expect(document.querySelector('.mcp-dialog-overlay')).toBeNull();
  });

  it('「返回修改」保留已粘贴的 JSON 并恢复焦点', () => {
    const json = JSON.stringify({ mcpServers: { s: { command: 'x' } } });
    const overlay = openAndParse(json);
    (overlay.querySelector('.mcp-import-back') as HTMLButtonElement).click();
    const textarea = overlay.querySelector<HTMLTextAreaElement>('.mcp-import-textarea')!;
    expect(textarea.value).toBe(json);
    expect(document.activeElement).toBe(textarea);
  });

  it('导入中 ✕/取消/遮罩关闭被忽略，完成后正常关闭', async () => {
    let resolveUpsert: (v: unknown) => void = () => {};
    upsertMock.mockImplementation(() => new Promise((res) => { resolveUpsert = res; }));
    const overlay = openAndParse(JSON.stringify({ mcpServers: { s: { command: 'x' } } }));
    (overlay.querySelector('.mcp-import-confirm') as HTMLButtonElement).click();
    await Promise.resolve();

    // 导入中：✕ 与遮罩点击均不关闭
    (overlay.querySelector('.mcp-dialog-close') as HTMLButtonElement).click();
    overlay.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(document.querySelector('.mcp-dialog-overlay')).not.toBeNull();

    // 完成后关闭
    resolveUpsert({ servers: [{ name: 's', config: { type: 'stdio', command: 'x' } }], configPath: '' });
    await new Promise((r) => setTimeout(r, 10));
    expect(document.querySelector('.mcp-dialog-overlay')).toBeNull();
  });

  it('Esc 移除对话框后，导入循环自动取消剩余条目', async () => {
    let resolveUpsert: (v: unknown) => void = () => {};
    let upsertCalls = 0;
    upsertMock.mockImplementation(() => {
      upsertCalls += 1;
      return new Promise((res) => { resolveUpsert = res; });
    });
    const overlay = openAndParse(
      JSON.stringify({ mcpServers: { a: { command: 'x' }, b: { command: 'y' }, c: { command: 'z' } } }),
    );
    (overlay.querySelector('.mcp-import-confirm') as HTMLButtonElement).click();
    await Promise.resolve();
    expect(upsertCalls).toBe(1);

    // 模拟 Esc 关闭（mount.ts onEscapeKey 直接移除 overlay）
    overlay.remove();
    resolveUpsert({ servers: [], configPath: '' });
    await new Promise((r) => setTimeout(r, 10));
    // 剩余条目未导入
    expect(upsertCalls).toBe(1);
  });

  it('重复打开对话框：单例不堆叠', () => {
    openMcpImportDialog();
    openMcpImportDialog();
    expect(document.querySelectorAll('.mcp-dialog-overlay').length).toBe(1);
  });

  it('混合结果：有效条目与错误条目同屏展示', () => {
    const overlay = openAndParse(
      JSON.stringify({
        mcpServers: {
          good: { command: 'x' },
          bad: { type: 'nope', url: 'wss://x' },
        },
      }),
    );
    expect(overlay.querySelector('.mcp-import-error')).not.toBeNull();
    expect(overlay.querySelectorAll('.mcp-import-item').length).toBe(1);
    expect(overlay.querySelector('.mcp-import-confirm')!.textContent).toContain('导入 1 个');
  });
});
