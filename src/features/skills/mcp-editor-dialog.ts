import { appState } from '../../state';
import * as api from '../../api';
import { escapeHtml } from '../../utils';
import { showConfirmDialog, showCopyToastMsg } from '../../ui';
import type { McpServerConfig, McpServerEntry } from '../../types';
export async function loadMcpServers(): Promise<void> {
  const listEl = document.querySelector('#mcp-list');
  if (!listEl) return;
  listEl.innerHTML = '<div class="mcp-loading">加载中…</div>';
  try {
    const state = await api.getMcpServers();
    appState.mcpServers = state.servers;
    appState.mcpConfigPath = state.configPath;
    const pathEl = document.querySelector('.mcp-config-path');
    if (pathEl) pathEl.textContent = `配置文件：${state.configPath}`;
    renderMcpList();
  } catch (err) {
    listEl.innerHTML = `<div class="mcp-empty mcp-error">加载失败：${escapeHtml(String(err))}</div>`;
  }
}

export function renderMcpList(): void {
  const listEl = document.querySelector('#mcp-list');
  if (!listEl) return;
  if (appState.mcpServers.length === 0) {
    listEl.innerHTML = `
      <div class="mcp-empty">
        <p class="mcp-empty-title">尚未配置任何 MCP 服务器</p>
        <p class="mcp-empty-hint">点击上方「+ 添加服务器」创建你的第一个 MCP 服务器</p>
      </div>
    `;
    return;
  }
  listEl.innerHTML = appState.mcpServers.map((entry) => renderMcpServerCard(entry)).join('');
  listEl.querySelectorAll<HTMLElement>('[data-mcp-action]').forEach((btn) => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const action = btn.dataset.mcpAction;
      const name = btn.dataset.mcpName || '';
      if (action === 'edit') {
        openMcpEditorDialog(name);
      } else if (action === 'delete') {
        void deleteMcpServer(name);
      }
    });
  });
}

export function renderMcpServerCard(entry: McpServerEntry): string {
  const config = entry.config || {};
  const type = config.type || 'stdio';
  const argsCount = (config.args || []).length;
  const envCount = Object.keys(config.env || {}).length;
  let meta = '';
  if (type === 'stdio') {
    meta = escapeHtml([config.command || '', ...(config.args || [])].filter(Boolean).join(' '));
  } else {
    meta = escapeHtml(config.url || '');
  }
  const badges = [
    `<span class="mcp-badge mcp-badge-type">${escapeHtml(type)}</span>`,
    argsCount > 0 ? `<span class="mcp-badge">${argsCount} 个参数</span>` : '',
    envCount > 0 ? `<span class="mcp-badge">${envCount} 个环境变量</span>` : '',
  ].filter(Boolean).join('');
  return `
    <div class="mcp-server-card">
      <div class="mcp-server-main">
        <div class="mcp-server-name-row">
          <span class="mcp-server-name">${escapeHtml(entry.name)}</span>
          <div class="mcp-badges">${badges}</div>
        </div>
        ${entry.parseError
          ? `<p class="mcp-server-error">${escapeHtml(entry.parseError)}</p>`
          : meta
            ? `<p class="mcp-server-meta">${meta}</p>`
            : '<p class="mcp-server-meta mcp-server-meta-empty">（无启动命令）</p>'}
      </div>
      <div class="mcp-server-actions">
        <button type="button" class="mcp-server-btn" data-mcp-action="edit" data-mcp-name="${escapeHtml(entry.name)}" title="编辑">编辑</button>
        <button type="button" class="mcp-server-btn danger" data-mcp-action="delete" data-mcp-name="${escapeHtml(entry.name)}" title="删除">删除</button>
      </div>
    </div>
  `;
}

export async function deleteMcpServer(name: string): Promise<void> {
  const confirmed = await showConfirmDialog({
    title: '删除 MCP 服务器',
    message: `确定要删除「${name}」吗？`,
    sub: '将从 ~/.claude.json 中移除该服务器配置。',
    confirmLabel: '删除',
  });
  if (!confirmed) return;
  try {
    const state = await api.deleteMcpServer(name);
    appState.mcpServers = state.servers;
    appState.mcpConfigPath = state.configPath;
    renderMcpList();
    showCopyToastMsg('已删除');
  } catch (err) {
    showCopyToastMsg(`删除失败：${String(err)}`);
  }
}

