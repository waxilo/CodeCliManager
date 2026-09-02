import { describe, expect, it, beforeEach, vi } from 'vitest';
import { mountGlobalSkillsSection, renderGlobalSkillsSectionHtml } from './global-skills-section';

const skillsMock = vi.fn();

vi.mock('../../api', () => ({
  getGlobalSkills: (...args: unknown[]) => skillsMock(...args),
}));

describe('「技能」页全局 Skills 分区', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
    skillsMock.mockReset();
  });

  it('挂载后渲染 Skills 卡片', async () => {
    document.body.innerHTML = renderGlobalSkillsSectionHtml();
    skillsMock.mockResolvedValue([
      { name: 'cv-builder', display_name: '简历生成', description: '生成/更新简历的技能', path: '/u/.claude/skills/cv-builder/SKILL.md' },
    ]);

    await mountGlobalSkillsSection();

    const html = document.querySelector('#global-skills-section')!.innerHTML;
    expect(html).toContain('简历生成');
    expect(html).toContain('生成/更新简历的技能');
    expect(html).toContain('cv-builder/SKILL.md');
  });

  it('无任何配置时展示空态（不报错）', async () => {
    document.body.innerHTML = renderGlobalSkillsSectionHtml();
    skillsMock.mockResolvedValue([]);

    await mountGlobalSkillsSection();

    const html = document.querySelector('#global-skills-section')!.innerHTML;
    expect(html).toContain('尚未安装全局 Skills');
  });

  it('拉取失败时展示错误信息且不渲染误导性空态', async () => {
    document.body.innerHTML = renderGlobalSkillsSectionHtml();
    skillsMock.mockRejectedValue(new Error('boom-skills'));

    await mountGlobalSkillsSection();

    const html = document.querySelector('#global-skills-section')!.innerHTML;
    expect(html).toContain('boom-skills');
    expect(html).not.toContain('尚未安装全局 Skills');
    expect(document.querySelector('.global-config-error')!.getAttribute('role')).toBe('alert');
  });

  it('刷新按钮重新拉取数据', async () => {
    document.body.innerHTML = renderGlobalSkillsSectionHtml();
    skillsMock.mockResolvedValue([]);
    await mountGlobalSkillsSection();

    const refresh = document.querySelector<HTMLButtonElement>('#global-skills-refresh')!;
    expect(refresh).not.toBeNull();
    refresh.click();
    await new Promise((r) => setTimeout(r, 10));
    expect(skillsMock).toHaveBeenCalledTimes(2);
  });

  it('快速连续挂载：旧请求结果不覆盖新渲染（竞态防护）', async () => {
    document.body.innerHTML = renderGlobalSkillsSectionHtml();
    let resolveFirst: (v: unknown) => void = () => {};
    skillsMock
      .mockImplementationOnce(() => new Promise((res) => { resolveFirst = res; }))
      .mockResolvedValue([{ name: 'new', display_name: '新', description: '', path: '/x' }]);

    const first = mountGlobalSkillsSection();
    // 第二次挂载立即开始（模拟快速切换）并先完成
    await mountGlobalSkillsSection();
    // 旧请求此时才完成 → 应被 token 丢弃
    resolveFirst([{ name: 'old', display_name: '旧', description: '', path: '/y' }]);
    await first;
    const html = document.querySelector('#global-skills-section')!.innerHTML;
    expect(html).toContain('新');
    expect(html).not.toContain('旧');
  });

  it('卡片内容被转义（防注入）', async () => {
    document.body.innerHTML = renderGlobalSkillsSectionHtml();
    skillsMock.mockResolvedValue([
      { name: '<img src=x onerror=1>', display_name: 'x', description: 'd', path: '"/>&<path' },
    ]);

    await mountGlobalSkillsSection();

    const pathEl = document.querySelector('.global-config-card-path')!;
    expect(pathEl.getAttribute('title')).toContain('/>&<path');
    expect(pathEl.getAttribute('title')).not.toContain('"><img');
    expect(pathEl.innerHTML).not.toContain('<img');
  });
});
