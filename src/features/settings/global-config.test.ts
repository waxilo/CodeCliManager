import { describe, expect, it, beforeEach, vi } from 'vitest';
import { appState } from '../../state';
import { mountGlobalConfigSection, renderGlobalConfigSectionHtml } from './global-config';
import { renderSettingsViewHtml, renderSettingsSidebarHtml } from './view';

const skillsMock = vi.fn();
const promptsMock = vi.fn();
const writeMock = vi.fn();

vi.mock('../../api', () => ({
  getGlobalSkills: (...args: unknown[]) => skillsMock(...args),
  getGlobalPrompts: (...args: unknown[]) => promptsMock(...args),
  writeGlobalPrompt: (...args: unknown[]) => writeMock(...args),
}));

describe('设置页「全局 Skills 与提示词」分区', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
    appState.settingsSection = 'global-config';
    skillsMock.mockReset();
    promptsMock.mockReset();
    writeMock.mockReset();
  });

  it('侧栏包含分区入口且激活态正确；全局 Skills 位于分隔线之后', () => {
    appState.settingsSection = 'app-update';
    const html = renderSettingsSidebarHtml();
    expect(html).toContain('data-settings-section="global-config"');
    expect(html).toContain('全局 Skills 与提示词');
    // 分隔线：global-config 在其后（最下面），dsh 在其前
    const dividerAt = html.indexOf('settings-section-divider');
    const globalAt = html.indexOf('data-settings-section="global-config"');
    const dshAt = html.indexOf('data-settings-section="dsh"');
    expect(dividerAt).toBeGreaterThan(-1);
    expect(globalAt).toBeGreaterThan(dividerAt);
    expect(dshAt).toBeGreaterThan(-1);
    expect(dshAt).toBeLessThan(dividerAt);

    const doc = new DOMParser().parseFromString(html, 'text/html');
    // 当前分区（app-update）激活，global-config 未激活
    expect(
      doc.querySelector('[data-settings-section="app-update"]')!.classList.contains('is-active'),
    ).toBe(true);
    expect(
      doc.querySelector('[data-settings-section="global-config"]')!.classList.contains('is-active'),
    ).toBe(false);

    appState.settingsSection = 'global-config';
    const doc2 = new DOMParser().parseFromString(renderSettingsSidebarHtml(), 'text/html');
    expect(
      doc2
        .querySelector('[data-settings-section="global-config"]')!
        .classList.contains('is-active'),
    ).toBe(true);
  });

  it('主区渲染 global-config 分区视图', () => {
    appState.settingsSection = 'global-config';
    const html = renderSettingsViewHtml();
    expect(html).toContain('settings-global-config-view');
    expect(html).toContain('global-config-section');
  });

  it('挂载后渲染 Skills 与提示词（含 CLAUDE.md 与斜杠命令）', async () => {
    document.body.innerHTML = renderGlobalConfigSectionHtml();
    skillsMock.mockResolvedValue([
      { name: 'cv-builder', display_name: '简历生成', description: '生成/更新简历的技能', path: '/u/.claude/skills/cv-builder/SKILL.md' },
    ]);
    promptsMock.mockResolvedValue({
      global_md: '# 全局规则\n- 用中文回复',
      global_md_path: '/u/.claude/CLAUDE.md',
      commands: [
        { name: 'review', description: '代码审查命令', path: '/u/.claude/commands/review.md' },
      ],
    });

    await mountGlobalConfigSection();

    const html = document.querySelector('.global-config-section')!.innerHTML;
    expect(html).toContain('简历生成');
    expect(html).toContain('生成/更新简历的技能');
    expect(html).toContain('cv-builder/SKILL.md');
    expect(html).toContain('全局规则');
    expect(html).toContain('用中文回复');
    expect(html).toContain('/review');
    expect(html).toContain('代码审查命令');
  });

  it('无任何配置时展示空态（不报错）', async () => {
    document.body.innerHTML = renderGlobalConfigSectionHtml();
    skillsMock.mockResolvedValue([]);
    promptsMock.mockResolvedValue({ global_md: null, global_md_path: null, commands: [] });

    await mountGlobalConfigSection();

    const html = document.querySelector('.global-config-section')!.innerHTML;
    expect(html).toContain('尚未安装全局 Skills');
    expect(html).toContain('未配置全局提示词');
    expect(html).toContain('未配置全局斜杠命令');
  });

  it('拉取失败时展示错误信息且不渲染误导性空态', async () => {
    document.body.innerHTML = renderGlobalConfigSectionHtml();
    skillsMock.mockRejectedValue(new Error('boom-skills'));
    promptsMock.mockRejectedValue(new Error('boom-prompts'));

    await mountGlobalConfigSection();

    const html = document.querySelector('.global-config-section')!.innerHTML;
    expect(html).toContain('boom-skills');
    expect(html).toContain('boom-prompts');
    expect(html).not.toContain('尚未安装全局 Skills');
    expect(html).not.toContain('未配置全局提示词');
    expect(html).not.toContain('未配置全局斜杠命令');
    expect(document.querySelector('.global-config-error')!.getAttribute('role')).toBe('alert');
  });

  it('刷新按钮重新拉取数据', async () => {
    document.body.innerHTML = renderGlobalConfigSectionHtml();
    skillsMock.mockResolvedValue([]);
    promptsMock.mockResolvedValue({ global_md: null, global_md_path: null, commands: [] });
    await mountGlobalConfigSection();

    const refresh = document.querySelector<HTMLButtonElement>('#global-config-refresh')!;
    expect(refresh).not.toBeNull();
    refresh.click();
    await new Promise((r) => setTimeout(r, 10));
    expect(skillsMock).toHaveBeenCalledTimes(2);
    expect(promptsMock).toHaveBeenCalledTimes(2);
  });

  it('快速连续挂载：旧请求结果不覆盖新渲染（竞态防护）', async () => {
    document.body.innerHTML = renderGlobalConfigSectionHtml();
    let resolveFirst: (v: unknown) => void = () => {};
    skillsMock
      .mockImplementationOnce(() => new Promise((res) => { resolveFirst = res; }))
      .mockResolvedValue([{ name: 'new', display_name: '新', description: '', path: '/x' }]);
    promptsMock.mockResolvedValue({ global_md: null, global_md_path: null, commands: [] });

    const first = mountGlobalConfigSection();
    // 第二次挂载立即开始（模拟快速切换）并先完成
    await mountGlobalConfigSection();
    // 旧请求此时才完成 → 应被 token 丢弃
    resolveFirst([{ name: 'old', display_name: '旧', description: '', path: '/y' }]);
    await first;
    const html = document.querySelector('.global-config-section')!.innerHTML;
    expect(html).toContain('新');
    expect(html).not.toContain('旧');
  });

  it('CLAUDE.md 内容被转义（防注入）', async () => {
    document.body.innerHTML = renderGlobalConfigSectionHtml();
    skillsMock.mockResolvedValue([
      { name: '<img src=x onerror=1>', display_name: 'x', description: 'd', path: '"/>&<path' },
    ]);
    promptsMock.mockResolvedValue({
      global_md: '<script>alert(1)</script> & 内容',
      global_md_path: '/u/.claude/CLAUDE.md',
      commands: [],
    });

    await mountGlobalConfigSection();

    // 编辑器 textarea：value 还原原始文本，innerHTML 不出现未转义标签
    const editor = document.querySelector<HTMLTextAreaElement>('.global-config-md-editor')!;
    expect(editor.innerHTML).not.toContain('<script>');
    expect(editor.value).toContain('<script>alert(1)</script>');
    expect(editor.value).toContain('& 内容');
    // 文件路径 hint 进入 title 属性上下文同样被转义
    const mdPathEl = document.querySelector('.global-config-md-path')!;
    expect(mdPathEl.getAttribute('title')).toContain('/u/.claude/CLAUDE.md');
    // 技能卡片路径（首张卡片）经转义后由浏览器还原为原始字符
    const pathEl = document.querySelector('.global-config-card-path')!;
    expect(pathEl.getAttribute('title')).toContain('/>&<path');
    expect(pathEl.getAttribute('title')).not.toContain('"><img');
    expect(pathEl.innerHTML).not.toContain('<img');
  });

  it('保存按钮把编辑器内容写入后端并提示成功', async () => {
    document.body.innerHTML = renderGlobalConfigSectionHtml();
    skillsMock.mockResolvedValue([]);
    promptsMock.mockResolvedValue({
      global_md: '# 旧',
      global_md_path: '/u/.claude/CLAUDE.md',
      commands: [],
    });
    writeMock.mockResolvedValue('/u/.claude/CLAUDE.md');
    await mountGlobalConfigSection();

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
    document.body.innerHTML = renderGlobalConfigSectionHtml();
    skillsMock.mockResolvedValue([]);
    promptsMock.mockResolvedValue({ global_md: null, global_md_path: null, commands: [] });
    writeMock.mockResolvedValue('/u/.claude/CLAUDE.md');
    await mountGlobalConfigSection();

    const editor = document.querySelector<HTMLTextAreaElement>('#global-config-md-editor')!;
    editor.value = '新增内容';
    editor.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Enter', ctrlKey: true, bubbles: true }),
    );
    await new Promise((r) => setTimeout(r, 10));
    expect(writeMock).toHaveBeenCalledWith('新增内容');
  });

  it('保存失败时展示错误状态并恢复按钮', async () => {
    document.body.innerHTML = renderGlobalConfigSectionHtml();
    skillsMock.mockResolvedValue([]);
    promptsMock.mockResolvedValue({
      global_md: '# 旧',
      global_md_path: '/u/.claude/CLAUDE.md',
      commands: [],
    });
    writeMock.mockRejectedValue(new Error('write-fail'));
    await mountGlobalConfigSection();

    const save = document.querySelector<HTMLButtonElement>('#global-config-save')!;
    const status = document.querySelector<HTMLParagraphElement>('#global-config-save-status')!;
    save.click();
    await new Promise((r) => setTimeout(r, 10));
    expect(status.textContent).toContain('保存失败');
    expect(status.textContent).toContain('write-fail');
    expect(status.classList.contains('is-error')).toBe(true);
    expect(save.disabled).toBe(false);
  });

  it('部分失败：skills 成功 + prompts 失败，各自独立呈现', async () => {
    document.body.innerHTML = renderGlobalConfigSectionHtml();
    skillsMock.mockResolvedValue([
      { name: 's1', display_name: '技能一', description: '描述', path: '/u/.claude/skills/s1/SKILL.md' },
    ]);
    promptsMock.mockRejectedValue(new Error('prompts-down'));

    await mountGlobalConfigSection();

    const html = document.querySelector('.global-config-section')!.innerHTML;
    expect(html).toContain('技能一');
    expect(html).toContain('prompts-down');
    expect(html).not.toContain('未配置全局提示词');
    expect(html).not.toContain('未配置全局斜杠命令');
  });
});