export function openMcpEditorDialog(name: string | null): void {
  const existing = document.querySelector('.mcp-dialog-overlay');
  if (existing) existing.remove();

  const isEdit = name !== null;
  const entry = isEdit ? appState.mcpServers.find((s) => s.name === name) : undefined;
  const config = entry?.config || {};
  const type = config.type || 'stdio';
  const command = config.command || '';
  const argsText = (config.args || []).join('\n');
  const envText = Object.entries(config.env || {})
    .map(([k, v]) => `${k}=${v}`)
    .join('\n');
  const url = config.url || '';

  const overlay = document.createElement('div');
  overlay.className = 'mcp-dialog-overlay';
  overlay.innerHTML = `
    <div class="mcp-dialog" role="dialog" aria-modal="true">
      <div class="mcp-dialog-header">
        <h3>${isEdit ? '编辑服务器' : '添加服务器'}</h3>
        <button type="button" class="settings-close-btn mcp-dialog-close" aria-label="关闭">✕</button>
      </div>
      <form class="mcp-dialog-form" id="mcp-dialog-form">
        <label class="settings-field">
          <span>服务器名称</span>
          <input type="text" name="name" placeholder="例如：cv-builder" value="${escapeHtml(isEdit ? entry!.name : '')}" ${isEdit ? 'readonly' : ''} required />
        </label>
        <label class="settings-field">
          <span>类型</span>
          <select name="type">
            <option value="stdio" ${type === 'stdio' ? 'selected' : ''}>stdio（本地命令）</option>
            <option value="sse" ${type === 'sse' ? 'selected' : ''}>sse（远程 SSE）</option>
            <option value="http" ${type === 'http' ? 'selected' : ''}>http（流式 HTTP）</option>
          </select>
        </label>
        <label class="settings-field mcp-field-stdio">
          <span>启动命令</span>
          <input type="text" name="command" placeholder="例如：npx" value="${escapeHtml(command)}" />
        </label>
        <label class="settings-field mcp-field-stdio">
          <span>参数（每行一个）</span>
          <textarea name="args" rows="3" placeholder="-y&#10;@waxilo/cv-mcp">${escapeHtml(argsText)}</textarea>
        </label>
        <label class="settings-field mcp-field-remote">
          <span>服务器 URL</span>
          <input type="url" name="url" placeholder="https://example.com/mcp" value="${escapeHtml(url)}" />
        </label>
        <details class="mcp-env-details">
          <summary>环境变量（可选，每行一个 KEY=value）</summary>
          <textarea name="env" rows="3" placeholder="API_KEY=sk-...">${escapeHtml(envText)}</textarea>
        </details>
        <div class="mcp-dialog-actions">
          <button type="button" class="mcp-dialog-btn cancel">取消</button>
          <button type="submit" class="mcp-dialog-btn primary">保存</button>
        </div>
      </form>
    </div>
  `;

  const cleanup = () => {
    overlay.remove();
  };

  overlay.querySelector('.mcp-dialog-close')?.addEventListener('click', cleanup);
  overlay.querySelector('.mcp-dialog-btn.cancel')?.addEventListener('click', cleanup);
  overlay.addEventListener('click', (event) => {
    if (event.target === overlay) cleanup();
  });

  const typeSelect = overlay.querySelector<HTMLSelectElement>('select[name="type"]');
  const syncTypeFields = () => {
    const isStdio = typeSelect?.value === 'stdio';
    overlay.querySelectorAll<HTMLElement>('.mcp-field-stdio').forEach((el) => {
      el.style.display = isStdio ? '' : 'none';
    });
    overlay.querySelectorAll<HTMLElement>('.mcp-field-remote').forEach((el) => {
      el.style.display = isStdio ? 'none' : '';
    });
  };
  typeSelect?.addEventListener('change', syncTypeFields);
  syncTypeFields();

  overlay.querySelector<HTMLFormElement>('#mcp-dialog-form')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const form = e.currentTarget as HTMLFormElement;
    const fd = new FormData(form);
    const serverName = String(fd.get('name') || '').trim();
    if (!serverName) {
      showCopyToastMsg('请填写服务器名称');
      return;
    }
    const serverType = String(fd.get('type') || 'stdio');
    const cmd = String(fd.get('command') || '').trim();
    const argsRaw = String(fd.get('args') || '').trim();
    const urlRaw = String(fd.get('url') || '').trim();
    const envRaw = String(fd.get('env') || '').trim();

    const args = argsRaw ? argsRaw.split('\n').map((s) => s.trim()).filter(Boolean) : [];
    const env: Record<string, string> = {};
    if (envRaw) {
      for (const line of envRaw.split('\n')) {
        const idx = line.indexOf('=');
        if (idx <= 0) continue;
        const key = line.slice(0, idx).trim();
        const value = line.slice(idx + 1).trim();
        if (key) env[key] = value;
      }
    }

    const config: McpServerConfig = { type: serverType, args, env };
    if (serverType === 'stdio') {
      if (!cmd) {
        showCopyToastMsg('请填写启动命令');
        return;
      }
      config.command = cmd;
    } else {
      if (!urlRaw) {
        showCopyToastMsg('请填写服务器 URL');
        return;
      }
      config.url = urlRaw;
    }

    const saveBtn = overlay.querySelector('.mcp-dialog-btn.primary') as HTMLButtonElement;
    saveBtn.disabled = true;
    saveBtn.textContent = '保存中…';
    try {
      const state = await api.upsertMcpServer({
        name: serverName,
        config,
      });
      appState.mcpServers = state.servers;
      appState.mcpConfigPath = state.configPath;
      renderMcpList();
      cleanup();
      showCopyToastMsg(isEdit ? '已保存' : '已添加');
    } catch (err) {
      saveBtn.disabled = false;
      saveBtn.textContent = '保存';
      showCopyToastMsg(`保存失败：${String(err)}`);
    }
  });

  document.body.appendChild(overlay);
  const nameInput = overlay.querySelector<HTMLInputElement>('input[name="name"]');
  if (nameInput && !isEdit) nameInput.focus();
}
