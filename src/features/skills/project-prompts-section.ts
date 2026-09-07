import * as api from '../../api';
import { escapeHtml } from '../../utils';
import { getSkillsTarget, isSameSkillsTarget } from './scope';

let mountToken = 0;

export function renderProjectPromptsSectionHtml(): string {
  return `
    <div class="settings-update-view" id="skills-project-prompts-view">
      <div class="global-config-toolbar">
        <span class="global-config-subtitle">编辑项目根目录的 CLAUDE.md（项目指令）</span>
        <button type="button" class="global-config-refresh" id="project-prompts-refresh">刷新</button>
      </div>
      <div class="global-config-section" id="project-prompts-section">
        <div class="global-config-loading">加载中…</div>
      </div>
    </div>
  `;
}

export async function mountProjectPromptsSection(): Promise<void> {
  const target = getSkillsTarget();
  if (target.scope !== 'project' || !target.projectDir) return;
  const token = ++mountToken;
  const section = document.querySelector<HTMLElement>('#project-prompts-section');
  if (!section) return;
  section.innerHTML = '<div class="global-config-loading">加载中…</div>';

  try {
    const prompt = await api.getProjectPrompt(target.projectDir);
    if (token !== mountToken || !section.isConnected || !isSameSkillsTarget(target, getSkillsTarget())) return;
    section.innerHTML = `
      <section class="global-config-block">
        <h4 class="global-config-sub-title">CLAUDE.md（项目指令）</h4>
        <div class="global-config-md">
          <textarea class="global-config-md-editor" id="project-config-md-editor" rows="14" placeholder="尚未配置项目指令，可在此撰写 CLAUDE.md">${escapeHtml(prompt.content || '')}</textarea>
          <div class="global-config-editor-actions">
            <span class="global-config-md-path" title="${escapeHtml(prompt.path)}">${escapeHtml(prompt.path)}</span>
            <button type="button" class="global-config-save" id="project-config-save">保存</button>
          </div>
          <p class="global-config-save-status" id="project-config-save-status" role="status">内容将写入项目根目录 CLAUDE.md，新会话生效</p>
        </div>
      </section>
    `;
  } catch (err) {
    if (token !== mountToken || !section.isConnected) return;
    section.innerHTML = `<p class="global-config-error" role="alert">加载失败：${escapeHtml(String(err))}</p>`;
    return;
  }

  const view = document.querySelector<HTMLElement>('#skills-project-prompts-view');
  if (view && view.dataset.bound !== '1') {
    view.dataset.bound = '1';
    view.querySelector('#project-prompts-refresh')?.addEventListener('click', () => void mountProjectPromptsSection());
  }
  const editor = section.querySelector<HTMLTextAreaElement>('#project-config-md-editor');
  const saveButton = section.querySelector<HTMLButtonElement>('#project-config-save');
  const status = section.querySelector<HTMLElement>('#project-config-save-status');
  if (!editor || !saveButton || !status) return;
  const save = async () => {
    saveButton.disabled = true;
    status.textContent = '正在保存…';
    status.classList.remove('is-success', 'is-error');
    try {
      const saved = await api.writeProjectPrompt(target.projectDir!, editor.value);
      if (!isSameSkillsTarget(target, getSkillsTarget())) return;
      status.textContent = `已保存到 ${saved.path}（新会话生效）`;
      status.classList.add('is-success');
    } catch (err) {
      status.textContent = `保存失败：${String(err)}`;
      status.classList.add('is-error');
    } finally {
      saveButton.disabled = false;
    }
  };
  saveButton.addEventListener('click', () => void save());
  editor.addEventListener('keydown', (event) => {
    if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
      event.preventDefault();
      void save();
    }
  });
}
