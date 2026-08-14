import { appState } from '../../state';
import type { Message, FileRef } from '../../types';
import { escapeHtml, formatTime } from '../../utils';
import { renderMarkdownCached as renderMarkdown } from '../../markdown';
import { parseFileRefs, isImageFile } from '../files';
import { parseAskUserQuestionInput } from '../permissions/ask-question';
import * as api from '../../api';
import { dedupeAdjacentDuplicateMessages } from '../conversations/normalize';
import { getFileSuggestionIcon, getImageMime, resolveFilePath, stripFileRefTags, stripFileRefsFromDisplay } from '../files/index';
export interface ToolConfig {
  displayMode: 'one-line' | 'collapsible';
  icon: string;
  label: string;
  getValue?: (input: Record<string, unknown>) => string;
  getSecondary?: (input: Record<string, unknown>) => string | undefined;
  style?: 'terminal' | 'file-open' | 'search' | 'default';
  borderColor: string;
  iconColor: string;
}

export const TOOL_CONFIG_MAP: Record<string, ToolConfig> = {
  Bash: { displayMode: 'one-line', icon: '>_', label: 'Bash', getValue: (i) => String(i.command || ''), getSecondary: (i) => i.description ? String(i.description) : undefined, style: 'terminal', borderColor: '#3fb950', iconColor: '#3fb950' },
  Read: { displayMode: 'one-line', icon: '📄', label: 'Read', getValue: (i) => String(i.file_path || ''), style: 'file-open', borderColor: '#8b949e', iconColor: '#8b949e' },
  Edit: { displayMode: 'collapsible', icon: '✏️', label: 'Edit', getValue: (i) => String(i.file_path || ''), borderColor: '#d29922', iconColor: '#d29922' },
  Write: { displayMode: 'collapsible', icon: '📝', label: 'Write', getValue: (i) => String(i.file_path || ''), borderColor: '#d29922', iconColor: '#d29922' },
  Grep: { displayMode: 'one-line', icon: '🔍', label: 'Grep', getValue: (i) => String(i.pattern || ''), style: 'search', borderColor: '#8b949e', iconColor: '#8b949e' },
  Glob: { displayMode: 'one-line', icon: '🔍', label: 'Glob', getValue: (i) => String(i.pattern || ''), style: 'search', borderColor: '#8b949e', iconColor: '#8b949e' },
  Task: { displayMode: 'collapsible', icon: '🤖', label: 'Subagent', getValue: (i) => String(i.description || i.prompt || '').substring(0, 80), borderColor: '#a371f7', iconColor: '#a371f7' },
  TodoWrite: { displayMode: 'collapsible', icon: '✅', label: 'TodoWrite', getValue: (i) => { const todos = Array.isArray(i.todos) ? (i.todos as Array<Record<string, unknown>>) : []; const done = todos.filter((t) => t?.status === 'completed').length; return `任务 ${done}/${todos.length}`; }, getSecondary: (i) => { const todos = Array.isArray(i.todos) ? (i.todos as Array<Record<string, unknown>>) : []; const inProg = todos.filter((t) => t?.status === 'in_progress').length; return inProg > 0 ? `${inProg} 个进行中` : undefined; }, borderColor: '#a371f7', iconColor: '#a371f7' },
  TaskCreate: { displayMode: 'one-line', icon: '📋', label: 'Task', getValue: (i) => String(i.subject || ''), getSecondary: (i) => i.activeForm ? String(i.activeForm) : undefined, borderColor: '#a371f7', iconColor: '#a371f7' },
  TaskUpdate: { displayMode: 'one-line', icon: '📋', label: 'Task', getValue: (i) => String(i.subject || ''), getSecondary: (i) => i.status ? String(i.status) : undefined, borderColor: '#a371f7', iconColor: '#a371f7' },
  AskUserQuestion: { displayMode: 'collapsible', icon: '❓', label: 'Question', borderColor: '#58a6ff', iconColor: '#58a6ff' },
  exit_plan_mode: { displayMode: 'collapsible', icon: '📐', label: 'Plan', borderColor: '#7b8cff', iconColor: '#7b8cff' },
  ExitPlanMode: { displayMode: 'collapsible', icon: '📐', label: 'Plan', borderColor: '#7b8cff', iconColor: '#7b8cff' },
};

