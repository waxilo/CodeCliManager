import { appState } from '../../state';
import * as api from '../../api';
import { escapeHtml } from '../../utils';
import { showCopyToastMsg } from '../../ui';
import type { McpServerConfig } from '../../types';
import { renderMcpList } from './mcp-editor-dialog';

export interface ImportedMcpServer {
  name: string;
  config: McpServerConfig;
  exists: boolean;
}

export interface McpImportResult {
  servers: ImportedMcpServer[];
  /** 硬错误：条目被跳过或整体失败（红色） */
  errors: string[];
  /** 软警告：字段被忽略等，不阻断导入（黄色） */
  warnings: string[];
}

const MAX_JSON_LENGTH = 200_000;
/** 作为 JSON 键导入有风险/无意义的保留名 */
const RESERVED_NAMES = new Set(['__proto__', 'constructor', 'prototype']);

/**
 * 解析 Claude Code 风格的 MCP JSON（兼容两种形态）：
 *   { "mcpServers": { name: config, ... } }   —— 标准形态
 *   { name: config, ... }                      —— 直接贴 servers 对象
 * config 支持字段：type(stdio|sse|http, 缺省 stdio)、command、args、env、url；
 * headers 等 CCM 不支持的字段会忽略（记入 warnings）。
 * 纯函数，便于单元测试；existingNames 用于标记「将覆盖」。
 */
export function parseMcpServersJson(
  text: string,
  existingNames: string[] = [],
): McpImportResult {
  const empty: McpImportResult = { servers: [], errors: [], warnings: [] };
  const trimmed = text.trim();
  if (!trimmed) {
    return { ...empty, errors: ['请输入要导入的 JSON'] };
  }
  if (trimmed.length > MAX_JSON_LENGTH) {
    return { ...empty, errors: ['JSON 过大（超过 200KB），请精简后导入'] };
  }

  let raw: unknown;
  try {
    raw = JSON.parse(trimmed);
  } catch {
    return { ...empty, errors: ['JSON 解析失败，请检查格式'] };
  }

  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { ...empty, errors: ['JSON 顶层必须是对象'] };
  }

  let map: Record<string, unknown>;
  const asRecord = raw as Record<string, unknown>;
  const wrapped = asRecord.mcpServers;
  if (wrapped !== undefined) {
    if (!wrapped || typeof wrapped !== 'object' || Array.isArray(wrapped)) {
      return { ...empty, errors: ['"mcpServers" 必须是对象'] };
    }
    map = wrapped as Record<string, unknown>;
  } else {
    map = asRecord;
  }

  const names = Object.keys(map);
  if (names.length === 0) {
    return { ...empty, errors: ['没有可导入的服务器（mcpServers 为空）'] };
  }

  const servers: ImportedMcpServer[] = [];
  const errors: string[] = [];
  const warnings: string[] = [];
  for (const rawName of names) {
    // 名称归一化：trim 后作为导入名（与后端 upsert 一致），空名/保留名拒绝
    const name = rawName.trim();
    if (!name) {
      errors.push('存在空名称的服务器条目，已跳过');
      continue;
    }
    if (RESERVED_NAMES.has(name)) {
      errors.push(`服务器名称「${name}」为保留名，已跳过`);
      continue;
    }
    const label = `「${name}」`;
    const value = map[rawName];
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      errors.push(`${label} 配置必须是对象`);
      continue;
    }
    const cfg = value as Record<string, unknown>;

    // 类型：Claude Code 约定 type 缺省即 stdio
    const type = typeof cfg.type === 'string' ? cfg.type.trim().toLowerCase() : 'stdio';
    if (type !== 'stdio' && type !== 'sse' && type !== 'http') {
      errors.push(`${label} 类型 "${String(cfg.type)}" 不受支持（支持 stdio / sse / http）`);
      continue;
    }

    const command = typeof cfg.command === 'string' ? cfg.command.trim() : '';
    const url = typeof cfg.url === 'string' ? cfg.url.trim() : '';

    if (type === 'stdio' && !command) {
      errors.push(
        url
          ? `${label} 缺少启动命令 command（若为远程服务器，请设置 type: "sse" 或 "http"）`
          : `${label} 缺少启动命令 command`,
      );
      continue;
    }
    if (type !== 'stdio' && !url) {
      errors.push(`${label} 缺少服务器地址 url`);
      continue;
    }

    // args / env 容错：格式不对时忽略并警告，不阻断导入
    let args: string[] = [];
    if (cfg.args !== undefined) {
      if (Array.isArray(cfg.args) && cfg.args.every((a) => typeof a === 'string')) {
        args = cfg.args as string[];
      } else {
        warnings.push(`${label} 的 args 应为字符串数组，已忽略`);
      }
    }
    let env: Record<string, string> = {};
    if (cfg.env !== undefined) {
      const envValue = cfg.env;
      if (
        envValue !== null &&
        typeof envValue === 'object' &&
        !Array.isArray(envValue) &&
        Object.values(envValue as Record<string, unknown>).every((v) => typeof v === 'string')
      ) {
        env = envValue as Record<string, string>;
      } else {
        warnings.push(`${label} 的 env 应为字符串键值对象，已忽略`);
      }
    }
    if (cfg.headers !== undefined) {
      warnings.push(`${label} 的 headers 暂不支持，已忽略`);
    }

    const config: McpServerConfig = { type, args, env };
    if (type === 'stdio') {
      config.command = command;
    } else {
      config.url = url;
    }
    servers.push({ name, config, exists: existingNames.includes(name) });
  }

  return { servers, errors, warnings };
}

