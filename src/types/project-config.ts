export type SkillsScope = 'global' | 'project';

export interface SkillsTarget {
  scope: SkillsScope;
  projectDir: string | null;
}

export interface ProjectSkillEntry {
  name: string;
  displayName: string;
  description: string;
  path: string;
}

export interface ProjectSkillDocument extends ProjectSkillEntry {
  content: string;
}

export interface ProjectPromptState {
  content: string | null;
  path: string;
}
