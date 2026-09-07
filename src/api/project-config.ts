import { invoke } from '@tauri-apps/api/core';
import type {
  McpServerConfig,
  McpServersState,
  ProjectPromptState,
  ProjectSkillDocument,
  ProjectSkillEntry,
} from '../types';

export function getProjectMcpServers(projectDir: string): Promise<McpServersState> {
  return invoke<McpServersState>('get_project_mcp_servers', { projectDir });
}

export function upsertProjectMcpServer(args: {
  projectDir: string;
  name: string;
  config: McpServerConfig;
}): Promise<McpServersState> {
  return invoke<McpServersState>('upsert_project_mcp_server', args);
}

export function deleteProjectMcpServer(projectDir: string, name: string): Promise<McpServersState> {
  return invoke<McpServersState>('delete_project_mcp_server', { projectDir, name });
}

export function getProjectSkills(projectDir: string): Promise<ProjectSkillEntry[]> {
  return invoke<ProjectSkillEntry[]>('get_project_skills', { projectDir });
}

export function readProjectSkill(projectDir: string, name: string): Promise<ProjectSkillDocument> {
  return invoke<ProjectSkillDocument>('read_project_skill', { projectDir, name });
}

export function writeProjectSkill(
  projectDir: string,
  name: string,
  content: string,
): Promise<ProjectSkillDocument> {
  return invoke<ProjectSkillDocument>('write_project_skill', { projectDir, name, content });
}

export function deleteProjectSkill(projectDir: string, name: string): Promise<void> {
  return invoke<void>('delete_project_skill', { projectDir, name });
}

export function getProjectPrompt(projectDir: string): Promise<ProjectPromptState> {
  return invoke<ProjectPromptState>('get_project_prompt', { projectDir });
}

export function writeProjectPrompt(projectDir: string, content: string): Promise<ProjectPromptState> {
  return invoke<ProjectPromptState>('write_project_claude_md', { projectDir, content });
}