export function getDefaultToolConfig(): ToolConfig {
  return { displayMode: 'one-line', icon: '🔧', label: 'Tool', borderColor: '#8b949e', iconColor: '#8b949e' };
}

/** 解析 JSON，失败返回 null */
export function tryParseJson(text: string): Record<string, unknown> | null {
  try {
    const trimmed = text.trim();
    if (!trimmed.startsWith('{')) return null;
    return JSON.parse(trimmed);
  } catch {
    return null;
  }
}

/** 提取工具名称 */
export function extractToolName(content: string): string {
  const json = tryParseJson(content);
  return json ? String(json.tool_name || json.tool || json.name || '') : '';
}

/** 提取 tool_use id */
export function extractToolUseId(content: string): string {
  const json = tryParseJson(content);
  if (!json) return '';
  return String(json.id || json.tool_use_id || json.toolUseId || '');
}

/** 提取工具输入 */
export function extractToolInput(content: string): Record<string, unknown> {
  const json = tryParseJson(content);
  if (!json) return {};
  return (json.tool_input || json.input || json.arguments || {}) as Record<string, unknown>;
}

function stringifyToolResultContent(raw: unknown): string {
  if (raw == null) return '';
  if (typeof raw === 'string') return raw;
  if (Array.isArray(raw)) {
    return raw
      .map((item) => {
        if (typeof item === 'string') return item;
        if (item && typeof item === 'object' && 'text' in item) {
          return String((item as { text?: unknown }).text ?? '');
        }
        return JSON.stringify(item);
      })
      .filter(Boolean)
      .join('\n');
  }
  if (typeof raw === 'object') return JSON.stringify(raw, null, 2);
  return String(raw);
}

/** 提取工具结果文本 */
export function extractToolResult(content: string): {
  text: string;
  isError: boolean;
  toolUseResult?: Record<string, unknown>;
  toolUseId?: string;
} {
  const json = tryParseJson(content);
  if (!json) return { text: content, isError: false };
  const text = stringifyToolResultContent(json.content ?? json.output ?? json.result ?? '');
  const isError = Boolean(json.is_error || json.isError);
  const toolUseResult =
    json.toolUseResult && typeof json.toolUseResult === 'object'
      ? (json.toolUseResult as Record<string, unknown>)
      : undefined;
  const toolUseId = String(json.tool_use_id || json.toolUseId || '');
  return { text, isError, toolUseResult, toolUseId: toolUseId || undefined };
}

/**
 * 渲染 AskUserQuestion 卡片
 * pending+interactive：对话流内可直接点选；否则只读展示
 */
