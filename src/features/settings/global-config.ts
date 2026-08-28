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
        <span class="global-config-subtitle">查询 ~/.claude 下的全局 Skills、CLAUDE.md 与斜杠命令；CLAUDE.md 可直接编辑</span>
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
  bindGlobalClaudeEditor();
}

/** 绑定全局 CLAUDE.md 编辑器：保存按钮 + Cmd/Ctrl+Enter 保存 + 状态回显 */
function bindGlobalClaudeEditor(): void {
  const editor = document.querySelector<HTMLTextAreaElement>('#global-config-md-editor');
  const saveBtn = document.querySelector<HTMLButtonElement>('#global-config-save');
  const status = document.querySelector<HTMLParagraphElement>('#global-config-save-status');
  if (!editor || !saveBtn || !status) return;

  const save = async (): Promise<void> => {
    saveBtn.disabled = true;
    status.textContent = '正在保存…';
    status.classList.remove('is-success', 'is-error');
    try {
      const savedPath = await api.writeGlobalPrompt(editor.value);
      status.textContent = `已保存到 ${savedPath}（新会话生效）`;
      status.classList.add('is-success');
    } catch (e) {
      status.textContent = `保存失败：${String(e)}`;
      status.classList.add('is-error');
    } finally {
      saveBtn.disabled = false;
    }
  };

  saveBtn.addEventListener('click', () => {
    void save();
  });
  editor.addEventListener('keydown', (event) => {
    if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
      event.preventDefault();
      void save();
    }
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
  // CLAUDE.md 可编辑：始终渲染 textarea（无内容时为空 + 占位提示），仅在快速失败时不渲染以免误导。
  const mdPathHint = prompts?.global_md_path || '~/.claude/CLAUDE.md（尚未创建）';
  const mdHtml = error
    ? ''
    : `
      <div class="global-config-md">
        <textarea
          class="global-config-md-editor"
          id="global-config-md-editor"
          rows="10"
          placeholder="未配置全局提示词（~/.claude/CLAUDE.md 不存在），可在此撰写内容"
        >${escapeHtml(prompts?.global_md || '')}</textarea>
        <div class="global-config-editor-actions">
          <span class="global-config-md-path" title="${escapeHtml(mdPathHint)}">${escapeHtml(mdPathHint)}</span>
          <button type="button" class="global-config-save" id="global-config-save">保存</button>
        </div>
        <p class="global-config-save-status" id="global-config-save-status" role="status">内容将写入 ~/.claude/CLAUDE.md，新会话生效</p>
      </div>
    `;

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
      <p class="global-config-subtitle">CLAUDE.md 与斜杠命令对 Claude Code 全局生效；编辑并保存后将写入 ~/.claude/CLAUDE.md</p>
      ${error ? `<p class="global-config-error" role="alert">加载失败：${escapeHtml(error)}</p>` : ''}
      <h4 class="global-config-sub-title">CLAUDE.md（全局记忆 / 提示词）</h4>
      ${mdHtml}
      <h4 class="global-config-sub-title">斜杠命令</h4>
      ${commandsHtml}
    </section>
  `;
}
