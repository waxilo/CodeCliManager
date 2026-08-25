/** 消息中的文件引用 */
export interface FileRef {
  path: string;
  isImage: boolean;
}

export interface ToolColorScheme {
  border: string;
  icon: string;
  primary: string;
}

/** 子代理完成通知（Rust 从 <task-notification> 解析，合并进 Agent/Task tool_use） */
export interface TaskNotificationData {
  tool_use_id?: string;
  status?: string;
  summary?: string;
  result?: string;
  total_tokens?: number;
  tool_uses?: number;
  duration_ms?: number;
}

export interface ToolMessageData {
  toolName: string;
  toolInput: Record<string, unknown>;
  toolResult?: string;
  isError?: boolean;
  toolUseId?: string;
  displayMode: 'one-line' | 'collapsible';
  colorScheme: ToolColorScheme;
  /** 子代理完成通知（status / summary / 完整报告），由 history 解析合并 */
  taskNotification?: TaskNotificationData;
  /** 头部摘要元信息 HTML（如「3 次工具 · 5.0s」）已被渲染为 .tool-meta span；
   *  用于把调用次数/耗时提到标题行右侧，而不是另占一行 */
  summaryMeta?: string;
}

export interface Message {
  id: string;
  role: string;
  content: string;
  thinking?: string;
  timestamp: number;
  refs?: FileRef[];
  toolData?: ToolMessageData;
}

/** 会话累计 token / 成本用量 */
export interface SessionUsage {
  inputTokens: number;
  outputTokens: number;
  cacheRead: number;
  cacheCreation: number;
  costUsd?: number | null;
}

export interface Conversation {
  id: string;
  title: string;
  messages: Message[];
  platform: string;
  project_dir?: string | null;
  source_path?: string | null;
  created_at: number;
  updated_at: number;
  context_tokens?: number | null;
  last_model?: string | null;
  /** 历史聚合用量（从 JSONL 解析），进程内增量在其上叠加 */
  usage?: SessionUsage | null;
}

export interface WorkspaceGroup {
  path: string;
  displayName: string;
  conversations: Conversation[];
}

/** 后端 import_external_path 返回值 */
export interface ImportResult {
  absolute_path: string;
  is_dir: boolean;
}