export function renderAskUserQuestionCardHtml(
  input: unknown,
  answers?: Record<string, string> | null,
  pending = false,
  interactive = false,
  requestId = '',
): string {
  const parsed = parseAskUserQuestionInput(input);
  if (!parsed) {
    return `<div class="ask-card"><div class="ask-card-empty">无法解析互动问题</div></div>`;
  }

  const blocks = parsed.questions
    .map((q, qIndex) => {
      const selectedRaw = answers?.[q.question] || '';
      const selectedSet = new Set(
        selectedRaw
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean),
      );
      const inputType = q.multiSelect ? 'checkbox' : 'radio';
      const name = `ask-q-${qIndex}`;

      const optionsHtml = q.options
        .map((opt, oIndex) => {
          const isSelected = selectedSet.has(opt.label);
          const hasDesc = Boolean(opt.description);
          const desc = hasDesc ? opt.description! : opt.label;
          if (interactive) {
            const idSafe = requestId.replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 12);
            const id = `${name}-opt-${oIndex}-${idSafe}`;
            return `
              <label class="ask-option${isSelected ? ' is-selected' : ''}" for="${id}">
                <input
                  type="${inputType}"
                  id="${id}"
                  name="${name}"
                  value="${escapeHtml(opt.label)}"
                  data-q-index="${qIndex}"
                />
                <div class="ask-option-top">
                  <span class="ask-option-label">${escapeHtml(opt.label)}</span>
                </div>
                <div class="ask-option-desc">${escapeHtml(desc)}</div>
              </label>
            `;
          }
          return `
            <div class="ask-option${isSelected ? ' is-selected' : ''}">
              <div class="ask-option-top">
                <span class="ask-option-label">${escapeHtml(opt.label)}</span>
                ${isSelected ? '<span class="ask-option-check" aria-hidden="true">✓</span>' : ''}
              </div>
              <div class="ask-option-desc">${escapeHtml(desc)}</div>
            </div>
          `;
        })
        .join('');

      const otherAnswer =
        selectedRaw && !q.options.some((o) => selectedSet.has(o.label))
          ? selectedRaw
          : selectedSet.size > 0 &&
              [...selectedSet].some((s) => !q.options.some((o) => o.label === s))
            ? [...selectedSet].filter((s) => !q.options.some((o) => o.label === s)).join(', ')
            : '';

      const otherHtml = interactive
        ? (() => {
            const idSafe = requestId.replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 12);
            const otherId = `${name}-other-${idSafe}`;
            return `
              <label class="ask-option ask-option-other" for="${otherId}">
                <input
                  type="${inputType}"
                  id="${otherId}"
                  name="${name}"
                  value="__other__"
                  data-q-index="${qIndex}"
                  data-other="1"
                />
                <div class="ask-option-top">
                  <span class="ask-option-label">其他</span>
                </div>
                <div class="ask-option-desc">在下方输入框填写</div>
              </label>
            `;
          })()
        : otherAnswer
          ? `<div class="ask-option is-selected ask-option-other-result">
               <div class="ask-option-top">
                 <span class="ask-option-label">其他</span>
                 <span class="ask-option-check" aria-hidden="true">✓</span>
               </div>
               <div class="ask-option-desc">${escapeHtml(otherAnswer)}</div>
             </div>`
          : '';

      return `
        <section class="ask-block" data-q-index="${qIndex}">
          <div class="ask-question-row">
            ${q.header ? `<span class="ask-header">${escapeHtml(q.header)}</span>` : ''}
            <p class="ask-question">${escapeHtml(q.question)}</p>
          </div>
          <div class="ask-options">${optionsHtml}${otherHtml}</div>
        </section>
      `;
    })
    .join('');

  const actionsHtml = interactive
    ? `<div class="ask-card-actions">
         <button type="button" class="interaction-btn ghost" data-ask-action="deny">跳过</button>
         <button type="button" class="interaction-btn primary" data-ask-action="submit">提交</button>
       </div>`
    : `<span class="ask-card-status">${pending ? '等待你的选择…' : answers ? '已选择' : '已提问'}</span>`;

  return `
    <div
      class="ask-card${pending ? ' is-pending' : ''}${answers ? ' is-answered' : ''}${interactive ? ' is-interactive' : ''}"
      ${interactive ? `data-ask-request-id="${escapeHtml(requestId)}"` : ''}
    >
      <div class="ask-card-bar">
        <span class="ask-card-badge">互动</span>
        ${actionsHtml}
      </div>
      ${blocks}
      ${interactive ? '<p class="ask-error" hidden></p>' : ''}
    </div>
  `;
}

/** 合并相邻的同类型消息（连续 assistant 文本或连续 thinking） */
export function mergeAdjacentSameRole(messages: Message[]): Message[] {
  if (messages.length === 0) return [];
  const result: Message[] = [messages[0]];

  for (let i = 1; i < messages.length; i++) {
    const prev = result[result.length - 1];
    const curr = messages[i];

    // 相邻同角色 assistant（无 thinking 字段的纯文本消息）→ 合并并完整保留内容
    if (
      prev.role === 'assistant' && curr.role === 'assistant'
      && !prev.thinking && !curr.thinking
    ) {
      prev.content = prev.content + '\n\n' + curr.content;
      continue;
    }

    // 相邻 thinking 消息 → 合并
    if (prev.role === 'thinking' && curr.role === 'thinking') {
      prev.content = prev.content + '\n' + curr.content;
      continue;
    }

    result.push(curr);
  }

  return result;
}

interface ToolResultMeta {
  text: string;
  isError: boolean;
  toolUseResult?: Record<string, unknown>;
}

