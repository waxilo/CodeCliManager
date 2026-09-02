import { describe, expect, it, beforeEach, vi } from 'vitest';
import { mountGlobalPromptsSection, renderGlobalPromptsSectionHtml } from './global-prompts-section';

const promptsMock = vi.fn();
const writeMock = vi.fn();

vi.mock('../../api', () => ({
  getGlobalPrompts: (...args: unknown[]) => promptsMock(...args),
  writeGlobalPrompt: (...args: unknown[]) => writeMock(...args),
}));

describe('「技能」页全局提示词分区', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
    promptsMock.mockReset();
    writeMock.mockReset();
  });

  it('挂载后渲染 CLAUDE.md 与斜杠命令', async () => {
    document.body.innerHTML = renderGlobalPromptsSectionHtml();
    promptsMock.mockResolvedValue({
      global_md: '# 全局规则\n- 用中文回复',
      global_md_path: '/u/.claude/CLAUDE.md',
      commands: [
        { name: 'review', description: '代码审查命令', path: '/u/.claude/commands/review.md' },
      ],
    });

    await mountGlobalPromptsSection();

    const html = document.querySelector('#global-prompts-section')!.innerHTML;
    expect(html).toContain('全局规则');
    expect(html).toContain('用中文回复');
    expect(html).toContain('/review');
    expect(html).toContain('代码审查命令');
  });

  it('无任何配置时展示空态（不报错）', async () => {
    document.body.innerHTML = renderGlobalPromptsSectionHtml();
    promptsMock.mockResolvedValue({ global_md: null, global_md_path: null, commands: [] });

    await mountGlobalPromptsSection();

    const html = document.querySelector('#global-prompts-section')!.innerHTML;
    expect(html).toContain('未配置全局斜杠命令');
  });

  it('拉取失败时展示错误信息且不渲染误导性空态', async () => {
    document.body.innerHTML = renderGlobalPromptsSectionHtml();
    promptsMock.mockRejectedValue(new Error('boom-prompts'));

    await mountGlobalPromptsSection();

    const html = document.querySelector('#global-prompts-section')!.innerHTML;
    expect(html).toContain('boom-prompts');
    expect(html).not.toContain('未配置全局斜杠命令');
    expect(document.querySelector('.global-config-error')!.getAttribute('role')).toBe('alert');
  });

  it('刷新按钮重新拉取数据', async () => {
    document.body.innerHTML = renderGlobalPromptsSectionHtml();
    promptsMock.mockResolvedValue({ global_md: null, global_md_path: null, commands: [] });
    await mountGlobalPromptsSection();

    const refresh = document.querySelector<HTMLButtonElement>('#global-prompts-refresh')!;
    expect(refresh).not.toBeNull();
    refresh.click();
    await new Promise((r) => setTimeout(r, 10));
    expect(promptsMock).toHaveBeenCalledTimes(2);
  });

  it('CLAUDE.md 内容被转义（防注入）', async () => {
    document.body.innerHTML = renderGlobalPromptsSectionHtml();
    promptsMock.mockResolvedValue({
      global_md: '<script>alert(1)</script> & 内容',
      global_md_path: '/u/.claude/CLAUDE.md',
      commands: [],
    });

    await mountGlobalPromptsSection();

    // 编辑器 textarea：value 还原原始文本，innerHTML 不出现未转义标签
    const editor = document.querySelector<HTMLTextAreaElement>('.global-config-md-editor')!;
    expect(editor.innerHTML).not.toContain('<script>');
    expect(editor.value).toContain('<script>alert(1)</script>');
    expect(editor.value).toContain('& 内容');
    // 文件路径 hint 进入 title 属性上下文同样被转义
    const mdPathEl = document.querySelector('.global-config-md-path')!;
    expect(mdPathEl.getAttribute('title')).toContain('/u/.claude/CLAUDE.md');
  });

  it('保存按钮把编辑器内容写入后端并提示成功', async () => {
    document.body.innerHTML = renderGlobalPromptsSectionHtml();
    promptsMock.mockResolvedValue({
      global_md: '# 旧',
      global_md_path: '/u/.claude/CLAUDE.md',
      commands: [],
    });
    writeMock.mockResolvedValue('/u/.claude/CLAUDE.md');
    await mountGlobalPromptsSection();

    const editor = document.querySelector<HTMLTextAreaElement>('#global-config-md-editor')!;
    editor.value = '# 新的全局提示词\n- 规则';
    const save = document.querySelector<HTMLButtonElement>('#global-config-save')!;
    const status = document.querySelector<HTMLParagraphElement>('#global-config-save-status')!;

    save.click();
    await new Promise((r) => setTimeout(r, 10));

    expect(writeMock).toHaveBeenCalledWith('# 新的全局提示词\n- 规则');
    expect(status.textContent).toContain('已保存到');
    expect(status.textContent).toContain('/u/.claude/CLAUDE.md');
    expect(status.classList.contains('is-success')).toBe(true);
    expect(save.disabled).toBe(false);
  });

  it('Cmd/Ctrl+Enter 触发保存', async () => {
    document.body.innerHTML = renderGlobalPromptsSectionHtml();
    promptsMock.mockResolvedValue({ global_md: null, global_md_path: null, commands: [] });
    writeMock.mockResolvedValue('/u/.claude/CLAUDE.md');
    await mountGlobalPromptsSection();

    const editor = document.querySelector<HTMLTextAreaElement>('#global-config-md-editor')!;
    editor.value = '新增内容';
    editor.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Enter', ctrlKey: true, bubbles: true }),
    );
    await new Promise((r) => setTimeout(r, 10));
    expect(writeMock).toHaveBeenCalledWith('新增内容');
  });

  it('保存失败时展示错误状态并恢复按钮', async () => {
    document.body.innerHTML = renderGlobalPromptsSectionHtml();
    promptsMock.mockResolvedValue({
      global_md: '# 旧',
      global_md_path: '/u/.claude/CLAUDE.md',
      commands: [],
    });
    writeMock.mockRejectedValue(new Error('write-fail'));
    await mountGlobalPromptsSection();

    const save = document.querySelector<HTMLButtonElement>('#global-config-save')!;
    const status = document.querySelector<HTMLParagraphElement>('#global-config-save-status')!;
    save.click();
    await new Promise((r) => setTimeout(r, 10));
    expect(status.textContent).toContain('保存失败');
    expect(status.textContent).toContain('write-fail');
    expect(status.classList.contains('is-error')).toBe(true);
    expect(save.disabled).toBe(false);
  });
});
