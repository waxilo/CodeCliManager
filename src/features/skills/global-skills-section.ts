import * as api from '../../api';
import { escapeHtml } from '../../utils';
import { showConfirmDialog, showCopyToastMsg } from '../../ui';
import type { GlobalSkillEntry } from '../../types';

/** 挂载令牌：快速切换分区时旧请求不得覆盖新渲染 */
let mountToken = 0;

/** 「技能」页全局 Skills 分区：只读查询 ~/.claude/skills */
export function renderGlobalSkillsSectionHtml(): string {
  return `
    <div class="settings-update-view" id="skills-global-skills-view">
      <div class="global-config-toolbar">
        <span class="global-config-subtitle">查询 ~/.claude/skills/ 下的全局 Skills，对 Claude Code 全局生效</span>
        <button type="button" class="global-config-refresh" id="global-skills-refresh">刷新</button>
      </div>
      <div class="global-config-section" id="global-skills-section">
        <div class="global-config-loading">加载中…</div>
      </div>
    </div>
  `;
}

/** 挂载分区：拉取全局 Skills 并渲染（token 防竞态） */
export async function mountGlobalSkillsSection(): Promise<void> {
  const token = ++mountToken;
  const section = document.querySelector('#global-skills-section');
  if (!section) return;
  section.innerHTML = '<div class="global-config-loading">加载中…</div>';

  let skills: GlobalSkillEntry[] = [];
  let error = '';
  try {
    skills = await api.getGlobalSkills();
  } catch (e) {
    error = String(e);
  }

  // 竞态防护：期间已切走/重挂载则丢弃本次结果
  if (token !== mountToken || !section.isConnected) return;

  section.innerHTML = renderSkillsBlock(skills, error);

  const view = document.querySelector('#skills-global-skills-view');
  if (view && (view as HTMLElement).dataset.bound !== '1') {
    (view as HTMLElement).dataset.bound = '1';
    view
      .querySelector<HTMLButtonElement>('#global-skills-refresh')
      ?.addEventListener('click', () => {
        void mountGlobalSkillsSection();
      });
    // 事件委托挂在分区容器上：卡片列表每次刷新都会重建，委托避免逐卡重复绑定
    section.addEventListener('click', (event) => {
      const btn = (event.target as HTMLElement | null)?.closest<HTMLButtonElement>(
        '[data-skill-action="delete"]',
      );
      if (!btn) return;
      void handleDeleteSkill(btn.dataset.skillName || '', btn.dataset.skillDisplayName || '');
    });
  }
}

async function handleDeleteSkill(name: string, displayName: string): Promise<void> {
  if (!name) return;
  const confirmed = await showConfirmDialog({
    title: '删除 Skill',
    message: `确定要删除「${displayName || name}」吗？`,
    sub: `将删除 ~/.claude/skills/${name}/ 整个目录，且不可恢复。`,
    confirmLabel: '删除',
  });
  if (!confirmed) return;
  try {
    await api.deleteGlobalSkill(name);
    showCopyToastMsg('已删除');
    await mountGlobalSkillsSection();
  } catch (err) {
    showCopyToastMsg(`删除失败：${String(err)}`);
  }
}

function renderSkillsBlock(skills: GlobalSkillEntry[], error: string): string {
  const cards = skills
    .map(
      (s) => `
      <div class="global-config-card">
        <div class="global-config-card-title-row">
          <span class="global-config-card-title">${escapeHtml(s.display_name)}</span>
          <span class="global-config-card-badge">skill</span>
          <button type="button" class="global-config-card-delete" data-skill-action="delete" data-skill-name="${escapeHtml(s.name)}" data-skill-display-name="${escapeHtml(s.display_name)}" title="删除">删除</button>
        </div>
        ${s.description
          ? `<p class="global-config-card-desc">${escapeHtml(s.description)}</p>`
          : '<p class="global-config-card-desc global-config-muted">（无描述）</p>'}
        <p class="global-config-card-path" title="${escapeHtml(s.path)}">${escapeHtml(s.path)}</p>
      </div>
    `,
    )
    .join('');
  return `
    <section class="global-config-block">
      ${error ? `<p class="global-config-error" role="alert">加载失败：${escapeHtml(error)}</p>` : ''}
      ${skills.length > 0 ? `<div class="global-config-cards">${cards}</div>` : error ? '' : `
        <div class="global-config-empty">尚未安装全局 Skills（~/.claude/skills/ 不存在或为空）</div>
      `}
    </section>
  `;
}