/**
 * 将 tool_use 和 tool_result 配对处理，生成内嵌工具消息。
 *
 * 结果驱动单遍配对：每个结果只解析一次，按流顺序配对其「之前最早、未配对、合规」的 tool_use，
 * 替代原先对每个 tool_use 的前向扫描（工具密集会话最坏 O(N²) 次 extractToolResult）。
 * 语义与原实现一致：带 id 的结果配同 id 或无 id 的 tool_use（取最早）；无 id 的结果配最早未配对的 tool_use。
 */
export function processToolMessages(messages: Message[]): Message[] {
  const result: Message[] = [];

  // —— 预扫描：结果索引（每个结果只解析一次）——
  const resultMetaByIndex = new Map<number, ToolResultMeta>();
  const resultIdByIndex = new Map<number, string>();
  const resultById = new Map<string, number[]>();
  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];
    if (msg.role !== 'tool_result') continue;
    const resData = extractToolResult(msg.content);
    resultMetaByIndex.set(i, {
      text: resData.text,
      isError: resData.isError,
      toolUseResult: resData.toolUseResult,
    });
    if (resData.toolUseId) {
      resultIdByIndex.set(i, resData.toolUseId);
      const arr = resultById.get(resData.toolUseId);
      if (arr) arr.push(i);
      else resultById.set(resData.toolUseId, [i]);
    }
  }

  // —— 结果驱动配对 ——
  const pairedToolUse = new Set<number>();
  const resultForToolUse = new Map<number, ToolResultMeta>();
  const toolUseById = new Map<string, number[]>(); // id -> 未配对 tool_use 下标（流顺序）
  const idlessToolUses: number[] = []; // 无 id 的未配对 tool_use 下标（流顺序）
  const allToolUses: number[] = []; // 全部 tool_use 下标（流顺序），供无 id 结果取最早
  let idlessHead = 0;
  let allHead = 0;
  const byIdHead = new Map<string, number>();

  const nextUnpaired = (arr: number[], head: number): number => {
    while (head < arr.length && pairedToolUse.has(arr[head])) head++;
    return head;
  };

  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];
    if (msg.role === 'tool_use') {
      const tid = extractToolUseId(msg.content);
      allToolUses.push(i);
      if (tid) {
        const arr = toolUseById.get(tid);
        if (arr) arr.push(i);
        else {
          toolUseById.set(tid, [i]);
          byIdHead.set(tid, 0);
        }
      } else {
        idlessToolUses.push(i);
      }
      continue;
    }
    if (msg.role !== 'tool_result') continue;

    const meta = resultMetaByIndex.get(i);
    if (!meta) continue;
    const tid = resultIdByIndex.get(i);

    let bestIdx: number | null = null;
    if (tid) {
      // 带 id 的结果：同 id 的 tool_use 或任意无 id 的 tool_use，取流顺序最早者
      const sameIdArr = toolUseById.get(tid);
      if (sameIdArr) {
        const h = nextUnpaired(sameIdArr, byIdHead.get(tid) ?? 0);
        byIdHead.set(tid, h);
        if (h < sameIdArr.length) bestIdx = sameIdArr[h];
      }
      const h2 = nextUnpaired(idlessToolUses, idlessHead);
      idlessHead = h2;
      if (h2 < idlessToolUses.length && (bestIdx === null || idlessToolUses[h2] < bestIdx)) {
        bestIdx = idlessToolUses[h2];
      }
    } else {
      // 无 id 的结果：配对最早未配对的 tool_use（任意 id）
      const h = nextUnpaired(allToolUses, allHead);
      allHead = h;
      if (h < allToolUses.length) bestIdx = allToolUses[h];
    }

    if (bestIdx !== null) {
      pairedToolUse.add(bestIdx);
      resultForToolUse.set(bestIdx, meta);
    }
  }

  // —— 输出：按流顺序，tool_use 位输出合并后的工具消息，tool_result 跳过 ——
  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];
    if (msg.role === 'tool_result') continue;

    if (msg.role === 'tool_use') {
      const toolName = extractToolName(msg.content);
      const toolInput = extractToolInput(msg.content);
      const toolUseId = extractToolUseId(msg.content);
      const config = TOOL_CONFIG_MAP[toolName] || getDefaultToolConfig();
      const paired = resultForToolUse.get(i);
      const toolResult = paired?.text;
      const isError = paired?.isError ?? false;
      const toolUseResult = paired?.toolUseResult;

      // AskUserQuestion：把 answers 并入 toolInput，供专用卡片渲染
      let mergedInput = toolInput;
      if (toolName === 'AskUserQuestion' && toolUseResult) {
        mergedInput = {
          ...toolInput,
          answers: toolUseResult.answers,
          questions: toolUseResult.questions || toolInput.questions,
        };
      }

      const toolMsg: Message = {
        id: msg.id,
        role: 'tool',
        content: mergedInput ? JSON.stringify(mergedInput) : msg.content,
        timestamp: msg.timestamp,
        toolData: {
          toolName,
          toolInput: mergedInput,
          toolResult,
          isError,
          toolUseId: toolUseId || undefined,
          displayMode: config.displayMode,
          colorScheme: {
            border: config.borderColor,
            icon: config.iconColor,
            primary: config.borderColor,
          },
        },
      };
      result.push(toolMsg);
      continue;
    }

    result.push(msg);
  }

  return result;
}