/** 打开「从 JSON 导入 MCP 服务器」对话框 */
export function openMcpImportDialog(): void {
  const existing = document.querySelector('.mcp-dialog-overlay');
  if (existing) existing.remove();

  const overlay = document.createElement('div');
  overlay.className = 'mcp-dialog-overlay';
  overlay.innerHTML = `
    <div class="mcp-dialog mcp-import-dialog" role="dialog" aria-modal="true" aria-labelledby="mcp-import-title">
      <div class="mcp-dialog-header">
        <h3 id="mcp-import-title">从 JSON 导入 MCP 服务器</h3>
        <button type="button" class="settings-close-btn mcp-dialog-close" aria-label="关闭">✕</button>
      </div>
      <div class="mcp-import-body">
        <p class="mcp-import-hint">粘贴 Claude Code 格式的 mcpServers JSON，例如：</p>
        <pre class="mcp-import-example">{
  "mcpServers": {
    "writer-demo": {
      "command": "writer-demo-mcp",
      "args": []
    }
  }
}</pre>
        <textarea class="mcp-import-textarea" rows="8" spellcheck="false" placeholder='{"mcpServers": { "name": { "command": "…", "args": [] } }}'></textarea>
        <div class="mcp-import-actions">
          <button type="button" class="mcp-dialog-btn cancel mcp-import-cancel">取消</button>
          <button type="button" class="mcp-dialog-btn primary mcp-import-parse">解析</button>
        </div>
      </div>
    </div>
  `;

  const body = overlay.querySelector<HTMLElement>('.mcp-import-body');
  const initialBodyHtml = body?.innerHTML ?? '';
  if (!body) return;
  const openingFocus =
    document.activeElement instanceof HTMLElement ? document.activeElement : null;
  /** 导入进行中：禁止 ✕/取消/遮罩关闭（Esc 仍可取消，循环检测移除后停止） */
  const importState = { busy: false };
  /** 最近一次粘贴的 JSON（返回修改时恢复，避免重贴） */
  let lastJson = '';

  const cleanup = () => {
    if (importState.busy) return;
    overlay.remove();
    openingFocus?.focus();
  };
  overlay.querySelector('.mcp-dialog-close')?.addEventListener('click', cleanup);
  overlay.querySelector('.mcp-import-cancel')?.addEventListener('click', cleanup);
  overlay.addEventListener('click', (event) => {
    if (event.target === overlay) cleanup();
  });

  const restoreForm = () => {
    body.innerHTML = initialBodyHtml;
    const ta = body.querySelector<HTMLTextAreaElement>('.mcp-import-textarea');
    if (ta) {
      ta.value = lastJson;
      ta.focus();
    }
    bindInitialActions();
  };

  const bindInitialActions = () => {
    overlay.querySelector<HTMLButtonElement>('.mcp-import-parse')?.addEventListener('click', () => {
      const textarea = overlay.querySelector<HTMLTextAreaElement>('.mcp-import-textarea');
      lastJson = textarea?.value || '';
      const result = parseMcpServersJson(lastJson, appState.mcpServers.map((s) => s.name));
      renderImportResult(body, result, {
        onBack: restoreForm,
        onConfirm: (servers) => {
          void runImport(overlay, body, servers, { onBack: restoreForm, importState });
        },
      });
    });
  };
  bindInitialActions();

  document.body.appendChild(overlay);
  overlay.querySelector<HTMLTextAreaElement>('.mcp-import-textarea')?.focus();
}

