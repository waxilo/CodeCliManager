import { appState } from '../../state';
import * as api from '../../api';
import { getEffectiveProjectDir } from '../chat/session-context';
import { syncStatusBarSections } from './balance';
import { getMainBalanceBarEl } from './balance';
export function setGitBranchContent(projectDir: string, branch: string): void {
  appState.gitBranchCache = { projectDir, branch };
  const bar = getMainBalanceBarEl();
  if (!bar) return;
  const branchEl = bar.querySelector('[data-git-branch]') as HTMLElement | null;
  if (branchEl) {
    branchEl.textContent = branch;
    branchEl.title = branch;
  }
  syncStatusBarSections();
}

export function clearGitBranchCache(): void {
  appState.gitBranchCache = null;
  syncStatusBarSections();
}

/** 刷新当前项目目录的 git 分支（有缓存时先保留，结果回来再替换） */
export async function refreshGitBranch(): Promise<void> {
  const bar = getMainBalanceBarEl();
  if (!bar) return;

  const projectDir = getEffectiveProjectDir();
  if (!projectDir) {
    clearGitBranchCache();
    return;
  }

  if (appState.gitBranchCache && appState.gitBranchCache.projectDir !== projectDir) {
    clearGitBranchCache();
  }

  try {
    const branch = await api.getGitBranch(projectDir);
    if (getEffectiveProjectDir() !== projectDir) return;
    if (branch && branch.trim()) {
      setGitBranchContent(projectDir, branch.trim());
    } else {
      clearGitBranchCache();
    }
  } catch {
    // 保留缓存，避免偶发失败把分支刷没
  }
}

/** 刷新主界面底部余额条（DeepSeek 余额 / Kiro 额度；其余配置隐藏） */
