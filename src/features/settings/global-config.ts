import * as api from '../../api';
import { escapeHtml } from '../../utils';
import type { GlobalSkillEntry, GlobalPromptEntry, GlobalPromptsState } from '../../types';

/** 挂载令牌：快速切换分区时旧请求不得覆盖新渲染 */
let globalConfigMountToken = 0;

/** 设置页「全局 Skills 与提示词」分区：只读查询 ~/.claude 全局配置 */
export function renderGlobalConfigSectionHtml(): string {
  return `
    <div class="settings-update-view" id="settings-global-config-view">
      <div class="global-config-toolbar">
        <span class="global-config-subtitle">查询 ~/.claude 下的全局 Skills、CLAUDE.md 与斜杠命令（只读）</span>
        <button type="button" class="global-config-refresh" id="global-config-refresh">刷新</button>
      </div>
      <div class="global-config-section">
        <div class="global-config-loading">加载中…</div>
      </div>
    </div>
  `;
}

/** 挂载分区：拉取全局 Skills 与提示词并渲染（token 防竞态，双请求并行） */
export async function mountGlobalConfigSection(): Promise<void> {
  const token = ++globalConfigMountToken;
  const section = document.querySelector('.global-config-section');
  if (!section) return;
  section.innerHTML = '<div class="global-config-loading">加载中…</div>';

  const [skillsRes, promptsRes] = await Promise.all([
    api
      .getGlobalSkills()
      .then((v): { value: GlobalSkillEntry[]; error?: string } => ({ value: v }))
      .catch((e): { value: GlobalSkillEntry[]; error?: string } => ({
        value: [],
        error: String(e),
      })),
    api
      .getGlobalPrompts()
      .then((v): { value: GlobalPromptsState | null; error?: string } => ({ value: v }))
      .catch((e): { value: GlobalPromptsState | null; error?: string } => ({
        value: null,
        error: String(e),
      })),
  ]);

  // 竞态防护：期间已切走/重挂载则丢弃本次结果
  if (token !== globalConfigMountToken || !section.isConnected) return;

  section.innerHTML = `
    ${renderSkillsBlock(skillsRes.value, skillsRes.error || '')}
    ${renderPromptsBlock(promptsRes.value, promptsRes.error || '')}
  `;
  document
    .querySelector<HTMLButtonElement>('#global-config-refresh')
    ?.addEventListener('click', () => {
      void mountGlobalConfigSection();
    });
}

function renderSkillsBlock(skills: GlobalSkillEntry[], error: string): string {
  const cards = skills
    .map(
      (s) => `
      <div class="global-config-card">
        <div class="global-config-card-title-row">
          <span class="global-config-card-title">${escapeHtml(s.display_name)}</span>
          <span class="global-config-card-badge">skill</span>
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
      <h3 class="global-config-title">全局 Skills</h3>
      <p class="global-config-subtitle">位于 ~/.claude/skills/ 下，对 Claude Code 全局生效</p>
      ${error ? `<p class="global-config-error" role="alert">加载失败：${escapeHtml(error)}</p>` : ''}
      ${skills.length > 0 ? `<div class="global-config-cards">${cards}</div>` : error ? '' : `
        <div class="global-config-empty">尚未安装全局 Skills（~/.claude/skills/ 不存在或为空）</div>
      `}
    </section>
  `;
}

function renderPromptsBlock(prompts: GlobalPromptsState | null, error: string): string {
  const mdHtml = prompts?.global_md
    ? `
      <div class="global-config-md">
        <pre class="global-config-md-content">${escapeHtml(prompts.global_md)}</pre>
        <p class="global-config-card-path" title="${escapeHtml(prompts.global_md_path || '')}">${escapeHtml(prompts.global_md_path || '')}</p>
      </div>
    `
    : error
      ? ''
      : '<div class="global-config-empty">未配置全局提示词（~/.claude/CLAUDE.md 不存在）</div>';

  const commands = prompts?.commands ?? [];
  const commandsHtml =
    commands.length > 0
      ? `<div class="global-config-cards">
           ${commands
             .map(
               (c: GlobalPromptEntry) => `
               <div class="global-config-card">
                 <div class="global-config-card-title-row">
                   <span class="global-config-card-title">/${escapeHtml(c.name)}</span>
                   <span class="global-config-card-badge">command</span>
                 </div>
                 <p class="global-config-card-desc">${escapeHtml(c.description)}</p>
                 <p class="global-config-card-path" title="${escapeHtml(c.path)}">${escapeHtml(c.path)}</p>
               </div>
             `,
             )
             .join('')}
         </div>`
      : error
        ? ''
        : '<div class="global-config-empty">未配置全局斜杠命令（~/.claude/commands/ 不存在或为空）</div>';

  return `
    <section class="global-config-block">
      <h3 class="global-config-title">全局提示词</h3>
      <p class="global-config-subtitle">CLAUDE.md 与斜杠命令对 Claude Code 全局生效</p>
      ${error ? `<p class="global-config-error" role="alert">加载失败：${escapeHtml(error)}</p>` : ''}
      <h4 class="global-config-sub-title">CLAUDE.md（全局记忆 / 提示词）</h4>
      ${mdHtml}
      <h4 class="global-config-sub-title">斜杠命令</h4>
      ${commandsHtml}
    </section>
  `;
}
