import type { FileRef, Message, SessionUsage } from './conversation';

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
  source_path?: string | null;
  sourcePath?: string | null;
  updated_at: number;
  updatedAt?: number;
  context_tokens?: number | null;
  last_model?: string | null;
  usage?: SessionUsage | null;
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

/** 流式/进行中的可见工具 */
export type ActiveToolStatus = 'running' | 'done' | 'failed';

/** 子代理执行进度（system/task_notification 下发） */
export interface SubagentProgress {
  status?: string;
  totalTokens?: number;
  toolUses?: number;
  durationMs?: number;
}

export interface ActiveToolState {
  toolUseId: string;
  toolName: string;
  input: Record<string, unknown>;
  status: ActiveToolStatus;
  toolResult?: string;
  isError?: boolean;
  startedAt: number;
  /** 工具开始时的流式块序号：实时渲染时工具卡插到该思考/文本块之后（思考-工具-思考穿插） */
  blockIndexAtStart?: number;
  /** 子代理 Task：CLI task_id（与 tool_use_id 可能不同时用于匹配通知） */
  taskId?: string;
  /** 子代理 Task：执行描述（system/task_started 下发） */
  description?: string;
  /** 子代理 Task：进度汇总（system/task_notification 下发） */
  progress?: SubagentProgress;
  /** 子代理：完成通知摘要（<task-notification> summary，history 解析合并） */
  summary?: string;
  /** 子代理：完整报告（<task-notification> result，history 解析合并） */
  report?: string;
}

/** TodoList 清单项（TodoWrite 协议：整表替换） */
export interface TodoItem {
  id: string;
  content: string;
  status: string;
  [key: string]: unknown;
}

/** 会话用量增量事件（后端 session-usage-updated 下发） */
export interface SessionUsageUpdatedPayload {
  conversationId: string;
  inputTokens: number;
  outputTokens: number;
  cacheRead: number;
  cacheCreation: number;
  costUsd?: number | null;
}

export interface StreamBlock {
  type: 'thinking' | 'text';
  content: string;
  /** text 块结束后才执行完整 Markdown 渲染 */
  finalized?: boolean;
  /** 思考块时长（ms）：后端 thinking_end 下发，展示在思考块标题 */
  durationMs?: number;
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
  runId?: string | null;
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
