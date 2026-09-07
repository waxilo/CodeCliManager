import { appState } from '../../state';
import type { SkillsTarget } from '../../types';

export function getSkillsTarget(): SkillsTarget {
  if (appState.skillsScope === 'project' && appState.skillsProjectDir) {
    return { scope: 'project', projectDir: appState.skillsProjectDir };
  }
  return { scope: 'global', projectDir: null };
}

export function isSameSkillsTarget(a: SkillsTarget, b: SkillsTarget): boolean {
  return a.scope === b.scope && a.projectDir === b.projectDir;
}

export function skillsTargetKey(target = getSkillsTarget()): string {
  return target.scope === 'project' ? `project:${target.projectDir}` : 'global';
}

export function projectName(projectDir: string): string {
  return projectDir.replace(/[\\/]+$/, '').split(/[\\/]/).pop() || projectDir;
}
