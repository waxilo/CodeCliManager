import * as api from '../../api';
import type { ProjectSkillEntry, SkillsTarget } from '../../types';
import { escapeHtml } from '../../utils';
import { showConfirmDialog, showCopyToastMsg } from '../../ui';
import { getSkillsTarget, isSameSkillsTarget } from './scope';

let mountToken = 0;

export function renderProjectSkillsSectionHtml(): string {
  return `
    <div class="settings-update-view" id="skills-project-skills-view">
      <div class="global-config-toolbar">
        <span class="global-config-subtitle">管理项目 .claude/skills/ 下的 Skills</span>
        <div class="global-config-toolbar-actions">
          <button type="button" class="global-config-refresh" id="project-skills-refresh">刷新</button>
          <button type="button" class="settings-btn-primary" id="project-skill-add">+ 新建 Skill</button>
        </div>
      </div>
      <div class="global-config-section" id="project-skills-section">
        <div class="global-config-loading">加载中…</div>
      </div>
    </div>
  `;
}

export async function mountProjectSkillsSection(): Promise<void> {
  const target = getSkillsTarget();
  if (target.scope !== 'project' || !target.projectDir) return;
  const token = ++mountToken;
  const section = document.querySelector<HTMLElement>('#project-skills-section');
  if (!section) return;
  section.innerHTML = '<div class="global-config-loading">加载中…</div>';

  let skills: ProjectSkillEntry[] = [];
  let error = '';
  try {
    skills = await api.getProjectSkills(target.projectDir);
  } catch (err) {
    error = String(err);
  }
  if (token !== mountToken || !section.isConnected || !isSameSkillsTarget(target, getSkillsTarget())) return;
  section.innerHTML = renderProjectSkills(skills, error);

  const view = document.querySelector<HTMLElement>('#skills-project-skills-view');
  if (!view || view.dataset.bound === '1') return;
  view.dataset.bound = '1';
  view.querySelector('#project-skills-refresh')?.addEventListener('click', () => void mountProjectSkillsSection());
  view.querySelector('#project-skill-add')?.addEventListener('click', () => void openProjectSkillDialog(target, null));
  section.addEventListener('click', (event) => {
    const button = (event.target as HTMLElement).closest<HTMLButtonElement>('[data-project-skill-action]');
    if (!button) return;
    const name = button.dataset.skillName || '';
    if (button.dataset.projectSkillAction === 'edit') void openProjectSkillDialog(target, name);
    if (button.dataset.projectSkillAction === 'delete') void deleteProjectSkill(target, name);
  });
}

function renderProjectSkills(skills: ProjectSkillEntry[], error: string): string {
  if (error) return `<p class="global-config-error" role="alert">加载失败：${escapeHtml(error)}</p>`;
  if (skills.length === 0) {
    return '<div class="global-config-empty">项目尚未配置 Skills（.claude/skills/ 不存在或为空）</div>';
  }
  return `<div class="global-config-cards">${skills.map((skill) => `
    <div class="global-config-card">
      <div class="global-config-card-title-row">
        <span class="global-config-card-title">${escapeHtml(skill.displayName)}</span>
        <span class="global-config-card-badge">skill</span>
        <button type="button" class="global-config-card-action" data-project-skill-action="edit" data-skill-name="${escapeHtml(skill.name)}">编辑</button>
        <button type="button" class="global-config-card-delete" data-project-skill-action="delete" data-skill-name="${escapeHtml(skill.name)}">删除</button>
      </div>
      ${skill.description
        ? `<p class="global-config-card-desc">${escapeHtml(skill.description)}</p>`
        : '<p class="global-config-card-desc global-config-muted">（无描述）</p>'}
      <p class="global-config-card-path" title="${escapeHtml(skill.path)}">${escapeHtml(skill.path)}</p>
    </div>
  `).join('')}</div>`;
}

