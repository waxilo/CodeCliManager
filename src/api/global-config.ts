import { invoke } from '@tauri-apps/api/core';
import type { GlobalSkillEntry, GlobalPromptsState } from '../types';

export function getGlobalSkills(): Promise<GlobalSkillEntry[]> {
  return invoke<GlobalSkillEntry[]>('get_global_skills');
}

/** 删除全局 Skill：整目录移除 ~/.claude/skills/<name>/ */
export function deleteGlobalSkill(name: string): Promise<void> {
  return invoke<void>('delete_global_skill', { name });
}

export function getGlobalPrompts(): Promise<GlobalPromptsState> {
  return invoke<GlobalPromptsState>('get_global_prompts');
}

/** 把全局 CLAUDE.md 内容写入 ~/.claude/CLAUDE.md，返回写入后的路径 */
export function writeGlobalPrompt(content: string): Promise<string> {
  return invoke<string>('write_global_claude_md', { content });
}
