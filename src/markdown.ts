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

  // 转义代码内容用于 data 属性
  const escapedCode = code.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

  const langLabel = lang || 'text';
  const langBadge = lang && lang !== 'text'
    ? `<span class="code-lang-badge">${langLabel}</span>`
    : '';

  return `
    <div class="code-block-wrapper">
      <div class="code-block-header">
        ${langBadge}
        <button type="button" class="code-copy-btn" data-code="${escapedCode}" title="复制代码">
          <svg class="code-copy-icon" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect>
            <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path>
          </svg>
          <span class="code-copy-text">复制</span>
        </button>
      </div>
      <pre><code class="hljs language-${langLabel}">${highlighted}</code></pre>
    </div>
  `;
};

marked.use({ renderer });

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
      try {
        await navigator.clipboard.writeText(code);
        const icon = btn.querySelector('.code-copy-icon') as HTMLElement | null;
        const text = btn.querySelector('.code-copy-text') as HTMLElement | null;

        // 切换为勾选图标
        if (icon) {
          icon.innerHTML = '<polyline points="20 6 9 17 4 12"></polyline>';
          icon.setAttribute('stroke', 'currentColor');
          icon.setAttribute('fill', 'none');
        }
        if (text) text.textContent = '已复制';
        btn.classList.add('copied');

        setTimeout(() => {
          if (icon) {
            icon.innerHTML = '<rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path>';
          }
          if (text) text.textContent = '复制';
          btn.classList.remove('copied');
        }, 2000);
      } catch {
        // 降级方案：使用 textarea
        const textarea = document.createElement('textarea');
        textarea.value = code;
        textarea.style.position = 'fixed';
        textarea.style.opacity = '0';
        document.body.appendChild(textarea);
        textarea.select();
        document.execCommand('copy');
        document.body.removeChild(textarea);
      }
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
    const escapedCode = formatted.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    return `
      <div class="code-block-wrapper json-block">
        <div class="code-block-header">
          <span class="code-lang-badge">json</span>
          <button type="button" class="code-copy-btn" data-code="${escapedCode}" title="复制代码">
            <svg class="code-copy-icon" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect>
              <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path>
            </svg>
            <span class="code-copy-text">复制</span>
          </button>
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
    ADD_ATTR: ['data-code', 'data-bound', 'target', 'rel'],
  });
}