/**
 * 逐条 upsert 导入。全部成功才关闭；有失败时保留对话框，
 * 逐条标注成败并支持「重试失败项」（已成功项不会重复导入）。
 * Esc / 关闭视图导致的 overlay 移除会自动取消剩余条目。
 */
async function runImport(
  overlay: HTMLElement,
  body: HTMLElement,
  servers: ImportedMcpServer[],
  opts: { onBack: () => void; importState: { busy: boolean } },
): Promise<void> {
  let okCount = 0;
  let failReasons = new Map<string, string>();
  const runBatch = async (batch: ImportedMcpServer[]): Promise<void> => {
    // 重试批次：先清除这批条目的旧失败记录，避免残留误判
    for (const s of batch) failReasons.delete(s.name);
    opts.importState.busy = true;
    renderImportProgress(body, batch, failReasons, {
      busy: true,
      onRetry: () => undefined,
      onBack: opts.onBack,
    });
    for (const s of batch) {
      if (!overlay.isConnected) return; // 用户已取消（Esc/关视图）
      try {
        const state = await api.upsertMcpServer({ name: s.name, config: s.config });
        appState.mcpServers = state.servers;
        appState.mcpConfigPath = state.configPath;
        okCount += 1;
      } catch (e) {
        failReasons.set(s.name, String(e));
      }
    }
    opts.importState.busy = false;
    if (!overlay.isConnected) return;
    if (failReasons.size === 0) {
      renderMcpList();
      overlay.remove();
      showCopyToastMsg(`已导入 ${okCount} 个服务器`);
      return;
    }
    renderImportProgress(body, batch, failReasons, {
      busy: false,
      onRetry: () => {
        const failed = batch.filter((s) => failReasons.has(s.name));
        void runBatch(failed);
      },
      onBack: opts.onBack,
    });
  };
  await runBatch(servers);
}

/** 导入中/导入结果的进度视图：逐条标注成功 ✓ / 失败 ✗ */
function renderImportProgress(
  body: HTMLElement,
  batch: ImportedMcpServer[],
  failReasons: Map<string, string>,
  opts: { busy: boolean; onRetry: () => void; onBack: () => void },
): void {
  const okCount = batch.length - failReasons.size;
  const itemsHtml = batch
    .map((s) => {
      const reason = failReasons.get(s.name);
      const cfg = s.config;
      const typeBadge = `<span class="mcp-badge mcp-badge-type">${escapeHtml(cfg.type || 'stdio')}</span>`;
      const status = reason
        ? `<span class="mcp-import-status is-failed" title="${escapeHtml(reason)}">✗ 失败</span>`
        : opts.busy
          ? `<span class="mcp-import-status is-running">…</span>`
          : `<span class="mcp-import-status is-ok">✓ 成功</span>`;
      const meta = cfg.type === 'stdio'
        ? escapeHtml([cfg.command || '', ...(cfg.args || [])].filter(Boolean).join(' '))
        : escapeHtml(cfg.url || '');
      return `
        <div class="mcp-import-item">
          <div class="mcp-import-item-name-row">
            <span class="mcp-import-item-name">${escapeHtml(s.name)}</span>
            <span class="mcp-import-item-status-row">${typeBadge}${status}</span>
          </div>
          <p class="mcp-import-item-meta">${meta}</p>
          ${reason ? `<p class="mcp-import-item-reason">${escapeHtml(reason)}</p>` : ''}
        </div>
      `;
    })
    .join('');

  const failCount = failReasons.size;
  const actionsHtml = opts.busy
    ? `<p class="mcp-import-progress-hint">正在导入 ${batch.length} 个服务器…（Esc 可取消）</p>`
    : failCount > 0
      ? `<div class="mcp-import-actions">
           <button type="button" class="mcp-dialog-btn cancel mcp-import-back">返回修改</button>
           <button type="button" class="mcp-dialog-btn primary mcp-import-retry">重试失败项（${failCount}）</button>
         </div>`
      : '';

  body.innerHTML = `
    <div class="mcp-import-preview">
      <p class="mcp-import-preview-title">${opts.busy ? `导入中：${batch.length} 个服务器` : `导入结果：成功 ${okCount}，失败 ${failCount}`}</p>
      ${itemsHtml}
    </div>
    ${actionsHtml}
  `;
  body.querySelector('.mcp-import-back')?.addEventListener('click', opts.onBack);
  body.querySelector('.mcp-import-retry')?.addEventListener('click', opts.onRetry);
}

