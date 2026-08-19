import { invoke } from '@tauri-apps/api/core';
import type { GlobalSkillEntry, GlobalPromptsState } from '../types';

export function getGlobalSkills(): Promise<GlobalSkillEntry[]> {
  return invoke<GlobalSkillEntry[]>('get_global_skills');
}

export function getGlobalPrompts(): Promise<GlobalPromptsState> {
  return invoke<GlobalPromptsState>('get_global_prompts');
}
