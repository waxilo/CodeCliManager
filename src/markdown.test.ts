import { describe, expect, it } from 'vitest';
import { renderMarkdown, scheduleHighlighting, flushHighlighting } from './markdown';

function mount(html: string): HTMLElement {
  const container = document.createElement('div');
  container.innerHTML = html;
  document.body.appendChild(container);
  return container;
}

function unmount(container: HTMLElement): void {
  document.body.removeChild(container);
}

describe('markdown 延迟语法高亮', () => {
  it('围栏代码块输出 data-hl-lang 占位（不同步跑 hljs）', () => {
    const html = renderMarkdown('```ts\nconst x: number = 1;\n```');
    expect(html).toContain('data-hl-lang="ts"');
    expect(html).not.toContain('hljs-keyword');
    // 原文已转义进 code 文本
    expect(html).toContain('const x: number = 1;');
  });

  it('flushHighlighting 后补上 hljs span 并移除占位标记', () => {
    const container = mount(renderMarkdown('```ts\nconst x: number = 1;\n```'));
    scheduleHighlighting(container);
    flushHighlighting();
    const code = container.querySelector<HTMLElement>('pre > code');
    expect(code).toBeTruthy();
    expect(code!.dataset.hlLang).toBeUndefined();
    expect(code!.dataset.hlDone).toBe('1');
    expect(code!.innerHTML).toContain('hljs-keyword');
    expect(code!.textContent).toContain('const x: number = 1;');
    unmount(container);
  });

  it('代码文本经转义后 textContent 还原原文（含 < 号）', () => {
    const container = mount(renderMarkdown('```ts\nconst ok = 1 < 2;\n```'));
    scheduleHighlighting(container);
    flushHighlighting();
    const code = container.querySelector<HTMLElement>('pre > code');
    expect(code!.textContent).toContain('const ok = 1 < 2;');
    unmount(container);
  });

  it('未知语言小块仍走 highlightAuto', () => {
    const container = mount(renderMarkdown('```\nfunction foo() { return 1; }\n```'));
    scheduleHighlighting(container);
    flushHighlighting();
    const code = container.querySelector<HTMLElement>('pre > code');
    expect(code!.dataset.hlDone).toBe('1');
    expect(code!.innerHTML).toContain('hljs-');
    unmount(container);
  });

  it('未知语言大块跳过 highlightAuto（留纯文本，无 hljs span）', () => {
    const big = Array.from({ length: 3000 }, (_, i) => `line ${i} data`).join('\n');
    const container = mount(renderMarkdown('```\n' + big + '\n```'));
    scheduleHighlighting(container);
    flushHighlighting();
    const code = container.querySelector<HTMLElement>('pre > code');
    expect(code!.dataset.hlDone).toBe('1');
    expect(code!.innerHTML).not.toContain('hljs-');
    expect(code!.textContent).toBe(big);
    unmount(container);
  });

  it('JSON 自动检测块同样延迟高亮', () => {
    const container = mount(renderMarkdown('{"a":1}'));
    const code = container.querySelector<HTMLElement>('pre > code');
    expect(code!.dataset.hlLang).toBe('json');
    scheduleHighlighting(container);
    flushHighlighting();
    expect(code!.innerHTML).toContain('hljs-');
    unmount(container);
  });

  it('未插入 DOM 的节点不高亮（isConnected=false 跳过）', () => {
    const container = document.createElement('div');
    container.innerHTML = renderMarkdown('```ts\nconst a = 1;\n```');
    scheduleHighlighting(container); // 未挂载
    flushHighlighting();
    const code = container.querySelector<HTMLElement>('pre > code');
    expect(code!.dataset.hlLang).toBe('ts');
    expect(code!.innerHTML).not.toContain('hljs-');
  });

  it('同一容器重复 scheduleHighlighting 不重复处理已高亮块', () => {
    const container = mount(renderMarkdown('```ts\nconst a = 1;\n```'));
    scheduleHighlighting(container);
    flushHighlighting();
    const code = container.querySelector<HTMLElement>('pre > code');
    const innerBefore = code!.innerHTML;
    scheduleHighlighting(container); // 已高亮块带 data-hl-done，不入队
    flushHighlighting();
    expect(code!.innerHTML).toBe(innerBefore);
    unmount(container);
  });
});