export function filterVisibleMessages(messages: Message[]): Message[] {
  // tool_use/tool_result 已在 processToolMessages 中合并为内嵌工具消息，此处不再处理

  return messages.filter((msg) => {
    // 过滤内部系统消息
    const trimmed = msg.content.trim();
    if (
      trimmed.startsWith('<system-reminder>')
      || trimmed.startsWith('<local-command-caveat>')
      || trimmed.startsWith('<command-name>')
      || trimmed.startsWith('<local-command-stdout>')
    ) {
      return false;
    }

    // thinking 消息始终显示（参考 claudecodeui: isThinking 消息作为独立 Reasoning accordion 渲染）
    if (msg.role === 'thinking') return true;

    return true;
  });
}

/** 大脑图标 SVG */
export function renderBrainIconHtml(): string {
  return `<svg class="thinking-brain-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
    <path d="M12 5a3 3 0 1 0-5.997.125 4 4 0 0 0-2.526 5.77 4 4 0 0 0 .556 6.588A4 4 0 1 0 12 18Z"/>
    <path d="M12 5a3 3 0 1 1 5.997.125 4 4 0 0 1 2.526 5.77 4 4 0 0 1-.556 6.588A4 4 0 1 1 12 18Z"/>
    <path d="M15 13a4.5 4.5 0 0 1-3-4 4.5 4.5 0 0 1-3 4"/>
    <path d="M17.599 6.5a3 3 0 0 0 .399-1.375"/>
    <path d="M6.003 5.125A3 3 0 0 0 6.401 6.5"/>
    <path d="M3.477 10.896a4 4 0 0 1 .585-.396"/>
    <path d="M19.938 10.5a4 4 0 0 1 .585.396"/>
    <path d="M6 18a4 4 0 0 1-1.967-.516"/>
    <path d="M19.967 17.484A4 4 0 0 1 18 18"/>
  </svg>`;
}

/** 下箭头 SVG */
export function renderChevronDownIconHtml(): string {
  return `<svg class="thinking-chevron" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
    <polyline points="6 9 12 15 18 9"></polyline>
  </svg>`;
}

export function renderThinkingDetails(thinking: string, label: string, expanded: boolean, dataId?: string, isStreaming: boolean = false): string {
  const openAttr = expanded ? ' open' : '';
  const dataAttr = dataId ? ` data-thinking-id="${escapeHtml(dataId)}"` : '';
  const streamClass = isStreaming ? ' streaming-active' : '';
  const durationText = isStreaming ? '' : '<span class="thinking-duration">思考完成</span>';
  return `
    <details class="thinking-block${streamClass}"${openAttr}${dataAttr}>
      <summary class="thinking-summary">
        ${renderBrainIconHtml()}
        <span class="thinking-label"><span class="thinking-label-text">${escapeHtml(label)}</span></span>
        ${durationText}
        ${renderChevronDownIconHtml()}
      </summary>
      <div class="thinking-content-wrapper">
        <div class="thinking-content-inner">
          <div class="thinking-content-scroll">
            <div class="thinking-content"><pre>${escapeHtml(thinking)}</pre></div>
          </div>
        </div>
      </div>
    </details>
  `;
}

