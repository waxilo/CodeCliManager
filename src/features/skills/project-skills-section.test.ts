import { beforeEach, describe, expect, it, vi } from 'vitest';
import { appState } from '../../state';
import { mountProjectSkillsSection, renderProjectSkillsSectionHtml } from './project-skills-section';

const getSkillsMock = vi.fn();
const readSkillMock = vi.fn();
const writeSkillMock = vi.fn();
const deleteSkillMock = vi.fn();

vi.mock('../../api', () => ({
  getProjectSkills: (...args: unknown[]) => getSkillsMock(...args),
  readProjectSkill: (...args: unknown[]) => readSkillMock(...args),
  writeProjectSkill: (...args: unknown[]) => writeSkillMock(...args),
  deleteProjectSkill: (...args: unknown[]) => deleteSkillMock(...args),
}));

describe('项目 Skills 分区', () => {
  beforeEach(() => {
    document.body.innerHTML = renderProjectSkillsSectionHtml();
    appState.skillsScope = 'project';
    appState.skillsProjectDir = '/projects/demo';
    getSkillsMock.mockReset();
    readSkillMock.mockReset();
    writeSkillMock.mockReset();
    deleteSkillMock.mockReset();
  });

  it('加载项目 Skills 并转义卡片内容', async () => {
    getSkillsMock.mockResolvedValue([{
      name: 'review',
      displayName: '<img src=x>',
      description: '审查 & 修复',
      path: '/projects/demo/.claude/skills/review/SKILL.md',
    }]);

    await mountProjectSkillsSection();

    expect(getSkillsMock).toHaveBeenCalledWith('/projects/demo');
    expect(document.querySelector('.global-config-card-title')?.innerHTML).not.toContain('<img');
    expect(document.querySelector('.global-config-card-title')?.textContent).toBe('<img src=x>');
  });

  it('项目切换后旧列表请求不能覆盖新项目', async () => {
    let resolveOld: (value: unknown) => void = () => {};
    getSkillsMock
      .mockImplementationOnce(() => new Promise((resolve) => { resolveOld = resolve; }))
      .mockResolvedValueOnce([{
        name: 'project-b', displayName: 'Project B', description: '', path: '/projects/b/.claude/skills/project-b/SKILL.md',
      }]);

    const oldMount = mountProjectSkillsSection();
    appState.skillsProjectDir = '/projects/b';
    document.body.innerHTML = renderProjectSkillsSectionHtml();
    await mountProjectSkillsSection();
    resolveOld([{
      name: 'project-a', displayName: 'Project A', description: '', path: '/projects/a/.claude/skills/project-a/SKILL.md',
    }]);
    await oldMount;

    expect(document.querySelector('#project-skills-section')?.textContent).toContain('Project B');
    expect(document.querySelector('#project-skills-section')?.textContent).not.toContain('Project A');
  });

  it('编辑时读取并原样保存完整 SKILL.md', async () => {
    getSkillsMock.mockResolvedValue([{
      name: 'review', displayName: 'Review', description: '', path: '/skill/SKILL.md',
    }]);
    readSkillMock.mockResolvedValue({
      name: 'review',
      displayName: 'Review',
      description: '',
      path: '/skill/SKILL.md',
      content: '---\nname: Review\ncustom: keep\n---\n\nOld',
    });
    writeSkillMock.mockResolvedValue({
      name: 'review', displayName: 'Review', description: '', path: '/skill/SKILL.md', content: 'saved',
    });
    await mountProjectSkillsSection();

    document.querySelector<HTMLButtonElement>('[data-project-skill-action="edit"]')!.click();
    await new Promise((resolve) => setTimeout(resolve, 0));
    const editor = document.querySelector<HTMLTextAreaElement>('.project-skill-editor')!;
    expect(editor.value).toContain('custom: keep');
    editor.value = '---\nname: Review\ncustom: keep\n---\n\nNew';
    document.querySelector<HTMLFormElement>('#project-skill-form')!.dispatchEvent(
      new Event('submit', { bubbles: true, cancelable: true }),
    );
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(writeSkillMock).toHaveBeenCalledWith(
      '/projects/demo',
      'review',
      '---\nname: Review\ncustom: keep\n---\n\nNew',
    );
  });

  it('读取 Skill 期间切走分区不会弹出陈旧编辑框', async () => {
    getSkillsMock.mockResolvedValue([{
      name: 'review', displayName: 'Review', description: '', path: '/skill/SKILL.md',
    }]);
    let resolveRead: (value: unknown) => void = () => {};
    readSkillMock.mockImplementation(() => new Promise((resolve) => { resolveRead = resolve; }));
    await mountProjectSkillsSection();

    document.querySelector<HTMLButtonElement>('[data-project-skill-action="edit"]')!.click();
    document.body.innerHTML = '<div id="skills-mcp-section"></div>';
    resolveRead({
      name: 'review', displayName: 'Review', description: '', path: '/skill/SKILL.md', content: '# Old',
    });
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(document.querySelector('.project-skill-dialog')).toBeNull();
  });

  it('确认删除后只删除当前项目的目标 Skill', async () => {
    getSkillsMock.mockResolvedValue([{
      name: 'review', displayName: 'Review', description: '', path: '/skill/SKILL.md',
    }]);
    deleteSkillMock.mockResolvedValue(undefined);
    await mountProjectSkillsSection();

    document.querySelector<HTMLButtonElement>('[data-project-skill-action="delete"]')!.click();
    document.querySelector<HTMLButtonElement>('.confirm-btn.danger')!.click();
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(deleteSkillMock).toHaveBeenCalledWith('/projects/demo', 'review');
  });

  it('新建 Skill 使用目录名生成标准模板', async () => {
    getSkillsMock.mockResolvedValue([]);
    writeSkillMock.mockResolvedValue({
      name: 'security-review', displayName: 'security-review', description: '', path: '/skill/SKILL.md', content: '',
    });
    await mountProjectSkillsSection();

    document.querySelector<HTMLButtonElement>('#project-skill-add')!.click();
    const nameInput = document.querySelector<HTMLInputElement>('input[name="name"]')!;
    const editor = document.querySelector<HTMLTextAreaElement>('.project-skill-editor')!;
    nameInput.value = 'security-review';
    nameInput.dispatchEvent(new Event('input', { bubbles: true }));
    expect(editor.value).toContain('name: security-review');

    document.querySelector<HTMLFormElement>('#project-skill-form')!.dispatchEvent(
      new Event('submit', { bubbles: true, cancelable: true }),
    );
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(writeSkillMock).toHaveBeenCalledWith(
      '/projects/demo',
      'security-review',
      expect.stringContaining('name: security-review'),
    );
  });
});
