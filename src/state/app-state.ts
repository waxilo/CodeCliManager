import type { Update as AppUpdate } from '@tauri-apps/plugin-updater';
import type {
  Conversation,
  StreamingState,
  PendingAskQuestionState,
  KiroStatusData,
  DshStatusData,
  McpServerEntry,
  ClaudeCodeUpdateInfo,
  ClaudeUpdateCheckStatus,
  AppUpdateCheckStatus,
  AppUpdateInfo,
  QueuedPromptItem,
  SettingsSection,
  SkillsSection,
  ActiveToolState,
  TodoItem,
  SessionUsage,
  FileRef,
} from '../types';
import { createRequestGuard } from '../utils';
import type { ScrollController } from '../ui';

/** 消息窗口封顶数；超过则只渲染尾部窗口，顶部提供「加载更早」按钮 */
export const MAX_VISIBLE_MESSAGES = 200;
/** 点击「加载更早」每次多取的消息条数 */
export const LOAD_EARLIER_STEP = 200;

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

export interface PendingUserMessage {
  content: string;
  refs?: FileRef[];
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
  activePendingSessionKey: '',
  pendingUserMessagesBySession: new Map<string, PendingUserMessage>(),
  transientSessionErrorsBySession: new Map<string, string>(),
  chatModelOptions: [] as string[],
  currentDefaultModel: '',
  pendingProjectDir: null as string | null,
  chatModelPickerHighlightIndex: -1,
  expandedThinkingBlocks: new Set<string>(),
  isApiConfigViewActive: false,
  isSettingsViewActive: false,
  settingsSection: 'app-update' as SettingsSection,
  apiConfigMountToken: 0,
  apiConfigEscapeHandler: null as ((event: KeyboardEvent) => void) | null,
  settingsEscapeHandler: null as ((event: KeyboardEvent) => void) | null,
  kiroStatus: null as KiroStatusData | null,
  /** 当前活跃 API profile 是否为 DeepSeek（标题栏 DSH 入口显示条件） */
  activeProfileIsDeepSeek: false,
  /** 当前活跃 API profile 的 baseUrl / id（供 DSH 顶栏等复用余额查询） */
  activeProfileBaseUrl: '',
  activeProfileId: '',
  dshStatus: null as DshStatusData | null,
  dshProgressText: '',
  /** DSH 模式：主窗口整体切换为 DeepSeek Harness 页面 */
  dshModeActive: false,
  kiroUsageGuard: createRequestGuard(),
  isKiroViewActive: false,
  kiroMountToken: 0,
  kiroEscapeHandler: null as ((event: KeyboardEvent) => void) | null,
  deepSeekBalanceGuard: createRequestGuard(),
  mainBalanceGuard: createRequestGuard(),
  mainBalanceCache: null as MainBalanceCache | null,
  gitBranchCache: null as GitBranchCache | null,
  /** 底栏展示的当前会话工作目录（null = 无会话/未知，不展示） */
  activeProjectDirCache: null as string | null,
  isSkillsViewActive: false,
  skillsSection: 'mcp' as SkillsSection,
  skillsMountToken: 0,
  skillsEscapeHandler: null as ((event: KeyboardEvent) => void) | null,
  mcpServers: [] as McpServerEntry[],
  mcpConfigPath: '',
  claudeUpdateInfo: null as ClaudeCodeUpdateInfo | null,
  claudeUpdateCheckStatus: 'idle' as ClaudeUpdateCheckStatus,
  claudeUpdateCheckPromise: null as Promise<void> | null,
  claudeUpdateError: null as string | null,
  /** claude 更新子进程的实时输出行（最后一行，用于进度反馈） */
  claudeUpdateProgressText: '' as string,
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
  /** 更新过程中的分步状态文案（重新获取/下载/关闭会话/安装），用于弹层实时反馈，避免误以为卡死 */
  appUpdateStatusText: null as string | null,
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
  /** sessionId → 本轮运行起始时间戳（ms）；输入框下方「执行时长」的计时锚点 */
  sessionRunStartedAt: new Map<string, number>(),
  /** sessionId → 临时状态文案（api_retry 等），下一个内容块/turn 结束时清除 */
  runStatusOverride: new Map<string, string>(),
  /** askKey(sessionId|'pending') → 问卡 Enter 提交回调；并发多卡互不覆盖 */
  activeQuestionEnterHandlers: new Map<string, () => boolean>(),
  streamRefreshBySession: new Map<string, StreamRefreshState>(),
  thinkingScrollers: new Map<string, ScrollController>(),
  interactionPanelsBySession: new Map<string, ActiveInteractionPanel>(),
  /** tail-N 消息窗口：conversationInstanceKey → 可见消息条数（「加载更早」按会话独立累计，切换不丢失） */
  messageWindowSizeByConversation: new Map<string, number>(),
  /** conversationInstanceKey → get_conversation 返回的版本号；用于回传 known_version 跳过未变更会话的重传 */
  conversationVersions: new Map<string, string>(),
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
