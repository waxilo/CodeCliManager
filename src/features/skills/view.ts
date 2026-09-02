import { appState } from '../../state';
import { renderMcpSectionHtml } from './mcp-section';
import { renderGlobalSkillsSectionHtml } from './global-skills-section';
import { renderGlobalPromptsSectionHtml } from './global-prompts-section';

/** 「技能」页左侧竖排导航：MCP / 全局 Skills / 全局提示词 三个横向分区（复用设置页分类导航样式） */
export function renderSkillsSidebarHtml(): string {
  return `
    <div class="api-config-sidebar settings-sidebar">
      <div class="settings-section-nav" role="navigation" aria-label="技能分类">
        <button type="button" class="settings-section-item${appState.skillsSection === 'mcp' ? ' is-active' : ''}" data-skills-section="mcp">
          <span class="settings-section-item-icon">
            <svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <rect x="2" y="3" width="20" height="14" rx="2"/>
              <line x1="8" y1="21" x2="16" y2="21"/>
              <line x1="12" y1="17" x2="12" y2="21"/>
              <path d="M7 7h2v2H7zM11 7h2v2h-2zM15 7h2v2h-2z"/>
            </svg>
          </span>
          <span>MCP</span>
        </button>
        <button type="button" class="settings-section-item${appState.skillsSection === 'skill' ? ' is-active' : ''}" data-skills-section="skill">
          <span class="settings-section-item-icon">
            <svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <path d="M4 6a2 2 0 0 1 2-2h4l2 2h6a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6z"/>
              <path d="M9 14l2 2 4-4"/>
            </svg>
          </span>
          <span>Skill</span>
        </button>
        <button type="button" class="settings-section-item${appState.skillsSection === 'prompts' ? ' is-active' : ''}" data-skills-section="prompts">
          <span class="settings-section-item-icon">
            <svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/>
              <path d="M14 2v6h6"/>
              <line x1="8" y1="13" x2="16" y2="13"/>
              <line x1="8" y1="17" x2="16" y2="17"/>
            </svg>
          </span>
          <span>提示词</span>
        </button>
      </div>
    </div>
  `;
}

export function renderSkillsViewHtml(): string {
  if (appState.skillsSection === 'skill') {
    return renderGlobalSkillsSectionHtml();
  }
  if (appState.skillsSection === 'prompts') {
    return renderGlobalPromptsSectionHtml();
  }
  return renderMcpSectionHtml();
}