/** 渲染工具消息 HTML */
export function renderToolMessageHtml(msg: Message): string {
  const td = msg.toolData;
  if (!td) return '';

  const { toolName, toolInput, toolResult, isError, displayMode, colorScheme } = td;
  const isRunning = toolResult === undefined;
  const hasResult = toolResult !== undefined && toolResult !== '';
  const statusBadge = isRunning
    ? '<span class="tool-status tool-status-running">运行中</span>'
    : isError
      ? '<span class="tool-status tool-status-error">错误</span>'
      : '<span class="tool-status tool-status-done">完成</span>';

  // One-line 显示（Bash、Read、Grep、Glob 等简单工具）
  if (displayMode === 'one-line') {
    const config = TOOL_CONFIG_MAP[toolName] || getDefaultToolConfig();
    const value = config.getValue ? config.getValue(toolInput) : toolName;
    const secondary = config.getSecondary ? config.getSecondary(toolInput) : undefined;
    const styleClass = config.style ? `tool-oneline-${config.style}` : 'tool-oneline-default';

    let oneLineHtml = '';
    if (config.style === 'terminal') {
      oneLineHtml = `<span class="tool-cmd-prefix">$</span> <code class="tool-cmd-text">${escapeHtml(value)}</code>`;
    } else if (config.style === 'file-open') {
      oneLineHtml = `<span class="tool-file-link">📄 ${escapeHtml(value)}</span>`;
    } else if (config.style === 'search') {
      oneLineHtml = `<span class="tool-search-pattern">${escapeHtml(value)}</span>`;
    } else {
      oneLineHtml = `<span>${escapeHtml(value || toolName)}</span>`;
    }

    const secondaryHtml = secondary ? `<span class="tool-secondary">${escapeHtml(secondary)}</span>` : '';

    const toolContent = `
      <div class="tool-card" style="border-left-color: ${colorScheme.border}">
        <div class="tool-card-header">
          <span class="tool-icon" style="color: ${colorScheme.icon}">${escapeHtml(config.icon)}</span>
          <span class="tool-label">${escapeHtml(config.label)}</span>
          ${secondaryHtml}
          ${statusBadge}
        </div>
        <div class="tool-card-body ${styleClass}">
          ${oneLineHtml}
        </div>
        ${hasResult ? `<div class="tool-card-result"><div class="markdown-body">${renderMarkdown(toolResult!)}</div></div>` : ''}
      </div>`;
    return toolContent;
  }

  // 可折叠显示（Edit、Write、Task、Plan 等复杂工具）
  const config = TOOL_CONFIG_MAP[toolName] || getDefaultToolConfig();
  const value = config.getValue ? config.getValue(toolInput) : undefined;
  const titleText = value || toolName;

  let inputPreview = '';
  if (toolInput && Object.keys(toolInput).length > 0) {
    const previewObj: Record<string, unknown> = {};
    // 只显示关键字段
    for (const key of ['file_path', 'old_string', 'new_string', 'prompt', 'description', 'subject', 'question']) {
      if (key in toolInput) {
        const val = toolInput[key];
        if (typeof val === 'string' && val.length > 200) {
          previewObj[key] = (val as string).substring(0, 200) + '...';
        } else {
          previewObj[key] = val;
        }
      }
    }
    if (Object.keys(previewObj).length > 0) {
      inputPreview = `<pre class="tool-input-preview"><code>${escapeHtml(JSON.stringify(previewObj, null, 2))}</code></pre>`;
    }
  }

  const expanded = isRunning ? ' open' : '';
  const toolContent = `
    <div class="tool-card" style="border-left-color: ${colorScheme.border}">
      <details class="tool-collapsible"${expanded}>
        <summary class="tool-card-header tool-collapsible-summary">
          <span class="tool-icon" style="color: ${colorScheme.icon}">${escapeHtml(config.icon)}</span>
          <span class="tool-label">${escapeHtml(config.label)}</span>
          <span class="tool-title-text">${escapeHtml(titleText)}</span>
          ${statusBadge}
          <span class="tool-chevron">▾</span>
        </summary>
        <div class="tool-card-body">
          ${inputPreview}
          ${hasResult
            ? `<div class="tool-card-result"><div class="markdown-body">${renderMarkdown(toolResult!)}</div></div>`
            : isRunning
              ? '<div class="tool-running-indicator"><span class="pending-dot"></span><span class="pending-dot"></span><span class="pending-dot"></span></div>'
              : ''}
        </div>
      </details>
    </div>`;
  return toolContent;
}

