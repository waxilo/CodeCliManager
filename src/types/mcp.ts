/** MCP 服务器配置（对应 ~/.claude.json mcpServers 中单个服务器的结构） */
export interface McpServerConfig {
  type?: string;
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
}

/** MCP 服务器列表条目 */
export interface McpServerEntry {
  name: string;
  config: McpServerConfig;
  parseError?: string | null;
}

/** get_mcp_servers / upsert / delete 的返回值 */
export interface McpServersState {
  servers: McpServerEntry[];
  configPath: string;
}