function renderImportResult(
  body: HTMLElement,
  result: McpImportResult,
  opts: { onBack: () => void; onConfirm: (servers: ImportedMcpServer[]) => void },
): void {

  const errorsHtml =
    result.errors.length > 0
      ? `<div class="mcp-import-errors" role="alert">
           ${result.errors.map((e) => `<p class="mcp-import-error">⚠ ${escapeHtml(e)}</p>`).join('')}
         </div>`
      : '';
  const warningsHtml =
    result.warnings.length > 0
      ? `<div class="mcp-import-warnings">
           ${result.warnings.map((w) => `<p class="mcp-import-warning">ℹ ${escapeHtml(w)}</p>`).join('')}
         </div>`
      : '';

  if (result.servers.length === 0) {
    body.innerHTML = `
      ${errorsHtml}
      ${warningsHtml}
      <div class="mcp-import-actions">
        <button type="button" class="mcp-dialog-btn cancel mcp-import-back">返回修改</button>
      </div>
    `;
    body.querySelector('.mcp-import-back')?.addEventListener('click', opts.onBack);
    body.querySelector<HTMLButtonElement>('.mcp-import-back')?.focus();
    return;
  }

  const itemsHtml = result.servers
    .map((s) => {
      const cfg = s.config;
      const typeBadge = `<span class="mcp-badge mcp-badge-type">${escapeHtml(cfg.type || 'stdio')}</span>`;
      const meta = cfg.type === 'stdio'
        ? escapeHtml([cfg.command || '', ...(cfg.args || [])].filter(Boolean).join(' '))
        : escapeHtml(cfg.url || '');
      const existsBadge = s.exists
        ? '<span class="mcp-badge mcp-badge-exists">将覆盖已有配置</span>'
        : '';
      return `
        <div class="mcp-import-item">
          <div class="mcp-import-item-name-row">
            <span class="mcp-import-item-name">${escapeHtml(s.name)}</span>
            <span class="mcp-badges">${typeBadge}${existsBadge}</span>
          </div>
          <p class="mcp-import-item-meta">${meta}</p>
        </div>
      `;
    })
    .join('');

  const conflicts = result.servers.filter((s) => s.exists).length;
  const conflictHint =
    conflicts > 0
      ? `<p class="mcp-import-conflict-hint">其中 ${conflicts} 个与现有服务器同名，导入后将覆盖原配置。</p>`
      : '';

  body.innerHTML = `
    ${errorsHtml}
    ${warningsHtml}
    <div class="mcp-import-preview">
      <p class="mcp-import-preview-title">将导入 ${result.servers.length} 个服务器：</p>
      ${itemsHtml}
      ${conflictHint}
      <p class="mcp-import-note">导入将写入配置文件，本地命令会在服务器启动时执行。</p>
    </div>
    <div class="mcp-import-actions">
      <button type="button" class="mcp-dialog-btn cancel mcp-import-back">返回修改</button>
      <button type="button" class="mcp-dialog-btn primary mcp-import-confirm">导入 ${result.servers.length} 个</button>
    </div>
  `;

  body.querySelector('.mcp-import-back')?.addEventListener('click', opts.onBack);
  body.querySelector('.mcp-import-confirm')?.addEventListener('click', () => {
    opts.onConfirm(result.servers);
  });
  body.querySelector<HTMLButtonElement>('.mcp-import-confirm')?.focus();
}