async function openProjectSkillDialog(target: SkillsTarget, name: string | null): Promise<void> {
  if (!target.projectDir) return;
  const sourceView = document.querySelector('#skills-project-skills-view');
  document.querySelector('.mcp-dialog-overlay')?.remove();
  let content = name ? '' : skillTemplate('skill-name');
  if (name) {
    try {
      content = (await api.readProjectSkill(target.projectDir, name)).content;
    } catch (err) {
      if (sourceView?.isConnected && isSameSkillsTarget(target, getSkillsTarget())) {
        showCopyToastMsg(`加载失败：${String(err)}`);
      }
      return;
    }
  }
  if (!sourceView?.isConnected || !isSameSkillsTarget(target, getSkillsTarget())) return;

  const overlay = document.createElement('div');
  overlay.className = 'mcp-dialog-overlay';
  overlay.innerHTML = `
    <div class="mcp-dialog project-skill-dialog" role="dialog" aria-modal="true" aria-labelledby="project-skill-dialog-title">
      <div class="mcp-dialog-header">
        <h3 id="project-skill-dialog-title">${name ? '编辑 Skill' : '新建 Skill'}</h3>
        <button type="button" class="settings-close-btn mcp-dialog-close" aria-label="关闭">✕</button>
      </div>
      <form class="mcp-dialog-form" id="project-skill-form">
        <label class="settings-field">
          <span>目录名</span>
          <input type="text" name="name" value="${escapeHtml(name || '')}" placeholder="例如：code-review" ${name ? 'readonly' : ''} required />
        </label>
        <label class="settings-field">
          <span>SKILL.md</span>
          <textarea class="project-skill-editor" name="content" rows="18" spellcheck="false">${escapeHtml(content)}</textarea>
        </label>
        <p class="global-config-save-status" role="status">保存后对该项目的新会话生效</p>
        <div class="mcp-dialog-actions">
          <button type="button" class="mcp-dialog-btn cancel">取消</button>
          <button type="submit" class="mcp-dialog-btn primary">保存</button>
        </div>
      </form>
    </div>
  `;
  const cleanup = () => overlay.remove();
  overlay.querySelector('.mcp-dialog-close')?.addEventListener('click', cleanup);
  overlay.querySelector('.mcp-dialog-btn.cancel')?.addEventListener('click', cleanup);
  overlay.addEventListener('click', (event) => { if (event.target === overlay) cleanup(); });
  const nameInput = overlay.querySelector<HTMLInputElement>('input[name="name"]');
  const editor = overlay.querySelector<HTMLTextAreaElement>('textarea[name="content"]');
  if (!name) {
    nameInput?.addEventListener('input', () => {
      if (editor && editor.value === content) {
        content = skillTemplate(nameInput.value.trim() || 'skill-name');
        editor.value = content;
      }
    });
  }
  const form = overlay.querySelector<HTMLFormElement>('#project-skill-form');
  const save = async () => {
    if (!form || !editor || !target.projectDir) return;
    const skillName = nameInput?.value.trim() || '';
    if (!skillName) return showCopyToastMsg('请填写目录名');
    const button = form.querySelector<HTMLButtonElement>('.primary')!;
    const status = form.querySelector<HTMLElement>('[role="status"]')!;
    button.disabled = true;
    button.textContent = '保存中…';
    try {
      await api.writeProjectSkill(target.projectDir, skillName, editor.value);
      if (!isSameSkillsTarget(target, getSkillsTarget())) return cleanup();
      cleanup();
      showCopyToastMsg('已保存');
      await mountProjectSkillsSection();
    } catch (err) {
      status.textContent = `保存失败：${String(err)}`;
      status.classList.add('is-error');
      button.disabled = false;
      button.textContent = '保存';
    }
  };
  form?.addEventListener('submit', (event) => { event.preventDefault(); void save(); });
  editor?.addEventListener('keydown', (event) => {
    if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
      event.preventDefault();
      void save();
    }
  });
  document.body.appendChild(overlay);
  (name ? editor : nameInput)?.focus();
}

async function deleteProjectSkill(target: SkillsTarget, name: string): Promise<void> {
  if (!target.projectDir || !name) return;
  const confirmed = await showConfirmDialog({
    title: '删除项目 Skill',
    message: `确定要删除「${name}」吗？`,
    sub: `将删除 .claude/skills/${name}/ 整个目录，且不可恢复。`,
    confirmLabel: '删除',
  });
  if (!confirmed) return;
  try {
    await api.deleteProjectSkill(target.projectDir, name);
    if (isSameSkillsTarget(target, getSkillsTarget())) await mountProjectSkillsSection();
    showCopyToastMsg('已删除');
  } catch (err) {
    showCopyToastMsg(`删除失败：${String(err)}`);
  }
}

function skillTemplate(name: string): string {
  return `---\nname: ${name}\ndescription: 描述这个 Skill 的用途和触发场景\n---\n\n# Instructions\n\n在此编写项目级 Skill 指令。\n`;
}
