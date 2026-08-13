import type { Update as AppUpdate } from '@tauri-apps/plugin-updater';
import type {
  Conversation,
  StreamingState,
  PendingAskQuestionState,
  KiroStatusData,
  McpServerEntry,
  ClaudeCodeUpdateInfo,
  ClaudeUpdateCheckStatus,
  AppUpdateCheckStatus,
  AppUpdateInfo,
  QueuedPromptItem,
  SettingsSection,
  ActiveToolState,
  TodoItem,
  SessionUsage,
} from '../types';
import { createRequestGuard } from '../utils';
import type { ScrollController } from '../ui';

/** 工具权限：ask=同工具首次询问，silent=静默自动允许 */
export const PERMISSION_MODE_STORAGE_KEY = 'codemanager-permission-mode';

/** 侧边栏工作区展开状态持久化（localStorage key） */
export const EXPANDED_WORKSPACES_KEY = 'expandedWorkspaces';

export interface MainBalanceCache {
  profileId: string;
  label: string;
  value: string;
}

export interface GitBranchCache {
  projectDir: string;
  branch: string;
}

export interface PasteAttachment {
  path: string;
  name: string;
  objectUrl: string;
}

export interface ImportedFileRef {
  ref: string;
  fileName: string;
  isImage: boolean;
  isDir: boolean;
}

export interface ComposerDraft {
  text: string;
  pasteAttachments: PasteAttachment[];
  importedFileRefs: ImportedFileRef[];
}

export interface StreamRefreshState {
  rafId: number | null;
  pending: boolean;
  lastTime: number;
}

export interface ActiveInteractionPanel {
  conversationId: string;
  element: HTMLElement;
  cleanup: (result: 'allow' | 'deny') => void;
}

/**
 * 全局可变应用状态。
 * 使用对象属性以便跨模块读写（ESM 对 import let 绑定不可赋值）。
 */
export const appState = {
  conversations: [] as Conversation[],
  currentPlatform: '',
  activeConversationId: '',
  activeConversationSourcePath: null as string | null,
  editingConversationId: null as string | null,
  editingConversationSourcePath: null as string | null,
  pendingUserMessage: null as string | null,
  pendingUserMessageConvId: null as string | null,
  transientSessionError: null as string | null,
  chatModelOptions: [] as string[],
  currentDefaultModel: '',
  pendingProjectDir: null as string | null,
  chatModelPickerHighlightIndex: -1,
  expandedThinkingBlocks: new Set<string>(),
  sidebarSearchQuery: '',
  isApiConfigViewActive: false,
  isSettingsViewActive: false,
  settingsSection: 'app-update' as SettingsSection,
  apiConfigMountToken: 0,
  apiConfigEscapeHandler: null as ((event: KeyboardEvent) => void) | null,
  settingsEscapeHandler: null as ((event: KeyboardEvent) => void) | null,
  kiroStatus: null as KiroStatusData | null,
  kiroUsageGuard: createRequestGuard(),
  isKiroViewActive: false,
  kiroMountToken: 0,
  kiroEscapeHandler: null as ((event: KeyboardEvent) => void) | null,
  deepSeekBalanceGuard: createRequestGuard(),
  mainBalanceGuard: createRequestGuard(),
  mainBalanceCache: null as MainBalanceCache | null,
  gitBranchCache: null as GitBranchCache | null,
  isMcpViewActive: false,
  mcpMountToken: 0,
  mcpEscapeHandler: null as ((event: KeyboardEvent) => void) | null,
  mcpServers: [] as McpServerEntry[],
  mcpConfigPath: '',
  claudeUpdateInfo: null as ClaudeCodeUpdateInfo | null,
  claudeUpdateCheckStatus: 'idle' as ClaudeUpdateCheckStatus,
  claudeUpdateCheckPromise: null as Promise<void> | null,
  claudeUpdateError: null as string | null,
  appUpdate: null as AppUpdate | null,
  appUpdateInfo: {
    currentVersion: null,
    latestVersion: null,
    updateAvailable: false,
    body: null,
    error: null,
  } as AppUpdateInfo,
  appUpdateCheckStatus: 'idle' as AppUpdateCheckStatus,
  appUpdateProgress: null as { downloaded: number; total: number } | null,
  appUpdateCheckPromise: null as Promise<void> | null,
  newConversationIds: new Set<string>(),
  expandedWorkspaces: new Set<string>(
    (() => {
      try {
        return JSON.parse(localStorage.getItem(EXPANDED_WORKSPACES_KEY) || '[]');
      } catch {
        return [];
      }
    })()
  ),
  streamingBySession: new Map<string, StreamingState>(),
  pendingTextDelta: new Map<string, string>(),
  runningSessions: new Set<string>(),
  abortingSessions: new Set<string>(),
  modelRestartingSessions: new Set<string>(),
  isAbortingActiveSession: false,
  sessionProcessModels: new Map<string, string>(),
  runIdsBySession: new Map<string, string>(),
  queuedPromptsBySession: new Map<string, QueuedPromptItem[]>(),
  pendingAskQuestions: new Map<string, PendingAskQuestionState>(),
  /** sessionId → toolUseId → 进行中的 Task 等可见工具 */
  activeToolsBySession: new Map<string, Map<string, ActiveToolState>>(),
  /** sessionId → TodoList 清单（TodoWrite 整表替换） */
  todosBySession: new Map<string, TodoItem[]>(),
  /** sessionId → 会话累计用量（历史基线 + 进程增量叠加） */
  usageBySession: new Map<string, SessionUsage>(),
  activeQuestionEnterHandler: null as (() => boolean) | null,
  activeAskQuestionCleanup: null as (() => void) | null,
  questionOtherInputActive: false,
  streamRefreshBySession: new Map<string, StreamRefreshState>(),
  answerScroller: null as ScrollController | null,
  thinkingScrollers: new Map<string, ScrollController>(),
  activeInteractionPanel: null as ActiveInteractionPanel | null,
  _cachedFileList: null as string[] | null,
  _cachedProjectDir: '',
  composerDrafts: new Map<string, ComposerDraft>(),
  pasteAttachments: [] as PasteAttachment[],
  importedFileRefs: [] as ImportedFileRef[],
  _lastDropTime: 0,
  _unlistenDragDrop: null as (() => void) | null,
};

/** 根挂载点 */
export const app = document.querySelector<HTMLDivElement>('#app')!;
