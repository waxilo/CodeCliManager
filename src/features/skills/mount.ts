import { appState } from '../../state';
import { shellApi } from '../../app/shell/api';
import { stashComposerDraft, restoreComposerDraft } from '../files/index';
import { startMainBalanceBarAutoRefresh } from '../status-bar';
import { mountMcpSection } from './mcp-mount';
import { mountGlobalSkillsSection } from './global-skills-section';
import { mountGlobalPromptsSection } from './global-prompts-section';

export function openSkillsView() {
  if (appState.isSkillsViewActive) return;
  // 全屏管理页互斥
  if (appState.isApiConfigViewActive) {
    shellApi.dismissApiConfigViewState();
  }
  if (appState.isSettingsViewActive) {
    shellApi.dismissSettingsViewState();
  }
  if (appState.isKiroViewActive) {
    shellApi.dismissKiroViewState();
  }
  // 增量进出会摘取/挂回主视图；先保存草稿以防回退到全量重绘路径时丢失
  stashComposerDraft();
  appState.isSkillsViewActive = true;
  shellApi.enterManagementView('skills');
}

/** 退出「技能」页状态（不触发 render，供即将全量重绘的路径使用） */
export function dismissSkillsViewState() {
  if (!appState.isSkillsViewActive && !appState.skillsEscapeHandler) return;
  if (appState.skillsEscapeHandler) {
    document.removeEventListener('keydown', appState.skillsEscapeHandler);
    appState.skillsEscapeHandler = null;
  }
  appState.skillsMountToken += 1;
  document.querySelector('.mcp-dialog-overlay')?.remove();
  appState.isSkillsViewActive = false;
}

export function closeSkillsView() {
  if (!appState.isSkillsViewActive) {
    dismissSkillsViewState();
    return;
  }
  dismissSkillsViewState();
  shellApi.exitManagementView();
  restoreComposerDraft();
  startMainBalanceBarAutoRefresh();
}

export function mountSkillsView() {
  if (!appState.isSkillsViewActive) return;

  const onEscapeKey = (event: KeyboardEvent) => {
    if (event.key !== 'Escape') return;
    if (!appState.isSkillsViewActive) return;
    // 确认框/MCP 弹窗打开时交由其自身处理
    if (document.querySelector('.confirm-overlay')) return;
    const dialog = document.querySelector('.mcp-dialog-overlay');
    if (dialog) {
      dialog.remove();
      event.preventDefault();
      return;
    }
    event.preventDefault();
    closeSkillsView();
  };

  if (appState.skillsEscapeHandler) {
    document.removeEventListener('keydown', appState.skillsEscapeHandler);
  }
  appState.skillsEscapeHandler = onEscapeKey;
  document.addEventListener('keydown', onEscapeKey);

  void mountActiveSkillsSection();
}

/** 按当前 skillsSection 挂载对应分区内容 */
export async function mountActiveSkillsSection(): Promise<void> {
  if (appState.skillsSection === 'skill') {
    await mountGlobalSkillsSection();
  } else if (appState.skillsSection === 'prompts') {
    await mountGlobalPromptsSection();
  } else {
    await mountMcpSection();
  }
}