export function renderMessageHtml(msg: Message, prevRole?: string, showUndo = false): string {
  if (msg.role === 'tool') {
    if (msg.toolData?.toolName === 'AskUserQuestion') {
      const input = msg.toolData.toolInput || {};
      const answers =
        input.answers && typeof input.answers === 'object'
          ? (input.answers as Record<string, string>)
          : null;
      const isPending = msg.id.startsWith('pending-ask-') && !answers;
      const requestId = isPending ? msg.id.replace(/^pending-ask-/, '') : '';
      const interactive = isPending && !!requestId;
      return `<div class="message tool ask-message">${renderAskUserQuestionCardHtml(
        input,
        answers,
        isPending,
        interactive,
        requestId,
      )}</div>`;
    }
    return renderToolMessageHtml(msg);
  }

  if (msg.role === 'error') {
    return `
      <div class="message error">
        <div class="message-content message-error-content">
          <div class="message-error-title">调用失败</div>
          <div class="markdown-body">${renderMarkdown(msg.content)}</div>
          <div class="message-footer">
            <div class="message-time">${formatTime(msg.timestamp)}</div>
          </div>
        </div>
      </div>
    `;
  }

  const isThinking = msg.role === 'thinking';
  const roleClass = isThinking ? 'assistant thinking-msg' : msg.role;

  let thinkingHtml = '';
  let contentHtml = '';
  // 默认折叠，只有用户手动展开过才展开（匹配 claudecodeui defaultOpen=false）
  const thinkingExpanded = appState.expandedThinkingBlocks.has(msg.id);

  if (isThinking && msg.content.trim()) {
    thinkingHtml = renderThinkingDetails(msg.content, '思考过程', thinkingExpanded, msg.id);
  } else {
    // 助手消息中合并的思考过程
    if (msg.thinking && msg.thinking.trim()) {
      thinkingHtml = renderThinkingDetails(msg.thinking, '思考过程', thinkingExpanded, msg.id);
    }
    if (msg.content.trim()) {
      // 用户消息：剥离 @文件路径引用和 @File[] 标签后再渲染（芯片已展示文件信息）
      const renderContent = msg.role === 'user'
        ? stripFileRefTags(stripFileRefsFromDisplay(msg.content))
        : msg.content;
      if (renderContent.trim()) {
        contentHtml = `<div class="markdown-body">${renderMarkdown(renderContent)}</div>`;
      }
    }
  }

  // 用户消息：从内容中解析 @File[] 引用生成文件芯片
  const fileRefChips = msg.role === 'user' ? parseFileRefs(msg.content) : [];
  const userRefs = fileRefChips.length > 0
    ? renderFileRefChipsHtml(fileRefChips)
    : (msg.role === 'user' && msg.refs && msg.refs.length > 0
      ? renderFileRefChipsHtml(msg.refs)
      : '');

  // 消息复制控件（非思考消息且有内容时显示）
  let copyControlHtml = '';
  if (!isThinking && msg.content.trim()) {
    const escapedContent = escapeHtml(msg.content);
    copyControlHtml = `
      <div class="msg-copy-control">
        <button type="button" class="msg-copy-btn" data-copy-content="${escapedContent}" title="复制消息" aria-label="复制消息">
          <svg class="msg-copy-icon-svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect>
            <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path>
          </svg>
        </button>
      </div>`;
  }

  const isGrouped = prevRole && prevRole === msg.role && (msg.role === 'user' || msg.role === 'assistant' || msg.role === 'tool');
  const groupedClass = isGrouped ? ' grouped' : '';

  // 助手/思考消息：全宽布局，无头像
  if (msg.role === 'assistant' || isThinking) {
    return `
      <div class="message ${roleClass}${groupedClass}">
        <div class="message-content">
          ${thinkingHtml}
          ${contentHtml}
          <div class="message-footer">
            ${copyControlHtml}
            <div class="message-time">${formatTime(msg.timestamp)}</div>
          </div>
        </div>
      </div>
    `;
  }

  // 用户消息：蓝色气泡（复制 / 时间在气泡外，悬浮显示）
  // 撤回按钮（仅最后一条用户消息，hover 显示）
  const undoHtml = showUndo ? `
    <button type="button" class="msg-action-btn msg-retry-btn"
      data-action="undo" title="撤回此消息" aria-label="撤回此消息">
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
        <polyline points="1 4 1 10 7 10"></polyline>
        <path d="M3.51 15a9 9 0 1 0 2.13-9.36L1 10"></path>
      </svg>
    </button>` : '';
  return `
    <div class="message ${roleClass}${groupedClass}">
      <div class="message-content">
        ${userRefs}
        ${thinkingHtml}
        ${contentHtml}
      </div>
      <div class="message-footer message-footer-user">
        ${undoHtml}
        ${copyControlHtml}
        <div class="message-time">${formatTime(msg.timestamp)}</div>
      </div>
    </div>
  `;
}

