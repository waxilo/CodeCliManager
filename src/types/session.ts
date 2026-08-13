import type { FileRef, Message } from './conversation';

export interface SessionErrorPayload {
  conversationId: string | null;
  error: string;
}

export interface SessionEventPayload {
  conversation_id: string;
  conversationId?: string;
  title: string;
  messages: Message[];
  project_dir?: string | null;
  projectDir?: string | null;
  updated_at: number;
  updatedAt?: number;
  context_tokens?: number | null;
  last_model?: string | null;
}

export interface MessageChunkPayload {
  conversation_id: string;
  kind: string;
  content: string;
}

/** 后端 permission-request 事件（工具权限确认 / AskUserQuestion） */
export interface PermissionRequestPayload {
  conversationId: string;
  requestId: string;
  toolName: string;
  input: unknown;
  description?: string | null;
}

/** AskUserQuestion 单个选项 */
export interface AskUserQuestionOption {
  label: string;
  description?: string;
}

/** AskUserQuestion 单题 */
export interface AskUserQuestionItem {
  question: string;
  header?: string;
  options: AskUserQuestionOption[];
  multiSelect?: boolean;
}

/** AskUserQuestion 工具 input */
export interface AskUserQuestionInput {
  questions: AskUserQuestionItem[];
}

export type QuestionDialogResult =
  | { action: 'submit'; answers: Record<string, string> }
  | { action: 'deny' };

/** 进行中的 AskUserQuestion */
export interface PendingAskQuestionState {
  requestId: string;
  conversationId: string;
  input: AskUserQuestionInput;
  answers?: Record<string, string>;
  finish?: (result: QuestionDialogResult) => void;
}

export interface StreamBlock {
  type: 'thinking' | 'text';
  content: string;
  /** text 块结束后才执行完整 Markdown 渲染 */
  finalized?: boolean;
}

export interface StreamingState {
  blocks: StreamBlock[];
  thinkingDone: boolean;
  /** 当前正在追加内容的块索引 */
  currentBlockIdx: number;
}

export interface QueuedPromptItem {
  id: string;
  prompt: string;
  messageContent: string;
  model?: string | null;
  queuedAt: number;
}

export interface ExecutePromptResult {
  status: 'sent' | 'queued';
  item?: QueuedPromptItem | null;
}

/** 待发送指令（发给 CLI 的一轮用户输入） */
export interface PreparedCommand {
  /** 发给 CLI 的完整 prompt */
  prompt: string;
  /** 气泡展示内容 */
  messageContent: string;
  refs?: FileRef[];
  model?: string;
}

export type PermissionMode = 'ask' | 'silent';
