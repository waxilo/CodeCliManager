import { beforeEach, describe, expect, it, vi } from 'vitest';
import { appState } from '../../state';
import { mountProjectPromptsSection, renderProjectPromptsSectionHtml } from './project-prompts-section';

const getPromptMock = vi.fn();
const writePromptMock = vi.fn();

vi.mock('../../api', () => ({
  getProjectPrompt: (...args: unknown[]) => getPromptMock(...args),
  writeProjectPrompt: (...args: unknown[]) => writePromptMock(...args),
}));

describe('项目提示词分区', () => {
  beforeEach(() => {
    document.body.innerHTML = renderProjectPromptsSectionHtml();
    appState.skillsScope = 'project';
    appState.skillsProjectDir = '/projects/demo';
    getPromptMock.mockReset();
    writePromptMock.mockReset();
  });

  it('加载并安全渲染项目 CLAUDE.md', async () => {
    getPromptMock.mockResolvedValue({
      content: '<script>alert(1)</script>\n# 项目规则',
      path: '/projects/demo/CLAUDE.md',
    });

    await mountProjectPromptsSection();

    expect(getPromptMock).toHaveBeenCalledWith('/projects/demo');
    const editor = document.querySelector<HTMLTextAreaElement>('#project-config-md-editor')!;
    expect(editor.value).toContain('<script>alert(1)</script>');
    expect(editor.innerHTML).not.toContain('<script>');
    expect(document.querySelector('.global-config-md-path')?.textContent).toBe('/projects/demo/CLAUDE.md');
  });

  it('保存到打开时的项目并显示成功状态', async () => {
    getPromptMock.mockResolvedValue({ content: '# 旧', path: '/projects/demo/CLAUDE.md' });
    writePromptMock.mockResolvedValue({ content: '# 新', path: '/projects/demo/CLAUDE.md' });
    await mountProjectPromptsSection();

    const editor = document.querySelector<HTMLTextAreaElement>('#project-config-md-editor')!;
    editor.value = '# 新';
    document.querySelector<HTMLButtonElement>('#project-config-save')!.click();
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(writePromptMock).toHaveBeenCalledWith('/projects/demo', '# 新');
    expect(document.querySelector('#project-config-save-status')?.textContent).toContain('已保存到');
  });

  it('项目切换后旧请求不能覆盖新页面', async () => {
    let resolveOld: (value: unknown) => void = () => {};
    getPromptMock
      .mockImplementationOnce(() => new Promise((resolve) => { resolveOld = resolve; }))
      .mockResolvedValueOnce({ content: '项目 B', path: '/projects/b/CLAUDE.md' });

    const oldMount = mountProjectPromptsSection();
    appState.skillsProjectDir = '/projects/b';
    document.body.innerHTML = renderProjectPromptsSectionHtml();
    await mountProjectPromptsSection();
    resolveOld({ content: '项目 A', path: '/projects/demo/CLAUDE.md' });
    await oldMount;

    expect(document.querySelector<HTMLTextAreaElement>('#project-config-md-editor')?.value).toBe('项目 B');
  });
});