/** 完整消息处理管线：处理工具 → 过滤不可见 → 合并相邻助手（含去重）→ 渲染 HTML */
export function renderMessageListHtml(messages: Message[]): string {
  const isRunning = appState.activeConversationId ? appState.runningSessions.has(appState.activeConversationId) : false;
  // 先处理/过滤工具，再合并相邻助手，避免「助手-工具-助手」过滤后露出重复答案
  const processed = mergeAdjacentSameRole(
    dedupeAdjacentDuplicateMessages(filterVisibleMessages(processToolMessages(messages))),
  );
  // 提前计算最后一条用户消息索引，避免在 .map() 内部 O(n²) 重复计算
  const lastUserIdx = processed.map(m => m.role).lastIndexOf('user');
  return processed
    .map((msg, idx, arr) => {
      // 撤回按钮始终显示在最后一条用户消息上，即使后面还有 AI 回复
      // 点击撤回会删除该用户提问 + 所有后续回答
      const showUndo = !isRunning && idx === lastUserIdx;
      return renderMessageHtml(msg, idx > 0 ? arr[idx - 1].role : undefined, showUndo);
    })
    .join('');
}

export function renderFileRefChipsHtml(refs: FileRef[]): string {
  // 为图片文件异步预加载缩略图
  setTimeout(() => {
    const chips = document.querySelectorAll<HTMLElement>('.file-ref-chip[data-file-path] img.file-ref-chip-thumb');
    chips.forEach(async (img) => {
      const filePath = ((img as HTMLElement).parentElement as HTMLElement)?.dataset.filePath;
      if (!filePath || img.getAttribute('src') !== '') return;
      try {
        // 绝对路径直接使用，相对路径拼接项目目录
        const fullPath = resolveFilePath(filePath);
        const mime = getImageMime(filePath);
        const b64 = await api.readFileBase64(fullPath );
        (img as HTMLImageElement).src = `data:${mime};base64,${b64}`;
      } catch { /* 加载缩略图失败，保持空状态 */ }
    });
  }, 100);

  return `
    <div class="file-ref-chips">
      ${refs
        .map(
          (ref) => {
            const icon = getFileSuggestionIcon(ref.path);
            const isImg = isImageFile(ref.path);
            // 提取文件名（去掉尾部斜杠用于目录）
            const cleanPath = ref.path.replace(/\/$/, '');
            const parts = cleanPath.split(/[/\\]/).filter(Boolean);
            const fileName = ref.path.endsWith('/') ? parts[parts.length - 1] + '/' : (parts[parts.length - 1] || ref.path);
            return `
        <span class="file-ref-chip${isImg ? ' file-ref-chip--image' : ''}" title="${escapeHtml(ref.path)}" data-file-path="${escapeHtml(ref.path)}">
          ${isImg ? `<img class="file-ref-chip-thumb" src="" alt="" loading="lazy" />` : `<span class="file-ref-chip-icon">${icon}</span>`}
          <span class="file-ref-chip-path">${escapeHtml(fileName)}</span>
        </span>`;
          },
        )
        .join('')}
    </div>`;
}

