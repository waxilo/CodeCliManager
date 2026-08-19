/** 全局 Skills：~/.claude/skills/<name>/SKILL.md */
export interface GlobalSkillEntry {
  name: string;
  display_name: string;
  description: string;
  path: string;
}

/** 全局斜杠命令：~/.claude/commands/<name>.md */
export interface GlobalPromptEntry {
  name: string;
  description: string;
  path: string;
}

/** get_global_prompts 返回值 */
export interface GlobalPromptsState {
  global_md: string | null;
  global_md_path: string | null;
  commands: GlobalPromptEntry[];
}
