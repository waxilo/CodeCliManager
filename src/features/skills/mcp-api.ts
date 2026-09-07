import * as api from '../../api';
import type { McpServerConfig, McpServersState, SkillsTarget } from '../../types';

function requireProjectDir(target: SkillsTarget): string {
  if (target.scope !== 'project' || !target.projectDir) {
    throw new Error('缺少项目目录');
  }
  return target.projectDir;
}

export function getScopedMcpServers(target: SkillsTarget): Promise<McpServersState> {
  return target.scope === 'project'
    ? api.getProjectMcpServers(requireProjectDir(target))
    : api.getMcpServers();
}

export function upsertScopedMcpServer(
  target: SkillsTarget,
  args: { name: string; config: McpServerConfig; oldName?: string | null },
): Promise<McpServersState> {
  return target.scope === 'project'
    ? api.upsertProjectMcpServer({
        projectDir: requireProjectDir(target),
        name: args.name,
        config: args.config,
      })
    : api.upsertMcpServer(args);
}

export function deleteScopedMcpServer(
  target: SkillsTarget,
  name: string,
): Promise<McpServersState> {
  return target.scope === 'project'
    ? api.deleteProjectMcpServer(requireProjectDir(target), name)
    : api.deleteMcpServer(name);
}
