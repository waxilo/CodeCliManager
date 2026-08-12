import { invoke } from '@tauri-apps/api/core';
import type { McpServerConfig, McpServersState } from '../types';

export function getMcpServers(): Promise<McpServersState> {
  return invoke<McpServersState>('get_mcp_servers');
}

export function upsertMcpServer(args: {
  name: string;
  config: McpServerConfig;
  oldName?: string | null;
}): Promise<McpServersState> {
  return invoke<McpServersState>('upsert_mcp_server', args);
}

export function deleteMcpServer(name: string): Promise<McpServersState> {
  return invoke<McpServersState>('delete_mcp_server', { name });
}
