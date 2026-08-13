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

export interface ToolMessageData {
  toolName: string;
  toolInput: Record<string, unknown>;
  toolResult?: string;
  isError?: boolean;
  toolUseId?: string;
  displayMode: 'one-line' | 'collapsible';
  colorScheme: ToolColorScheme;
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
