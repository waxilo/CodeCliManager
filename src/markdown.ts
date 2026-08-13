import DOMPurify from 'dompurify';
import { marked } from 'marked';
import hljs from 'highlight.js';

// 使用 GitHub Dark 风格主题
import 'highlight.js/styles/github-dark.css';

// 配置 marked，集成 highlight.js 语法高亮
marked.setOptions({
  gfm: true,
  breaks: true,
});

// 自定义 renderer：为代码块添加语言标记和复制按钮容器
const renderer = new marked.Renderer();

renderer.code = function (codeObj: { text: string; lang?: string; escaped?: boolean }): string {
  const code = codeObj.text;
  const lang = (codeObj.lang || '').trim();
  let highlighted: string;

  if (lang && hljs.getLanguage(lang)) {
    try {
      highlighted = hljs.highlight(code, { language: lang }).value;
    } catch {
      highlighted = hljs.highlightAuto(code).value;
    }
  } else {
    highlighted = hljs.highlightAuto(code).value;
  }

  const escapedCode = escapeAttr(code);
  // 语言标签来自围栏内容，用户/模型可控；转义后再拼入类名与角标，防止属性注入
  const langLabel = escapeAttr(lang) || 'text';
  const langBadge = lang && lang !== 'text'
    ? `<span class="code-lang-badge">${langLabel}</span>`
    : '';

  return `
    <div class="code-block-wrapper">
      <div class="code-block-header">
        ${langBadge}
        ${renderCodeCopyButton(escapedCode)}
      </div>
      <pre><code class="hljs language-${langLabel}">${highlighted}</code></pre>
    </div>
  `;
};

renderer.link = function (linkObj: { href: string; title?: string | null; text: string }): string {
  const href = linkObj.href;
  const title = linkObj.title ? ` title="${escapeAttr(linkObj.title)}"` : '';
  return `<a href="${href}"${title} target="_blank" rel="noopener noreferrer">${linkObj.text}</a>`;
};

marked.use({ renderer });

/**
 * 复制文本到剪贴板（自动降级：navigator.clipboard → execCommand）
 * @returns 是否复制成功
 */
export async function copyToClipboard(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    try {
      const textarea = document.createElement('textarea');
      textarea.value = text;
      textarea.style.position = 'fixed';
      textarea.style.opacity = '0';
      document.body.appendChild(textarea);
      textarea.select();
      document.execCommand('copy');
      document.body.removeChild(textarea);
      return true;
    } catch {
      return false;
    }
  }
}

/** 复制按钮的勾选图标（已复制） */
const CHECK_ICON = '<polyline points="20 6 9 17 4 12"></polyline>';
/** 复制按钮的默认图标 */
const COPY_ICON = '<rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path>';

/** 生成代码块复制按钮 HTML */
function renderCodeCopyButton(escapedCode: string): string {
  return `
    <button type="button" class="code-copy-btn" data-code="${escapedCode}" title="复制代码">
      <svg class="code-copy-icon" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
        ${COPY_ICON}
      </svg>
      <span class="code-copy-text">复制</span>
    </button>`;
}

/** 对代码内容进行 HTML 属性转义 */
function escapeAttr(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/**
 * 初始化代码复制按钮事件（在 DOM 插入后调用）
 */
export function initCodeCopyButtons(container: HTMLElement): void {
  container.querySelectorAll('.code-copy-btn').forEach((btn) => {
    // 避免重复绑定
    if ((btn as HTMLElement).dataset.bound === '1') return;
    (btn as HTMLElement).dataset.bound = '1';

    btn.addEventListener('click', async () => {
      const code = (btn as HTMLElement).dataset.code || '';
      const ok = await copyToClipboard(code);
      if (!ok) return;

      const icon = btn.querySelector('.code-copy-icon') as HTMLElement | null;
      const text = btn.querySelector('.code-copy-text') as HTMLElement | null;

      if (icon) {
        icon.innerHTML = CHECK_ICON;
        icon.setAttribute('stroke', 'currentColor');
        icon.setAttribute('fill', 'none');
      }
      if (text) text.textContent = '已复制';
      btn.classList.add('copied');

      setTimeout(() => {
        if (icon) icon.innerHTML = COPY_ICON;
        if (text) text.textContent = '复制';
        btn.classList.remove('copied');
      }, 2000);
    });
  });
}

/**
 * 检测内容是否为 JSON 并返回格式化后的 HTML
 */
function tryFormatJson(text: string): string | null {
  const trimmed = text.trim();
  if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) return null;

  try {
    const parsed = JSON.parse(trimmed);
    const formatted = JSON.stringify(parsed, null, 2);
    const highlighted = hljs.highlight(formatted, { language: 'json' }).value;
    const escapedCode = escapeAttr(formatted);
    return `
      <div class="code-block-wrapper json-block">
        <div class="code-block-header">
          <span class="code-lang-badge">json</span>
          ${renderCodeCopyButton(escapedCode)}
        </div>
        <pre><code class="hljs language-json">${highlighted}</code></pre>
      </div>
    `;
  } catch {
    return null;
  }
}

/**
 * 渲染 Markdown 为带语法高亮的 HTML，自动检测 JSON 内容
 */
export function renderMarkdown(text: string): string {
  // 先尝试 JSON 自动检测
  const jsonHtml = tryFormatJson(text);
  if (jsonHtml) return jsonHtml;

  const raw = marked.parse(text, { async: false }) as string;
  return DOMPurify.sanitize(raw, {
    USE_PROFILES: { html: true },
    ADD_ATTR: ['data-code', 'data-bound', 'target', 'rel', 'class'],
  });
}

// Markdown 渲染缓存：避免对相同内容重复调用 marked.parse + DOMPurify
const _mdCache = new Map<string, string>();
const _MD_CACHE_MAX = 3000;

/** 带 LRU 缓存的 Markdown 渲染 */
export function renderMarkdownCached(src: string): string {
  const cached = _mdCache.get(src);
  if (cached !== undefined) return cached;
  const html = renderMarkdown(src);
  if (_mdCache.size >= _MD_CACHE_MAX) {
    // 简单 LRU：删除最早的条目
    const firstKey = _mdCache.keys().next().value;
    if (firstKey !== undefined) _mdCache.delete(firstKey);
  }
  _mdCache.set(src, html);
  return html;
}
