import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { open, save } from '@tauri-apps/plugin-dialog';
import { getCurrentWebviewWindow } from '@tauri-apps/api/webviewWindow';
import { renderMarkdown as _renderMarkdown, initCodeCopyButtons, copyToClipboard as _copyToClipboard } from './markdown';

/** 后端 import_external_path 返回值 */
interface ImportResult {
  absolute_path: string;
  is_dir: boolean;
}

// Markdown 渲染缓存：避免对相同内容重复调用 marked.parse + DOMPurify
const _mdCache = new Map<string, string>();
const _MD_CACHE_MAX = 3000;
function renderMarkdown(src: string): string {
  const cached = _mdCache.get(src);
  if (cached !== undefined) return cached;
  const html = _renderMarkdown(src);
  if (_mdCache.size >= _MD_CACHE_MAX) {
    // 简单 LRU：删除最早的条目
    const firstKey = _mdCache.keys().next().value;
    if (firstKey !== undefined) _mdCache.delete(firstKey);
  }
  _mdCache.set(src, html);
  return html;
}

interface Message {
  id: string;
  role: string;
  content: string;
  thinking?: string;
  timestamp: number;
  refs?: FileRef[];
  toolData?: ToolMessageData;
}

interface ToolMessageData {
  toolName: string;
  toolInput: Record<string, unknown>;
  toolResult?: string;
  isError?: boolean;
  displayMode: 'one-line' | 'collapsible';
  colorScheme: ToolColorScheme;
}

interface ToolColorScheme {
  border: string;
  icon: string;
  primary: string;
}

interface FileRef {
  path: string;
  isImage: boolean;
}

interface Conversation {
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

interface SessionErrorPayload {
  conversationId: string | null;
  error: string;
}

interface SessionEventPayload {
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

interface MessageChunkPayload {
  conversation_id: string;
  kind: string;
  content: string;
}

interface ClaudeCodeApiConfig {
  baseUrl: string;
  hasApiKey: boolean;
  defaultModel: string;
  haikuModel: string;
  sonnetModel: string;
  opusModel: string;
  displayModels?: string[];
  customModels?: string[];
  configPath: string;
}

interface ApiProfileItem {
  id: string;
  name: string;
  baseUrl: string;
  defaultModel: string;
  hasApiKey: boolean;
  isActive: boolean;
}

interface ApiProfilesState {
  activeProfileId: string | null;
  profiles: ApiProfileItem[];
  current: ClaudeCodeApiConfig;
}

interface CcSwitchImportResult {
  importedCount: number;
  skippedCount: number;
  skippedNames: string[];
  ccSwitchPath: string;
  state: ApiProfilesState;
}

interface FetchedModel {
  id: string;
  ownedBy?: string | null;
}

type ThemeMode = 'light' | 'dark';

const THEME_STORAGE_KEY = 'codemanager-theme';
const SIDEBAR_WIDTH_STORAGE_KEY = 'codemanager-sidebar-width';
const SIDEBAR_COLLAPSED_STORAGE_KEY = 'codemanager-sidebar-collapsed';
const CLAUDE_UPDATE_DISMISS_KEY = 'codemanager-claude-update-dismissed';
const DEFAULT_SIDEBAR_WIDTH = 280;
/** 历史默认宽度：命中这些值时视为「用户从未手动调整」，自动迁移到新默认宽度 */
const LEGACY_DEFAULT_SIDEBAR_WIDTHS = [320, 184];
const MIN_SIDEBAR_WIDTH = 240;
const MIN_MAIN_CONTENT_WIDTH = 300;
const SIDEBAR_RESIZER_WIDTH = 4;
/** 窗口宽度低于该值时自动折叠侧边栏（响应式） */
const SIDEBAR_AUTO_COLLAPSE_WIDTH = 880;

interface StreamBlock {
  type: 'thinking' | 'text';
  content: string;
}

interface StreamingState {
  blocks: StreamBlock[];
  thinkingDone: boolean;
  /** 当前正在追加内容的块索引 */
  currentBlockIdx: number;
}

let conversations: Conversation[] = [];
let currentPlatform = '';
let activeConversationId = '';
let editingConversationId: string | null = null;
let pendingUserMessage: string | null = null;
/** pendingUserMessage 所属的会话 ID（确保消息不串会话） */
let pendingUserMessageConvId: string | null = null;
let transientSessionError: string | null = null;
let chatModelOptions: string[] = [];
/** 从配置文件（ANTHROPIC_MODEL / 活跃 profile.default_model）读取的当前默认模型 */
let currentDefaultModel: string = '';
/** 新会话尚未创建 ID 时，用户选择的工作目录 */
let pendingProjectDir: string | null = null;
let chatModelPickerHighlightIndex = -1;
/** 跟踪用户手动展开了哪些思考块（默认全部折叠，参考 claudecodeui defaultOpen=false） */
const expandedThinkingBlocks = new Set<string>();
/** 思考过程始终展示 */

let sidebarWidth = DEFAULT_SIDEBAR_WIDTH;
let isSidebarCollapsed = false;
/** 侧边栏当前是否处于「窄窗口自动折叠」状态（区别于用户手动折叠） */
let sidebarAutoCollapsed = false;
/** 上一次判定的窗口宽度区间，用于只在跨越断点时触发自动折叠 */
let sidebarWasNarrow: boolean | null = null;
/** 侧边栏会话搜索关键词 */
let sidebarSearchQuery = '';
/** 主界面是否正在展示 API 配置页（非弹窗） */
let isApiConfigViewActive = false;
/** 防止异步挂载与关闭竞态 */
let apiConfigMountToken = 0;
/** API 配置页 Escape 键监听（需在关闭时统一移除） */
let apiConfigEscapeHandler: ((event: KeyboardEvent) => void) | null = null;

interface ClaudeCodeUpdateInfo {
  installed: string | null;
  latest: string | null;
  updateAvailable: boolean;
  executablePath: string | null;
  error: string | null;
}

type ClaudeUpdateCheckStatus = 'idle' | 'checking' | 'ready' | 'error';

let claudeUpdateInfo: ClaudeCodeUpdateInfo | null = null;
let claudeUpdateCheckStatus: ClaudeUpdateCheckStatus = 'idle';
let claudeUpdateDismissedVersion: string | null = (() => {
  try {
    return localStorage.getItem(CLAUDE_UPDATE_DISMISS_KEY);
  } catch {
    return null;
  }
})();
let claudeUpdateCheckPromise: Promise<void> | null = null;
/** 新加入列表、需要播放淡入动画的会话 ID */
const newConversationIds = new Set<string>();

/** 侧边栏工作区展开状态持久化（localStorage key） */
const EXPANDED_WORKSPACES_KEY = 'expandedWorkspaces';
/** 工作区展开状态，key 为 workspace path */
let expandedWorkspaces = new Set<string>(
  (() => { try { return JSON.parse(localStorage.getItem(EXPANDED_WORKSPACES_KEY) || '[]'); } catch { return []; } })()
);

const streamingBySession = new Map<string, StreamingState>();
const pendingTextDelta = new Map<string, string>();
/** 正在运行的会话 ID 集合（后台执行的任务也包含在内） */
const runningSessions = new Set<string>();

/** 待发送指令（可在当前任务执行期间入队，结束后自动执行） */
interface QueuedCommand {
  id: string;
  /** 发给 CLI 的完整 prompt */
  prompt: string;
  /** 气泡展示内容 */
  messageContent: string;
  refs?: FileRef[];
  model?: string;
  createdAt: number;
}

/** 每会话独立指令队列（key 为 conversationId；新会话未建 ID 时用 pending） */
const commandQueues = new Map<string, QueuedCommand[]>();
/** 防止同一会话并发 drain */
const queueDrainInFlight = new Set<string>();
let streamRefreshRafId: number | null = null;
let streamRefreshPending = false;
let streamRefreshLastTime = 0;

// ── ScrollController：独立滚动容器管理 ──────────────────────────────

interface ScrollControllerOptions {
  /** 距离底部多少 px 时判定为"在底部"（触发恢复自动滚动） */
  resumePx: number;
  /** 距离底部多少 px 时判定为"用户已离开"（触发停止自动滚动） */
  leavePx: number;
  /** 是否创建浮动"回到底部"按钮 */
  createButton?: boolean;
  /** 滚动按钮的 CSS class */
  buttonClass?: string;
  /** 是否阻止 wheel 事件冒泡（嵌套滚动容器使用，避免影响父容器） */
  stopWheelPropagation?: boolean;
}

class ScrollController {
  readonly el: HTMLElement;
  autoScroll = true;
  private opts: Required<ScrollControllerOptions>;
  private rafId: number | null = null;
  private buttonEl: HTMLElement | null = null;
  private buttonClickHandler: (() => void) | null = null;

  constructor(el: HTMLElement, opts: ScrollControllerOptions) {
    this.el = el;
    this.opts = {
      resumePx: opts.resumePx,
      leavePx: opts.leavePx,
      createButton: opts.createButton ?? false,
      buttonClass: opts.buttonClass ?? 'scroll-to-bottom-btn',
      stopWheelPropagation: opts.stopWheelPropagation ?? false,
    };

    // wheel 事件：向上滚动 → 关闭自动滚动
    el.addEventListener('wheel', this._onWheel, { passive: true });
    // scroll 事件：回到底部 → 恢复自动滚动（scroll 不冒泡，无需处理）
    el.addEventListener('scroll', this._onScroll, { passive: true });

    if (this.opts.createButton) {
      this._createButton();
    }
  }

  /** 新内容到达时调用：若 autoScroll 则置底（RAF 节流） */
  onNewContent(): void {
    if (!this.autoScroll) return;
    if (this.rafId !== null) return; // 已有待处理的 RAF
    this.rafId = requestAnimationFrame(() => {
      this.rafId = null;
      this._scrollToBottom();
    });
  }

  /** 立即置底并开启自动滚动 */
  scrollToBottom(): void {
    this.autoScroll = true;
    this._scrollToBottom();
    this._updateButton();
  }

  /** 销毁：移除监听器和按钮 */
  destroy(): void {
    this.el.removeEventListener('wheel', this._onWheel);
    this.el.removeEventListener('scroll', this._onScroll);
    if (this.rafId !== null) {
      cancelAnimationFrame(this.rafId);
      this.rafId = null;
    }
    if (this.buttonClickHandler) {
      this.buttonEl?.removeEventListener('click', this.buttonClickHandler);
      this.buttonClickHandler = null;
    }
    this.buttonEl?.remove();
    this.buttonEl = null;
  }

  // ── 内部方法 ──────────────────────────────────────────

  private _isNearBottom(): boolean {
    return this.el.scrollHeight - this.el.scrollTop - this.el.clientHeight < this.opts.resumePx;
  }

  private _isFarFromBottom(): boolean {
    return this.el.scrollHeight - this.el.scrollTop - this.el.clientHeight > this.opts.leavePx;
  }

  private _scrollToBottom(): void {
    // 暂时关闭 smooth 滚动避免动画积压
    const prev = this.el.style.scrollBehavior;
    this.el.style.scrollBehavior = 'auto';
    this.el.scrollTop = this.el.scrollHeight;
    this.el.style.scrollBehavior = prev;
  }

  private _onWheel = (e: WheelEvent): void => {
    if (this.opts.stopWheelPropagation) {
      e.stopPropagation();
    }
    if (e.deltaY < 0) {
      // 用户向上滚动 → 停止自动跟随
      this.autoScroll = false;
    } else if (this._isNearBottom()) {
      // 用户向下滚动到底部 → 恢复自动跟随
      this.autoScroll = true;
    }
  };

  private _onScroll = (): void => {
    if (this._isNearBottom()) {
      this.autoScroll = true;
    } else if (this._isFarFromBottom()) {
      // 用户已离开底部区域 → 停止自动跟随
      this.autoScroll = false;
    }
    this._updateButton();
  };

  private _createButton(): void {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = this.opts.buttonClass;
    btn.title = '滚动到底部';
    btn.innerHTML = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9"></polyline></svg>`;
    btn.addEventListener('click', this.buttonClickHandler = () => this.scrollToBottom());
    this.el.appendChild(btn);
    this.buttonEl = btn;
  }

  private _updateButton(): void {
    if (!this.buttonEl) return;
    if (this._isNearBottom()) {
      this.buttonEl.classList.remove('visible');
    } else {
      this.buttonEl.classList.add('visible');
    }
  }
}

// ── 全局滚动控制器 ──────────────────────────────────────

/** Answer 区域滚动控制器（#message-list） */
let answerScroller: ScrollController | null = null;
/** Thinking 区域滚动控制器（按元素映射，key 为 streaming-block-N 的 N） */
const thinkingScrollers = new Map<string, ScrollController>();

/** 获取或创建指定思考块的 ScrollController */
function getThinkingScroller(el: HTMLElement, id: string): ScrollController {
  let sc = thinkingScrollers.get(id);
  if (!sc || sc.el !== el) {
    sc?.destroy();
    sc = new ScrollController(el, { resumePx: 20, leavePx: 80, stopWheelPropagation: true });
    thinkingScrollers.set(id, sc);
  }
  return sc;
}

const app = document.querySelector<HTMLDivElement>('#app')!;

function getStoredTheme(): ThemeMode | null {
  const stored = localStorage.getItem(THEME_STORAGE_KEY);
  if (stored === 'light' || stored === 'dark') {
    return stored;
  }
  return null;
}

function getSystemTheme(): ThemeMode {
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

function getCurrentTheme(): ThemeMode {
  const theme = document.documentElement.dataset.theme;
  return theme === 'light' ? 'light' : 'dark';
}

function applyTheme(theme: ThemeMode) {
  document.documentElement.dataset.theme = theme;
  localStorage.setItem(THEME_STORAGE_KEY, theme);
  updateThemeToggleButton();
}

function getThemeToggleTitle(theme: ThemeMode = getCurrentTheme()): string {
  return theme === 'dark' ? '切换到日间模式' : '切换到夜间模式';
}

function getThemeToggleIcon(theme: ThemeMode = getCurrentTheme()): string {
  if (theme === 'dark') {
    return `<svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M4.93 19.07l1.41-1.41M17.66 6.34l1.41-1.41"/></svg>`;
  }
  return `<svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/></svg>`;
}

function updateThemeToggleButton() {
  const themeBtn = document.querySelector('#theme-toggle-btn') as HTMLButtonElement | null;
  if (!themeBtn) return;
  themeBtn.title = getThemeToggleTitle();
  themeBtn.setAttribute('aria-label', getThemeToggleTitle());
  themeBtn.innerHTML = getThemeToggleIcon();
}

function initTheme() {
  applyTheme(getStoredTheme() || getSystemTheme());
}

function loadSidebarWidth(): number {
  try {
    const stored = localStorage.getItem(SIDEBAR_WIDTH_STORAGE_KEY);
    if (stored) {
      const parsed = Number.parseInt(stored, 10);
      if (!Number.isNaN(parsed)) {
        if (LEGACY_DEFAULT_SIDEBAR_WIDTHS.includes(parsed) || parsed < MIN_SIDEBAR_WIDTH) {
          return DEFAULT_SIDEBAR_WIDTH;
        }
        return parsed;
      }
    }
  } catch {
    // ignore invalid storage
  }
  return DEFAULT_SIDEBAR_WIDTH;
}

function getMaxSidebarWidth(): number {
  const container = document.querySelector('.app-container');
  const containerWidth = container?.clientWidth ?? window.innerWidth;
  return containerWidth - MIN_MAIN_CONTENT_WIDTH - SIDEBAR_RESIZER_WIDTH;
}

function clampSidebarWidth(width: number): number {
  const maxWidth = Math.max(MIN_SIDEBAR_WIDTH, getMaxSidebarWidth());
  return Math.round(Math.min(Math.max(width, MIN_SIDEBAR_WIDTH), maxWidth));
}

function applySidebarWidth(width: number) {
  sidebarWidth = clampSidebarWidth(width);
  document.documentElement.style.setProperty('--sidebar-width', `${sidebarWidth}px`);
}

function saveSidebarWidth(width: number) {
  localStorage.setItem(SIDEBAR_WIDTH_STORAGE_KEY, String(width));
}

function initSidebarWidth() {
  applySidebarWidth(loadSidebarWidth());
}

function bindSidebarResizer() {
  // 折叠状态下 resizer 已被 CSS 设为 pointer-events: none，这里仍然绑定，
  // 保证展开后无需重新 render 即可拖拽
  const resizer = document.querySelector('#sidebar-resizer') as HTMLElement | null;
  if (!resizer) return;

  const onPointerMove = (event: PointerEvent) => {
    applySidebarWidth(event.clientX);
  };

  const onPointerUp = (event: PointerEvent) => {
    resizer.releasePointerCapture(event.pointerId);
    resizer.classList.remove('is-dragging');
    document.body.classList.remove('is-sidebar-resizing');
    document.removeEventListener('pointermove', onPointerMove);
    document.removeEventListener('pointerup', onPointerUp);
    saveSidebarWidth(sidebarWidth);
  };

  resizer.addEventListener('pointerdown', (event: PointerEvent) => {
    if (event.button !== 0) return;
    event.preventDefault();
    resizer.setPointerCapture(event.pointerId);
    resizer.classList.add('is-dragging');
    document.body.classList.add('is-sidebar-resizing');
    document.addEventListener('pointermove', onPointerMove);
    document.addEventListener('pointerup', onPointerUp);
  });
}

function loadSidebarCollapsed(): boolean {
  try {
    return localStorage.getItem(SIDEBAR_COLLAPSED_STORAGE_KEY) === '1';
  } catch {
    return false;
  }
}

function saveSidebarCollapsed(collapsed: boolean) {
  localStorage.setItem(SIDEBAR_COLLAPSED_STORAGE_KEY, collapsed ? '1' : '0');
}

function getSidebarToggleTitle(collapsed: boolean = isSidebarCollapsed): string {
  return collapsed ? '展开侧边栏' : '收起侧边栏';
}

function getSidebarToggleIcon(collapsed: boolean = isSidebarCollapsed): string {
  if (collapsed) {
    return `<svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect width="18" height="18" x="3" y="3" rx="2"/><path d="M9 3v18"/><path d="m14 9 3 3-3 3"/></svg>`;
  }
  return `<svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect width="18" height="18" x="3" y="3" rx="2"/><path d="M9 3v18"/><path d="m16 15-3-3 3-3"/></svg>`;
}

function updateSidebarToggleButtons() {
  const title = getSidebarToggleTitle();
  for (const btn of document.querySelectorAll<HTMLButtonElement>('.sidebar-toggle-btn')) {
    btn.title = title;
    btn.setAttribute('aria-label', title);
    btn.setAttribute('aria-expanded', String(!isSidebarCollapsed));
    btn.innerHTML = getSidebarToggleIcon();
  }
}

function syncSidebarCollapsedUI() {
  document.querySelector('.app-container')?.classList.toggle('is-sidebar-collapsed', isSidebarCollapsed);
  updateSidebarToggleButtons();
}

function setSidebarCollapsed(collapsed: boolean, persist = true) {
  isSidebarCollapsed = collapsed;
  if (persist) saveSidebarCollapsed(collapsed);
  syncSidebarCollapsedUI();
}

function toggleSidebarCollapsed() {
  // 用户手动操作后放弃自动折叠的接管权，避免窗口变宽时被强行展开
  sidebarAutoCollapsed = false;
  setSidebarCollapsed(!isSidebarCollapsed);
}

function initSidebarCollapsed() {
  isSidebarCollapsed = loadSidebarCollapsed();
}

/**
 * 窄窗口自动折叠侧边栏；变宽后自动恢复。
 * 只在跨越断点时干预一次，用户之后的手动展开/折叠不会被覆盖。
 */
function syncSidebarResponsiveState() {
  const isNarrow = window.innerWidth < SIDEBAR_AUTO_COLLAPSE_WIDTH;
  if (isNarrow === sidebarWasNarrow) return;
  sidebarWasNarrow = isNarrow;

  if (isNarrow) {
    if (!isSidebarCollapsed) {
      sidebarAutoCollapsed = true;
      setSidebarCollapsed(true, false);
    }
    return;
  }

  if (sidebarAutoCollapsed) {
    sidebarAutoCollapsed = false;
    // 恢复到用户持久化的偏好
    setSidebarCollapsed(loadSidebarCollapsed(), false);
  }
}

function bindSidebarResponsive() {
  window.addEventListener('resize', () => {
    syncSidebarResponsiveState();
    applySidebarWidth(sidebarWidth);
  });
  syncSidebarResponsiveState();
}

function toggleTheme() {
  applyTheme(getCurrentTheme() === 'dark' ? 'light' : 'dark');
}

function getActiveChatModelForRender(): string {
  // 始终以配置文件读取到的当前默认模型为准
  if (currentDefaultModel && chatModelOptions.includes(currentDefaultModel)) {
    return currentDefaultModel;
  }
  return chatModelOptions[0] || '';
}

function getActiveChatModel(): string {
  const trigger = document.querySelector('#chat-model-picker-trigger') as HTMLButtonElement | null;
  const value = trigger?.dataset.value?.trim();
  if (value) {
    return value;
  }
  return getActiveChatModelForRender();
}

function renderChatModelPickerListItems(filter: string): string {
  const query = filter.trim().toLowerCase();
  const current = getActiveChatModelForRender();
  const models = chatModelOptions.filter(
    (model) => !query || model.toLowerCase().includes(query),
  );

  if (models.length === 0) {
    return `<div class="chat-model-picker-empty">${query ? '无匹配模型' : '未配置模型'}</div>`;
  }

  return models
    .map((model) => {
      const isActive = model === current;
      return `
        <button
          type="button"
          class="chat-model-picker-option${isActive ? ' is-active' : ''}"
          data-model="${escapeHtml(model)}"
          title="${escapeHtml(model)}"
        >
          <span class="chat-model-picker-option-label">${escapeHtml(model)}</span>
          ${isActive ? '<span class="chat-model-picker-option-check" aria-hidden="true">✓</span>' : ''}
        </button>
      `;
    })
    .join('');
}

function renderChatModelPickerHtml(): string {
  const current = getActiveChatModelForRender();
  const disabled = chatModelOptions.length === 0;
  const label = current || '未配置模型';

  return `
    <div class="chat-model-picker" id="chat-model-picker">
      <div class="chat-model-picker-panel is-hidden" id="chat-model-picker-panel">
        <input
          type="search"
          class="chat-model-picker-search"
          placeholder="搜索模型..."
          autocomplete="off"
          aria-label="搜索模型"
        />
        <div class="chat-model-picker-list" id="chat-model-picker-list">
          ${renderChatModelPickerListItems('')}
        </div>
      </div>
      <button
        type="button"
        class="chat-model-picker-trigger"
        id="chat-model-picker-trigger"
        title="${escapeHtml(current || '未配置模型')}"
        aria-haspopup="listbox"
        aria-expanded="false"
        ${disabled ? 'disabled' : ''}
        data-value="${escapeHtml(current)}"
      >
        <span class="chat-model-picker-value">${escapeHtml(label)}</span>
        <span class="chat-model-picker-chevron" aria-hidden="true">▾</span>
      </button>
    </div>
  `;
}

function resetChatModelPickerHighlight() {
  chatModelPickerHighlightIndex = -1;
  document.querySelectorAll('.chat-model-picker-option.is-highlighted').forEach((element) => {
    element.classList.remove('is-highlighted');
  });
}

function getVisibleChatModelOptions(): HTMLElement[] {
  return Array.from(document.querySelectorAll('#chat-model-picker-list .chat-model-picker-option'));
}

function setChatModelPickerHighlight(index: number) {
  const options = getVisibleChatModelOptions();
  resetChatModelPickerHighlight();
  if (options.length === 0) {
    return;
  }

  const clamped = Math.max(0, Math.min(index, options.length - 1));
  chatModelPickerHighlightIndex = clamped;
  const option = options[clamped];
  option.classList.add('is-highlighted');
  option.scrollIntoView({ block: 'nearest' });
}

function selectHighlightedChatModelOption() {
  const options = getVisibleChatModelOptions();
  if (options.length === 0) {
    return;
  }

  const index = chatModelPickerHighlightIndex >= 0 ? chatModelPickerHighlightIndex : 0;
  const model = options[index]?.dataset.model;
  if (!model) {
    return;
  }

  closeChatModelPicker();
  void applyChatModelSelection(model);
}

function closeChatModelPicker() {
  const panel = document.querySelector('#chat-model-picker-panel');
  const picker = document.querySelector('#chat-model-picker');
  const trigger = document.querySelector('#chat-model-picker-trigger') as HTMLButtonElement | null;
  panel?.classList.add('is-hidden');
  picker?.classList.remove('is-open');
  resetChatModelPickerHighlight();
  if (trigger) {
    trigger.setAttribute('aria-expanded', 'false');
  }
}

function openChatModelPicker() {
  const panel = document.querySelector('#chat-model-picker-panel');
  const picker = document.querySelector('#chat-model-picker');
  const trigger = document.querySelector('#chat-model-picker-trigger') as HTMLButtonElement | null;
  if (!panel || chatModelOptions.length === 0) {
    return;
  }

  panel.classList.remove('is-hidden');
  picker?.classList.add('is-open');
  if (trigger) {
    trigger.setAttribute('aria-expanded', 'true');
  }

  const search = document.querySelector('.chat-model-picker-search') as HTMLInputElement | null;
  const list = document.querySelector('#chat-model-picker-list');
  if (search) {
    search.value = '';
  }
  if (list) {
    list.innerHTML = renderChatModelPickerListItems('');
  }
  resetChatModelPickerHighlight();
  search?.focus();
}

function handleChatModelPickerOutsideClick(event: Event) {
  const picker = document.querySelector('#chat-model-picker');
  if (picker && !picker.contains(event.target as Node)) {
    closeChatModelPicker();
  }
}

function bindChatModelPickerEvents() {
  document.removeEventListener('click', handleChatModelPickerOutsideClick);

  const trigger = document.querySelector('#chat-model-picker-trigger');
  const search = document.querySelector('.chat-model-picker-search');
  const list = document.querySelector('#chat-model-picker-list');

  trigger?.addEventListener('click', (event) => {
    event.stopPropagation();
    const panel = document.querySelector('#chat-model-picker-panel');
    const isOpen = panel && !panel.classList.contains('is-hidden');
    if (isOpen) {
      closeChatModelPicker();
    } else {
      openChatModelPicker();
    }
  });

  search?.addEventListener('input', (event) => {
    const query = (event.target as HTMLInputElement).value;
    if (list) {
      list.innerHTML = renderChatModelPickerListItems(query);
    }
    resetChatModelPickerHighlight();
  });

  search?.addEventListener('keydown', (event) => {
    const keyboardEvent = event as KeyboardEvent;
    const options = getVisibleChatModelOptions();

    if (keyboardEvent.key === 'ArrowDown') {
      keyboardEvent.preventDefault();
      if (options.length === 0) {
        return;
      }
      const nextIndex =
        chatModelPickerHighlightIndex < 0 ? 0 : chatModelPickerHighlightIndex + 1;
      setChatModelPickerHighlight(Math.min(nextIndex, options.length - 1));
      return;
    }

    if (keyboardEvent.key === 'ArrowUp') {
      keyboardEvent.preventDefault();
      if (options.length === 0) {
        return;
      }
      const nextIndex =
        chatModelPickerHighlightIndex < 0
          ? options.length - 1
          : chatModelPickerHighlightIndex - 1;
      setChatModelPickerHighlight(Math.max(nextIndex, 0));
      return;
    }

    if (keyboardEvent.key === 'Enter') {
      keyboardEvent.preventDefault();
      if (options.length === 0) {
        return;
      }
      selectHighlightedChatModelOption();
      return;
    }

    if (keyboardEvent.key === 'Escape') {
      keyboardEvent.preventDefault();
      closeChatModelPicker();
    }
    keyboardEvent.stopPropagation();
  });

  list?.addEventListener('click', (event) => {
    const option = (event.target as HTMLElement).closest('.chat-model-picker-option') as HTMLElement | null;
    const model = option?.dataset.model;
    if (!model) {
      return;
    }
    closeChatModelPicker();
    void applyChatModelSelection(model);
  });

  document.addEventListener('click', handleChatModelPickerOutsideClick);
}

function updateChatModelPicker() {
  const trigger = document.querySelector('#chat-model-picker-trigger') as HTMLButtonElement | null;
  const valueEl = trigger?.querySelector('.chat-model-picker-value');
  const search = document.querySelector('.chat-model-picker-search') as HTMLInputElement | null;
  const list = document.querySelector('#chat-model-picker-list');
  const current = getActiveChatModelForRender();

  if (trigger) {
    trigger.dataset.value = current;
    trigger.disabled = chatModelOptions.length === 0;
    trigger.title = current || '未配置模型';
    if (valueEl) {
      valueEl.textContent = current || '未配置模型';
    }
  }
  if (list) {
    list.innerHTML = renderChatModelPickerListItems(search?.value || '');
  }
}

async function applyChatModelSelection(model: string): Promise<void> {
  const trimmed = model.trim();
  if (!trimmed || !chatModelOptions.includes(trimmed)) {
    return;
  }

  // 立即写入配置文件（Claude Code settings.json + 活跃 profile.default_model）
  try {
    await invoke<ClaudeCodeApiConfig>('set_active_default_model', { model: trimmed });
    currentDefaultModel = trimmed;
  } catch (err) {
    console.error('[model] 写入默认模型失败:', err);
  }

  updateChatModelPicker();
  if (!activeConversationId) {
    void refreshModelInfo();
  }
}

async function loadChatModelOptions(): Promise<void> {
  try {
    const config = await invoke<ClaudeCodeApiConfig>('get_claude_api_config');
    currentDefaultModel = (config.defaultModel || '').trim();
    const customModels = config.customModels || [];
    let apiModels: string[] = [];

    if (config.displayModels && config.displayModels.length > 0) {
      apiModels = [...config.displayModels];
    } else if (config.baseUrl.trim() && config.hasApiKey) {
      try {
        const fetched = await invoke<FetchedModel[]>('fetch_api_models', {
          baseUrl: config.baseUrl.trim(),
          apiKey: null,
          profileId: null,
        });
        apiModels = fetched.map((model) => model.id);
      } catch {
        apiModels = [];
      }
    }

    const merged = [...apiModels];
    for (const modelId of customModels) {
      if (!merged.includes(modelId)) {
        merged.push(modelId);
      }
    }
    // 官方订阅模式（未配置第三方 API 且无模型列表）下，提供官方模型选项
    if (merged.length === 0 && !config.baseUrl.trim()) {
      chatModelOptions = ['default', 'opus', 'sonnet', 'haiku'];
    } else {
      chatModelOptions = merged;
    }

    // 若配置文件里的当前默认模型不在候选列表，附加到首位以便展示与切换
    if (currentDefaultModel && !chatModelOptions.includes(currentDefaultModel)) {
      chatModelOptions = [currentDefaultModel, ...chatModelOptions];
    }
  } catch {
    chatModelOptions = [];
    currentDefaultModel = '';
  }
  updateChatModelPicker();
}

function setupExternalLinkInterceptor(): void {
  document.addEventListener('click', async (e) => {
    const target = e.target as HTMLElement;
    const anchor = target.closest('a');
    if (!anchor) return;
    const href = anchor.getAttribute('href');
    if (!href || !/^https?:\/\//i.test(href)) return;
    e.preventDefault();
    try {
      await invoke('plugin:opener|open_url', { url: href });
    } catch (err) {
      console.error('[opener] 打开链接失败:', href, err);
    }
  });
}

async function init() {
  initPlatformClass();
  initTheme();
  initSidebarWidth();
  initSidebarCollapsed();
  // 首屏就按窗口宽度决定侧边栏是否折叠，避免渲染后再跳一次
  syncSidebarResponsiveState();
  await loadData();
  await loadChatModelOptions();
  render();
  if (!activeConversationId) {
    void refreshModelInfo();
  }
  setupEventListeners();
  setupExternalLinkInterceptor();
  bindSidebarResponsive();
  void checkClaudeCodeUpdate(false);
}

function syncClaudeUpdateButtonUI() {
  const btn = document.querySelector('#claude-update-btn') as HTMLButtonElement | null;
  if (!btn) return;
  const showBadge = shouldShowClaudeUpdateBadge();
  const checking = claudeUpdateCheckStatus === 'checking';
  btn.classList.toggle('has-update', showBadge);
  btn.classList.toggle('is-checking', checking);
  const label = btn.querySelector('.toolbar-update-btn-label');
  if (label) label.textContent = showBadge ? '有更新' : '版本';
  let dot = btn.querySelector('.toolbar-update-btn-dot');
  if (showBadge && !dot) {
    dot = document.createElement('span');
    dot.className = 'toolbar-update-btn-dot';
    dot.setAttribute('aria-hidden', 'true');
    btn.appendChild(dot);
  } else if (!showBadge && dot) {
    dot.remove();
  }
  const title = getClaudeUpdateButtonTitle();
  btn.title = title;
  btn.setAttribute('aria-label', title);
}

async function checkClaudeCodeUpdate(force = false): Promise<void> {
  if (claudeUpdateCheckPromise) {
    if (!force) return claudeUpdateCheckPromise;
  }

  claudeUpdateCheckStatus = 'checking';
  syncClaudeUpdateButtonUI();

  claudeUpdateCheckPromise = (async () => {
    try {
      const info = await invoke<ClaudeCodeUpdateInfo>('check_claude_code_update');
      claudeUpdateInfo = info;
      claudeUpdateCheckStatus = info.error && !info.installed && !info.latest ? 'error' : 'ready';
    } catch (e) {
      claudeUpdateInfo = {
        installed: null,
        latest: null,
        updateAvailable: false,
        executablePath: null,
        error: String(e),
      };
      claudeUpdateCheckStatus = 'error';
    } finally {
      syncClaudeUpdateButtonUI();
      claudeUpdateCheckPromise = null;
      // 若弹层开着，刷新内容
      const panel = document.querySelector('#claude-update-popover');
      if (panel) {
        panel.innerHTML = renderClaudeUpdatePopoverBody();
        bindClaudeUpdatePopoverEvents(panel);
      }
    }
  })();

  return claudeUpdateCheckPromise;
}

function dismissClaudeUpdateReminder() {
  const latest = claudeUpdateInfo?.latest;
  if (!latest) return;
  claudeUpdateDismissedVersion = latest;
  try {
    localStorage.setItem(CLAUDE_UPDATE_DISMISS_KEY, latest);
  } catch {
    /* ignore */
  }
  syncClaudeUpdateButtonUI();
  closeClaudeUpdatePopover();
}

function renderClaudeUpdatePopoverBody(): string {
  const info = claudeUpdateInfo;
  const checking = claudeUpdateCheckStatus === 'checking';

  if (checking && !info) {
    return `
      <div class="claude-update-popover-header">
        <strong>Claude Code 版本</strong>
        <button type="button" class="claude-update-popover-close" aria-label="关闭">✕</button>
      </div>
      <p class="claude-update-popover-status">正在检查更新…</p>
    `;
  }

  const installed = info?.installed || '未检测到';
  const latest = info?.latest || '—';
  const path = info?.executablePath || '';
  const hasUpdate = Boolean(info?.updateAvailable && info.latest);
  const error = info?.error || '';

  return `
    <div class="claude-update-popover-header">
      <strong>Claude Code 版本</strong>
      <button type="button" class="claude-update-popover-close" aria-label="关闭">✕</button>
    </div>
    <div class="claude-update-popover-rows">
      <div class="claude-update-row">
        <span class="claude-update-key">当前版本</span>
        <span class="claude-update-value">${escapeHtml(installed)}</span>
      </div>
      <div class="claude-update-row">
        <span class="claude-update-key">最新版本</span>
        <span class="claude-update-value${hasUpdate ? ' is-newer' : ''}">${escapeHtml(latest)}</span>
      </div>
      ${path ? `
      <div class="claude-update-row claude-update-row-path">
        <span class="claude-update-key">安装路径</span>
        <span class="claude-update-value" title="${escapeHtml(path)}">${escapeHtml(path)}</span>
      </div>` : ''}
    </div>
    ${hasUpdate
      ? `<p class="claude-update-popover-hint">发现新版本，可在终端执行 <code>claude update</code> 升级。</p>`
      : info?.installed && info.latest
        ? `<p class="claude-update-popover-hint">已是最新版本。</p>`
        : ''}
    ${error ? `<p class="claude-update-popover-error">${escapeHtml(error)}</p>` : ''}
    <div class="claude-update-popover-actions">
      <button type="button" class="claude-update-action" data-action="recheck" ${checking ? 'disabled' : ''}>
        ${checking ? '检查中…' : '重新检查'}
      </button>
      ${hasUpdate ? `
        <button type="button" class="claude-update-action primary" data-action="update">终端更新</button>
        <button type="button" class="claude-update-action" data-action="dismiss">稍后提醒</button>
      ` : ''}
    </div>
  `;
}

function bindClaudeUpdatePopoverEvents(panel: Element) {
  panel.querySelector('.claude-update-popover-close')?.addEventListener('click', () => {
    closeClaudeUpdatePopover();
  });

  panel.querySelectorAll<HTMLButtonElement>('[data-action]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const action = btn.dataset.action;
      if (action === 'recheck') {
        void checkClaudeCodeUpdate(true);
      } else if (action === 'update') {
        void (async () => {
          try {
            await invoke('open_claude_code_update_terminal');
            showCopyToastMsg('已打开终端执行更新');
            closeClaudeUpdatePopover();
          } catch (e) {
            alert('打开更新终端失败: ' + String(e));
          }
        })();
      } else if (action === 'dismiss') {
        dismissClaudeUpdateReminder();
      }
    });
  });
}

function closeClaudeUpdatePopover() {
  document.querySelector('.claude-update-popover-overlay')?.remove();
  document.querySelector('#claude-update-popover')?.remove();
}

function toggleClaudeUpdatePopover() {
  if (document.querySelector('#claude-update-popover')) {
    closeClaudeUpdatePopover();
    return;
  }

  const anchor = document.querySelector('#claude-update-btn') as HTMLElement | null;
  if (!anchor) return;

  const overlay = document.createElement('div');
  overlay.className = 'claude-update-popover-overlay';
  overlay.addEventListener('click', closeClaudeUpdatePopover);

  const panel = document.createElement('div');
  panel.id = 'claude-update-popover';
  panel.className = 'claude-update-popover';
  panel.setAttribute('role', 'dialog');
  panel.setAttribute('aria-label', 'Claude Code 版本更新');
  panel.innerHTML = renderClaudeUpdatePopoverBody();

  document.body.appendChild(overlay);
  document.body.appendChild(panel);
  bindClaudeUpdatePopoverEvents(panel);

  const rect = anchor.getBoundingClientRect();
  const panelWidth = panel.offsetWidth || 300;
  const left = Math.min(
    Math.max(8, rect.right - panelWidth),
    window.innerWidth - panelWidth - 8,
  );
  panel.style.top = `${rect.bottom + 6}px`;
  panel.style.left = `${left}px`;

  if (!claudeUpdateInfo || claudeUpdateCheckStatus === 'idle') {
    void checkClaudeCodeUpdate(true);
  }
}

// 设置事件监听器 - 监听后端发送的实时事件
async function setupEventListeners() {
  // 监听流式消息块（thinking / answer 实时分离）
  await listen<MessageChunkPayload>('message-chunk', (event) => {
    handleMessageChunk(event.payload);
  });

  // 监听会话创建事件（后端在流完成后首次写入会话时触发）
  await listen<SessionEventPayload>('session-created', (event) => {
    const payload = normalizeSessionEventPayload(event.payload);
    runningSessions.delete(payload.conversation_id);
    transientSessionError = null;

    // 判断用户当前是否正在查看此会话（不要强制切换视图）
    const isViewingThis = activeConversationId === payload.conversation_id;

    if (isViewingThis) {
      pendingProjectDir = null;
    }

    updateOrAddConversation({
      id: payload.conversation_id,
      title: payload.title,
      messages: payload.messages,
      platform: 'claude',
      project_dir: payload.project_dir,
      created_at: payload.updated_at,
      updated_at: payload.updated_at,
      context_tokens: payload.context_tokens ?? null,
      last_model: payload.last_model ?? null,
    });

    // 只在会话数据已包含用户消息时才清空 pendingUserMessage
    // 同时确保只清除属于当前会话的 pending 消息（防止串会话）
    if (pendingUserMessage && pendingUserMessageConvId === payload.conversation_id && payload.messages.some(
      (m: Message) => m.role === 'user' && m.content === pendingUserMessage
    )) {
      pendingUserMessage = null;
      pendingUserMessageConvId = null;
    }

    clearStreamingState(payload.conversation_id);

    if (isViewingThis) {
      hideSendingState();
      render();
      setTimeout(() => answerScroller?.scrollToBottom(), 100);
    } else {
      // 用户在看别的会话或新聊天页，只更新侧边栏
      updateConversationListSpinner();
    }
  });
  
  // 监听消息更新事件
  await listen<SessionEventPayload>('messages-updated', (event) => {
    const payload = normalizeSessionEventPayload(event.payload);
    // 只在会话数据已包含用户消息时才清空 pendingUserMessage，
    // 否则保留以便 refreshChatContent 补充显示
    // （Claude CLI 仅在完成响应后才写入会话文件，首条用户消息可能不在其中）
    // 同时确保只清除属于当前会话的 pending 消息（防止串会话）
    if (pendingUserMessage && pendingUserMessageConvId === payload.conversation_id && payload.messages.some(
      (m: Message) => m.role === 'user' && m.content === pendingUserMessage
    )) {
      pendingUserMessage = null;
      pendingUserMessageConvId = null;
    }
    transientSessionError = null;

    updateOrAddConversation({
      id: payload.conversation_id,
      title: payload.title,
      messages: payload.messages,
      platform: 'claude',
      project_dir: payload.project_dir,
      created_at: payload.updated_at,
      updated_at: payload.updated_at,
      context_tokens: payload.context_tokens ?? null,
      last_model: payload.last_model ?? null,
    });

    clearStreamingState(payload.conversation_id);

    const isViewingThis = activeConversationId === payload.conversation_id;

    if (isViewingThis) {
      // 如果会话仍在运行中（如重试/重新生成），保持 loading 状态
      // session-ended 到达时再调用 hideSendingState
      if (!runningSessions.has(payload.conversation_id)) {
        hideSendingState();
      }
      refreshChatContent();
      updateContextIndicator();
    } else {
      updateConversationListSpinner();
    }
  });
  
  // 监听会话错误事件
  await listen<SessionErrorPayload>('session-error', (event) => {
    handleSessionError(event.payload);
  });

  // 监听会话结束事件
  await listen<string | null>('session-ended', (event) => {
    const endedSessionId = event.payload;
    // 从运行集合中移除
    if (endedSessionId) {
      runningSessions.delete(endedSessionId);
    }
    // 无论哪个会话结束，都清理 pending 键
    runningSessions.delete('pending');
    clearStreamingState(endedSessionId || '');

    const isCurrentSession = !endedSessionId || endedSessionId === activeConversationId;

    if (isCurrentSession) {
      hideSendingState();
      pendingUserMessage = null;
      pendingUserMessageConvId = null;
    }

    const preservedErrors = conversations.flatMap((conversation) =>
      conversation.messages
        .filter((message) => message.role === 'error')
        .map((message) => ({ conversationId: conversation.id, message })),
    );

    void loadData().then(() => {
      preservedErrors.forEach(({ conversationId, message }) => {
        const conversation = conversations.find((item) => item.id === conversationId);
        if (
          conversation &&
          !conversation.messages.some(
            (item) => item.role === 'error' && item.content === message.content,
          )
        ) {
          conversation.messages.push(message);
        }
      });

      updateConversationListSpinner();
      updateContextIndicator();
      refreshCommandQueueUI();

      if (isCurrentSession && (activeConversationId || transientSessionError)) {
        refreshChatContent();
      }

      // 当前任务结束后，自动执行该会话队列中的下一条
      const drainId = endedSessionId || activeConversationId;
      if (drainId) {
        void processNextQueuedCommand(drainId);
      }
    });
  });

  // ESC 键取消正在运行的任务（参考 claudecodeui）
  document.addEventListener('keydown', (e: KeyboardEvent) => {
    if (e.key === 'Escape' && !e.repeat) {
      const sendBtn = document.querySelector<HTMLButtonElement>('#send-btn');
      if (sendBtn?.dataset.loading === 'true') {
        e.preventDefault();
        void abortSession();
      }
    }
  });
}

function getStreamingState(sessionId: string): StreamingState {
  if (!streamingBySession.has(sessionId)) {
    streamingBySession.set(sessionId, { blocks: [], thinkingDone: false, currentBlockIdx: -1 });
  }
  return streamingBySession.get(sessionId)!;
}

function clearStreamingState(sessionId: string) {
  streamingBySession.delete(sessionId);
  pendingTextDelta.delete(sessionId);
  removeStreamingElements();
  // 取消待处理的 RAF 刷新
  if (streamRefreshRafId !== null) {
    cancelAnimationFrame(streamRefreshRafId);
    streamRefreshRafId = null;
    streamRefreshPending = false;
  }
}

/** 将当前缓冲的文本追加到当前 text 块的 content */
function flushPendingTextDelta(sessionId: string) {
  const pending = pendingTextDelta.get(sessionId);
  if (!pending) return;
  const state = getStreamingState(sessionId);
  const block = state.blocks[state.currentBlockIdx];
  if (block && block.type === 'text') {
    block.content += pending;
  }
  pendingTextDelta.set(sessionId, '');
}

function handleMessageChunk(payload: MessageChunkPayload) {
  const { conversation_id: sid, kind, content } = payload;
  if (!sid) return;

  if (kind === 'session_created') {
    // pending -> 真实 session ID 转换
    runningSessions.delete('pending');
    runningSessions.add(sid);
    migrateCommandQueue('pending', sid);
    // 仅在尚未激活会话时设置 activeConversationId，避免打断用户已切换的视图
    if (!activeConversationId) {
      activeConversationId = sid;
    }
    const now = Math.floor(Date.now() / 1000);
    const existing = conversations.find((c) => c.id === sid);
    // 只有当 pendingUserMessage 属于此会话时才使用（防止串会话）
    const pendingMatchesThisSession = pendingUserMessage &&
      (!pendingUserMessageConvId || pendingUserMessageConvId === sid);
    updateOrAddConversation({
      id: sid,
      title: existing?.title || 'New Chat',
      messages: existing?.messages ?? (pendingMatchesThisSession
        ? [{ id: `user-${Date.now()}`, role: 'user', content: pendingUserMessage!, timestamp: now }]
        : []),
      platform: 'claude',
      project_dir: content?.trim() || existing?.project_dir || null,
      source_path: existing?.source_path ?? null,
      created_at: existing?.created_at ?? now,
      updated_at: now,
    });
    // 此时尚无会话数据，保留 pendingUserMessage 以确保用户消息可见
    updateSendButtonState();
    updateProjectDirDisplay();
    ensureChatViewVisible();
    updateConversationListSpinner();
    refreshCommandQueueUI();
    // ensureChatViewVisible 可能调用了 render()，需要恢复按钮 loading 状态
    // 只有当 pending 消息属于此会话时才设置 loading（防止串会话）
    if (sid === activeConversationId || (!activeConversationId && pendingUserMessage && !pendingUserMessageConvId)) {
      setSendButtonLoading(true);
    }
    return;
  }

  // 所有会话都累积流式数据（包括后台运行的会话）
  const state = getStreamingState(sid);
  const isActive = sid === activeConversationId || (!activeConversationId && pendingUserMessage && !pendingUserMessageConvId);

  switch (kind) {
    case 'thinking_start':
      state.thinkingDone = false;
      // 创建新的 thinking 块
      state.blocks.push({ type: 'thinking', content: '' });
      state.currentBlockIdx = state.blocks.length - 1;
      if (isActive) refreshStreamingUI(sid);
      break;
    case 'thinking_delta':
      {
        const block = state.blocks[state.currentBlockIdx];
        if (block && block.type === 'thinking') {
          block.content += content;
        }
      }
      if (isActive) scheduleStreamingRefresh(sid);
      break;
    case 'thinking_end':
      state.thinkingDone = true;
      if (isActive) refreshStreamingUI(sid);
      break;
    case 'text_start':
      // 创建新的 text 块
      state.blocks.push({ type: 'text', content: '' });
      state.currentBlockIdx = state.blocks.length - 1;
      break;
    case 'text_delta':
      pendingTextDelta.set(sid, (pendingTextDelta.get(sid) || '') + content);
      if (isActive) scheduleStreamingRefresh(sid);
      break;
    case 'text_end':
    case 'stream_end':
      flushPendingTextDelta(sid);
      if (isActive) refreshStreamingUI(sid);
      break;
    case 'error':
      flushPendingTextDelta(sid);
      clearStreamingState(sid);
      break;
    case 'api_retry':
      if (isActive) {
        removePendingAssistantIndicator();
        updatePendingStatus(content);
      }
      break;
    case 'complete':
      flushPendingTextDelta(sid);
      if (isActive) refreshStreamingUI(sid);
      break;
    default:
      break;
  }
}

function scheduleStreamingRefresh(sessionId: string) {
  if (streamRefreshPending) return;
  streamRefreshPending = true;

  const doRefresh = (timestamp: number) => {
    if (timestamp - streamRefreshLastTime < 100) {
      // 距上次刷新不足 100ms，等待下一帧
      streamRefreshRafId = requestAnimationFrame(doRefresh);
      return;
    }
    streamRefreshLastTime = timestamp;
    streamRefreshRafId = null;
    streamRefreshPending = false;
    flushPendingTextDelta(sessionId);
    refreshStreamingUI(sessionId);
  };

  streamRefreshRafId = requestAnimationFrame(doRefresh);
}

function handleSessionError(payload: SessionErrorPayload) {
  const sid = payload.conversationId || activeConversationId || null;
  const errorText = payload.error.trim();
  if (!errorText) return;

  clearPendingRequestState();
  clearStreamingState(sid || 'pending');
  hideSendingState();

  const errorMessage: Message = {
    id: `error-${Date.now()}`,
    role: 'error',
    content: errorText,
    timestamp: Math.floor(Date.now() / 1000),
  };

  if (sid) {
    transientSessionError = null;
    let conversation = conversations.find((c) => c.id === sid);
    if (!conversation) {
      conversation = {
        id: sid,
        title: 'New Chat',
        messages: [],
        platform: 'claude',
        project_dir: null,
        created_at: errorMessage.timestamp,
        updated_at: errorMessage.timestamp,
      };
      conversations.unshift(conversation);
    }

    const hasSameError = conversation.messages.some(
      (message) => message.role === 'error' && message.content === errorText,
    );
    if (!hasSameError) {
      conversation.messages.push(errorMessage);
      conversation.updated_at = errorMessage.timestamp;
    }
    activeConversationId = sid;
    pendingUserMessage = null;
    pendingUserMessageConvId = null;
  } else {
    transientSessionError = errorText;
  }

  ensureChatViewVisible();
  refreshChatContent();
}

function ensureChatViewVisible() {
  // API 配置页占用主区域时，不因后台流式事件强制切回聊天视图
  if (isApiConfigViewActive) return;
  const mainContent = document.querySelector('.main-content');
  if (!mainContent) return;
  if (!document.querySelector('#message-list')) {
    render();
    return;
  }
  refreshChatContent();
}

function removeStreamingElements() {
  document.querySelectorAll('[id^="streaming-"]').forEach((el) => el.remove());
}

function refreshStreamingUI(sessionId: string) {
  // 只有当 sessionId 匹配当前会话时才更新
  if (sessionId !== activeConversationId && !(pendingUserMessage && !activeConversationId && !pendingUserMessageConvId)) return;

  const messageList = document.querySelector<HTMLDivElement>('#message-list');
  if (!messageList) return;

  removePendingAssistantIndicator();

  const state = getStreamingState(sessionId);

  // 先合并相邻的同类型块（thinking-thinking, text-text）
  const merged: StreamBlock[] = [];
  for (const block of state.blocks) {
    const last = merged[merged.length - 1];
    if (last && last.type === block.type && block.type === 'thinking') {
      last.content = last.content + '\n' + block.content;
    } else if (last && last.type === block.type && block.type === 'text') {
      last.content = last.content + '\n\n' + block.content;
    } else {
      merged.push({ type: block.type, content: block.content });
    }
  }

  // 收集现有流式块元素，按索引索引
  const existingEls = new Map<number, HTMLElement>();
  messageList.querySelectorAll<HTMLElement>('[id^="streaming-block-"]').forEach((el) => {
    const idx = parseInt(el.id.replace('streaming-block-', ''), 10);
    if (!isNaN(idx)) existingEls.set(idx, el);
  });
  const usedIndices = new Set<number>();

  // 按合并后的块序列更新（就地更新已存在的元素，创建新元素）
  merged.forEach((block, idx) => {
    usedIndices.add(idx);
    const blockId = `streaming-block-${idx}`;
    const existingEl = existingEls.get(idx);

    if (block.type === 'thinking') {
      const label = state.thinkingDone ? '思考过程' : '思考中...';
      const isStreaming = !state.thinkingDone;
      const expanded = isStreaming || expandedThinkingBlocks.has(sessionId);

      if (existingEl && existingEl.classList.contains('thinking-msg')) {
        // 就地更新：只更新 <pre> 文本和 <summary> 标签
        const pre = existingEl.querySelector('.thinking-content pre');
        const summary = existingEl.querySelector('.thinking-summary .thinking-label-text');
        if (pre) pre.textContent = block.content;
        if (summary) summary.textContent = label;
        // 更新流式状态类
        if (isStreaming) {
          existingEl.querySelector('.thinking-block')?.classList.add('streaming-active');
        } else {
          existingEl.querySelector('.thinking-block')?.classList.remove('streaming-active');
        }
        // 思考内容独立滚动
        const scrollEl = existingEl.querySelector<HTMLElement>('.thinking-content-scroll');
        if (scrollEl) getThinkingScroller(scrollEl, blockId).onNewContent();
      } else {
        // 删除旧元素（类型不匹配或不存在）
        existingEl?.remove();
        const el = document.createElement('div');
        el.id = blockId;
        el.className = 'message assistant thinking-msg streaming';
        el.innerHTML = `<div class="message-content">${renderThinkingDetails(block.content, label, expanded, undefined, isStreaming)}</div>`;
        messageList.appendChild(el);
        const detailsEl = el.querySelector('.thinking-block');
        if (detailsEl) {
          detailsEl.addEventListener('toggle', () => {
            if ((detailsEl as HTMLDetailsElement).open) {
              expandedThinkingBlocks.add(sessionId);
            } else {
              expandedThinkingBlocks.delete(sessionId);
            }
          });
        }
        // 新创建的思考块：初始化独立 ScrollController
        const scrollEl = el.querySelector<HTMLElement>('.thinking-content-scroll');
        if (scrollEl) getThinkingScroller(scrollEl, blockId).scrollToBottom();
        existingEls.set(idx, el);
      }
    } else if (block.type === 'text') {
      if (existingEl && !existingEl.classList.contains('thinking-msg')) {
        // 就地更新：只更新 markdown-body 内容
        const mdBody = existingEl.querySelector('.markdown-body');
        if (mdBody) mdBody.innerHTML = renderMarkdown(block.content);
      } else {
        existingEl?.remove();
        const el = document.createElement('div');
        el.id = blockId;
        el.className = 'message assistant streaming';
        el.innerHTML = `<div class="message-content">
          <div class="markdown-body">${renderMarkdown(block.content)}</div>
          <div class="message-footer">
            <span class="message-streaming-indicator">正在输出...</span>
          </div>
        </div>`;
        messageList.appendChild(el);
        initCodeCopyButtons(el);
        existingEls.set(idx, el);
      }
    }
  });

  // 移除不再需要的旧流式元素（块数量减少时）
  existingEls.forEach((el, idx) => {
    if (!usedIndices.has(idx)) {
      // 清理对应的 thinking scroller
      const blockId = `streaming-block-${idx}`;
      thinkingScrollers.get(blockId)?.destroy();
      thinkingScrollers.delete(blockId);
      el.remove();
    }
  });

  // Answer 区域自动置底
  answerScroller?.onNewContent();
}

/** 初始化 Answer 区域 ScrollController（#message-list） */
function initAnswerScroller(): void {
  const messageList = document.querySelector<HTMLDivElement>('#message-list');
  if (!messageList) return;

  // 销毁旧实例
  answerScroller?.destroy();
  thinkingScrollers.forEach((sc) => sc.destroy());
  thinkingScrollers.clear();

  answerScroller = new ScrollController(messageList, {
    resumePx: 20,
    leavePx: 80,
    createButton: true,
  });
}

function isNewChatSession(): boolean {
  return !activeConversationId;
}

function getEffectiveProjectDir(): string {
  if (activeConversationId) {
    const conv = conversations.find((c) => c.id === activeConversationId);
    const dir = conv?.project_dir?.trim();
    return dir || '';
  }
  return pendingProjectDir?.trim() || '';
}

function hasRequiredProjectDir(): boolean {
  return getEffectiveProjectDir().length > 0;
}

function canSendMessage(content?: string): boolean {
  const input = document.querySelector<HTMLTextAreaElement>('#message-input');
  const text = (content ?? input?.value ?? '').trim();
  // 有导入文件引用时也允许发送（即使没有文字）
  if (!text && importedFileRefs.length === 0) {
    return false;
  }
  if (isNewChatSession() && !hasRequiredProjectDir()) {
    return false;
  }
  return true;
}

function isSendButtonLoading(): boolean {
  const sendBtn = document.querySelector<HTMLButtonElement>('#send-btn');
  return sendBtn?.dataset.loading === 'true';
}

/** 当前会话是否忙碌（运行中或正在出队发送） */
function isQueueKeyBusy(queueKey: string): boolean {
  return (
    runningSessions.has(queueKey) ||
    (queueKey === 'pending' && runningSessions.has('pending')) ||
    queueDrainInFlight.has(queueKey) ||
    (activeConversationId === queueKey && isSendButtonLoading())
  );
}

function getActiveQueueKey(): string {
  return activeConversationId || 'pending';
}

function getCommandQueue(queueKey: string): QueuedCommand[] {
  return commandQueues.get(queueKey) ?? [];
}

function setCommandQueue(queueKey: string, items: QueuedCommand[]): void {
  if (items.length === 0) {
    commandQueues.delete(queueKey);
  } else {
    commandQueues.set(queueKey, items);
  }
}

function migrateCommandQueue(fromKey: string, toKey: string): void {
  if (!fromKey || !toKey || fromKey === toKey) return;
  const from = getCommandQueue(fromKey);
  if (from.length === 0) return;
  setCommandQueue(toKey, [...getCommandQueue(toKey), ...from]);
  commandQueues.delete(fromKey);
}

function clearCommandQueue(queueKey: string): void {
  commandQueues.delete(queueKey);
  refreshCommandQueueUI();
}

function updateSendButtonState() {
  const sendBtn = document.querySelector<HTMLButtonElement>('#send-btn');
  if (!sendBtn) {
    return;
  }

  const loading = sendBtn.dataset.loading === 'true';
  const sendIcon = sendBtn.querySelector('.send-icon') as SVGElement | null;
  const stopIcon = sendBtn.querySelector('.stop-icon') as SVGElement | null;
  const hasContent = canSendMessage();

  if (loading) {
    // 运行中：有内容 → 入队；无内容 → 停止
    const enqueueMode = hasContent;
    sendBtn.disabled = false;
    sendBtn.classList.toggle('is-loading', !enqueueMode);
    sendBtn.classList.toggle('is-queue', enqueueMode);
    sendBtn.setAttribute('aria-label', enqueueMode ? '加入队列' : '停止');
    sendBtn.title = enqueueMode ? '加入队列（当前任务结束后自动发送）' : '停止当前任务';
    if (sendIcon) sendIcon.style.display = enqueueMode ? '' : 'none';
    if (stopIcon) stopIcon.style.display = enqueueMode ? 'none' : '';
    return;
  }

  sendBtn.classList.remove('is-queue');
  sendBtn.classList.remove('is-loading');
  sendBtn.disabled = !hasContent;
  sendBtn.setAttribute('aria-label', '发送');
  sendBtn.title = '发送';
  if (sendIcon) sendIcon.style.display = '';
  if (stopIcon) stopIcon.style.display = 'none';
}

function setSendButtonLoading(loading: boolean) {
  const sendBtn = document.querySelector<HTMLButtonElement>('#send-btn');
  if (!sendBtn) {
    return;
  }
  sendBtn.dataset.loading = loading ? 'true' : 'false';

  // 运行中仍允许继续输入并入队，不禁用输入框
  const input = document.querySelector<HTMLTextAreaElement>('#message-input');
  if (input) {
    input.disabled = false;
    input.placeholder = loading
      ? 'AI 正在回答中，输入下一条后 Enter 加入队列…'
      : '输入你的问题，Enter 发送，Shift+Enter 换行，@ 引用文件，粘贴图片...';
  }

  const inputArea = document.querySelector('.input-composer');
  if (inputArea) {
    inputArea.classList.toggle('is-loading', loading);
  }

  updateSendButtonState();
}

function renderCopyIconHtml(className = 'toolbar-copy-icon'): string {
  return `
    <span class="${className}" aria-hidden="true">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
        <rect x="9" y="9" width="13" height="13" rx="2"/>
        <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>
      </svg>
    </span>
  `;
}

async function copyTextToClipboard(text: string): Promise<boolean> {
  const trimmed = text.trim();
  if (!trimmed) return false;
  return _copyToClipboard(trimmed);
}

function formatProjectDirShortName(dir: string): string {
  const trimmed = dir.trim();
  if (!trimmed) return '';
  if (trimmed === '/') return '/';
  if (/^[A-Za-z]:\\?$/.test(trimmed)) return trimmed.replace(/\\$/, '');
  const normalized = trimmed.replace(/[\\/]+$/, '');
  const segments = normalized.split(/[\\/]/).filter(Boolean);
  return segments[segments.length - 1] || trimmed;
}

async function openPathInFileManager(path: string): Promise<void> {
  try {
    await invoke('plugin:opener|open_path', { path });
  } catch (e) {
    console.error('[opener] 打开路径失败:', path, e);
    showCopyToastMsg('打开失败');
  }
}

async function openPathInShell(path: string): Promise<void> {
  try {
    await invoke('open_terminal', { projectDir: path });
  } catch (e) {
    console.error('[terminal] 打开 Shell 失败:', path, e);
    showCopyToastMsg('打开 Shell 失败');
  }
}

async function handleSessionIdClick() {
  const control = document.querySelector<HTMLButtonElement>('#session-id-copy');
  const sessionId = control?.dataset.sessionId?.trim();
  if (!sessionId || sessionId === '—') {
    return;
  }

  const projectDir = getEffectiveProjectDir();
  if (!projectDir) {
    // 无工作目录：降级为复制 Session ID
    copyTextToClipboard(sessionId).then((ok) => {
      if (ok) showCopyToastMsg('已复制');
    });
    return;
  }

  try {
    await invoke('open_terminal_resume', {
      projectDir,
      sessionId,
    });
  } catch (e) {
    console.error('打开终端失败:', e);
    // 失败时降级复制
    copyTextToClipboard(sessionId).then((ok) => {
      if (ok) showCopyToastMsg('已复制');
    });
  }
}

function bindSessionIdCopyEvents() {
  const control = document.querySelector('#session-id-copy');
  if (!control) {
    return;
  }
  control.removeEventListener('click', handleSessionIdClick);
  control.addEventListener('click', handleSessionIdClick);
}

function renderSendButtonHtml(): string {
  const disabled = canSendMessage() ? '' : ' disabled';
  return `
    <button class="send-btn" id="send-btn" type="button" aria-label="发送"${disabled}>
      <svg class="send-icon" viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
        <path d="M12 19V5"/>
        <path d="m5 12 7-7 7 7"/>
      </svg>
      <svg class="stop-icon" viewBox="0 0 24 24" aria-hidden="true" style="display:none">
        <rect x="6" y="6" width="12" height="12" rx="2" fill="currentColor"/>
      </svg>
    </button>
  `;
}

/** 更新右下角工作目录展示（无需重建 DOM） */
function updateProjectDirDisplay() {
  const el = document.querySelector('#project-dir-display') as HTMLButtonElement | null;
  if (!el) return;

  const dir = getEffectiveProjectDir();
  const shortName = formatProjectDirShortName(dir);
  const label = shortName || '—';
  const title = dir ? `工作目录: ${dir}（点击打开）` : '未设置工作目录';
  const hasDir = Boolean(dir);

  el.title = title;
  el.setAttribute('aria-label', title);
  el.disabled = !hasDir;

  const labelEl = el.querySelector('.project-dir-display-label');
  if (labelEl) labelEl.textContent = label;

  // 更新外部链接图标
  el.querySelector('.project-dir-display-open')?.remove();
  if (hasDir) {
    el.insertAdjacentHTML('beforeend', '<span class="project-dir-display-open" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/></svg></span>');
  }
}

function renderProjectDirDisplayHtml(): string {
  const dir = getEffectiveProjectDir();
  const shortName = formatProjectDirShortName(dir);
  const label = shortName || '—';
  const title = dir ? `工作目录: ${dir}（点击打开）` : '未设置工作目录';
  const hasDir = Boolean(dir);

  return `
    <button
      type="button"
      class="project-dir-display"
      id="project-dir-display"
      title="${escapeHtml(title)}"
      aria-label="${escapeHtml(title)}"
      ${!hasDir ? 'disabled' : ''}
    >
      <span class="project-dir-display-icon" aria-hidden="true">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>
        </svg>
      </span>
      <span class="project-dir-display-label">${escapeHtml(label)}</span>
      ${hasDir ? '<span class="project-dir-display-open" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/></svg></span>' : ''}
    </button>
  `;
}

function renderInputComposerHtml(): string {
  return `
    <div class="input-area">
      <div id="command-queue" class="command-queue">${renderCommandQueueInnerHtml(getActiveQueueKey())}</div>
      <div id="paste-attachments-bar" class="paste-attachments-bar" style="display:none"></div>
      <div id="imported-file-bar" class="imported-file-bar" style="display:none"></div>
      <div class="input-composer">
        <textarea
          id="message-input"
          class="input-composer-textarea"
          rows="1"
          placeholder="输入你的问题，Enter 发送，Shift+Enter 换行，@ 引用文件，粘贴图片..."
        ></textarea>
        <div id="file-suggestions" class="file-suggestions" style="display:none"></div>
        <div class="input-composer-toolbar">
          <div class="input-composer-toolbar-start">
            <button
              id="btn-import"
              class="toolbar-icon-btn import-btn"
              type="button"
              title="导入外部文件 / 文件夹"
            >
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/>
                <polyline points="17 8 12 3 7 8"/>
                <line x1="12" y1="3" x2="12" y2="15"/>
              </svg>
            </button>
          </div>
          <div class="input-composer-toolbar-end">
            ${renderProjectDirDisplayHtml()}
            ${renderChatModelPickerHtml()}
            ${renderContextIndicatorHtml()}
            ${renderSendButtonHtml()}
          </div>
        </div>
      </div>
    </div>
  `;
}

function renderCommandQueueInnerHtml(queueKey: string): string {
  const items = getCommandQueue(queueKey);
  if (items.length === 0) return '';

  const rows = items
    .map((item, index) => {
      const preview = item.messageContent.trim() || item.prompt.trim() || '(空消息)';
      return `
        <div class="command-queue-item" data-queue-id="${escapeHtml(item.id)}">
          <span class="command-queue-index">${index + 1}</span>
          <span class="command-queue-text" title="${escapeHtml(preview)}">${escapeHtml(preview)}</span>
          <button
            type="button"
            class="command-queue-remove"
            data-action="remove-queued-command"
            data-queue-id="${escapeHtml(item.id)}"
            title="从队列移除"
            aria-label="从队列移除"
          >
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" aria-hidden="true">
              <line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>
            </svg>
          </button>
        </div>
      `;
    })
    .join('');

  return `
    <div class="command-queue-panel">
      <div class="command-queue-header">
        <span>待发送队列 · ${items.length}</span>
        <button type="button" class="command-queue-clear" data-action="clear-command-queue">清空</button>
      </div>
      <div class="command-queue-list">${rows}</div>
    </div>
  `;
}

function refreshCommandQueueUI(): void {
  const el = document.querySelector('#command-queue');
  if (!el) return;
  el.innerHTML = renderCommandQueueInnerHtml(getActiveQueueKey());
}

function bindCommandQueueEvents(): void {
  const el = document.querySelector('#command-queue');
  if (!el || (el as HTMLElement).dataset.bound === '1') return;
  (el as HTMLElement).dataset.bound = '1';
  el.addEventListener('click', (event) => {
    const target = event.target as HTMLElement;
    const clearBtn = target.closest<HTMLElement>('[data-action="clear-command-queue"]');
    if (clearBtn) {
      clearCommandQueue(getActiveQueueKey());
      showCopyToastMsg('已清空队列');
      return;
    }
    const removeBtn = target.closest<HTMLElement>('[data-action="remove-queued-command"]');
    if (!removeBtn) return;
    const id = removeBtn.dataset.queueId;
    if (!id) return;
    removeQueuedCommand(getActiveQueueKey(), id);
  });
}

function removeQueuedCommand(queueKey: string, commandId: string): void {
  const next = getCommandQueue(queueKey).filter((item) => item.id !== commandId);
  setCommandQueue(queueKey, next);
  refreshCommandQueueUI();
}

function enqueueCommand(queueKey: string, command: QueuedCommand): void {
  setCommandQueue(queueKey, [...getCommandQueue(queueKey), command]);
  refreshCommandQueueUI();
}

async function processNextQueuedCommand(conversationId: string): Promise<void> {
  if (!conversationId) return;
  if (runningSessions.has(conversationId) || queueDrainInFlight.has(conversationId)) {
    return;
  }

  const queue = getCommandQueue(conversationId);
  if (queue.length === 0) {
    refreshCommandQueueUI();
    return;
  }

  const next = queue[0];
  setCommandQueue(conversationId, queue.slice(1));
  refreshCommandQueueUI();

  queueDrainInFlight.add(conversationId);
  try {
    await executePreparedCommand(conversationId, next);
  } finally {
    queueDrainInFlight.delete(conversationId);
  }
}

function normalizeConversation(
  raw: Conversation & { projectDir?: string | null; sourcePath?: string | null }
): Conversation {
  const projectDir = raw.project_dir ?? raw.projectDir ?? null;
  return {
    ...raw,
    project_dir: projectDir?.trim() ? projectDir.trim() : null,
    source_path: raw.source_path ?? raw.sourcePath ?? null,
  };
}

function normalizeSessionEventPayload(raw: SessionEventPayload): SessionEventPayload {
  const conversationId = raw.conversation_id ?? raw.conversationId ?? '';
  const projectDir = raw.project_dir ?? raw.projectDir ?? null;
  const updatedAt = raw.updated_at ?? raw.updatedAt ?? Math.floor(Date.now() / 1000);
  return {
    conversation_id: conversationId,
    title: raw.title,
    messages: raw.messages,
    project_dir: projectDir?.trim() ? projectDir.trim() : null,
    updated_at: updatedAt,
    context_tokens: raw.context_tokens ?? null,
    last_model: raw.last_model ?? null,
  };
}

function resolveConversationProjectDir(
  incoming: string | null | undefined,
  existing: string | null | undefined,
): string | null {
  const trimmedIncoming = incoming?.trim();
  if (trimmedIncoming) {
    return trimmedIncoming;
  }
  const trimmedExisting = existing?.trim();
  if (trimmedExisting) {
    return trimmedExisting;
  }
  return null;
}


// 在内存中更新或添加会话
function updateOrAddConversation(conv: Conversation) {
  const normalized = normalizeConversation(conv as Conversation & { projectDir?: string | null });
  const idx = conversations.findIndex(c => c.id === normalized.id);
  if (idx >= 0) {
    const existing = conversations[idx];
    conversations[idx] = {
      ...normalized,
      project_dir: resolveConversationProjectDir(normalized.project_dir, existing.project_dir),
      source_path: normalized.source_path ?? existing.source_path,
      created_at: existing.created_at,
    };
  } else {
    conversations.unshift(normalized);
    // 标记为新增，下一次渲染时播放淡入动画
    newConversationIds.add(normalized.id);
  }
  conversations.sort((a, b) => b.created_at - a.created_at);
}

async function refreshConversationFromBackend(conversationId: string) {
  if (!conversationId) {
    return;
  }
  try {
    const raw = await invoke<(Conversation & { projectDir?: string | null }) | null>('get_conversation', {
      conversationId,
    });
    if (raw) {
      updateOrAddConversation(raw);
    }
  } catch (e) {
    console.error('Failed to refresh conversation:', e);
  }
}

// ── 工作区分组辅助函数 ─────────────────────────────────────────────

interface WorkspaceGroup {
  path: string;
  displayName: string;
  conversations: Conversation[];
}

/** 从完整路径提取最后一级目录名作为展示名 */
function getWorkspaceDisplayName(path: string): string {
  const normalized = path.replace(/[\\/]+$/, '');
  const parts = normalized.split(/[\\/]/);
  return parts[parts.length - 1] || path;
}

// ── 侧边栏展示辅助（项目 icon / 时间 / 模型标签）─────────────────────

/** 把后端时间戳（秒或毫秒）统一为毫秒 */
function toMillis(ts: number | null | undefined): number {
  if (!ts) return 0;
  // 小于 1e12 视为秒级时间戳
  return ts < 1e12 ? ts * 1000 : ts;
}

/** 稳定字符串哈希，用于给项目 icon 分配固定色相 */
function hashString(input: string): number {
  let hash = 0;
  for (let i = 0; i < input.length; i++) {
    hash = (hash << 5) - hash + input.charCodeAt(i);
    hash |= 0;
  }
  return Math.abs(hash);
}

/** 项目 icon 色相：同一路径始终得到同一颜色 */
function getWorkspaceHue(path: string): number {
  return hashString(path) % 360;
}

/** 项目 icon 文字：取目录名的 1~2 个有效字符 */
function getWorkspaceInitials(displayName: string): string {
  const cleaned = displayName.replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
  if (!cleaned) return '#';

  const words = cleaned.split(/\s+/);
  if (words.length >= 2) {
    return (words[0][0] + words[1][0]).toUpperCase();
  }

  const word = words[0];
  // CamelCase：取首字母 + 第二个大写字母（CodeCliManager → CC）
  const camel = word.match(/^(\p{Lu})[\p{Ll}\p{N}]*(\p{Lu})/u);
  if (camel) {
    return (camel[1] + camel[2]).toUpperCase();
  }
  // 中文取首字，其他取前两位
  return /\p{Script=Han}/u.test(word) ? word[0] : word.slice(0, 2).toUpperCase();
}

/** 相对时间（完整版，用于项目卡片元信息） */
function formatRelativeTime(ts: number | null | undefined): string {
  const ms = toMillis(ts);
  if (!ms) return '';

  const diff = Date.now() - ms;
  if (diff < 60_000) return '刚刚';
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} 分钟前`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)} 小时前`;
  if (diff < 172_800_000) return '昨天';
  if (diff < 604_800_000) return `${Math.floor(diff / 86_400_000)} 天前`;

  const date = new Date(ms);
  const sameYear = date.getFullYear() === new Date().getFullYear();
  const md = `${date.getMonth() + 1}/${date.getDate()}`;
  return sameYear ? md : `${date.getFullYear()}/${md}`;
}

/** 极简时间（用于会话行右侧，尽量少占宽度） */
function formatCompactTime(ts: number | null | undefined): string {
  const ms = toMillis(ts);
  if (!ms) return '';

  const diff = Date.now() - ms;
  if (diff < 60_000) return '刚刚';
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}分`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}时`;
  if (diff < 172_800_000) return '昨天';
  if (diff < 604_800_000) return `${Math.floor(diff / 86_400_000)}天`;

  const date = new Date(ms);
  return `${date.getMonth() + 1}/${date.getDate()}`;
}

/** 把模型 ID 压缩成短标签：claude-sonnet-4-5-20250929 → Sonnet 4.5 */
function formatModelLabel(model: string | null | undefined): string {
  const raw = model?.trim();
  if (!raw) return '';

  // 去掉日期后缀与厂商前缀
  let id = raw.replace(/[-_]?\d{8}$/, '');
  id = id.replace(/^(anthropic|openai|google|deepseek|qwen|moonshot)[/-]/i, '');

  const family = id.match(/(opus|sonnet|haiku|gpt|o\d|gemini|deepseek|qwen|kimi|glm|grok)/i);
  const version = id.match(/(\d+(?:[.-]\d+)?)/);

  if (family) {
    const name = family[1].toLowerCase();
    const pretty = name.charAt(0).toUpperCase() + name.slice(1);
    const ver = version ? ` ${version[1].replace('-', '.')}` : '';
    return `${pretty}${ver}`.trim();
  }

  return id.length > 18 ? `${id.slice(0, 17)}…` : id;
}

/** 将工作区展开状态持久化到 localStorage */
function saveExpandedWorkspaces(): void {
  try {
    localStorage.setItem(EXPANDED_WORKSPACES_KEY, JSON.stringify(Array.from(expandedWorkspaces)));
  } catch (e) {
    console.warn('Failed to save expanded workspaces:', e);
  }
}

/** 按 project_dir 将对话分组为工作区，返回工作区列表和未分类对话 */
function groupConversationsByWorkspace(): { workspaces: WorkspaceGroup[]; uncategorized: Conversation[] } {
  const workspaceMap = new Map<string, Conversation[]>();
  const uncategorized: Conversation[] = [];

  for (const conv of conversations) {
    const dir = conv.project_dir?.trim();
    if (dir) {
      const list = workspaceMap.get(dir) || [];
      list.push(conv);
      workspaceMap.set(dir, list);
    } else {
      uncategorized.push(conv);
    }
  }

  // 构建工作区数组，按对话创建时间降序排列
  const workspaces: WorkspaceGroup[] = Array.from(workspaceMap.entries()).map(([path, convs]) => ({
    path,
    displayName: getWorkspaceDisplayName(path),
    conversations: convs.sort((a, b) => b.created_at - a.created_at),
  }));
  workspaces.sort((a, b) => {
    const aLatest = a.conversations[0]?.created_at ?? 0;
    const bLatest = b.conversations[0]?.created_at ?? 0;
    return bLatest - aLatest;
  });

  // 未分类对话也按创建时间降序
  uncategorized.sort((a, b) => b.created_at - a.created_at);

  return { workspaces, uncategorized };
}

/** 在指定工作区快速新建对话（预设工作目录，跳过选目录步骤） */
function newChatInWorkspace(workspacePath: string): void {
  dismissApiConfigViewState();
  activeConversationId = '';
  invalidateFileCache();
  pendingUserMessage = null;
  pendingUserMessageConvId = null;
  transientSessionError = null;
  pendingProjectDir = workspacePath;
  clearCommandQueue('pending');
  render();
  void refreshModelInfo();

  setTimeout(() => {
    const input = document.querySelector<HTMLTextAreaElement>('#message-input');
    if (input) input.focus();
  }, 100);
}

/** 渲染单个对话列表项 HTML（供工作区卡片复用） */
function renderConversationItemHtml(c: Conversation): string {
  const isActive = c.id === activeConversationId;
  const isEditing = editingConversationId === c.id;
  const isRunning = runningSessions.has(c.id);
  const isNew = newConversationIds.has(c.id);

  const classNames = [
    'conversation-item',
    isActive ? 'active' : '',
    isEditing ? 'editing' : '',
    isRunning ? 'running' : '',
    isNew ? 'is-new' : '',
  ].filter(Boolean).join(' ');

  const time = formatCompactTime(c.updated_at || c.created_at);
  const stateIcon = isRunning ? CONVERSATION_RUNNING_DOT_HTML : CONVERSATION_CHAT_ICON_SVG;

  return `
    <div class="${classNames}" data-id="${c.id}" title="${escapeHtml(c.title)}">
      <span class="conversation-rail" aria-hidden="true"></span>
      ${isEditing ? `
        <div class="conversation-edit-row">
          <input type="text"
                 class="edit-input"
                 id="edit-input-${c.id}"
                 value="${escapeHtml(c.title)}"
          />
          <div class="edit-action-buttons">
            <button type="button" class="edit-action-btn save" data-action="save-edit" data-id="${c.id}" title="保存">✓</button>
            <button type="button" class="edit-action-btn cancel" data-action="cancel-edit" title="取消">✕</button>
          </div>
        </div>
      ` : `
        <span class="conversation-row">
          ${stateIcon}
          <span class="conversation-title">${escapeHtml(c.title)}</span>
          ${time ? `<span class="conversation-time">${escapeHtml(time)}</span>` : ''}
          <button type="button" class="conv-more-btn" data-action="more" data-id="${c.id}" title="更多操作" aria-label="更多操作">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><circle cx="12" cy="5" r="2"/><circle cx="12" cy="12" r="2"/><circle cx="12" cy="19" r="2"/></svg>
          </button>
        </span>
      `}
    </div>
  `;
}

async function loadData() {
  try {
    const raw = await invoke<(Conversation & { projectDir?: string | null })[]>('get_conversations');
    conversations = raw.map(normalizeConversation);
    currentPlatform = await invoke<string>('get_current_platform');
    console.log('Current platform:', currentPlatform);
  } catch (e) {
    console.error('Failed to load data:', e);
  }
}

/** 未分类分组的固定 key */
const UNCATEGORIZED_WORKSPACE_KEY = '__uncategorized__';

interface SidebarWorkspaceView {
  /** 展开状态 / 事件传参使用的 key（未分类为固定常量） */
  key: string;
  /** 真实目录路径，未分类为空字符串 */
  path: string;
  displayName: string;
  conversations: Conversation[];
  /** 最近活动时间（毫秒） */
  latestActivity: number;
  /** 最近使用的模型短标签 */
  modelLabel: string;
  hasActive: boolean;
  runningCount: number;
  isUncategorized: boolean;
}

/** 构建侧边栏工作区视图模型（含搜索过滤、活动时间、模型标签） */
function buildSidebarWorkspaceViews(): SidebarWorkspaceView[] {
  const { workspaces, uncategorized } = groupConversationsByWorkspace();
  const query = sidebarSearchQuery.trim().toLowerCase();

  const toView = (
    key: string,
    path: string,
    displayName: string,
    convs: Conversation[],
    isUncategorized: boolean,
  ): SidebarWorkspaceView | null => {
    // 目录名/路径命中时保留全部会话，否则只保留标题命中的会话
    const workspaceHit =
      !!query && (displayName.toLowerCase().includes(query) || path.toLowerCase().includes(query));
    const matched = !query || workspaceHit
      ? convs
      : convs.filter((c) => c.title.toLowerCase().includes(query));

    if (matched.length === 0) return null;

    const latestActivity = matched.reduce(
      (max, c) => Math.max(max, toMillis(c.updated_at), toMillis(c.created_at)),
      0,
    );
    // 模型标签取最近活动会话上记录的模型
    const newest = [...matched].sort(
      (a, b) => toMillis(b.updated_at || b.created_at) - toMillis(a.updated_at || a.created_at),
    )[0];

    return {
      key,
      path,
      displayName,
      conversations: matched,
      latestActivity,
      modelLabel: formatModelLabel(matched.find((c) => c.last_model)?.last_model ?? newest?.last_model),
      hasActive: matched.some((c) => c.id === activeConversationId),
      runningCount: matched.filter((c) => runningSessions.has(c.id)).length,
      isUncategorized,
    };
  };

  const views = workspaces
    .map((ws) => toView(ws.path, ws.path, ws.displayName, ws.conversations, false))
    .filter((v): v is SidebarWorkspaceView => v !== null)
    // 按最近活动时间降序，让常用项目始终靠前
    .sort((a, b) => b.latestActivity - a.latestActivity);

  const uncatView = uncategorized.length
    ? toView(UNCATEGORIZED_WORKSPACE_KEY, '', '未分类', uncategorized, true)
    : null;
  if (uncatView) views.push(uncatView);

  return views;
}

const CHEVRON_SVG =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="9 18 15 12 9 6"/></svg>';

const CONVERSATION_CHAT_ICON_SVG =
  '<svg class="conversation-chat-icon" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>';

const CONVERSATION_RUNNING_DOT_HTML =
  '<span class="conversation-status-dot" title="运行中" aria-label="运行中"></span>';

/** 项目卡片元信息（最近使用时间 / 运行中状态）的内部 HTML */
function renderWorkspaceMetaInnerHtml(ws: SidebarWorkspaceView): string {
  const relTime = formatRelativeTime(ws.latestActivity);

  return [
    ws.runningCount > 0
      ? `<span class="workspace-live"><i class="workspace-live-dot" aria-hidden="true"></i>${ws.runningCount} 运行中</span>`
      : relTime
        ? `<span class="workspace-time">${escapeHtml(relTime)}</span>`
        : '',
  ].filter(Boolean).join('');
}

/** 渲染单个工作区卡片 */
function renderWorkspaceCardHtml(ws: SidebarWorkspaceView, isExpanded: boolean): string {
  const key = escapeHtml(ws.key);
  const cardClasses = [
    'workspace-card',
    isExpanded ? 'is-expanded' : '',
    ws.hasActive ? 'has-active' : '',
    ws.isUncategorized ? 'is-uncategorized' : '',
  ].filter(Boolean).join(' ');

  const hue = ws.isUncategorized ? 220 : getWorkspaceHue(ws.path);
  const initials = ws.isUncategorized ? '·' : getWorkspaceInitials(ws.displayName);
  const titleAttr = ws.isUncategorized ? '未归属工作目录的会话' : ws.path;

  return `
    <section class="${cardClasses}" data-workspace-key="${key}" style="--ws-hue: ${hue}">
      <div
        class="workspace-header"
        data-action="toggle-workspace"
        data-workspace="${key}"
        role="button"
        tabindex="0"
        aria-expanded="${isExpanded}"
        title="${escapeHtml(titleAttr)}"
      >
        <span class="workspace-arrow${isExpanded ? ' expanded' : ''}">${CHEVRON_SVG}</span>
        <span class="workspace-avatar" aria-hidden="true">${escapeHtml(initials)}</span>
        <span class="workspace-main">
          <span class="workspace-name-row">
            <span class="workspace-name">${escapeHtml(ws.displayName)}</span>
            <span class="workspace-count">${ws.conversations.length}</span>
          </span>
          <span class="workspace-meta">${renderWorkspaceMetaInnerHtml(ws)}</span>
        </span>
        <span class="workspace-actions">
          <button type="button" class="ws-icon-btn" data-action="workspace-more" data-workspace="${key}" title="项目操作" aria-label="项目操作">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><circle cx="12" cy="5" r="2"/><circle cx="12" cy="12" r="2"/><circle cx="12" cy="19" r="2"/></svg>
          </button>
        </span>
      </div>
      <div class="workspace-body">
        <div class="workspace-conversations">
          ${ws.conversations.map((c) => renderConversationItemHtml(c)).join('')}
        </div>
      </div>
    </section>
  `;
}

function renderSidebarEmptyHtml(isSearching: boolean): string {
  const icon = isSearching
    ? '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="11" cy="11" r="7"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>'
    : '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>';

  return `
    <div class="sidebar-empty">
      <span class="sidebar-empty-icon">${icon}</span>
      <span class="sidebar-empty-title">${isSearching ? '没有匹配的会话' : '还没有会话'}</span>
      <span class="sidebar-empty-hint">${isSearching ? '试试其他关键词，或清空搜索条件' : '点击上方「新建会话」选择工作目录开始'}</span>
    </div>
  `;
}

function renderConversationList(): string {
  const isSearching = sidebarSearchQuery.trim().length > 0;
  const views = conversations.length === 0 ? [] : buildSidebarWorkspaceViews();

  if (views.length === 0) {
    newConversationIds.clear();
    return renderSidebarEmptyHtml(isSearching);
  }

  const totalConversations = views.reduce((sum, ws) => sum + ws.conversations.length, 0);
  const label = isSearching
    ? `<div class="sidebar-section-label"><span>搜索结果</span><span class="sidebar-section-label-count">${totalConversations} 个会话</span></div>`
    : `<div class="sidebar-section-label"><span>工作区</span><span class="sidebar-section-label-count">${views.length} 个项目</span></div>`;

  // 搜索时强制展开所有命中的卡片，方便直接定位会话
  const cards = views
    .map((ws) => renderWorkspaceCardHtml(ws, isSearching || expandedWorkspaces.has(ws.key)))
    .join('');

  // 淡入动画只播放一次
  newConversationIds.clear();

  return label + cards;
}

/** 局部重渲染侧边栏会话列表 */
function refreshConversationListDom(): void {
  if (isApiConfigViewActive) return;
  const list = document.querySelector('#conversation-list');
  if (list) list.innerHTML = renderConversationList();
}

/** 展开 / 收起工作区卡片（带 200ms 高度过渡） */
function toggleWorkspaceExpanded(key: string): void {
  const willExpand = !expandedWorkspaces.has(key);
  if (willExpand) {
    expandedWorkspaces.add(key);
  } else {
    expandedWorkspaces.delete(key);
  }
  saveExpandedWorkspaces();

  const card = Array.from(document.querySelectorAll<HTMLElement>('.workspace-card'))
    .find((el) => el.dataset.workspaceKey === key);
  const body = card?.querySelector<HTMLElement>('.workspace-body');

  if (!card || !body) {
    refreshConversationListDom();
    return;
  }

  card.querySelector('.workspace-arrow')?.classList.toggle('expanded', willExpand);
  card.querySelector('.workspace-header')?.setAttribute('aria-expanded', String(willExpand));

  const targetHeight = body.scrollHeight;

  if (willExpand) {
    body.style.maxHeight = '0px';
    card.classList.add('is-expanded');
    void body.offsetHeight; // 强制 reflow，确保从 0 开始过渡
    body.style.maxHeight = `${targetHeight}px`;
    window.setTimeout(() => {
      // 过渡结束后交还给内容自适应高度
      if (card.classList.contains('is-expanded')) body.style.maxHeight = '';
    }, 220);
  } else {
    body.style.maxHeight = `${targetHeight}px`;
    void body.offsetHeight;
    card.classList.remove('is-expanded');
    body.style.maxHeight = ''; // 回落到 CSS 的 max-height: 0
  }
}

function updateConversationListSpinner() {
  // 会话行：运行中显示脉冲点，否则回到聊天图标
  document.querySelectorAll<HTMLElement>('.conversation-item').forEach((item) => {
    const id = item.dataset.id;
    if (!id) return;

    const isRunning = runningSessions.has(id);
    const wasRunning = item.classList.contains('running');
    item.classList.toggle('running', isRunning);
    if (isRunning === wasRunning) return;

    const icon = item.querySelector('.conversation-chat-icon, .conversation-status-dot');
    if (icon) {
      icon.outerHTML = isRunning ? CONVERSATION_RUNNING_DOT_HTML : CONVERSATION_CHAT_ICON_SVG;
    }
  });

  // 项目卡片：同步「运行中」标记与最近使用时间
  const cards = document.querySelectorAll<HTMLElement>('.workspace-card');
  if (cards.length === 0) return;

  const viewByKey = new Map(buildSidebarWorkspaceViews().map((ws) => [ws.key, ws]));
  cards.forEach((card) => {
    const ws = card.dataset.workspaceKey ? viewByKey.get(card.dataset.workspaceKey) : undefined;
    const meta = card.querySelector<HTMLElement>('.workspace-meta');
    if (ws && meta) meta.innerHTML = renderWorkspaceMetaInnerHtml(ws);
  });
}

function initPlatformClass() {
  const ua = navigator.userAgent.toLowerCase();
  if (ua.includes('mac')) {
    document.documentElement.classList.add('platform-macos');
  } else if (ua.includes('win')) {
    document.documentElement.classList.add('platform-windows');
  }
}

function renderApiConfigIcon(): string {
  return `
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M4 4h16a1 1 0 0 1 1 1v4a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1zm0 8h16a1 1 0 0 1 1 1v4a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1v-4a1 1 0 0 1 1-1zm2 2.5a1.5 1.5 0 1 0 0 3 1.5 1.5 0 0 0 0-3zm0-8a1.5 1.5 0 1 0 0 3 1.5 1.5 0 0 0 0-3z"/>
    </svg>
  `;
}

function shouldShowClaudeUpdateBadge(): boolean {
  if (!claudeUpdateInfo?.updateAvailable || !claudeUpdateInfo.latest) return false;
  return claudeUpdateDismissedVersion !== claudeUpdateInfo.latest;
}

function getClaudeUpdateButtonTitle(): string {
  if (claudeUpdateCheckStatus === 'checking') return '正在检查 Claude Code 更新…';
  if (shouldShowClaudeUpdateBadge() && claudeUpdateInfo?.latest) {
    return `Claude Code 有新版本 ${claudeUpdateInfo.latest}`;
  }
  if (claudeUpdateInfo?.installed) {
    return `Claude Code ${claudeUpdateInfo.installed}`;
  }
  return '检查 Claude Code 更新';
}

function renderClaudeUpdateIcon(): string {
  return `
    <svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
      <path d="M21 12a9 9 0 0 0-9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/>
      <path d="M3 3v5h5"/>
      <path d="M3 12a9 9 0 0 0 9 9 9.75 9.75 0 0 0 6.74-2.74L21 16"/>
      <path d="M16 16h5v5"/>
    </svg>
  `;
}

function renderTitlebarActions(): string {
  const showBadge = shouldShowClaudeUpdateBadge();
  const checking = claudeUpdateCheckStatus === 'checking';
  return `
    <button
      type="button"
      class="toolbar-update-btn${showBadge ? ' has-update' : ''}${checking ? ' is-checking' : ''}"
      id="claude-update-btn"
      title="${escapeHtml(getClaudeUpdateButtonTitle())}"
      aria-label="${escapeHtml(getClaudeUpdateButtonTitle())}"
      aria-haspopup="dialog"
    >
      <span class="toolbar-update-btn-icon" aria-hidden="true">${renderClaudeUpdateIcon()}</span>
      <span class="toolbar-update-btn-label">${showBadge ? '有更新' : '版本'}</span>
      ${showBadge ? '<span class="toolbar-update-btn-dot" aria-hidden="true"></span>' : ''}
    </button>
    <button type="button" class="toolbar-settings-btn settings-btn${isApiConfigViewActive ? ' is-active' : ''}" id="settings-btn" title="管理 Claude Code API 配置" aria-label="API 配置" aria-pressed="${isApiConfigViewActive}">
      <span class="toolbar-settings-btn-icon" aria-hidden="true">${renderApiConfigIcon()}</span>
      <span class="toolbar-settings-btn-label">API 配置</span>
    </button>
    <button type="button" class="toolbar-icon-btn theme-toggle-btn" id="theme-toggle-btn" title="${escapeHtml(getThemeToggleTitle())}" aria-label="${escapeHtml(getThemeToggleTitle())}">
      ${getThemeToggleIcon()}
    </button>
  `;
}

function renderApiConfigSidebarHtml(): string {
  return `
    <div class="api-config-sidebar">
      <div class="settings-profiles-header">
        <span>已保存配置</span>
        <span class="settings-profiles-hint">左键查看 · 右键应用 / 删除</span>
      </div>
      <div class="settings-profile-list"></div>
      <div class="api-config-sidebar-actions">
        <button type="button" class="settings-add-profile">+ 新建</button>
        <button type="button" class="settings-import-cc-switch">从 CC Switch 导入</button>
      </div>
    </div>
  `;
}

function renderApiConfigViewHtml(): string {
  return `
    <div class="api-config-view" id="api-config-view" data-profile-id="">
      <div class="settings-header">
        <div>
          <h3 class="settings-title">Claude Code API 配置</h3>
          <p class="settings-subtitle">保存多套 API 配置，一键切换并写入 Claude Code</p>
        </div>
        <button type="button" class="settings-close-btn" aria-label="返回聊天">✕</button>
      </div>
      <form class="settings-form" id="settings-form">
        <label class="settings-field">
          <span>配置名称</span>
          <input type="text" name="profileName" placeholder="例如：DeepSeek / 官方 Anthropic" />
        </label>
        <label class="settings-field">
          <span>API Base URL</span>
          <input type="url" name="baseUrl" placeholder="https://api.anthropic.com" />
        </label>
        <div class="settings-field">
          <span>API Key</span>
          <div class="settings-apikey-box" data-mode="empty">
            <span class="settings-apikey-display">
              <span class="settings-apikey-display-label">当前：</span>
              <code class="settings-apikey-display-value"></code>
            </span>
            <input type="password" name="apiKey" class="settings-apikey-input" placeholder="sk-..." autocomplete="off" />
            <div class="settings-apikey-actions">
              <button type="button" class="settings-apikey-btn" data-action="edit" title="编辑密钥">编辑</button>
              <button type="button" class="settings-apikey-btn" data-action="copy" title="复制完整密钥">复制</button>
              <button type="button" class="settings-apikey-btn" data-action="cancel" title="取消编辑" hidden>取消</button>
            </div>
          </div>
        </div>
        <label class="settings-field">
          <span>模型配置</span>
          <input
            type="text"
            class="settings-model-input settings-model-config-summary"
            placeholder="点击配置模型"
            readonly
          />
        </label>
        <p class="settings-model-config-hint">配置展示模型与自定义模型列表，点击输入框管理</p>
        <p class="settings-path settings-live-path"></p>
      </form>
      <div class="settings-footer">
        <div class="settings-footer-actions">
          <button type="button" class="settings-btn-secondary settings-apply-profile">应用</button>
          <button type="button" class="settings-btn-secondary settings-close-footer">返回</button>
          <button type="button" class="settings-btn-primary save-only">保存</button>
        </div>
      </div>
    </div>
  `;
}

function getSettingsProfileListEl(): HTMLElement | null {
  return document.querySelector('.settings-profile-list');
}

function render() {
  app.innerHTML = `
    <div class="app-shell">
      <header class="app-titlebar">
        <div class="app-titlebar-leading">
          <button
            type="button"
            class="toolbar-icon-btn sidebar-toggle-btn"
            id="sidebar-toggle-btn"
            title="${escapeHtml(getSidebarToggleTitle())}"
            aria-label="${escapeHtml(getSidebarToggleTitle())}"
            aria-expanded="${!isSidebarCollapsed}"
          >
            ${getSidebarToggleIcon()}
          </button>
        </div>
        <div class="app-titlebar-drag" data-tauri-drag-region></div>
        <h1 class="app-titlebar-title">AI CLI Manager</h1>
        <div class="app-titlebar-actions">
          ${renderTitlebarActions()}
        </div>
      </header>
      <div class="app-container${isSidebarCollapsed ? ' is-sidebar-collapsed' : ''}${isApiConfigViewActive ? ' is-api-config' : ''}">
      <div class="sidebar${isApiConfigViewActive ? ' is-api-config' : ''}">
        ${isApiConfigViewActive ? renderApiConfigSidebarHtml() : `
        <div class="sidebar-header">
          <div class="sidebar-header-actions">
            <div class="new-chat-btn-wrapper">
              <button type="button" class="new-chat-btn" id="new-chat-btn" aria-haspopup="menu"><svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" aria-hidden="true"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>新建会话</button>
            </div>
          </div>
          <div class="sidebar-search-row">
            <div class="sidebar-search">
              <span class="sidebar-search-icon" aria-hidden="true">
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="7"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>
              </span>
              <input
                type="text"
                class="sidebar-search-input"
                id="sidebar-search-input"
                placeholder="搜索会话或项目…"
                autocomplete="off"
                spellcheck="false"
                aria-label="搜索会话或项目"
                value="${escapeHtml(sidebarSearchQuery)}"
              />
              <button
                type="button"
                class="sidebar-search-clear"
                id="sidebar-search-clear"
                title="清空搜索"
                aria-label="清空搜索"
                ${sidebarSearchQuery ? '' : 'hidden'}
              >
                <svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" aria-hidden="true"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
              </button>
            </div>
            <button type="button" class="refresh-btn" id="refresh-btn" title="扫描本地新会话" aria-label="刷新会话列表"><span class="refresh-icon">↻</span></button>
          </div>
        </div>
        <div class="conversation-list" id="conversation-list">
          ${renderConversationList()}
        </div>
        `}
      </div>
      <div
        class="sidebar-resizer"
        id="sidebar-resizer"
        role="separator"
        aria-orientation="vertical"
        aria-label="调整侧边栏宽度"
      ></div>
      <div class="main-content${isApiConfigViewActive ? ' is-api-config' : ''}">
        ${isApiConfigViewActive ? renderApiConfigViewHtml() : `
        <div class="drop-zone-overlay" id="drop-zone-overlay">
          <div class="drop-zone-content">
            <div class="drop-zone-icon" aria-hidden="true">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
                <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/>
                <polyline points="17 8 12 3 7 8"/>
                <line x1="12" y1="3" x2="12" y2="15"/>
              </svg>
            </div>
            <p class="drop-zone-title">拖拽文件到此处引用</p>
            <p class="drop-zone-hint">支持项目内文件自动匹配，外部文件以绝对路径引用</p>
          </div>
        </div>
        ${activeConversationId || pendingUserMessage ? `
        <div class="main-topbar">
          <div class="main-topbar-main">
            ${renderChatHeaderHtml(conversations.find((c) => c.id === activeConversationId))}
          </div>
        </div>
        ` : ''}
        ${activeConversationId || pendingUserMessage ? renderChatContent() : renderEmptyState()}
        ${renderInputComposerHtml()}
        `}
      </div>
      </div>
    </div>
  `;
  
  attachEventListeners();
}

function attachEventListeners() {
  document.querySelector('#new-chat-btn')?.addEventListener('click', newChat);

  document.querySelector('#refresh-btn')?.addEventListener('click', async () => {
    const btn = document.querySelector('#refresh-btn') as HTMLButtonElement | null;
    const sidebar = document.querySelector('.sidebar');
    if (btn) btn.disabled = true;
    btn?.classList.add('is-loading');

    let overlay: HTMLDivElement | null = null;
    if (sidebar && !sidebar.querySelector('.sidebar-loading-overlay')) {
      overlay = document.createElement('div');
      overlay.className = 'sidebar-loading-overlay';
      overlay.innerHTML = `
        <span class="list-loading-spinner" aria-hidden="true"></span>
        <span class="list-loading-text">正在扫描会话…</span>
      `;
      sidebar.appendChild(overlay);
    }

    try {
      // 加了缓存后刷新很快，给 loading 一个最小显示时长，避免一闪而过
      await Promise.all([
        loadData(),
        new Promise((resolve) => setTimeout(resolve, 500)),
      ]);
    } finally {
      refreshConversationListDom();
      overlay?.remove();
      if (btn) btn.disabled = false;
      btn?.classList.remove('is-loading');
    }
  });

  bindSidebarSearch();

  const listEl = document.querySelector('#conversation-list');
  if (listEl) {
    listEl.removeEventListener('click', handleConversationListClick);
    listEl.addEventListener('click', handleConversationListClick);
    listEl.removeEventListener('contextmenu', handleConversationListContextMenu);
    listEl.addEventListener('contextmenu', handleConversationListContextMenu);
    listEl.removeEventListener('keydown', handleConversationListKeydown);
    listEl.addEventListener('keydown', handleConversationListKeydown);
  }

  const textarea = document.querySelector('#message-input') as HTMLTextAreaElement;
  if (textarea) {
    textarea.addEventListener('keydown', handleKeydown);
    textarea.addEventListener('input', updateSendButtonState);
    textarea.addEventListener('input', handleFileSuggestionInput);
    textarea.addEventListener('keydown', handleFileSuggestionKeydown);
    textarea.addEventListener('paste', handlePaste);
    textarea.addEventListener('blur', () => {
      // 延迟关闭，让点击建议项有时间触发
      setTimeout(() => hideFileSuggestions(), 150);
    });
  }

  document.querySelector('#send-btn')?.addEventListener('click', handleSendButtonClick);
  bindCommandQueueEvents();
  refreshCommandQueueUI();

  // 右下角工作目录展示：点击在文件管理器中打开
  const projectDirDisplay = document.querySelector('#project-dir-display');
  if (projectDirDisplay) {
    projectDirDisplay.addEventListener('click', () => {
      const dir = getEffectiveProjectDir().trim();
      if (dir) void openPathInFileManager(dir);
    });
  }

  bindChatModelPickerEvents();
  bindSessionIdCopyEvents();
  bindSidebarResizer();
  document.querySelectorAll('.sidebar-toggle-btn').forEach((btn) => {
    btn.addEventListener('click', toggleSidebarCollapsed);
  });
  syncSidebarResponsiveState();
  syncSidebarCollapsedUI();
  document.querySelector('#theme-toggle-btn')?.addEventListener('click', toggleTheme);
  document.querySelector('#claude-update-btn')?.addEventListener('click', () => {
    toggleClaudeUpdatePopover();
  });
  document.querySelector('#settings-btn')?.addEventListener('click', () => {
    if (isApiConfigViewActive) {
      closeApiConfigView();
    } else {
      openApiConfigView();
    }
  });

  if (isApiConfigViewActive) {
    void mountApiConfigView();
  }

  // 拖拽文件自动引用（API 配置页无输入区，跳过）
  if (!isApiConfigViewActive) {
    bindDragDropFileRefs();
  }

  // 导入外部文件/文件夹按钮（点击弹出选择菜单）
  document.querySelector('#btn-import')?.addEventListener('click', (e) => {
    const target = e.currentTarget as HTMLElement;
    showImportMenu(target);
  });

  // 文件引用芯片双击预览（事件委托，图片 / PDF / 文本通用）
  document.querySelector('#message-list')?.addEventListener('dblclick', (e) => {
    const chip = (e.target as HTMLElement).closest('.file-ref-chip') as HTMLElement | null;
    if (chip?.dataset.filePath) {
      void previewFileByPath(chip.dataset.filePath);
    }
  });

  if (editingConversationId) {
    setTimeout(() => {
      const editInput = document.querySelector(`#edit-input-${editingConversationId}`) as HTMLInputElement;
      if (editInput) {
        editInput.focus();
        editInput.select();
        editInput.addEventListener('keydown', (e) => {
          if (editingConversationId) {
            handleEditKeydown(e, editingConversationId);
          }
        });
      }
    }, 50);
  }

  // 初始化代码复制按钮和消息复制控件
  const msgList = document.querySelector<HTMLDivElement>('#message-list');
  if (msgList) setupMessageListPostRender(msgList);
}

/** 侧边栏搜索框：输入即过滤（局部重渲染，保持输入焦点） */
function bindSidebarSearch() {
  const input = document.querySelector<HTMLInputElement>('#sidebar-search-input');
  const clearBtn = document.querySelector<HTMLButtonElement>('#sidebar-search-clear');
  if (!input) return;

  const apply = (value: string) => {
    sidebarSearchQuery = value;
    if (clearBtn) clearBtn.hidden = value.trim().length === 0;
    refreshConversationListDom();
  };

  input.addEventListener('input', () => apply(input.value));
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && input.value) {
      e.preventDefault();
      input.value = '';
      apply('');
    }
  });

  clearBtn?.addEventListener('click', () => {
    input.value = '';
    apply('');
    input.focus();
  });
}

/** 工作区卡片标题支持键盘展开/收起 */
function handleConversationListKeydown(e: Event) {
  const event = e as KeyboardEvent;
  if (event.key !== 'Enter' && event.key !== ' ') return;

  const target = event.target as HTMLElement;
  // 焦点在卡片内的操作按钮上时交给按钮自身处理，避免同时触发展开
  if (target.closest('button')) return;

  const header = target.closest<HTMLElement>('.workspace-header');
  const key = header?.dataset.workspace;
  if (!header || !key) return;

  event.preventDefault();
  toggleWorkspaceExpanded(key);
}

function handleConversationListClick(e: Event) {
  const target = e.target as HTMLElement;
  const actionEl = target.closest('[data-action]') as HTMLElement | null;

  if (actionEl) {
    e.preventDefault();
    e.stopPropagation();
    const action = actionEl.dataset.action;
    const id = actionEl.dataset.id;
    const workspacePath = actionEl.dataset.workspace;

    // 工作区展开/折叠
    if (action === 'toggle-workspace' && workspacePath) {
      toggleWorkspaceExpanded(workspacePath);
      return;
    }

    // 工作区内新建对话
    if (action === 'new-chat-in-workspace' && workspacePath) {
      newChatInWorkspace(workspacePath);
      return;
    }

    // 工作区 ⋮ 菜单
    if (action === 'workspace-more' && workspacePath) {
      toggleWorkspaceMenu(workspacePath, actionEl);
      return;
    }

    if (action === 'more' && id) {
      toggleConversationMenu(id, actionEl as HTMLElement);
      return;
    }
    if (action === 'save-edit' && id) {
      void saveEdit(id);
      return;
    }
    if (action === 'cancel-edit') {
      cancelEdit();
    }
    return;
  }

  if (editingConversationId) return;

  const item = target.closest('.conversation-item') as HTMLElement | null;
  const id = item?.dataset.id;
  if (id) {
    selectConversation(id);
  }
}

function handleConversationListContextMenu(e: Event) {
  const target = e.target as HTMLElement;
  // 只有工作区 header 区域触发右键菜单（非按钮区域）
  const workspaceHeader = target.closest('.workspace-header') as HTMLElement | null;
  if (!workspaceHeader) return;

  // 排除「未分类」分组
  const workspacePath = workspaceHeader.dataset.workspace;
  if (!workspacePath || workspacePath === UNCATEGORIZED_WORKSPACE_KEY) return;

  e.preventDefault();
  e.stopPropagation();
  toggleWorkspaceMenu(workspacePath, workspaceHeader, e as MouseEvent);
}

function closeWorkspaceContextMenu() {
  document.querySelector('.ws-menu-overlay')?.remove();
}

/**
 * 工作区（项目）操作菜单。
 * - 由 ⋮ 按钮触发时锚定按钮右下角
 * - 由右键触发时锚定鼠标位置
 */
function toggleWorkspaceMenu(workspacePath: string, anchorEl: HTMLElement, event?: MouseEvent) {
  const existing = document.querySelector<HTMLElement>('.ws-menu-overlay');
  if (existing?.dataset.wsPath === workspacePath) {
    return closeWorkspaceContextMenu();
  }
  closeWorkspaceContextMenu();
  closeConversationMenu();

  if (workspacePath === UNCATEGORIZED_WORKSPACE_KEY) return;

  const ws = escapeHtml(workspacePath);
  const overlay = document.createElement('div');
  overlay.className = 'ws-menu-overlay';
  overlay.dataset.wsPath = workspacePath;
  overlay.innerHTML = `
    <div class="conv-menu-dropdown ws-menu-dropdown">
      <button type="button" class="conv-menu-item" data-action="new-chat" data-workspace="${ws}">在此目录新建会话</button>
      <button type="button" class="conv-menu-item" data-action="open-dir" data-workspace="${ws}">在文件管理器中打开</button>
      <button type="button" class="conv-menu-item" data-action="open-shell" data-workspace="${ws}">在 Shell 中打开</button>
      <button type="button" class="conv-menu-item" data-action="copy-path" data-workspace="${ws}">复制目录路径</button>
      <button type="button" class="conv-menu-item is-danger" data-action="delete-workspace" data-workspace="${ws}">删除目录下所有会话</button>
    </div>
  `;

  let onKey: (ev: KeyboardEvent) => void;
  let onDocClick: (ev: Event) => void;
  const closeMenu = () => {
    overlay.remove();
    document.removeEventListener('keydown', onKey);
    document.removeEventListener('click', onDocClick);
  };
  onKey = (ev: KeyboardEvent) => {
    if (ev.key === 'Escape') closeMenu();
  };
  // 点击下拉菜单外部时关闭菜单（overlay 是 pointer-events: none，需监听 document）
  onDocClick = (ev: Event) => {
    const dropdown = overlay.querySelector('.ws-menu-dropdown');
    if (dropdown && !dropdown.contains(ev.target as Node)) closeMenu();
  };

  document.addEventListener('keydown', onKey);
  document.addEventListener('click', onDocClick);

  // 菜单项点击处理挂在下拉菜单上（overlay 是 pointer-events: none）
  const dropdown = overlay.querySelector<HTMLElement>('.ws-menu-dropdown')!;
  dropdown.addEventListener('click', (ev) => {
    const btn = (ev.target as HTMLElement).closest<HTMLElement>('.conv-menu-item');
    if (!btn || !btn.dataset.action) return closeMenu();
    const { action, workspace: dir } = btn.dataset;
    closeMenu();
    if (action === 'new-chat' && dir) newChatInWorkspace(dir);
    if (action === 'open-dir' && dir) void openPathInFileManager(dir);
    if (action === 'open-shell' && dir) void openPathInShell(dir);
    if (action === 'copy-path' && dir) {
      void copyTextToClipboard(dir).then((ok) => {
        if (ok) showCopyToastMsg('已复制目录路径');
      });
    }
    if (action === 'delete-workspace' && dir) void deleteWorkspaceConversations(dir);
  });

  document.body.appendChild(overlay);

  requestAnimationFrame(() => {
    const menu = overlay.querySelector<HTMLElement>('.ws-menu-dropdown');
    if (!menu) return;
    const r = menu.getBoundingClientRect();

    let x: number;
    let y: number;
    if (event) {
      // 右键：锚定鼠标位置
      x = event.clientX;
      y = event.clientY;
    } else {
      // ⋮ 按钮：右对齐于按钮下方
      const a = anchorEl.getBoundingClientRect();
      x = a.right - r.width;
      y = a.bottom + 4;
      if (y + r.height > window.innerHeight) y = a.top - r.height - 4;
    }

    const left = x + r.width > window.innerWidth ? Math.max(8, window.innerWidth - r.width - 8) : x;
    const top = y + r.height > window.innerHeight ? Math.max(8, y - r.height) : y;
    menu.style.left = `${Math.max(8, left)}px`;
    menu.style.top = `${Math.max(8, top)}px`;
  });
}

function closeConversationMenu() {
  document.querySelector('.conv-menu-overlay')?.remove();
  closeWorkspaceContextMenu();
}

function toggleConversationMenu(conversationId: string, anchorEl: HTMLElement) {
  const existing = document.querySelector<HTMLElement>('.conv-menu-overlay');
  if (existing?.dataset.convId === conversationId) {
    return closeConversationMenu();
  }
  closeConversationMenu();

  const { right, bottom, top: anchorTop } = anchorEl.getBoundingClientRect();

  const overlay = document.createElement('div');
  overlay.className = 'conv-menu-overlay';
  overlay.dataset.convId = conversationId;
  overlay.innerHTML = `
    <div class="conv-menu-dropdown">
      <button type="button" class="conv-menu-item" data-action="edit" data-id="${conversationId}">重命名</button>
      <button type="button" class="conv-menu-item" data-action="export" data-id="${conversationId}">导出为 Markdown</button>
      <button type="button" class="conv-menu-item is-danger" data-action="delete" data-id="${conversationId}">删除</button>
    </div>
  `;

  let onKey: (ev: KeyboardEvent) => void;
  const closeMenu = () => {
    overlay.remove();
    document.removeEventListener('keydown', onKey);
  };
  onKey = (ev: KeyboardEvent) => {
    if (ev.key === 'Escape') closeMenu();
  };

  document.addEventListener('keydown', onKey);
  overlay.addEventListener('click', (ev) => {
    const btn = (ev.target as HTMLElement).closest<HTMLElement>('.conv-menu-item');
    if (!btn || !btn.dataset.action) return closeMenu();
    const { action, id } = btn.dataset;
    closeMenu();
    if (action === 'edit' && id) startEdit(id);
    if (action === 'export' && id) void exportConversationToMarkdown(id);
    if (action === 'delete' && id) void deleteConversation(id);
  });

  document.body.appendChild(overlay);

  requestAnimationFrame(() => {
    const menu = overlay.querySelector<HTMLElement>('.conv-menu-dropdown');
    if (!menu) return;
    const r = menu.getBoundingClientRect();
    menu.style.left = `${Math.max(8, right - r.width)}px`;
    menu.style.top = `${bottom + r.height > window.innerHeight ? Math.max(8, anchorTop - r.height - 4) : bottom + 4}px`;
  });
}

interface ConfirmDialogOptions {
  title: string;
  message: string;
  sub?: string;
  confirmLabel?: string;
}

function showConfirmDialog(options: ConfirmDialogOptions): Promise<boolean> {
  return new Promise((resolve) => {
    const overlay = document.createElement('div');
    overlay.className = 'confirm-overlay';
    overlay.innerHTML = `
      <div class="confirm-dialog" role="dialog" aria-modal="true">
        <h3 class="confirm-title">${escapeHtml(options.title)}</h3>
        <p class="confirm-message">${options.message}</p>
        ${options.sub ? `<p class="confirm-sub">${escapeHtml(options.sub)}</p>` : ''}
        <div class="confirm-actions">
          <button type="button" class="confirm-btn cancel">取消</button>
          <button type="button" class="confirm-btn danger">${escapeHtml(options.confirmLabel || '确认')}</button>
        </div>
      </div>
    `;

    const cleanup = (result: boolean) => {
      overlay.remove();
      resolve(result);
    };

    overlay.querySelector('.confirm-btn.cancel')?.addEventListener('click', () => cleanup(false));
    overlay.querySelector('.confirm-btn.danger')?.addEventListener('click', () => cleanup(true));
    overlay.addEventListener('click', (event) => {
      if (event.target === overlay) cleanup(false);
    });

    document.body.appendChild(overlay);
    (overlay.querySelector('.confirm-btn.danger') as HTMLButtonElement | null)?.focus();
  });
}

function showDeleteConfirm(title: string): Promise<boolean> {
  return showConfirmDialog({
    title: '删除会话',
    message: `确定要删除「${escapeHtml(title)}」吗？`,
    sub: '此操作将永久删除本地会话记录，且不可恢复。',
    confirmLabel: '删除',
  });
}

function closeProfileContextMenu() {
  document.querySelector('.profile-context-menu-overlay')?.remove();
}

interface ProfileContextMenuOptions {
  x: number;
  y: number;
  profileId: string;
  profileName: string;
  isActive: boolean;
  allowDelete?: boolean;
  onApply: () => void | Promise<void>;
  onDelete: () => void | Promise<void>;
}

function showProfileContextMenu(options: ProfileContextMenuOptions) {
  closeProfileContextMenu();

  const overlay = document.createElement('div');
  overlay.className = 'profile-context-menu-overlay';
  overlay.innerHTML = `
    <div
      class="profile-context-menu"
      role="menu"
      style="left: ${options.x}px; top: ${options.y}px"
    >
      <button
        type="button"
        class="profile-context-menu-item"
        data-action="apply"
        ${options.isActive ? 'disabled' : ''}
        ${options.isActive ? 'title="该配置正在使用中"' : ''}
      >应用</button>
      ${options.allowDelete === false ? '' : `<button
        type="button"
        class="profile-context-menu-item profile-context-menu-item-danger"
        data-action="delete"
        ${options.isActive ? 'disabled' : ''}
        ${options.isActive ? 'title="无法删除正在使用的配置"' : ''}
      >删除</button>`}
    </div>
  `;

  const close = () => {
    overlay.remove();
    document.removeEventListener('keydown', onKeyDown);
  };

  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key === 'Escape') {
      close();
    }
  };

  overlay.addEventListener('click', (event) => {
    if (event.target === overlay) {
      close();
    }
  });

  overlay.querySelector('[data-action="apply"]')?.addEventListener('click', async () => {
    if (options.isActive) return;
    close();
    await options.onApply();
  });

  overlay.querySelector('[data-action="delete"]')?.addEventListener('click', async () => {
    if (options.isActive) return;
    close();
    await options.onDelete();
  });

  document.addEventListener('keydown', onKeyDown);
  document.body.appendChild(overlay);

  const menu = overlay.querySelector('.profile-context-menu') as HTMLElement | null;
  if (menu) {
    const rect = menu.getBoundingClientRect();
    if (rect.right > window.innerWidth) {
      menu.style.left = `${Math.max(8, window.innerWidth - rect.width - 8)}px`;
    }
    if (rect.bottom > window.innerHeight) {
      menu.style.top = `${Math.max(8, window.innerHeight - rect.height - 8)}px`;
    }
  }
}

function renderSettingsProfileList(profiles: ApiProfileItem[], selectedProfileId: string | null): string {
  const officialActive = !profiles.some((p) => p.isActive);
  const officialSelected = selectedProfileId === OFFICIAL_PROFILE_ID;
  const officialItem = `
    <div
      class="settings-profile-item settings-profile-official ${officialActive ? 'active' : ''} ${officialSelected ? 'selected' : ''}"
      data-official="true"
      role="button"
      tabindex="0"
      aria-label="使用官方默认（Claude 订阅）"
    >
      ${officialActive ? '<span class="settings-profile-badge">使用中</span>' : ''}
      <div class="settings-profile-main">
        <span class="settings-profile-name">官方默认</span>
        <span class="settings-profile-meta">Claude 订阅 / 官方登录（清除自定义 API）</span>
      </div>
    </div>
  `;

  if (profiles.length === 0) {
    return officialItem;
  }

  return officialItem + profiles
    .map((profile) => {
      const isSelected = selectedProfileId === profile.id;
      const isActive = profile.isActive;
      return `
        <div
          class="settings-profile-item ${isSelected ? 'selected' : ''} ${isActive ? 'active' : ''}"
          data-profile-id="${profile.id}"
          role="button"
          tabindex="0"
          aria-label="选择配置 ${escapeHtml(profile.name)}"
        >
          ${isActive ? '<span class="settings-profile-badge">使用中</span>' : ''}
          <div class="settings-profile-main">
            <span class="settings-profile-name">${escapeHtml(profile.name)}</span>
            <span class="settings-profile-meta">${escapeHtml(profile.baseUrl || '未设置 Base URL')}</span>
          </div>
        </div>
      `;
    })
    .join('');
}

// 官方默认伪配置的标识：用于「查看」其只读详情
const OFFICIAL_PROFILE_ID = '__official__';

/** 切换右侧表单是否可编辑（官方默认只读、无需保存） */
function setSettingsFormEditable(overlay: HTMLElement, editable: boolean) {
  for (const name of ['profileName', 'baseUrl', 'apiKey']) {
    const el = overlay.querySelector(`input[name="${name}"]`) as HTMLInputElement | null;
    if (el) el.disabled = !editable;
  }
  const modelInput = overlay.querySelector('.settings-model-config-summary') as HTMLInputElement | null;
  if (modelInput) modelInput.classList.toggle('is-disabled', !editable);
  const saveBtn = overlay.querySelector('.save-only') as HTMLButtonElement | null;
  if (saveBtn) {
    saveBtn.disabled = !editable;
    saveBtn.title = editable ? '' : '官方默认无需保存';
  }
}

/** 在右侧以只读方式展示「官方默认」详情 */
function fillOfficialView(overlay: HTMLElement) {
  overlay.dataset.profileId = OFFICIAL_PROFILE_ID;
  (overlay.querySelector('input[name="profileName"]') as HTMLInputElement).value = '官方默认（Claude 订阅）';
  const baseInput = overlay.querySelector('input[name="baseUrl"]') as HTMLInputElement;
  baseInput.value = '';
  baseInput.placeholder = '官方登录，无需 Base URL';
  const keyInput = overlay.querySelector('input[name="apiKey"]') as HTMLInputElement;
  keyInput.value = '';
  keyInput.placeholder = '官方登录，无需 API Key';
  resetApiKeyBox(overlay);
  const modelInput = overlay.querySelector('.settings-model-config-summary') as HTMLInputElement | null;
  if (modelInput) modelInput.value = '由订阅 / 官方登录决定';
  setSettingsFormEditable(overlay, false);
}

/** 将完整 API Key 转换为首尾可见的脱敏字符串，例如 `sk-a••••••••••wxyz`。 */
function maskApiKey(key: string): string {
  const trimmed = (key || '').trim();
  if (!trimmed) return '';
  if (trimmed.length <= 8) return '•'.repeat(trimmed.length);
  const head = trimmed.slice(0, 4);
  const tail = trimmed.slice(-4);
  const dots = Math.max(6, Math.min(12, trimmed.length - 8));
  return `${head}${'•'.repeat(dots)}${tail}`;
}

/** API Key 输入框三种模式：
 *  - empty：未保存密钥，纯输入框
 *  - view ：已保存密钥，显示脱敏 + [编辑][复制]
 *  - edit ：编辑中，显示输入框 + [取消]
 */
type ApiKeyBoxMode = 'empty' | 'view' | 'edit';

function setApiKeyBoxMode(overlay: HTMLElement, mode: ApiKeyBoxMode) {
  const box = overlay.querySelector('.settings-apikey-box') as HTMLElement | null;
  if (!box) return;
  box.dataset.mode = mode;
  const input = box.querySelector('input[name="apiKey"]') as HTMLInputElement | null;
  const display = box.querySelector('.settings-apikey-display') as HTMLElement | null;
  const editBtn = box.querySelector('[data-action="edit"]') as HTMLButtonElement | null;
  const copyBtn = box.querySelector('[data-action="copy"]') as HTMLButtonElement | null;
  const cancelBtn = box.querySelector('[data-action="cancel"]') as HTMLButtonElement | null;

  if (display) display.hidden = mode !== 'view';
  if (input) input.hidden = mode === 'view';
  if (editBtn) editBtn.hidden = mode !== 'view';
  if (copyBtn) copyBtn.hidden = mode !== 'view';
  if (cancelBtn) cancelBtn.hidden = mode !== 'edit';
}

/** 重置 API Key 输入框（清空输入与缓存的明文），常用于切换 profile 时。 */
function resetApiKeyBox(overlay: HTMLElement) {
  const box = overlay.querySelector('.settings-apikey-box') as HTMLElement | null;
  if (!box) return;
  const valueEl = box.querySelector('.settings-apikey-display-value') as HTMLElement | null;
  if (valueEl) {
    valueEl.textContent = '';
    delete valueEl.dataset.full;
    delete valueEl.dataset.masked;
  }
  const input = box.querySelector('input[name="apiKey"]') as HTMLInputElement | null;
  if (input) input.value = '';
  setApiKeyBoxMode(overlay, 'empty');
}

/** 根据 profile 拉取明文密钥并展示首尾脱敏。无密钥则保持「输入」模式。 */
async function loadApiKeyPreview(overlay: HTMLElement, profileId: string | null) {
  resetApiKeyBox(overlay);
  if (!profileId || profileId === OFFICIAL_PROFILE_ID) return;
  try {
    const key = await invoke<string>('get_api_profile_key', { profileId });
    const trimmed = (key || '').trim();
    if (!trimmed) return;
    // 异步加载期间用户可能已经切换到别的 profile，丢弃陈旧结果。
    if (overlay.dataset.profileId !== profileId) return;
    const valueEl = overlay.querySelector('.settings-apikey-display-value') as HTMLElement | null;
    if (!valueEl) return;
    valueEl.dataset.full = trimmed;
    valueEl.dataset.masked = maskApiKey(trimmed);
    valueEl.textContent = valueEl.dataset.masked;
    setApiKeyBoxMode(overlay, 'view');
  } catch {
    /* keep empty mode */
  }
}

function fillSettingsForm(
  overlay: HTMLElement,
  config: ClaudeCodeApiConfig,
  profileName = '',
  profileId: string | null = null,
) {
  setSettingsFormEditable(overlay, true);
  overlay.dataset.profileId = profileId || '';
  (overlay.querySelector('input[name="profileName"]') as HTMLInputElement).value = profileName;
  const baseInput = overlay.querySelector('input[name="baseUrl"]') as HTMLInputElement;
  baseInput.value = config.baseUrl || '';
  baseInput.placeholder = 'https://api.anthropic.com';

  const apiKeyInput = overlay.querySelector('input[name="apiKey"]') as HTMLInputElement;
  apiKeyInput.value = '';
  apiKeyInput.placeholder = config.hasApiKey ? '已配置，留空则不修改' : 'sk-...';

  if (profileId && config.hasApiKey) {
    void loadApiKeyPreview(overlay, profileId);
  } else {
    resetApiKeyBox(overlay);
  }
}

async function refreshSettingsModal(
  overlay: HTMLElement,
  selectedProfileId: string | null,
  onConfigLoaded?: (config: ClaudeCodeApiConfig) => void,
) {
  const state = await invoke<ApiProfilesState>('get_api_profiles_state');

  // 官方默认处于使用中（无指定 profile 且无激活 profile）：展示只读官方视图，
  // 不要回退到第一个 API 配置，否则会把别的配置的模型/详情显示成「官方默认」
  const officialActive = !selectedProfileId && !state.activeProfileId;
  if (officialActive) {
    const listEl = getSettingsProfileListEl();
    if (listEl) {
      listEl.innerHTML = renderSettingsProfileList(state.profiles, OFFICIAL_PROFILE_ID);
    }
    fillOfficialView(overlay);
    // 复用 onConfigLoaded 清空遗留的模型缓存（官方无 Base URL，不会触发拉取）
    onConfigLoaded?.(state.current);
    return { state, selectedProfileId: OFFICIAL_PROFILE_ID };
  }

  const resolvedSelectedId =
    selectedProfileId ||
    state.activeProfileId ||
    state.profiles.find((profile) => profile.isActive)?.id ||
    state.profiles[0]?.id ||
    null;

  const listEl = getSettingsProfileListEl();
  if (listEl) {
    listEl.innerHTML = renderSettingsProfileList(state.profiles, resolvedSelectedId);
  }

  let config = state.current;
  let profileName = '';

  if (resolvedSelectedId) {
    const selected = state.profiles.find((profile) => profile.id === resolvedSelectedId);
    if (selected) {
      profileName = selected.name;
      config = await invoke<ClaudeCodeApiConfig>('get_api_profile_config', {
        profileId: resolvedSelectedId,
      });
    }
  }

  fillSettingsForm(overlay, config, profileName, resolvedSelectedId);
  onConfigLoaded?.(config);
  return { state, selectedProfileId: resolvedSelectedId };
}

function openApiConfigView() {
  if (isApiConfigViewActive) return;
  // 配置列表在左侧栏，收起时先展开以免看不见
  if (isSidebarCollapsed) {
    setSidebarCollapsed(false);
  }
  isApiConfigViewActive = true;
  render();
}

/** 退出 API 配置页状态（不触发 render，供即将全量重绘的路径使用） */
function dismissApiConfigViewState() {
  if (!isApiConfigViewActive && !apiConfigEscapeHandler) return;
  if (apiConfigEscapeHandler) {
    document.removeEventListener('keydown', apiConfigEscapeHandler);
    apiConfigEscapeHandler = null;
  }
  apiConfigMountToken += 1;
  closeProfileContextMenu();
  document.querySelector('.model-picker-overlay')?.remove();
  isApiConfigViewActive = false;
}

function closeApiConfigView() {
  if (!isApiConfigViewActive) {
    dismissApiConfigViewState();
    return;
  }
  dismissApiConfigViewState();
  render();
  void loadChatModelOptions();
  if (!activeConversationId) {
    void refreshModelInfo();
  }
}

async function mountApiConfigView() {
  const overlay = document.querySelector('#api-config-view') as HTMLElement | null;
  if (!overlay || !isApiConfigViewActive) return;

  const mountToken = ++apiConfigMountToken;
  const isMountCurrent = () => mountToken === apiConfigMountToken && isApiConfigViewActive;

  const close = () => {
    closeApiConfigView();
  };

  const onEscapeKey = (event: KeyboardEvent) => {
    if (event.key !== 'Escape') return;
    if (!isMountCurrent()) return;

    const modelPicker = document.querySelector('.model-picker-overlay');
    if (modelPicker) {
      modelPicker.remove();
      event.preventDefault();
      return;
    }

    if (document.querySelector('.confirm-overlay')) {
      return;
    }

    if (document.querySelector('.profile-context-menu-overlay')) {
      closeProfileContextMenu();
      event.preventDefault();
      return;
    }

    event.preventDefault();
    close();
  };

  if (apiConfigEscapeHandler) {
    document.removeEventListener('keydown', apiConfigEscapeHandler);
  }
  apiConfigEscapeHandler = onEscapeKey;
  document.addEventListener('keydown', onEscapeKey);
  const livePathEl = overlay.querySelector('.settings-live-path') as HTMLElement | null;
  let fetchedModels: FetchedModel[] = [];
  let modelsFetchKey = '';
  let modelsFetchInFlight = 0;
  let refreshOpenModelPicker: (() => void) | null = null;
  /** 空数组表示展示 API 拉取到的全部模型 */
  let displayModels: string[] = [];
  let customModels: string[] = [];

  const isModelsLoading = (): boolean => modelsFetchInFlight > 0;

  const setModelsLoading = (loading: boolean) => {
    modelsFetchInFlight = loading
      ? modelsFetchInFlight + 1
      : Math.max(0, modelsFetchInFlight - 1);
    updateModelConfigSummary();
    refreshOpenModelPicker?.();
  };

  const renderModelsLoadingState = (
    listEl: Element,
    message = '正在从 API 获取模型列表…',
    subMessage = '请稍候，这可能需要几秒钟',
  ) => {
    listEl.innerHTML = `
      <div class="model-picker-loading">
        <div class="model-picker-loading-dots" aria-hidden="true">
          <span class="pending-dot"></span>
          <span class="pending-dot"></span>
          <span class="pending-dot"></span>
        </div>
        <div class="model-picker-loading-copy">
          <span class="model-picker-loading-text">${escapeHtml(message)}</span>
          <span class="model-picker-loading-subtext">${escapeHtml(subMessage)}</span>
        </div>
      </div>
    `;
  };

  const usesAllFetchedModels = (): boolean => displayModels.length === 0;

  const getFetchedModelIds = (): Set<string> => new Set(fetchedModels.map((model) => model.id));

  const getApiDisplayModels = (): string[] => {
    if (displayModels.length > 0) {
      return [...displayModels];
    }
    return fetchedModels.map((model) => model.id);
  };

  const getEffectiveDisplayModels = (): string[] => {
    const merged = [...getApiDisplayModels()];
    for (const modelId of customModels) {
      if (!merged.includes(modelId)) {
        merged.push(modelId);
      }
    }
    return merged;
  };

  const splitDraftModels = (draft: string[]) => {
    const fetchedIds = getFetchedModelIds();
    return {
      apiModels: draft.filter((modelId) => fetchedIds.has(modelId)),
      customInDraft: draft.filter((modelId) => !fetchedIds.has(modelId)),
    };
  };

  const updateModelConfigSummary = () => {
    const input = overlay.querySelector('.settings-model-config-summary') as HTMLInputElement | null;
    const hintEl = overlay.querySelector('.settings-model-config-hint');
    if (!input) return;

    // 官方默认只读：模型由订阅 / 官方登录决定，不展示 API 模型数量
    // （防止上一个配置遗留的异步取模型完成后把官方详情覆盖成「API N 个」）
    if (overlay.dataset.profileId === OFFICIAL_PROFILE_ID) {
      input.classList.remove('is-loading');
      input.value = '由订阅 / 官方登录决定';
      if (hintEl) hintEl.textContent = '官方默认模型由 Claude 订阅 / 官方登录决定';
      return;
    }

    if (isModelsLoading()) {
      input.value = '正在从 API 获取模型列表…';
      input.placeholder = '';
      input.classList.add('is-loading');
      if (hintEl) {
        hintEl.textContent = '请稍候，正在连接 API 并加载可用模型';
      }
      return;
    }

    input.classList.remove('is-loading');
    const ids = getEffectiveDisplayModels();

    if (ids.length === 0) {
      input.value = '';
      input.placeholder = '点击配置模型';
    } else {
      const displayPart = usesAllFetchedModels()
        ? `API ${getApiDisplayModels().length} 个`
        : `API ${displayModels.length} 个`;
      const customPart = customModels.length > 0 ? ` · 自定义 ${customModels.length} 个` : '';
      input.value = `${displayPart}${customPart}`;
    }

    if (hintEl) {
      hintEl.textContent = '配置展示模型与自定义模型列表，点击输入框管理';
    }
  };

  const normalizeDisplayModelsForSave = (models: string[]): string[] => {
    if (models.length === 0) {
      return [];
    }

    const fetchedIds = fetchedModels.map((model) => model.id);
    if (fetchedIds.length === 0) {
      return models;
    }

    const modelSet = new Set(models);
    const isSameAsAllFetched =
      models.length === fetchedIds.length && fetchedIds.every((id) => modelSet.has(id));
    return isSameAsAllFetched ? [] : models;
  };

  const setModelConfigFromConfig = (
    display: string[] | undefined,
    custom: string[] | undefined,
  ) => {
    displayModels = [...(display || [])];
    customModels = [...(custom || [])];
    updateModelConfigSummary();
  };

  const tryAutoFetchDisplayModels = async () => {
    const baseUrl =
      (overlay.querySelector('input[name="baseUrl"]') as HTMLInputElement | null)?.value.trim() || '';
    if (!baseUrl) {
      updateModelConfigSummary();
      return;
    }

    if (fetchedModels.length > 0 && modelsFetchKey === getModelsFetchKey()) {
      updateModelConfigSummary();
      return;
    }

    try {
      await fetchModelsForSettings();
    } catch {
      // 无 Key 或网络失败时仍展示已保存的自定义列表
    }
    updateModelConfigSummary();
  };

  const handleProfileConfigLoaded = (config: ClaudeCodeApiConfig) => {
    fetchedModels = [];
    modelsFetchKey = '';
    setModelConfigFromConfig(config.displayModels, config.customModels);
    void tryAutoFetchDisplayModels();
  };

  const getModelsFetchKey = (): string => {
    const baseUrl =
      (overlay.querySelector('input[name="baseUrl"]') as HTMLInputElement | null)?.value.trim() || '';
    const apiKeyRaw =
      (overlay.querySelector('input[name="apiKey"]') as HTMLInputElement | null)?.value.trim() || '';
    const profileId = overlay.dataset.profileId || '';
    return `${baseUrl}|${profileId}|${apiKeyRaw}`;
  };

  const fetchModelsForSettings = async (): Promise<FetchedModel[]> => {
    const baseUrl = (overlay.querySelector('input[name="baseUrl"]') as HTMLInputElement | null)?.value.trim() || '';
    const apiKeyRaw = (overlay.querySelector('input[name="apiKey"]') as HTMLInputElement | null)?.value.trim();
    const profileId = overlay.dataset.profileId || null;

    if (!baseUrl) {
      throw new Error('请先填写 API Base URL');
    }

    setModelsLoading(true);
    try {
      fetchedModels = await invoke<FetchedModel[]>('fetch_api_models', {
        baseUrl,
        apiKey: apiKeyRaw || null,
        profileId,
      });
      modelsFetchKey = getModelsFetchKey();
      return fetchedModels;
    } finally {
      setModelsLoading(false);
    }
  };

  const saveModelConfigImmediately = async (modelsToSave: {
    display: string[];
    custom: string[];
  }): Promise<boolean> => {
    displayModels = normalizeDisplayModelsForSave(modelsToSave.display);
    customModels = [...modelsToSave.custom];
    updateModelConfigSummary();

    const form = overlay.querySelector('#settings-form') as HTMLFormElement | null;
    if (!form) return false;

    const formData = new FormData(form);
    const profileName = String(formData.get('profileName') || '').trim();
    if (!profileName) {
      alert('请先填写配置名称');
      return false;
    }

    const profileId = overlay.dataset.profileId || null;
    const apiKeyRaw = String(formData.get('apiKey') || '').trim();

    try {
      const result = await invoke<ApiProfilesState>('upsert_api_profile', {
        profileId: profileId || null,
        name: profileName,
        config: {
          baseUrl: String(formData.get('baseUrl') || '').trim(),
          apiKey: apiKeyRaw || null,
          defaultModel: '',
          haikuModel: '',
          sonnetModel: '',
          opusModel: '',
          displayModels: [...displayModels],
          customModels: [...customModels],
        },
        apply: false,
      });

      const savedProfileId =
        profileId ||
        result.profiles.find((profile) => profile.name === profileName)?.id ||
        result.activeProfileId ||
        null;

      if (savedProfileId) {
        overlay.dataset.profileId = savedProfileId;
      }

      await loadChatModelOptions();
      return true;
    } catch (e) {
      console.error('保存模型配置失败:', e);
      alert('保存模型配置失败: ' + String(e));
      return false;
    }
  };

  const openModelConfigDialog = () => {
    if (document.querySelector('.model-picker-overlay')) {
      return;
    }

    let draftModels = [...getEffectiveDisplayModels()];
    let bulkSelectedModels = new Set<string>();

    const getSearchQuery = (): string =>
      (
        pickerOverlay.querySelector('.display-models-picker-search') as HTMLInputElement | null
      )?.value
        .trim()
        .toLowerCase() || '';

    const filterModelIds = (modelIds: string[]): string[] => {
      const query = getSearchQuery();
      if (!query) {
        return modelIds;
      }
      return modelIds.filter((modelId) => modelId.toLowerCase().includes(query));
    };

    const getAllFilteredModelIds = (): string[] => filterModelIds(draftModels);

    const getFilterEmptyText = (defaultText: string): string =>
      getSearchQuery() ? '无匹配模型' : defaultText;

    const renderBulkBar = () => {
      const bar = pickerOverlay.querySelector('.display-models-picker-bulk');
      if (!bar) {
        return;
      }

      const query = getSearchQuery();
      const filtered = getAllFilteredModelIds();
      if (!query) {
        bar.classList.add('is-hidden');
        bulkSelectedModels.clear();
        return;
      }

      bar.classList.remove('is-hidden');
      const countEl = bar.querySelector('.display-models-bulk-count');
      const checkbox = bar.querySelector('.display-models-bulk-checkbox') as HTMLInputElement | null;
      const removeBtn = bar.querySelector('.display-models-bulk-remove') as HTMLButtonElement | null;

      if (countEl) {
        countEl.textContent = String(filtered.length);
      }

      const allSelected =
        filtered.length > 0 && filtered.every((modelId) => bulkSelectedModels.has(modelId));
      const someSelected = filtered.some((modelId) => bulkSelectedModels.has(modelId));

      if (checkbox) {
        checkbox.checked = allSelected;
        checkbox.indeterminate = !allSelected && someSelected;
      }

      if (removeBtn) {
        removeBtn.disabled = bulkSelectedModels.size === 0;
        removeBtn.textContent =
          bulkSelectedModels.size > 0
            ? `移除已选 (${bulkSelectedModels.size})`
            : '移除已选';
      }
    };

    const pickerOverlay = document.createElement('div');
    pickerOverlay.className = 'model-picker-overlay display-models-picker-overlay';
    pickerOverlay.innerHTML = `
      <div class="model-picker-dialog display-models-picker-dialog" role="dialog" aria-modal="true">
        <div class="model-picker-header">
          <h4 class="model-picker-title">模型配置</h4>
          <button type="button" class="model-picker-close" aria-label="关闭">✕</button>
        </div>
        <div class="display-models-picker-toolbar">
          <input
            type="search"
            class="model-picker-search display-models-picker-search"
            placeholder="搜索模型，可全选批量移除"
          />
          <button type="button" class="display-models-picker-sync">同步 API</button>
        </div>
        <div class="display-models-picker-bulk is-hidden">
          <label class="display-models-bulk-select-all">
            <input type="checkbox" class="display-models-bulk-checkbox" />
            <span>全选 (<span class="display-models-bulk-count">0</span>)</span>
          </label>
          <button type="button" class="display-models-bulk-remove" disabled>移除已选</button>
        </div>
        <div class="display-models-picker-section">
          <span class="display-models-picker-section-title">展示模型</span>
          <div class="display-models-api-list"></div>
        </div>
        <div class="display-models-picker-section">
          <span class="display-models-picker-section-title">自定义模型</span>
          <div class="display-models-custom-add">
            <input
              type="text"
              class="display-models-custom-add-input"
              placeholder="输入自定义模型名"
              autocomplete="off"
            />
            <button type="button" class="display-models-custom-add-btn">添加</button>
          </div>
          <div class="display-models-custom-list"></div>
        </div>
        <p class="model-picker-tip">展示模型来自 API 同步；自定义模型需手动添加，操作后立即保存</p>
      </div>
    `;

    const closePicker = () => {
      if (refreshOpenModelPicker === renderDialog) {
        refreshOpenModelPicker = null;
      }
      pickerOverlay.remove();
    };

    const persistDraft = async (): Promise<boolean> => {
      const { apiModels, customInDraft } = splitDraftModels(draftModels);
      return saveModelConfigImmediately({
        display: apiModels,
        custom: customInDraft,
      });
    };

    const renderModelRows = (
      listEl: Element,
      modelIds: string[],
      emptyText: string,
    ) => {
      const filteredIds = filterModelIds(modelIds);
      if (filteredIds.length === 0) {
        listEl.innerHTML = `<div class="model-picker-empty">${escapeHtml(getFilterEmptyText(emptyText))}</div>`;
        return;
      }

      const showBulk = !!getSearchQuery();
      const fetchedById = new Map(fetchedModels.map((model) => [model.id, model]));
      listEl.innerHTML = filteredIds
        .map((modelId) => {
          const fetched = fetchedById.get(modelId);
          const isSelected = bulkSelectedModels.has(modelId);
          return `
            <div class="display-models-row${isSelected ? ' is-selected' : ''}" data-model-id="${escapeHtml(modelId)}">
              ${showBulk
                ? `
                <label class="display-models-row-check">
                  <input type="checkbox" data-action="toggle-select" ${isSelected ? 'checked' : ''} aria-label="选择 ${escapeHtml(modelId)}" />
                </label>
              `
                : ''}
              <div class="display-models-row-main">
                <span class="display-models-row-id">${escapeHtml(modelId)}</span>
                ${fetched?.ownedBy ? `<span class="display-models-row-owner">${escapeHtml(fetched.ownedBy)}</span>` : ''}
              </div>
              <div class="display-models-row-actions">
                <button type="button" class="display-models-row-btn display-models-row-btn-danger" data-action="delete">删除</button>
              </div>
            </div>
          `;
        })
        .join('');
    };

    const renderApiModelsList = () => {
      const listEl = pickerOverlay.querySelector('.display-models-api-list');
      if (!listEl) return;

      if (isModelsLoading() && fetchedModels.length === 0) {
        renderModelsLoadingState(listEl);
        return;
      }

      const fetchedIds = getFetchedModelIds();
      const apiModelIds = draftModels.filter((modelId) => fetchedIds.has(modelId));
      renderModelRows(
        listEl,
        apiModelIds,
        fetchedModels.length === 0 ? '暂无 API 模型，请点击右上角「同步 API」' : '暂无 API 展示模型，请同步 API',
      );
    };

    const renderCustomModelsList = () => {
      const listEl = pickerOverlay.querySelector('.display-models-custom-list');
      if (!listEl) return;

      const fetchedIds = getFetchedModelIds();
      const customModelIds = draftModels.filter((modelId) => !fetchedIds.has(modelId));
      renderModelRows(listEl, customModelIds, '暂无自定义模型');
    };

    const submitCustomModelAdd = async () => {
      const addInput = pickerOverlay.querySelector(
        '.display-models-custom-add-input',
      ) as HTMLInputElement | null;
      const modelId = addInput?.value.trim() || '';
      if (!modelId) {
        addInput?.focus();
        return;
      }

      if (draftModels.includes(modelId)) {
        alert('该模型已存在');
        addInput?.focus();
        return;
      }

      await addDraftModel(modelId);
      if (addInput) {
        addInput.value = '';
        addInput.focus();
      }
    };

    const renderDialog = () => {
      renderApiModelsList();
      renderCustomModelsList();
      renderBulkBar();
    };

    const addDraftModel = async (modelId: string) => {
      const trimmed = modelId.trim();
      if (!trimmed || draftModels.includes(trimmed)) return;
      draftModels = [...draftModels, trimmed];
      renderDialog();
      await persistDraft();
    };

    const deleteDraftModels = async (modelIds: string[]) => {
      if (modelIds.length === 0) {
        return;
      }

      const toDelete = new Set(modelIds);
      draftModels = draftModels.filter((id) => !toDelete.has(id));
      bulkSelectedModels.clear();
      renderDialog();

      await persistDraft();
    };

    const deleteDraftModel = async (modelId: string) => {
      await deleteDraftModels([modelId]);
    };

    const mergeDraftWithApiModels = (apiModelIds: string[]) => {
      const customPart = draftModels.filter((modelId) => !getFetchedModelIds().has(modelId));
      draftModels = [...apiModelIds, ...customPart];
    };

    pickerOverlay.querySelector('.model-picker-close')?.addEventListener('click', closePicker);
    pickerOverlay.addEventListener('click', (event) => {
      if (event.target === pickerOverlay) closePicker();
    });

    pickerOverlay.querySelector('.display-models-picker-sync')?.addEventListener('click', async () => {
      const syncBtn = pickerOverlay.querySelector('.display-models-picker-sync') as HTMLButtonElement | null;
      if (syncBtn) {
        syncBtn.disabled = true;
        syncBtn.textContent = '正在同步…';
      }

      try {
        await fetchModelsForSettings();
        mergeDraftWithApiModels(fetchedModels.map((model) => model.id));
        renderDialog();
        await persistDraft();
      } catch (e) {
        alert('同步模型失败: ' + String(e));
      } finally {
        if (syncBtn) {
          syncBtn.disabled = false;
          syncBtn.textContent = '同步 API';
        }
      }
    });

    pickerOverlay.querySelector('.display-models-picker-search')?.addEventListener('input', () => {
      const filtered = new Set(getAllFilteredModelIds());
      bulkSelectedModels = new Set(
        [...bulkSelectedModels].filter((modelId) => filtered.has(modelId)),
      );
      renderDialog();
    });

    pickerOverlay.querySelector('.display-models-custom-add-btn')?.addEventListener('click', () => {
      void submitCustomModelAdd();
    });

    pickerOverlay.querySelector('.display-models-custom-add-input')?.addEventListener('keydown', (event) => {
      const keyboardEvent = event as KeyboardEvent;
      if (keyboardEvent.key !== 'Enter') {
        return;
      }
      keyboardEvent.preventDefault();
      void submitCustomModelAdd();
    });

    pickerOverlay.querySelector('.display-models-bulk-checkbox')?.addEventListener('change', (event) => {
      const checkbox = event.target as HTMLInputElement;
      const filtered = getAllFilteredModelIds();
      if (checkbox.checked) {
        bulkSelectedModels = new Set(filtered);
      } else {
        bulkSelectedModels.clear();
      }
      renderDialog();
    });

    pickerOverlay.querySelector('.display-models-bulk-remove')?.addEventListener('click', () => {
      if (bulkSelectedModels.size === 0) {
        return;
      }
      void deleteDraftModels([...bulkSelectedModels]);
    });

    const handleModelRowCheckbox = (event: Event) => {
      const checkbox = event.target as HTMLInputElement;
      if (checkbox.dataset.action !== 'toggle-select') {
        return;
      }

      const row = checkbox.closest('.display-models-row') as HTMLElement | null;
      const modelId = row?.dataset.modelId;
      if (!modelId) {
        return;
      }

      if (checkbox.checked) {
        bulkSelectedModels.add(modelId);
      } else {
        bulkSelectedModels.delete(modelId);
      }
      renderDialog();
    };

    const handleModelRowAction = (event: Event) => {
      const target = event.target as HTMLElement;
      const actionEl = target.closest('[data-action]') as HTMLElement | null;
      const row = target.closest('.display-models-row') as HTMLElement | null;
      const modelId = row?.dataset.modelId;
      if (!actionEl || !modelId) return;

      const action = actionEl.dataset.action;
      if (action === 'toggle-select') {
        return;
      }
      if (action === 'delete') {
        void deleteDraftModel(modelId);
      }
    };

    pickerOverlay.querySelector('.display-models-api-list')?.addEventListener('change', handleModelRowCheckbox);
    pickerOverlay.querySelector('.display-models-custom-list')?.addEventListener('change', handleModelRowCheckbox);
    pickerOverlay.querySelector('.display-models-api-list')?.addEventListener('click', handleModelRowAction);
    pickerOverlay.querySelector('.display-models-custom-list')?.addEventListener('click', handleModelRowAction);

    document.body.appendChild(pickerOverlay);
    refreshOpenModelPicker = renderDialog;
    renderDialog();

    const baseUrl =
      (overlay.querySelector('input[name="baseUrl"]') as HTMLInputElement | null)?.value.trim() || '';
    if (baseUrl && (fetchedModels.length === 0 || modelsFetchKey !== getModelsFetchKey())) {
      void (async () => {
        const syncBtn = pickerOverlay.querySelector('.display-models-picker-sync') as HTMLButtonElement | null;
        if (syncBtn) {
          syncBtn.disabled = true;
          syncBtn.textContent = '正在同步…';
        }
        try {
          await fetchModelsForSettings();
          if (draftModels.length === 0) {
            mergeDraftWithApiModels(fetchedModels.map((model) => model.id));
          }
          renderDialog();
        } catch {
          const listEl = pickerOverlay.querySelector('.display-models-api-list');
          if (listEl && fetchedModels.length === 0) {
            listEl.innerHTML = `<div class="model-picker-empty">未能自动加载模型，请点击右上角「同步 API」重试</div>`;
          }
        } finally {
          if (syncBtn) {
            syncBtn.disabled = false;
            syncBtn.textContent = '同步 API';
          }
        }
      })();
    }

    const searchInput = pickerOverlay.querySelector('.display-models-picker-search') as HTMLInputElement | null;
    searchInput?.focus();
  };

  const bindModelConfigEvents = () => {
    overlay.querySelector('.settings-model-config-summary')?.addEventListener('click', () => {
      // 官方默认为只读，模型由订阅 / 官方登录决定，不打开模型配置
      if (overlay.dataset.profileId === OFFICIAL_PROFILE_ID) return;
      openModelConfigDialog();
    });
  };

  const bindProfileListEvents = () => {
    const list = getSettingsProfileListEl();
    if (!list || list.dataset.bound === 'true') {
      return;
    }
    list.dataset.bound = 'true';

    const applyProfile = async (profileId: string) => {
      try {
        await invoke('switch_api_profile', { profileId });
        await refreshSettingsModal(overlay, profileId, handleProfileConfigLoaded);
        if (livePathEl) {
          const state = await invoke<ApiProfilesState>('get_api_profiles_state');
          livePathEl.textContent = `配置文件：${state.current.configPath}`;
        }
        await loadChatModelOptions();
      } catch (e) {
        alert('应用 API 配置失败: ' + String(e));
      }
    };

    const deleteProfile = async (profileId: string, profileName: string) => {
      const confirmed = await showConfirmDialog({
        title: '删除配置',
        message: `确定要删除配置「${escapeHtml(profileName)}」吗？`,
        sub: '删除后无法恢复；若正在使用该配置，将自动切换到其他配置。',
        confirmLabel: '删除',
      });
      if (!confirmed) return;

      try {
        await invoke('delete_api_profile', { profileId });
        const refreshed = await refreshSettingsModal(overlay, null, handleProfileConfigLoaded);
        if (livePathEl) {
          livePathEl.textContent = `配置文件：${refreshed.state.current.configPath}`;
        }
      } catch (e) {
        alert('删除配置失败: ' + String(e));
      }
    };

    const applyOfficial = async () => {
      try {
        await invoke('use_official_api');
        await refreshSettingsModal(overlay, null, handleProfileConfigLoaded);
        if (livePathEl) {
          const state = await invoke<ApiProfilesState>('get_api_profiles_state');
          livePathEl.textContent = `配置文件：${state.current.configPath}`;
        }
        await loadChatModelOptions();
      } catch (e) {
        alert('切换到官方默认失败: ' + String(e));
      }
    };

    list.addEventListener('click', async (event) => {
      const target = event.target as HTMLElement;
      if (target.closest('.settings-profile-official')) {
        // 左键查看官方默认只读详情（应用走「应用」按钮 / 右键）
        try {
          const state = await invoke<ApiProfilesState>('get_api_profiles_state');
          list.innerHTML = renderSettingsProfileList(state.profiles, OFFICIAL_PROFILE_ID);
        } catch {
          /* 列表刷新失败不影响查看 */
        }
        // 清空上一个配置遗留的模型缓存，避免官方详情里看到别的配置的模型
        fetchedModels = [];
        modelsFetchKey = '';
        displayModels = [];
        customModels = [];
        fillOfficialView(overlay);
        return;
      }

      const item = target.closest('.settings-profile-item') as HTMLElement | null;
      if (!item) return;

      const profileId = item.dataset.profileId;
      if (!profileId) return;

      try {
        await refreshSettingsModal(overlay, profileId, handleProfileConfigLoaded);
      } catch (e) {
        alert('加载 API 配置失败: ' + String(e));
      }
    });

    list.addEventListener('contextmenu', (event) => {
      const target = event.target as HTMLElement;

      const official = target.closest('.settings-profile-official') as HTMLElement | null;
      if (official) {
        event.preventDefault();
        event.stopPropagation();
        showProfileContextMenu({
          x: event.clientX,
          y: event.clientY,
          profileId: OFFICIAL_PROFILE_ID,
          profileName: '官方默认',
          isActive: official.classList.contains('active'),
          allowDelete: false,
          onApply: () => applyOfficial(),
          onDelete: () => {},
        });
        return;
      }

      const item = target.closest('.settings-profile-item') as HTMLElement | null;
      if (!item) return;

      const profileId = item.dataset.profileId;
      if (!profileId) return;

      event.preventDefault();
      event.stopPropagation();

      const profileName =
        item.querySelector('.settings-profile-name')?.textContent?.trim() || '此配置';
      const isActive = item.classList.contains('active');

      showProfileContextMenu({
        x: event.clientX,
        y: event.clientY,
        profileId,
        profileName,
        isActive,
        onApply: () => applyProfile(profileId),
        onDelete: () => deleteProfile(profileId, profileName),
      });
    });

    list.addEventListener('keydown', (event) => {
      if (event.key !== 'Enter' && event.key !== ' ') return;
      const target = event.target as HTMLElement;
      const item = target.closest('.settings-profile-item') as HTMLElement | null;
      if (!item) return;
      event.preventDefault();
      item.click();
    });
  };

  overlay.querySelector('.settings-close-btn')?.addEventListener('click', close);
  overlay.querySelector('.settings-close-footer')?.addEventListener('click', close);

  // API Key 单框：编辑 / 取消 / 复制
  const apiKeyBox = overlay.querySelector('.settings-apikey-box') as HTMLElement | null;
  apiKeyBox?.addEventListener('click', async (event) => {
    const target = (event.target as HTMLElement | null)?.closest('[data-action]') as HTMLButtonElement | null;
    if (!target) return;
    event.preventDefault();
    const action = target.dataset.action;
    const input = apiKeyBox.querySelector('input[name="apiKey"]') as HTMLInputElement | null;
    const valueEl = apiKeyBox.querySelector('.settings-apikey-display-value') as HTMLElement | null;
    const fullKey = valueEl?.dataset.full || '';

    if (action === 'edit') {
      setApiKeyBoxMode(overlay, 'edit');
      if (input) {
        input.value = '';
        input.placeholder = fullKey ? '已配置，留空则不修改' : 'sk-...';
        input.focus();
      }
    } else if (action === 'cancel') {
      if (input) input.value = '';
      setApiKeyBoxMode(overlay, fullKey ? 'view' : 'empty');
    } else if (action === 'copy') {
      if (!fullKey) return;
      const ok = await copyTextToClipboard(fullKey);
      showCopyToastMsg(ok ? '已复制密钥' : '复制失败');
    }
  });

  const saveApiProfile = async () => {
    const form = overlay.querySelector('#settings-form') as HTMLFormElement | null;
    if (!form) return;

    const formData = new FormData(form);
    const apiKeyRaw = String(formData.get('apiKey') || '').trim();
    const profileId = overlay.dataset.profileId || null;
    const profileName = String(formData.get('profileName') || '').trim();
    const saveBtn = overlay.querySelector('.save-only') as HTMLButtonElement | null;

    if (!profileName) {
      if (saveBtn) {
        saveBtn.textContent = '请填写配置名称';
        window.setTimeout(() => {
          if (saveBtn.textContent === '请填写配置名称') {
            saveBtn.textContent = '保存';
          }
        }, 2000);
      }
      (overlay.querySelector('input[name="profileName"]') as HTMLInputElement | null)?.focus();
      return;
    }

    if (saveBtn) {
      saveBtn.disabled = true;
      saveBtn.textContent = '保存中...';
    }

    try {
      const displayModelsToSave = [...displayModels];
      const customModelsToSave = [...customModels];
      const result = await invoke<ApiProfilesState>('upsert_api_profile', {
        profileId: profileId || null,
        name: profileName,
        config: {
          baseUrl: String(formData.get('baseUrl') || '').trim(),
          apiKey: apiKeyRaw || null,
          defaultModel: '',
          haikuModel: '',
          sonnetModel: '',
          opusModel: '',
          displayModels: displayModelsToSave,
          customModels: customModelsToSave,
        },
        apply: false,
      });

      const savedProfileId =
        profileId ||
        result.profiles.find((profile) => profile.name === profileName)?.id ||
        result.activeProfileId ||
        null;

      await refreshSettingsModal(overlay, savedProfileId, handleProfileConfigLoaded);
      await loadChatModelOptions();

      if (saveBtn) {
        saveBtn.textContent = '已保存';
        window.setTimeout(() => {
          if (saveBtn.textContent === '已保存') {
            saveBtn.textContent = '保存';
          }
        }, 1500);
      }
    } catch (e) {
      console.error('保存 API 配置失败:', e);
      if (saveBtn) {
        saveBtn.textContent = '保存失败';
        window.setTimeout(() => {
          if (saveBtn.textContent === '保存失败') {
            saveBtn.textContent = '保存';
          }
        }, 2000);
      }
    } finally {
      if (saveBtn) {
        saveBtn.disabled = false;
      }
    }
  };

  overlay.querySelector('.save-only')?.addEventListener('click', () => {
    void saveApiProfile();
  });

  overlay.querySelector('.settings-apply-profile')?.addEventListener('click', async () => {
    const applyBtn = overlay.querySelector('.settings-apply-profile') as HTMLButtonElement | null;
    const profileId = overlay.dataset.profileId || null;
    if (!profileId) {
      if (applyBtn) {
        applyBtn.textContent = '请先选择配置';
        window.setTimeout(() => {
          if (applyBtn.textContent === '请先选择配置') applyBtn.textContent = '应用';
        }, 1800);
      }
      return;
    }
    if (applyBtn) {
      applyBtn.disabled = true;
      applyBtn.textContent = '应用中...';
    }
    try {
      if (profileId === OFFICIAL_PROFILE_ID) {
        await invoke('use_official_api');
        await refreshSettingsModal(overlay, null, handleProfileConfigLoaded);
      } else {
        await invoke('switch_api_profile', { profileId });
        await refreshSettingsModal(overlay, profileId, handleProfileConfigLoaded);
      }
      if (livePathEl) {
        const state = await invoke<ApiProfilesState>('get_api_profiles_state');
        livePathEl.textContent = `配置文件：${state.current.configPath}`;
      }
      await loadChatModelOptions();
      if (applyBtn) {
        applyBtn.textContent = '已应用';
        window.setTimeout(() => {
          if (applyBtn.textContent === '已应用') applyBtn.textContent = '应用';
        }, 1500);
      }
    } catch (e) {
      alert('应用 API 配置失败: ' + String(e));
      if (applyBtn) applyBtn.textContent = '应用';
    } finally {
      if (applyBtn) applyBtn.disabled = false;
    }
  });

  document.querySelector('.settings-add-profile')?.addEventListener('click', () => {
    fillSettingsForm(
      overlay,
      {
        baseUrl: '',
        hasApiKey: false,
        defaultModel: '',
        haikuModel: '',
        sonnetModel: '',
        opusModel: '',
        displayModels: [],
        customModels: [],
        configPath: '',
      },
      '',
      null,
    );
    document.querySelectorAll('.settings-profile-item').forEach((item) => {
      item.classList.remove('selected');
    });
    fetchedModels = [];
    modelsFetchKey = '';
    customModels = [];
    setModelConfigFromConfig([], []);
    (overlay.querySelector('input[name="profileName"]') as HTMLInputElement | null)?.focus();
  });

  document.querySelector('.settings-import-cc-switch')?.addEventListener('click', async () => {
    const importBtn = document.querySelector('.settings-import-cc-switch') as HTMLButtonElement | null;
    if (importBtn) {
      importBtn.disabled = true;
      importBtn.textContent = '导入中...';
    }

    try {
      const result = await invoke<CcSwitchImportResult>('import_cc_switch_profiles');
      const selectedId =
        result.state.activeProfileId ||
        result.state.profiles.find((profile) => profile.isActive)?.id ||
        result.state.profiles[0]?.id ||
        null;
      await refreshSettingsModal(overlay, selectedId, handleProfileConfigLoaded);

      let message: string;
      if (result.importedCount > 0) {
        message = `已从 CC Switch 导入 ${result.importedCount} 个配置`;
        if (result.skippedCount > 0) {
          message += `，跳过 ${result.skippedCount} 个重复或无效项`;
          if (result.skippedNames.length > 0) {
            message += `：${result.skippedNames.join('、')}`;
          }
        }
        message += '。导入后不会自动切换生效配置。';
      } else {
        message = 'CC Switch 配置已全部添加，无需重复导入。';
      }
      alert(message);
    } catch (e) {
      alert('从 CC Switch 导入失败: ' + String(e));
    } finally {
      if (importBtn) {
        importBtn.disabled = false;
        importBtn.textContent = '从 CC Switch 导入';
      }
    }
  });

  try {
    if (!isMountCurrent()) return;
    const initial = await refreshSettingsModal(overlay, null, handleProfileConfigLoaded);
    if (!isMountCurrent()) return;
    if (livePathEl) {
      livePathEl.textContent = `配置文件：${initial.state.current.configPath}`;
    }
    bindProfileListEvents();
    bindModelConfigEvents();
  } catch (e) {
    if (!isMountCurrent()) return;
    alert('加载 API 配置失败: ' + String(e));
    close();
  }
}


// ============================================================
// 工具消息渲染系统
// ============================================================

/** 工具显示配置 */
interface ToolConfig {
  displayMode: 'one-line' | 'collapsible';
  icon: string;
  label: string;
  getValue?: (input: Record<string, unknown>) => string;
  getSecondary?: (input: Record<string, unknown>) => string | undefined;
  style?: 'terminal' | 'file-open' | 'search' | 'default';
  borderColor: string;
  iconColor: string;
}

const TOOL_CONFIG_MAP: Record<string, ToolConfig> = {
  Bash: { displayMode: 'one-line', icon: '>_', label: 'Bash', getValue: (i) => String(i.command || ''), getSecondary: (i) => i.description ? String(i.description) : undefined, style: 'terminal', borderColor: '#3fb950', iconColor: '#3fb950' },
  Read: { displayMode: 'one-line', icon: '📄', label: 'Read', getValue: (i) => String(i.file_path || ''), style: 'file-open', borderColor: '#8b949e', iconColor: '#8b949e' },
  Edit: { displayMode: 'collapsible', icon: '✏️', label: 'Edit', getValue: (i) => String(i.file_path || ''), borderColor: '#d29922', iconColor: '#d29922' },
  Write: { displayMode: 'collapsible', icon: '📝', label: 'Write', getValue: (i) => String(i.file_path || ''), borderColor: '#d29922', iconColor: '#d29922' },
  Grep: { displayMode: 'one-line', icon: '🔍', label: 'Grep', getValue: (i) => String(i.pattern || ''), style: 'search', borderColor: '#8b949e', iconColor: '#8b949e' },
  Glob: { displayMode: 'one-line', icon: '🔍', label: 'Glob', getValue: (i) => String(i.pattern || ''), style: 'search', borderColor: '#8b949e', iconColor: '#8b949e' },
  Task: { displayMode: 'collapsible', icon: '🤖', label: 'Subagent', getValue: (i) => String(i.description || i.prompt || '').substring(0, 80), borderColor: '#a371f7', iconColor: '#a371f7' },
  TodoWrite: { displayMode: 'collapsible', icon: '✅', label: 'TodoWrite', borderColor: '#a371f7', iconColor: '#a371f7' },
  TaskCreate: { displayMode: 'one-line', icon: '📋', label: 'Task', getValue: (i) => String(i.subject || ''), borderColor: '#a371f7', iconColor: '#a371f7' },
  TaskUpdate: { displayMode: 'one-line', icon: '📋', label: 'Task', getValue: (i) => String(i.subject || ''), borderColor: '#a371f7', iconColor: '#a371f7' },
  AskUserQuestion: { displayMode: 'collapsible', icon: '❓', label: 'Question', borderColor: '#58a6ff', iconColor: '#58a6ff' },
  exit_plan_mode: { displayMode: 'collapsible', icon: '📐', label: 'Plan', borderColor: '#7b8cff', iconColor: '#7b8cff' },
  ExitPlanMode: { displayMode: 'collapsible', icon: '📐', label: 'Plan', borderColor: '#7b8cff', iconColor: '#7b8cff' },
};

function getDefaultToolConfig(): ToolConfig {
  return { displayMode: 'one-line', icon: '🔧', label: 'Tool', borderColor: '#8b949e', iconColor: '#8b949e' };
}

/** 解析 JSON，失败返回 null */
function tryParseJson(text: string): Record<string, unknown> | null {
  try {
    const trimmed = text.trim();
    if (!trimmed.startsWith('{')) return null;
    return JSON.parse(trimmed);
  } catch {
    return null;
  }
}

/** 提取工具名称 */
function extractToolName(content: string): string {
  const json = tryParseJson(content);
  return json ? String(json.tool_name || json.tool || json.name || '') : '';
}

/** 提取工具输入 */
function extractToolInput(content: string): Record<string, unknown> {
  const json = tryParseJson(content);
  if (!json) return {};
  return (json.tool_input || json.input || json.arguments || {}) as Record<string, unknown>;
}

/** 提取工具结果文本 */
function extractToolResult(content: string): { text: string; isError: boolean } {
  const json = tryParseJson(content);
  if (!json) return { text: content, isError: false };
  const text = String(json.content ?? json.output ?? json.result ?? '');
  const isError = Boolean(json.is_error || json.isError);
  return { text, isError };
}

/** 合并相邻的同类型消息（连续 assistant 文本或连续 thinking） */
function mergeAdjacentSameRole(messages: Message[]): Message[] {
  if (messages.length === 0) return [];
  const result: Message[] = [messages[0]];

  for (let i = 1; i < messages.length; i++) {
    const prev = result[result.length - 1];
    const curr = messages[i];

    // 相邻同角色 assistant（无 thinking 字段的纯文本消息）→ 合并
    if (
      prev.role === 'assistant' && curr.role === 'assistant'
      && !prev.thinking && !curr.thinking
    ) {
      prev.content = prev.content + '\n\n' + curr.content;
      continue;
    }

    // 相邻 thinking 消息 → 合并
    if (prev.role === 'thinking' && curr.role === 'thinking') {
      prev.content = prev.content + '\n' + curr.content;
      continue;
    }

    result.push(curr);
  }

  return result;
}

/** 将 tool_use 和 tool_result 配对处理，生成内嵌工具消息 */
function processToolMessages(messages: Message[]): Message[] {
  const result: Message[] = [];
  let i = 0;

  while (i < messages.length) {
    const msg = messages[i];

    if (msg.role === 'tool_use') {
      const toolName = extractToolName(msg.content);
      const toolInput = extractToolInput(msg.content);
      const config = TOOL_CONFIG_MAP[toolName] || getDefaultToolConfig();

      // 查找对应的 tool_result
      let toolResult: string | undefined;
      let isError = false;
      if (i + 1 < messages.length && messages[i + 1].role === 'tool_result') {
        const resData = extractToolResult(messages[i + 1].content);
        toolResult = resData.text;
        isError = resData.isError;
        i++; // 跳过 tool_result
      }

      // 创建内嵌工具消息
      const toolMsg: Message = {
        id: msg.id,
        role: 'tool',
        content: toolInput ? JSON.stringify(toolInput) : msg.content,
        timestamp: msg.timestamp,
        toolData: {
          toolName,
          toolInput,
          toolResult,
          isError,
          displayMode: config.displayMode,
          colorScheme: {
            border: config.borderColor,
            icon: config.iconColor,
            primary: config.borderColor,
          },
        },
      };
      result.push(toolMsg);
      i++;
      continue;
    }

    if (msg.role === 'tool_result') {
      // 孤立的 tool_result（没有前置 tool_use），跳过
      i++;
      continue;
    }

    result.push(msg);
    i++;
  }

  return result;
}

function filterVisibleMessages(messages: Message[]): Message[] {
  // tool_use/tool_result 已在 processToolMessages 中合并为内嵌工具消息，此处不再处理

  return messages.filter((msg) => {
    // 过滤内部系统消息
    const trimmed = msg.content.trim();
    if (
      trimmed.startsWith('<system-reminder>')
      || trimmed.startsWith('<local-command-caveat>')
      || trimmed.startsWith('<command-name>')
      || trimmed.startsWith('<local-command-stdout>')
    ) {
      return false;
    }

    // thinking 消息始终显示（参考 claudecodeui: isThinking 消息作为独立 Reasoning accordion 渲染）
    if (msg.role === 'thinking') return true;

    return true;
  });
}

/** 大脑图标 SVG */
function renderBrainIconHtml(): string {
  return `<svg class="thinking-brain-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
    <path d="M12 5a3 3 0 1 0-5.997.125 4 4 0 0 0-2.526 5.77 4 4 0 0 0 .556 6.588A4 4 0 1 0 12 18Z"/>
    <path d="M12 5a3 3 0 1 1 5.997.125 4 4 0 0 1 2.526 5.77 4 4 0 0 1-.556 6.588A4 4 0 1 1 12 18Z"/>
    <path d="M15 13a4.5 4.5 0 0 1-3-4 4.5 4.5 0 0 1-3 4"/>
    <path d="M17.599 6.5a3 3 0 0 0 .399-1.375"/>
    <path d="M6.003 5.125A3 3 0 0 0 6.401 6.5"/>
    <path d="M3.477 10.896a4 4 0 0 1 .585-.396"/>
    <path d="M19.938 10.5a4 4 0 0 1 .585.396"/>
    <path d="M6 18a4 4 0 0 1-1.967-.516"/>
    <path d="M19.967 17.484A4 4 0 0 1 18 18"/>
  </svg>`;
}

/** 下箭头 SVG */
function renderChevronDownIconHtml(): string {
  return `<svg class="thinking-chevron" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
    <polyline points="6 9 12 15 18 9"></polyline>
  </svg>`;
}

function renderThinkingDetails(thinking: string, label: string, expanded: boolean, dataId?: string, isStreaming: boolean = false): string {
  const openAttr = expanded ? ' open' : '';
  const dataAttr = dataId ? ` data-thinking-id="${escapeHtml(dataId)}"` : '';
  const streamClass = isStreaming ? ' streaming-active' : '';
  const durationText = isStreaming ? '' : '<span class="thinking-duration">思考完成</span>';
  return `
    <details class="thinking-block${streamClass}"${openAttr}${dataAttr}>
      <summary class="thinking-summary">
        ${renderBrainIconHtml()}
        <span class="thinking-label"><span class="thinking-label-text">${escapeHtml(label)}</span></span>
        ${durationText}
        ${renderChevronDownIconHtml()}
      </summary>
      <div class="thinking-content-wrapper">
        <div class="thinking-content-inner">
          <div class="thinking-content-scroll">
            <div class="thinking-content"><pre>${escapeHtml(thinking)}</pre></div>
          </div>
        </div>
      </div>
    </details>
  `;
}

/** 渲染工具消息 HTML */
function renderToolMessageHtml(msg: Message): string {
  const td = msg.toolData;
  if (!td) return '';

  const { toolName, toolInput, toolResult, isError, displayMode, colorScheme } = td;
  const isRunning = toolResult === undefined;
  const hasResult = toolResult !== undefined && toolResult !== '';
  const statusBadge = isRunning
    ? '<span class="tool-status tool-status-running">运行中</span>'
    : isError
      ? '<span class="tool-status tool-status-error">错误</span>'
      : '<span class="tool-status tool-status-done">完成</span>';

  // One-line 显示（Bash、Read、Grep、Glob 等简单工具）
  if (displayMode === 'one-line') {
    const config = TOOL_CONFIG_MAP[toolName] || getDefaultToolConfig();
    const value = config.getValue ? config.getValue(toolInput) : toolName;
    const secondary = config.getSecondary ? config.getSecondary(toolInput) : undefined;
    const styleClass = config.style ? `tool-oneline-${config.style}` : 'tool-oneline-default';

    let oneLineHtml = '';
    if (config.style === 'terminal') {
      oneLineHtml = `<span class="tool-cmd-prefix">$</span> <code class="tool-cmd-text">${escapeHtml(value)}</code>`;
    } else if (config.style === 'file-open') {
      oneLineHtml = `<span class="tool-file-link">📄 ${escapeHtml(value)}</span>`;
    } else if (config.style === 'search') {
      oneLineHtml = `<span class="tool-search-pattern">${escapeHtml(value)}</span>`;
    } else {
      oneLineHtml = `<span>${escapeHtml(value || toolName)}</span>`;
    }

    const secondaryHtml = secondary ? `<span class="tool-secondary">${escapeHtml(secondary)}</span>` : '';

    const toolContent = `
      <div class="tool-card" style="border-left-color: ${colorScheme.border}">
        <div class="tool-card-header">
          <span class="tool-icon" style="color: ${colorScheme.icon}">${escapeHtml(config.icon)}</span>
          <span class="tool-label">${escapeHtml(config.label)}</span>
          ${secondaryHtml}
          ${statusBadge}
        </div>
        <div class="tool-card-body ${styleClass}">
          ${oneLineHtml}
        </div>
        ${hasResult ? `<div class="tool-card-result"><div class="markdown-body">${renderMarkdown(toolResult!)}</div></div>` : ''}
      </div>`;
    return toolContent;
  }

  // 可折叠显示（Edit、Write、Task、Plan 等复杂工具）
  const config = TOOL_CONFIG_MAP[toolName] || getDefaultToolConfig();
  const value = config.getValue ? config.getValue(toolInput) : undefined;
  const titleText = value || toolName;

  let inputPreview = '';
  if (toolInput && Object.keys(toolInput).length > 0) {
    const previewObj: Record<string, unknown> = {};
    // 只显示关键字段
    for (const key of ['file_path', 'old_string', 'new_string', 'prompt', 'description', 'subject', 'question']) {
      if (key in toolInput) {
        const val = toolInput[key];
        if (typeof val === 'string' && val.length > 200) {
          previewObj[key] = (val as string).substring(0, 200) + '...';
        } else {
          previewObj[key] = val;
        }
      }
    }
    if (Object.keys(previewObj).length > 0) {
      inputPreview = `<pre class="tool-input-preview"><code>${escapeHtml(JSON.stringify(previewObj, null, 2))}</code></pre>`;
    }
  }

  const expanded = isRunning ? ' open' : '';
  const toolContent = `
    <div class="tool-card" style="border-left-color: ${colorScheme.border}">
      <details class="tool-collapsible"${expanded}>
        <summary class="tool-card-header tool-collapsible-summary">
          <span class="tool-icon" style="color: ${colorScheme.icon}">${escapeHtml(config.icon)}</span>
          <span class="tool-label">${escapeHtml(config.label)}</span>
          <span class="tool-title-text">${escapeHtml(titleText)}</span>
          ${statusBadge}
          <span class="tool-chevron">▾</span>
        </summary>
        <div class="tool-card-body">
          ${inputPreview}
          ${hasResult
            ? `<div class="tool-card-result"><div class="markdown-body">${renderMarkdown(toolResult!)}</div></div>`
            : isRunning
              ? '<div class="tool-running-indicator"><span class="pending-dot"></span><span class="pending-dot"></span><span class="pending-dot"></span></div>'
              : ''}
        </div>
      </details>
    </div>`;
  return toolContent;
}

function renderMessageHtml(msg: Message, prevRole?: string, showUndo = false): string {
  if (msg.role === 'tool') {
    return renderToolMessageHtml(msg);
  }

  if (msg.role === 'error') {
    return `
      <div class="message error">
        <div class="message-content message-error-content">
          <div class="message-error-title">调用失败</div>
          <div class="markdown-body">${renderMarkdown(msg.content)}</div>
          <div class="message-footer">
            <div class="message-time">${formatTime(msg.timestamp)}</div>
          </div>
        </div>
      </div>
    `;
  }

  const isThinking = msg.role === 'thinking';
  const roleClass = isThinking ? 'assistant thinking-msg' : msg.role;

  let thinkingHtml = '';
  let contentHtml = '';
  // 默认折叠，只有用户手动展开过才展开（匹配 claudecodeui defaultOpen=false）
  const thinkingExpanded = expandedThinkingBlocks.has(msg.id);

  if (isThinking && msg.content.trim()) {
    thinkingHtml = renderThinkingDetails(msg.content, '思考过程', thinkingExpanded, msg.id);
  } else {
    // 助手消息中合并的思考过程
    if (msg.thinking && msg.thinking.trim()) {
      thinkingHtml = renderThinkingDetails(msg.thinking, '思考过程', thinkingExpanded, msg.id);
    }
    if (msg.content.trim()) {
      // 用户消息：剥离 @文件路径引用和 @File[] 标签后再渲染（芯片已展示文件信息）
      const renderContent = msg.role === 'user'
        ? stripFileRefTags(stripFileRefsFromDisplay(msg.content))
        : msg.content;
      if (renderContent.trim()) {
        contentHtml = `<div class="markdown-body">${renderMarkdown(renderContent)}</div>`;
      }
    }
  }

  // 用户消息：从内容中解析 @File[] 引用生成文件芯片
  const fileRefChips = msg.role === 'user' ? parseFileRefs(msg.content) : [];
  const userRefs = fileRefChips.length > 0
    ? renderFileRefChipsHtml(fileRefChips)
    : (msg.role === 'user' && msg.refs && msg.refs.length > 0
      ? renderFileRefChipsHtml(msg.refs)
      : '');

  // 消息复制控件（非思考消息且有内容时显示）
  let copyControlHtml = '';
  if (!isThinking && msg.content.trim()) {
    const escapedContent = escapeHtml(msg.content);
    copyControlHtml = `
      <div class="msg-copy-control">
        <button type="button" class="msg-copy-btn" data-copy-content="${escapedContent}" title="复制消息" aria-label="复制消息">
          <svg class="msg-copy-icon-svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect>
            <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path>
          </svg>
        </button>
      </div>`;
  }

  const isGrouped = prevRole && prevRole === msg.role && (msg.role === 'user' || msg.role === 'assistant' || msg.role === 'tool');
  const groupedClass = isGrouped ? ' grouped' : '';

  // 助手/思考消息：全宽布局，无头像
  if (msg.role === 'assistant' || isThinking) {
    return `
      <div class="message ${roleClass}${groupedClass}">
        <div class="message-content">
          ${thinkingHtml}
          ${contentHtml}
          <div class="message-footer">
            ${copyControlHtml}
            <div class="message-time">${formatTime(msg.timestamp)}</div>
          </div>
        </div>
      </div>
    `;
  }

  // 用户消息：蓝色气泡（复制 / 时间在气泡外，悬浮显示）
  // 撤回按钮（仅最后一条用户消息，hover 显示）
  const undoHtml = showUndo ? `
    <button type="button" class="msg-action-btn msg-retry-btn"
      data-action="undo" title="撤回此消息" aria-label="撤回此消息">
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
        <polyline points="1 4 1 10 7 10"></polyline>
        <path d="M3.51 15a9 9 0 1 0 2.13-9.36L1 10"></path>
      </svg>
    </button>` : '';
  return `
    <div class="message ${roleClass}${groupedClass}">
      <div class="message-content">
        ${userRefs}
        ${thinkingHtml}
        ${contentHtml}
      </div>
      <div class="message-footer message-footer-user">
        ${undoHtml}
        ${copyControlHtml}
        <div class="message-time">${formatTime(msg.timestamp)}</div>
      </div>
    </div>
  `;
}

/** 完整消息处理管线：合并相邻消息 → 处理工具消息 → 过滤不可见 → 渲染 HTML */
function renderMessageListHtml(messages: Message[]): string {
  const isRunning = activeConversationId ? runningSessions.has(activeConversationId) : false;
  const processed = filterVisibleMessages(processToolMessages(mergeAdjacentSameRole(messages)));
  // 提前计算最后一条用户消息索引，避免在 .map() 内部 O(n²) 重复计算
  const lastUserIdx = processed.map(m => m.role).lastIndexOf('user');
  return processed
    .map((msg, idx, arr) => {
      // 撤回按钮始终显示在最后一条用户消息上，即使后面还有 AI 回复
      // 点击撤回会删除该用户提问 + 所有后续回答
      const showUndo = !isRunning && idx === lastUserIdx;
      return renderMessageHtml(msg, idx > 0 ? arr[idx - 1].role : undefined, showUndo);
    })
    .join('');
}

function renderFileRefChipsHtml(refs: FileRef[]): string {
  // 为图片文件异步预加载缩略图
  setTimeout(() => {
    const chips = document.querySelectorAll<HTMLElement>('.file-ref-chip[data-file-path] img.file-ref-chip-thumb');
    chips.forEach(async (img) => {
      const filePath = ((img as HTMLElement).parentElement as HTMLElement)?.dataset.filePath;
      if (!filePath || img.getAttribute('src') !== '') return;
      try {
        // 绝对路径直接使用，相对路径拼接项目目录
        const fullPath = resolveFilePath(filePath);
        const mime = getImageMime(filePath);
        const b64 = await invoke<string>('read_file_base64', { filePath: fullPath });
        (img as HTMLImageElement).src = `data:${mime};base64,${b64}`;
      } catch { /* 加载缩略图失败，保持空状态 */ }
    });
  }, 100);

  return `
    <div class="file-ref-chips">
      ${refs
        .map(
          (ref) => {
            const icon = getFileSuggestionIcon(ref.path);
            const isImg = isImageFile(ref.path);
            // 提取文件名（去掉尾部斜杠用于目录）
            const cleanPath = ref.path.replace(/\/$/, '');
            const parts = cleanPath.split(/[/\\]/).filter(Boolean);
            const fileName = ref.path.endsWith('/') ? parts[parts.length - 1] + '/' : (parts[parts.length - 1] || ref.path);
            return `
        <span class="file-ref-chip${isImg ? ' file-ref-chip--image' : ''}" title="${escapeHtml(ref.path)}" data-file-path="${escapeHtml(ref.path)}">
          ${isImg ? `<img class="file-ref-chip-thumb" src="" alt="" loading="lazy" />` : `<span class="file-ref-chip-icon">${icon}</span>`}
          <span class="file-ref-chip-path">${escapeHtml(fileName)}</span>
        </span>`;
          },
        )
        .join('')}
    </div>`;
}

function formatTokenCount(n: number): string {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1).replace(/\.0$/, '') + 'M';
  if (n >= 1000) return Math.round(n / 1000) + 'K';
  return String(n);
}

function getContextWindowFor(tokens: number): number {
  // 用量超过 20 万即判定启用了 1M 上下文窗口，否则按标准 20 万
  return tokens > 200_000 ? 1_000_000 : 200_000;
}

/** 右下角上下文环形指示器（参考 Claude 桌面端），悬停显示剩余空间 */
function renderContextIndicatorInner(): string {
  const conv = activeConversationId
    ? conversations.find((c) => c.id === activeConversationId)
    : undefined;
  const tokens = conv?.context_tokens ?? 0;
  if (!conv || tokens <= 0) return '';

  const model = conv.last_model?.trim() || '';
  const windowSize = getContextWindowFor(tokens);
  const ratio = Math.min(1, tokens / windowSize);
  const pct = Math.round(ratio * 100);
  const remaining = Math.max(0, windowSize - tokens);
  const circumference = 2 * Math.PI * 7;
  const offset = circumference * (1 - ratio);
  const level = pct >= 90 ? 'danger' : pct >= 75 ? 'warn' : 'ok';
  const tip = `${model ? model + ' · ' : ''}上下文 ${formatTokenCount(tokens)} / ${formatTokenCount(windowSize)} · 剩余 ${formatTokenCount(remaining)}（已用 ${pct}%）`;

  return `
    <div class="context-indicator context-${level}" title="${escapeHtml(tip)}" aria-label="${escapeHtml(tip)}">
      <svg class="context-ring" viewBox="0 0 18 18" width="16" height="16" aria-hidden="true">
        <circle class="context-ring-bg" cx="9" cy="9" r="7" fill="none" stroke-width="2.5"></circle>
        <circle class="context-ring-fg" cx="9" cy="9" r="7" fill="none" stroke-width="2.5"
          stroke-dasharray="${circumference.toFixed(2)}" stroke-dashoffset="${offset.toFixed(2)}"
          transform="rotate(-90 9 9)" stroke-linecap="round"></circle>
      </svg>
      <span class="context-indicator-pct">${pct}%</span>
    </div>
  `;
}

function renderContextIndicatorHtml(): string {
  return `<div class="context-indicator-slot" id="context-indicator-slot">${renderContextIndicatorInner()}</div>`;
}

function updateContextIndicator(): void {
  const slot = document.querySelector('#context-indicator-slot');
  if (slot) slot.innerHTML = renderContextIndicatorInner();
}

function renderChatHeaderHtml(conversation: Conversation | undefined): string {
  const hasMessages = (conversation?.messages.length ?? 0) > 0;
  const title = hasMessages ? (conversation?.title || '新会话') : '新会话';
  const sessionId = conversation?.id || activeConversationId || '—';
  const canCopySessionId = sessionId !== '—';
  const projectDir = getEffectiveProjectDir();
  const hasProjectDir = projectDir.length > 0;
  const sessionTitle = canCopySessionId
    ? (hasProjectDir
        ? `Session ID: ${sessionId}（点击在终端中 cd ${projectDir} && claude --resume）`
        : `Session ID: ${sessionId}（点击复制）`)
    : 'Session ID';

  // 终端图标（替代复制图标）
  const terminalIconSvg = canCopySessionId && hasProjectDir
    ? `<svg class="session-id-action-icon" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
        <polyline points="4 17 10 11 4 5"></polyline>
        <line x1="12" y1="19" x2="20" y2="19"></line>
      </svg>`
    : (canCopySessionId
        ? renderCopyIconHtml('session-id-copy-icon')
        : '');

  return `
    <div class="chat-header-left">
      <h2>${escapeHtml(title)}</h2>
    </div>
    <div class="chat-header-meta">
      ${
        canCopySessionId
          ? `
        <button
          type="button"
          class="session-id session-id-copy"
          id="session-id-copy"
          data-session-id="${escapeHtml(sessionId)}"
          title="${escapeHtml(sessionTitle)}"
          aria-label="${escapeHtml(sessionTitle)}"
        >
          <span class="session-id-text">${escapeHtml(sessionId)}</span>
          ${terminalIconSvg}
        </button>
      `
          : `<span class="session-id">${escapeHtml(sessionId)}</span>`
      }
    </div>
  `;
}

function buildDisplayMessages(conversation: Conversation | undefined): Message[] {
  const messages = [...(conversation?.messages ?? [])];
  // 只有当 pendingUserMessage 属于当前会话时才显示（防止串会话）
  const pendingBelongsToThisConv = pendingUserMessage &&
    (pendingUserMessageConvId === activeConversationId || (!pendingUserMessageConvId && !activeConversationId));
  if (pendingBelongsToThisConv && pendingUserMessage && !messages.some((m) => m.role === 'user' && m.content === pendingUserMessage)) {
    messages.push({
      id: `pending-user-${Date.now()}`,
      role: 'user',
      content: pendingUserMessage,
      timestamp: Math.floor(Date.now() / 1000),
    });
  }
  if (transientSessionError) {
    messages.push({
      id: `transient-error-${Date.now()}`,
      role: 'error',
      content: transientSessionError,
      timestamp: Math.floor(Date.now() / 1000),
    });
  }
  return messages;
}

function renderConversationMessagesInnerHtml(messages: Message[]): string {
  const messageHtml = renderMessageListHtml(messages);
  if (messageHtml) return messageHtml;

  return `
    <div class="conversation-empty-state">
      <span class="conversation-empty-state-icon" aria-hidden="true">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">
          <path d="M21 15a2 2 0 0 1-2 2H8l-5 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>
        </svg>
      </span>
      <strong>会话内容已撤回</strong>
      <span>在下方输入消息，重新开始这段会话</span>
    </div>
  `;
}

function renderChatContent(): string {
  const conversation = activeConversationId
    ? conversations.find((c) => c.id === activeConversationId)
    : undefined;

  const messages = buildDisplayMessages(conversation);

  return `
    <div class="message-list" id="message-list">
      ${renderConversationMessagesInnerHtml(messages)}
    </div>
  `;
}

function renderEmptyState(): string {
  return `
    <div class="empty-chat">
      <div class="empty-icon">💬</div>
      <h2>Start a New Conversation</h2>
      <p>Select a platform from the dropdown and start chatting with your AI CLI</p>
      <div class="empty-chat-model-info" id="empty-chat-model-info"></div>
    </div>
  `;
}

async function refreshModelInfo() {
  const container = document.querySelector('#empty-chat-model-info');
  if (!container) return;

  try {
    const state = await invoke<ApiProfilesState>('get_api_profiles_state');
    const activeProfile = state.profiles.find((p) => p.id === state.activeProfileId);
    const profileName = activeProfile?.name || '';
    const baseUrl = activeProfile?.baseUrl || state.current?.baseUrl || '';
    // 当前模型直接读自配置文件
    // 'default' 表示订阅默认（非具体模型），按未指定处理，让卡片回到「官方默认」文案
    const rawModel = getActiveChatModelForRender();
    const currentModel =
      (rawModel && rawModel !== 'default' ? rawModel : '') ||
      activeProfile?.defaultModel ||
      state.current?.defaultModel ||
      '';

    const hasInfo = Boolean(currentModel || profileName || baseUrl);
    const body = hasInfo
      ? `
          <div class="model-info-row"><span class="model-info-key">当前模型</span><span class="model-info-value model-info-model">${escapeHtml(currentModel || '未配置模型')}</span></div>
          ${profileName ? `<div class="model-info-row"><span class="model-info-key">配置方案</span><span class="model-info-value">${escapeHtml(profileName)}</span></div>` : ''}
          ${baseUrl ? `<div class="model-info-row"><span class="model-info-key">API 地址</span><span class="model-info-value model-info-url">${escapeHtml(baseUrl)}</span></div>` : ''}
        `
      : `
          <div class="model-info-row"><span class="model-info-key">当前模型</span><span class="model-info-value model-info-model">官方默认（Claude 订阅）</span></div>
          <div class="model-info-empty-text">正在使用 Claude 官方登录 / 订阅。如需改用第三方 API，点击右上角「API 配置」进入配置页并「应用」。</div>
        `;

    container.innerHTML = `
      <div class="model-info-card">
        <div class="model-info-header">
          <svg class="model-info-icon" viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <path d="M12 2L2 7l10 5 10-5-10-5z"/>
            <path d="M2 17l10 5 10-5"/>
            <path d="M2 12l10 5 10-5"/>
          </svg>
          <span class="model-info-label">当前模型配置</span>
        </div>
        <div class="model-info-body">${body}</div>
      </div>
    `;
  } catch {
    // 静默处理错误，不阻塞页面渲染
  }
}

function newChat() {
  toggleNewChatDropdown();
}

/** 关闭 New Chat 下拉框 */
function closeNewChatDropdown() {
  document.querySelector('.new-chat-overlay')?.remove();
  document.querySelector('.new-chat-dropdown')?.remove();
}

/** 切换 New Chat 下拉框显示/隐藏 */
function toggleNewChatDropdown() {
  if (document.querySelector('.new-chat-dropdown')) {
    closeNewChatDropdown();
    return;
  }

  const btnWrapper = document.querySelector('#new-chat-btn')?.parentElement;
  if (!btnWrapper) return;

  const { workspaces } = groupConversationsByWorkspace();

  const overlay = document.createElement('div');
  overlay.className = 'new-chat-overlay';
  overlay.addEventListener('click', closeNewChatDropdown);

  const dropdown = document.createElement('div');
  dropdown.className = 'new-chat-dropdown';
  dropdown.innerHTML = renderNewChatDropdownContent(workspaces);

  document.body.appendChild(overlay);
  document.body.appendChild(dropdown);

  // 定位下拉框
  requestAnimationFrame(() => {
    const btnRect = btnWrapper.getBoundingClientRect();
    dropdown.style.top = `${btnRect.bottom + 4}px`;
    dropdown.style.left = `${btnRect.left}px`;
    // 确保不超出右边界
    const dRect = dropdown.getBoundingClientRect();
    if (dRect.right > window.innerWidth - 8) {
      dropdown.style.left = `${Math.max(8, window.innerWidth - dRect.width - 8)}px`;
    }
    // 确保不超出下边界
    if (dRect.bottom > window.innerHeight - 8) {
      dropdown.style.top = `${Math.max(8, btnRect.top - dRect.height - 4)}px`;
    }
  });

  // 监听点击事件
  dropdown.addEventListener('click', (e) => {
    const target = (e.target as HTMLElement).closest('[data-action]') as HTMLElement | null;
    if (!target) return;
    const action = target.dataset.action;
    const workspacePath = target.dataset.workspace;

    if (action === 'pick-new-dir') {
      closeNewChatDropdown();
      void pickNewWorkspaceDirectory();
    } else if (action === 'new-chat-in-dropdown' && workspacePath) {
      closeNewChatDropdown();
      newChatInWorkspace(workspacePath);
    }
  });
}

/** 选择新的工作目录并创建新会话 */
async function pickNewWorkspaceDirectory(): Promise<void> {
  try {
    const selected = await open({
      directory: true,
      multiple: false,
      title: '选择工作目录',
    });
    if (typeof selected !== 'string' || !selected.trim()) {
      return;
    }
    const trimmed = selected.trim();
    pendingProjectDir = trimmed;
    invalidateFileCache();
  } catch (e) {
    console.error('Failed to pick project directory:', e);
    return;
  }
  // 完成选目录后执行创建新会话
  dismissApiConfigViewState();
  activeConversationId = '';
  invalidateFileCache();
  pendingUserMessage = null;
  pendingUserMessageConvId = null;
  transientSessionError = null;
  render();
  void refreshModelInfo();

  setTimeout(() => {
    const input = document.querySelector<HTMLTextAreaElement>('#message-input');
    if (input) input.focus();
  }, 100);
}

/** 渲染 New Chat 下拉框内容 */
function renderNewChatDropdownContent(workspaces: WorkspaceGroup[]): string {
  const plusSvg = `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>`;
  const folderSvg = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/></svg>`;

  let html = `
    <button type="button" class="new-chat-dropdown-action" data-action="pick-new-dir">
      <span class="new-chat-dropdown-action-icon">${plusSvg}</span>
      <span class="new-chat-dropdown-item-label">选择新工作目录…</span>
    </button>
  `;

  if (workspaces.length > 0) {
    html += `<div class="new-chat-dropdown-separator"></div>`;
    html += `<div class="new-chat-dropdown-label">最近使用</div>`;
    for (const ws of workspaces) {
      html += `
        <button type="button" class="new-chat-dropdown-item" data-action="new-chat-in-dropdown" data-workspace="${escapeHtml(ws.path)}" title="${escapeHtml(ws.path)}">
          <span class="new-chat-dropdown-item-icon">${folderSvg}</span>
          <span class="new-chat-dropdown-item-label">${escapeHtml(ws.displayName)}</span>
        </button>
      `;
    }
  } else {
    html += `<div class="new-chat-dropdown-empty">暂无历史工作目录</div>`;
  }

  return html;
}

// 发送消息：通过 invoke 到后端，后端启动 shell 并通过事件推送更新
async function sendMessage() {
  const input = document.querySelector<HTMLTextAreaElement>('#message-input');
  const sendBtn = document.querySelector<HTMLButtonElement>('#send-btn');

  if (!input) return;

  const hasPastedImages = pasteAttachments.length > 0;
  const hasImportedFiles = importedFileRefs.length > 0;
  if (!input.value.trim() && !hasPastedImages && !hasImportedFiles) return;
  if (sendBtn?.disabled) return;

  if (isNewChatSession() && !hasRequiredProjectDir()) {
    return;
  }

  let content = input.value.trim();
  input.value = '';
  updateSendButtonState();

  // 捕获导入的文件引用（在 clearImportedFileRefs 之前），用于构造发送给 CLI 的 prompt
  const capturedImportedRefs = importedFileRefs.map((e) => e.ref);
  clearImportedFileRefs();

  // 粘贴图片附件：拼到 prompt 前（给 CLI 用的），content 保持原始文字用于展示
  const pasteRefs: { path: string; name: string; objectUrl: string }[] = [];
  let promptWithPaste = content;
  if (hasPastedImages) {
    for (const att of pasteAttachments) {
      pasteRefs.push({ ...att });
    }
    const pasteRefStr = pasteRefs.map((a) => `@${a.path}`).join(' ');
    promptWithPaste = pasteRefStr + (content ? ' ' + content : '');
    clearPasteAttachments();
  }

  // 将导入的文件引用也拼到 prompt 前面（已经是 @File[path] 格式，直接拼接）
  if (capturedImportedRefs.length > 0) {
    const importedRefStr = capturedImportedRefs.join(' ');
    promptWithPaste = importedRefStr + (promptWithPaste ? ' ' + promptWithPaste : '');
  }

  // 所有引用（粘贴图片 + 导入文件）合并
  const allRefs: FileRef[] = [
    ...pasteRefs.map((a) => ({ path: a.path, isImage: true })),
    ...capturedImportedRefs.map((r) => {
      const path = unwrapFileRef(r).replace(/\/$/, '');
      return { path, isImage: isImageFile(path) };
    }),
  ];

  // 从 prompt 中提取 @File[] 标签，剩余文本交给 resolveFileReferences 处理 @path 引用
  const fileRefTagStr = capturedImportedRefs.length > 0 ? capturedImportedRefs.join(' ') + ' ' : '';
  // 先剥离 @File[] 标签，避免 resolveFileReferences 将其当作 @引用重复处理
  const promptForResolve = stripFileRefTags(promptWithPaste);

  const { prompt: resolvedFromAtPaths, displayPrompt, refs: fileRefs } = await resolveFileReferences(promptForResolve);

  // 合并 @file 引用到 allRefs
  for (const ref of fileRefs) {
    if (!allRefs.some((r) => r.path === ref.path)) {
      allRefs.push(ref);
    }
  }

  // 最终发送给 CLI 的 prompt：@File[] 标签 + resolveFileReferences 处理后的内容
  const resolvedContent = fileRefTagStr + resolvedFromAtPaths;

  // 展示用内容：剥离 @path 引用和粘贴图片引用，保留 @File[] 标签用于消息渲染
  let displayContent = stripFileRefsFromDisplay(displayPrompt);
  for (const att of pasteRefs) {
    const escaped = att.path.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    displayContent = displayContent.replace(new RegExp(`@${escaped}\\s*`, 'g'), '');
  }
  displayContent = displayContent.trim();

  // 存储的消息内容：@File[] 标签 + 干净文字（用于持久化和渲染芯片）
  const messageContent = (fileRefTagStr + (displayContent || '')).trim();
  const model = getActiveChatModel() || undefined;
  const queueKey = getActiveQueueKey();
  const prepared: QueuedCommand = {
    id: `q-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    prompt: resolvedContent,
    messageContent,
    refs: allRefs.length > 0 ? allRefs : undefined,
    model,
    createdAt: Date.now(),
  };

  // 当前会话忙碌：加入独立队列，等任务结束后自动发送
  const busy = isQueueKeyBusy(queueKey) || isSendButtonLoading();

  if (busy) {
    enqueueCommand(queueKey, prepared);
    showCopyToastMsg(`已加入队列（第 ${getCommandQueue(queueKey).length} 条）`);
    input.focus();
    return;
  }

  await executePreparedCommand(activeConversationId || null, prepared);
}

/** 立即执行一条已准备好的指令（新建会话时 conversationId 可为 null） */
async function executePreparedCommand(
  conversationId: string | null,
  command: QueuedCommand,
): Promise<void> {
  pendingUserMessage = command.prompt;
  pendingUserMessageConvId = conversationId;

  if (conversationId) {
    runningSessions.add(conversationId);
    const conv = conversations.find((c) => c.id === conversationId);
    if (conv) {
      conv.messages.push({
        id: `user-${Date.now()}`,
        role: 'user',
        content: command.messageContent,
        refs: command.refs,
        timestamp: Math.floor(Date.now() / 1000),
      });
      conv.updated_at = Math.floor(Date.now() / 1000);
    }
    clearStreamingState(conversationId);
    if (activeConversationId === conversationId) {
      refreshChatContent();
    }
    updateConversationListSpinner();
  } else {
    // 新会话，session ID 尚未确定，先标记为 pending
    runningSessions.add('pending');
    render();
  }

  // render() / refreshChatContent() 可能重建 DOM，需要在之后设置 loading 状态
  if (!conversationId || conversationId === activeConversationId) {
    setSendButtonLoading(true);
  }
  updateConversationListSpinner();
  refreshCommandQueueUI();

  try {
    const args: Record<string, string> = { prompt: command.prompt };
    if (conversationId) {
      args.conversationId = conversationId;
    }
    if (command.model) {
      args.model = command.model;
    }
    if (!conversationId) {
      const projectDir = getEffectiveProjectDir();
      if (projectDir) {
        args.projectDir = projectDir;
      }
    }
    await invoke('execute_prompt', args);
  } catch (e) {
    console.error('Failed to send message:', e);
    alert('Failed to send message: ' + String(e));
    pendingUserMessage = null;
    pendingUserMessageConvId = null;
    runningSessions.delete(conversationId || 'pending');
    if (!conversationId || conversationId === activeConversationId) {
      hideSendingState();
    }
    updateConversationListSpinner();
    // 发送失败时继续尝试队列下一条，避免整队列卡住
    if (conversationId) {
      void processNextQueuedCommand(conversationId);
    }
  }
}

async function abortSession() {
  const sendBtn = document.querySelector<HTMLButtonElement>('#send-btn');
  if (!sendBtn || sendBtn.dataset.loading !== 'true') return;

  try {
    const args: Record<string, string> = {};

    // 仅终止当前正在查看的会话（按 session ID）
    if (activeConversationId && runningSessions.has(activeConversationId)) {
      args.conversationId = activeConversationId;
    } else {
      // 当前查看的会话没有在运行，无需终止
      return;
    }

    const killed = await invoke<boolean>('abort_session', args);
    console.log('[abort] result:', killed, 'sessionId:', activeConversationId);

    // 点击停止后立即从运行集合中移除，让侧边栏转圈标志马上消失
    runningSessions.delete(activeConversationId);
    updateConversationListSpinner();

    // 安全回退：如果 session-ended 在 3 秒内未到达，强制清理当前会话的 UI 状态
    // 不再用 tauri://event 清理（该事件是通配符，任何事件都会触发导致提前取消）
    // session-ended 到达时 hideSendingState 会重置按钮，此处 isSendButtonLoading 检查保证幂等
    const abortSessionId = activeConversationId;
    setTimeout(() => {
      if (isSendButtonLoading() && !runningSessions.has(abortSessionId)) {
        console.warn('[abort] session-ended 未及时到达，强制清理 UI 状态');
        clearStreamingState(abortSessionId);
        hideSendingState();
        updateConversationListSpinner();
        void processNextQueuedCommand(abortSessionId);
      } else if (isSendButtonLoading() && runningSessions.has(abortSessionId)) {
        // session-ended 完全未到达（进程可能还在），强制清理
        console.warn('[abort] session-ended 完全未到达，强制终止并清理');
        runningSessions.delete(abortSessionId);
        clearStreamingState(abortSessionId);
        hideSendingState();
        updateConversationListSpinner();
        void processNextQueuedCommand(abortSessionId);
      }
    }, 3000);
  } catch (e) {
    console.error('Failed to abort session:', e);
    // 即使后端调用失败，也尝试清理 UI
    hideSendingState();
    updateConversationListSpinner();
  }
}

/** 重新生成或撤回消息的统一入口 */
async function invokeRetryMessage(mode: 'regenerate' | 'undo') {
  if (!activeConversationId) {
    showCopyToastMsg(mode === 'regenerate' ? '无法重新生成' : '无法撤回');
    return;
  }
  if (isSendButtonLoading()) {
    showCopyToastMsg(mode === 'regenerate' ? '请等待当前回复结束后再试' : '请等待当前回复结束后再撤回');
    return;
  }

  const cid = activeConversationId;
  if (mode === 'regenerate') {
    setSendButtonLoading(true);
    runningSessions.add(cid);
  } else {
    // 撤回：也设置 loading 状态防止双击，但不加入 runningSessions
    setSendButtonLoading(true);
  }

  try {
    await invoke('retry_message', { conversationId: cid, mode });

    if (mode === 'regenerate') {
      // 兜底超时：如果 session-ended 在 3 分钟内未到达，强制恢复 UI
      setTimeout(() => {
        if (runningSessions.has(cid)) {
          console.warn('[retry] regenerate 超时未收到 session-ended，强制恢复');
          runningSessions.delete(cid);
          hideSendingState();
        }
      }, 180_000);
    }

    // undo 模式：清理本地瞬时状态，并强制刷新（防止事件偶发丢失时残留气泡）
    if (mode === 'undo') {
      if (pendingUserMessageConvId === cid) {
        pendingUserMessage = null;
        pendingUserMessageConvId = null;
      }
      clearStreamingState(cid);
      runningSessions.delete(cid);
      setSendButtonLoading(false);
      hideSendingState();
      // messages-updated 通常已更新 conversations；再拉一次兜底
      await refreshConversationFromBackend(cid);
      if (activeConversationId === cid) {
        refreshChatContent();
        updateConversationListSpinner();
      }
      showCopyToastMsg('已撤回');
      void processNextQueuedCommand(cid);
    }
  } catch (e) {
    console.error(`[${mode}] 操作失败:`, e);
    if (mode === 'regenerate') {
      runningSessions.delete(cid);
    }
    setSendButtonLoading(false);
    const detail = e instanceof Error ? e.message : String(e ?? '');
    showCopyToastMsg(
      mode === 'regenerate'
        ? '重新生成失败'
        : detail.includes('未找到可撤回')
          ? '没有可撤回的消息'
          : '撤回失败',
    );
  }
}

/** 重新生成：截断最后 AI 回复并重发 */
async function handleRetryClick() {
  await invokeRetryMessage('regenerate');
}

/** 撤回：删除最后一条用户消息及其回复 */
async function handleUndoClick() {
  await invokeRetryMessage('undo');
}

function handleSendButtonClick() {
  const sendBtn = document.querySelector<HTMLButtonElement>('#send-btn');
  if (!sendBtn) return;

  if (sendBtn.dataset.loading === 'true') {
    // 运行中：有输入内容则入队，否则停止当前任务
    if (canSendMessage()) {
      void sendMessage();
    } else {
      void abortSession();
    }
  } else {
    void sendMessage();
  }
}

function removePendingAssistantIndicator() {
  document.querySelector('#pending-assistant')?.remove();
}

function showPendingAssistantIndicator(statusText = '正在思考...') {
  const messageList = document.querySelector<HTMLDivElement>('#message-list');
  if (!messageList) return;

  let pendingEl = document.querySelector('#pending-assistant') as HTMLDivElement | null;
  if (!pendingEl) {
    pendingEl = document.createElement('div');
    pendingEl.id = 'pending-assistant';
    pendingEl.className = 'message assistant pending';
    pendingEl.innerHTML = `
      <div class="message-content message-pending-content">
        <div class="pending-animation">
          <span class="pending-dot"></span>
          <span class="pending-dot"></span>
          <span class="pending-dot"></span>
        </div>
        <span class="pending-text"></span>
      </div>
    `;
    messageList.appendChild(pendingEl);
  }

  const textEl = pendingEl.querySelector('.pending-text');
  if (textEl) {
    textEl.textContent = statusText;
  }
  answerScroller?.scrollToBottom();
}

function updatePendingStatus(statusText: string) {
  showPendingAssistantIndicator(statusText);
}

function clearPendingRequestState() {
  removePendingAssistantIndicator();
}

function hideSendingState() {
  clearPendingRequestState();
  // 直接重置按钮为非加载状态（此函数仅在当前查看的会话结束时调用）
  setSendButtonLoading(false);
  updateSendButtonState();
}

/** 消息列表渲染后的统一后处理：代码复制按钮、思考块折叠、消息复制控件 */
function setupMessageListPostRender(container: HTMLElement): void {
  // 初始化代码块复制按钮
  initCodeCopyButtons(container);

  // 绑定思考块折叠事件
  container.querySelectorAll('.thinking-block[data-thinking-id]').forEach((details) => {
    // 避免重复绑定
    if ((details as HTMLElement).dataset.thinkingBound === '1') return;
    (details as HTMLElement).dataset.thinkingBound = '1';
    details.addEventListener('toggle', () => {
      const id = (details as HTMLElement).dataset.thinkingId;
      if (!id) return;
      if ((details as HTMLDetailsElement).open) {
        expandedThinkingBlocks.add(id);
      } else {
        expandedThinkingBlocks.delete(id);
      }
    });
  });

  // 初始化 Answer 区域滚动控制器
  initAnswerScroller();

  // 初始化消息复制按钮
  container.querySelectorAll('.msg-copy-btn').forEach((btn) => {
    if ((btn as HTMLElement).dataset.bound === '1') return;
    (btn as HTMLElement).dataset.bound = '1';
    btn.addEventListener('click', async () => {
      const content = (btn as HTMLElement).dataset.copyContent || '';
      const copyAsMarkdown = (btn as HTMLElement).dataset.copyMarkdown === '1';
      let textToCopy = content;
      if (copyAsMarkdown) {
        // 复制为 Markdown：去掉 HTML 标签，将代码块转回 markdown 格式
        const tempDiv = document.createElement('div');
        tempDiv.innerHTML = content;
        tempDiv.querySelectorAll('.code-block-wrapper').forEach((wrapper) => {
          const code = (wrapper.querySelector('.code-copy-btn') as HTMLElement)?.dataset.code || '';
          const lang = wrapper.querySelector('.code-lang-badge')?.textContent || '';
          const fence = '```' + (lang && lang !== 'text' ? lang : '');
          wrapper.outerHTML = fence + '\n' + code + '\n```';
        });
        textToCopy = tempDiv.textContent || '';
      }
      const ok = await _copyToClipboard(textToCopy);
      if (!ok) return;
      const icon = btn.querySelector('.msg-copy-icon-svg') as HTMLElement | null;
      if (icon) {
        icon.innerHTML = '<polyline points="20 6 9 17 4 12"></polyline>';
      }
      btn.classList.add('copied');
      setTimeout(() => {
        if (icon) {
          icon.innerHTML = '<rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path>';
        }
        btn.classList.remove('copied');
      }, 2000);
    });
  });

  // 初始化重试/撤回按钮事件委托（仅绑定一次）
  if (!(container as HTMLElement).dataset.retryBound) {
    (container as HTMLElement).dataset.retryBound = '1';
    container.addEventListener('click', (e) => {
      const btn = (e.target as HTMLElement).closest<HTMLButtonElement>('.msg-retry-btn');
      if (!btn) return;
      const action = btn.dataset.action;
      if (action === 'retry') {
        void handleRetryClick();
      } else if (action === 'undo') {
        void handleUndoClick();
      }
    });
  }
}

function refreshChatContent() {
  if (!activeConversationId && !pendingUserMessage && !transientSessionError) return;
  
  const conversation = activeConversationId
    ? conversations.find((c: Conversation) => c.id === activeConversationId)
    : undefined;
  
  const messageList = document.querySelector<HTMLDivElement>('#message-list');
  const topbarMain = document.querySelector<HTMLDivElement>('.main-topbar-main');

  if (topbarMain) {
    topbarMain.innerHTML = renderChatHeaderHtml(conversation);
    bindSessionIdCopyEvents();
  }

  updateSendButtonState();
  updateProjectDirDisplay();
  if (messageList) {
    const messages = buildDisplayMessages(conversation);
    messageList.innerHTML = renderConversationMessagesInnerHtml(messages);
    // 后处理：代码复制按钮、思考块折叠事件、消息复制控件
    setupMessageListPostRender(messageList);
    if (isSendButtonLoading()) {
      showPendingAssistantIndicator();
    } else {
      removePendingAssistantIndicator();
    }
    answerScroller?.scrollToBottom();
  }
}

function handleKeydown(e: KeyboardEvent) {
  // IME 组字中（如 macOS 拼音未选字）：Enter 用于上屏，不发送
  // keyCode 229 是部分浏览器/输入法在组字期间的兼容标识
  if (e.isComposing || e.keyCode === 229) {
    return;
  }
  // 文件建议列表可见且有待选项时，Enter 交给文件建议键盘处理逻辑（选择当前高亮项）
  const suggestionContainer = getFileSuggestionsContainer();
  if (suggestionContainer && suggestionContainer.style.display !== 'none' && e.key === 'Enter' && !e.shiftKey) {
    const activeIdx = getActiveSuggestionIndex();
    if (activeIdx >= 0) {
      // handleFileSuggestionKeydown 已注册在同一个 textarea 上，会处理选择逻辑
      return;
    }
  }
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    // 运行中也允许 Enter：有内容则入队，无内容不触发停止
    if (isSendButtonLoading() && !canSendMessage()) {
      return;
    }
    void sendMessage();
  }
}

function formatTime(timestamp: number): string {
  const date = new Date(timestamp * 1000);
  return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// 全局函数 - 用于 HTML 模板中调用
function selectConversation(id: string) {
  dismissApiConfigViewState();
  activeConversationId = id;
  invalidateFileCache();

  void refreshConversationFromBackend(id).then(() => {
    render();

    // render() 重建整个 DOM 后，必须立即根据目标会话的运行状态恢复按钮
    // 不能放在 setTimeout 中，否则中间可能有其他事件干扰
    const thisSessionRunning = runningSessions.has(id);
    setSendButtonLoading(thisSessionRunning);
    updateConversationListSpinner();
    refreshCommandQueueUI();

    setTimeout(() => {
      // 滚动到底部（ScrollController 会临时禁用 smooth 避免长动画）
      answerScroller?.scrollToBottom();
      // 如果切换到的会话正在流式输出，恢复流式 UI
      if (thisSessionRunning && streamingBySession.has(id)) {
        showPendingAssistantIndicator();
        refreshStreamingUI(id);
      }
    }, 50);
  });
}

async function deleteConversation(id: string) {
  const conversation = conversations.find((c) => c.id === id);
  if (!conversation) return;

  const confirmed = await showDeleteConfirm(conversation.title);
  if (!confirmed) return;

  try {
    await invoke('delete_conversation', {
      conversationId: id,
      sourcePath: conversation.source_path ?? null,
    });

    clearStreamingState(id);
    clearCommandQueue(id);
    pendingUserMessage = null;
    pendingUserMessageConvId = null;
    conversations = conversations.filter((c) => c.id !== id);

    if (activeConversationId === id) {
      activeConversationId = conversations.length > 0 ? conversations[0].id : '';
    }

    render();
  } catch (e) {
    console.error('Failed to delete conversation:', e);
    alert('删除会话失败: ' + String(e));
    await loadData();
    render();
  }
}

async function deleteWorkspaceConversations(workspacePath: string) {
  const { workspaces } = groupConversationsByWorkspace();
  const ws = workspaces.find((w) => w.path === workspacePath);
  console.log('[deleteWorkspace] path:', workspacePath, 'found:', !!ws, 'count:', ws?.conversations.length);
  if (!ws || ws.conversations.length === 0) return;

  const count = ws.conversations.length;
  const confirmed = await showConfirmDialog({
    title: '删除目录下所有会话',
    message: `确定要删除「${escapeHtml(ws.displayName)}」下的全部 ${count} 个会话吗？`,
    sub: `目录路径: ${escapeHtml(workspacePath)}\n此操作将永久删除所有会话记录及对应的 Claude 会话文件，且不可恢复。`,
    confirmLabel: '全部删除',
  });
  if (!confirmed) return;

  try {
    const deletedCount = await invoke<number>('delete_workspace_conversations', {
      projectDir: workspacePath,
    });
    console.log('[deleteWorkspace] deletedCount:', deletedCount);

    // 清理已删除会话的流式状态
    for (const conv of ws.conversations) {
      clearStreamingState(conv.id);
      runningSessions.delete(conv.id);
    }

    // 如果当前活跃会话属于被删除的工作区，切换到其他会话
    const deletedIds = new Set(ws.conversations.map((c) => c.id));
    if (activeConversationId && deletedIds.has(activeConversationId)) {
      activeConversationId = '';
      pendingUserMessage = null;
      pendingUserMessageConvId = null;
      transientSessionError = null;
    }

    await loadData();
    render();
    showCopyToastMsg(`已删除 ${deletedCount} 个会话`);
  } catch (e) {
    console.error('Failed to delete workspace conversations:', e);
    alert('删除目录会话失败: ' + String(e));
    await loadData();
    render();
  }
}

/** 会话标题转安全文件名 */
function sanitizeFileName(name: string): string {
  const cleaned = name.replace(/[\\/:*?"<>|\r\n]+/g, '_').replace(/\s+/g, ' ').trim();
  return (cleaned || 'conversation').slice(0, 80);
}

/** 把会话内容拼成 Markdown 文本 */
function buildConversationMarkdown(c: Conversation): string {
  const lines: string[] = [`# ${c.title || '未命名会话'}`, ''];

  lines.push(`- 会话 ID: \`${c.id}\``);
  if (c.project_dir) lines.push(`- 工作目录: \`${c.project_dir}\``);
  if (c.last_model) lines.push(`- 模型: \`${c.last_model}\``);
  if (c.created_at) lines.push(`- 创建时间: ${new Date(toMillis(c.created_at)).toLocaleString()}`);
  if (c.updated_at) lines.push(`- 更新时间: ${new Date(toMillis(c.updated_at)).toLocaleString()}`);
  lines.push('', '---', '');

  for (const msg of c.messages ?? []) {
    const role = msg.role === 'user' ? '用户' : msg.role === 'assistant' ? '助手' : msg.role;
    lines.push(`## ${role}`, '');

    if (msg.thinking?.trim()) {
      lines.push('<details><summary>思考过程</summary>', '', msg.thinking.trim(), '', '</details>', '');
    }
    if (msg.toolData?.toolName) {
      lines.push(`> 工具调用：\`${msg.toolData.toolName}\``, '');
    }
    if (msg.content?.trim()) {
      lines.push(msg.content.trim(), '');
    }
  }

  return lines.join('\n');
}

/** 导出单个会话为 Markdown 文件 */
async function exportConversationToMarkdown(id: string): Promise<void> {
  const conversation = conversations.find((c) => c.id === id);
  if (!conversation) return;

  // 列表中的会话可能没有完整消息，导出前先从后端取一次
  let full = conversation;
  try {
    const raw = await invoke<(Conversation & { projectDir?: string | null }) | null>('get_conversation', {
      conversationId: id,
    });
    if (raw) full = normalizeConversation(raw);
  } catch (e) {
    console.warn('Failed to load full conversation for export:', e);
  }

  try {
    const target = await save({
      title: '导出会话',
      defaultPath: `${sanitizeFileName(full.title)}.md`,
      filters: [{ name: 'Markdown', extensions: ['md'] }],
    });
    if (!target) return;

    const bytes = Array.from(new TextEncoder().encode(buildConversationMarkdown(full)));
    await invoke('write_file_bytes', { filePath: target, data: bytes });
    showCopyToastMsg('已导出会话');
  } catch (e) {
    console.error('Failed to export conversation:', e);
    alert('导出会话失败: ' + String(e));
  }
}

// 编辑会话功能
function startEdit(id: string) {
  editingConversationId = id;
  render();
}

function cancelEdit() {
  editingConversationId = null;
  render();
}

async function saveEdit(id: string) {
  const input = document.querySelector(`#edit-input-${id}`) as HTMLInputElement;
  if (!input) return;

  const conversation = conversations.find((c) => c.id === id);
  const newTitle = input.value.trim();
  if (!newTitle) {
    cancelEdit();
    return;
  }

  try {
    await invoke('update_conversation_title', {
      conversationId: id,
      title: newTitle,
      sourcePath: conversation?.source_path ?? null,
    });

    if (conversation) {
      conversation.title = newTitle;
    }

    editingConversationId = null;
    render();
  } catch (e) {
    console.error('Failed to update title:', e);
    alert('修改标题失败: ' + String(e));
  }
}

function handleEditKeydown(e: KeyboardEvent, id: string) {
  if (e.key === 'Enter') {
    e.preventDefault();
    void saveEdit(id);
  } else if (e.key === 'Escape') {
    e.preventDefault();
    cancelEdit();
  }
}

// ── @file 引用功能 ──────────────────────────────────────────────────
let _cachedFileList: string[] | null = null;
let _cachedProjectDir = '';

// ── 粘贴图片附件 ────────────────────────────────────────────────────
let pasteAttachments: { path: string; name: string; objectUrl: string }[] = [];

function getPasteUploadsDir(): string {
  const dir = getEffectiveProjectDir();
  return dir.endsWith('/') ? dir + '.clipboard-uploads' : dir + '/.clipboard-uploads';
}

async function handlePaste(e: ClipboardEvent) {
  const items = e.clipboardData?.items;
  if (!items) return;

  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    if (item.type.startsWith('image/')) {
      e.preventDefault();
      const blob = item.getAsFile();
      if (!blob) continue;

      const ext = item.type === 'image/png' ? 'png' : item.type === 'image/gif' ? 'gif' : item.type === 'image/webp' ? 'webp' : 'jpg';
      const fileName = `pasted-${Date.now()}-${i}.${ext}`;
      const uploadsDir = getPasteUploadsDir();
      const filePath = `${uploadsDir}/${fileName}`;

      try {
        const buf = await blob.arrayBuffer();
        await invoke('write_file_bytes', { filePath, data: Array.from(new Uint8Array(buf)) });

        const objectUrl = URL.createObjectURL(new Blob([buf], { type: item.type }));
        pasteAttachments.push({ path: `.clipboard-uploads/${fileName}`, name: fileName, objectUrl });
        renderPasteAttachmentsBar();
      } catch (e) {
        console.error('Failed to save pasted image:', e);
      }
    }
  }
}

function renderPasteAttachmentsBar() {
  const bar = document.querySelector('#paste-attachments-bar');
  if (!bar) return;

  if (pasteAttachments.length === 0) {
    (bar as HTMLElement).style.display = 'none';
    bar.innerHTML = '';
    return;
  }

  (bar as HTMLElement).style.display = 'flex';
  bar.innerHTML = pasteAttachments
    .map(
      (att, idx) => `
      <div class="paste-attachment-thumb" data-idx="${idx}">
        <img src="${att.objectUrl}" alt="${escapeHtml(att.name)}" />
        <button type="button" class="paste-attachment-remove" data-idx="${idx}" title="移除" aria-label="移除附件">×</button>
      </div>`,
    )
    .join('');

  bar.querySelectorAll('.paste-attachment-remove').forEach((btn) => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const idx = parseInt((btn as HTMLElement).dataset.idx || '');
      if (!isNaN(idx) && pasteAttachments[idx]) {
        URL.revokeObjectURL(pasteAttachments[idx].objectUrl);
        pasteAttachments.splice(idx, 1);
        renderPasteAttachmentsBar();
      }
    });
  });

  bar.querySelectorAll('.paste-attachment-thumb').forEach((thumb) => {
    thumb.addEventListener('click', () => {
      const idx = parseInt((thumb as HTMLElement).dataset.idx || '');
      if (!isNaN(idx) && pasteAttachments[idx]) {
        openImageLightbox(pasteAttachments[idx].objectUrl);
      }
    });
  });
}

function clearPasteAttachments() {
  pasteAttachments.forEach((att) => URL.revokeObjectURL(att.objectUrl));
  pasteAttachments = [];
  renderPasteAttachmentsBar();
}

// ── @File[] 引用格式辅助函数 ────────────────────────────────────────

/** 将原始路径包装为 @File[path] 引用，去除 Windows canonicalize 产生的 \\?\ 前缀 */
function wrapFileRef(path: string): string {
  const cleanPath = path.replace(/^\\\\\?\\/, '');
  return `@File[${cleanPath}]`;
}

/** 从 @File[path] 引用中提取路径 */
function unwrapFileRef(ref: string): string {
  const m = ref.match(/^@File\[(.+)]$/);
  return m ? m[1] : ref;
}

/** 解析文本中所有 @File[path] 引用，返回 FileRef 数组 */
function parseFileRefs(text: string): FileRef[] {
  const results: FileRef[] = [];
  const pattern = /@File\[([^\]]+)]/g;
  let match;
  while ((match = pattern.exec(text)) !== null) {
    const path = match[1];
    results.push({ path: path.replace(/\/$/, ''), isImage: isImageFile(path) });
  }
  return results;
}

/** 从显示文本中剥离 @File[path] 引用 */
function stripFileRefTags(text: string): string {
  return text.replace(/@File\[[^\]]+]\s*/g, '').replace(/\s{2,}/g, ' ').trim();
}

// ── 导入/拖放文件预览栏 ────────────────────────────────────────────
interface ImportedFileRef {
  ref: string;       // @File[path] 格式的引用文本
  fileName: string;  // 显示的文件名
  isImage: boolean;
  isDir: boolean;
}
let importedFileRefs: ImportedFileRef[] = [];

function addImportedFileRef(entry: ImportedFileRef): void {
  // 避免重复
  if (importedFileRefs.some((e) => e.ref === entry.ref)) return;
  importedFileRefs.push(entry);
  renderImportedFileBar();
}

function renderImportedFileBar(): void {
  const bar = document.querySelector('#imported-file-bar');
  if (!bar) return;

  if (importedFileRefs.length === 0) {
    (bar as HTMLElement).style.display = 'none';
    bar.innerHTML = '';
    return;
  }

  (bar as HTMLElement).style.display = 'flex';
  bar.innerHTML = importedFileRefs
    .map((entry, idx) => {
      const rawPath = unwrapFileRef(entry.ref);
      const ext = entry.fileName.split('.').pop()?.toLowerCase() || '';
      const icon = entry.isDir ? '📁' : (entry.isImage ? '🖼️' : (ext === 'pdf' ? '📕' : '📄'));
      return `
        <div class="imported-file-card" data-idx="${idx}" title="${escapeHtml(rawPath)}">
          <span class="imported-file-card-icon">${icon}</span>
          <span class="imported-file-card-name">${escapeHtml(entry.fileName)}</span>
          <button type="button" class="imported-file-remove" data-idx="${idx}" title="移除" aria-label="移除附件">×</button>
        </div>`;
    })
    .join('');

  // 移除按钮事件
  bar.querySelectorAll('.imported-file-remove').forEach((btn) => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const idx = parseInt((btn as HTMLElement).dataset.idx || '');
      if (!isNaN(idx) && importedFileRefs[idx]) {
        removeImportedFileRef(idx);
      }
    });
  });

  // 双击卡片预览（图片 / txt）
  bar.querySelectorAll('.imported-file-card').forEach((card) => {
    card.addEventListener('dblclick', () => {
      const idx = parseInt((card as HTMLElement).dataset.idx || '');
      if (!isNaN(idx) && importedFileRefs[idx]) {
        void previewImportedFile(idx);
      }
    });
  });
}

function removeImportedFileRef(idx: number): void {
  const entry = importedFileRefs[idx];
  if (!entry) return;
  importedFileRefs.splice(idx, 1);
  renderImportedFileBar();
  updateSendButtonState();
}

function clearImportedFileRefs(): void {
  importedFileRefs = [];
  renderImportedFileBar();
}

async function previewImportedFile(idx: number): Promise<void> {
  const entry = importedFileRefs[idx];
  if (!entry) return;
  if (entry.isDir) return;

  const filePath = unwrapFileRef(entry.ref);

  if (entry.isImage) {
    try {
      const mime = getImageMime(filePath);
      const b64 = await invoke<string>('read_file_base64', { filePath });
      openImageLightbox(`data:${mime};base64,${b64}`);
    } catch (e) {
      console.error('加载图片预览失败:', e);
    }
    return;
  }

  const ext = filePath.split('.').pop()?.toLowerCase() || '';

  if (ext === 'pdf') {
    try {
      await openPdfPreview(filePath, entry.fileName);
    } catch (e) {
      console.error('预览 PDF 失败:', e);
    }
    return;
  }

  // 已知二进制文件不支持内嵌预览，不响应双击
  if (isOtherBinaryFile(filePath)) return;

  // 其余文本类文件（md / csv / json / yaml / 代码等）统一当文本预览
  try {
    const content = await invoke<string>('read_file_content', { filePath });
    openTextPreview(content, entry.fileName);
  } catch (e) {
    console.error('读取文件失败:', e);
  }
}

function openTextPreview(content: string, fileName: string) {
  const existing = document.querySelector('#text-preview-overlay');
  if (existing) existing.remove();

  const overlay = document.createElement('div');
  overlay.id = 'text-preview-overlay';
  overlay.className = 'text-preview-overlay';
  overlay.innerHTML = `
    <div class="text-preview-dialog">
      <div class="text-preview-header">
        <span class="text-preview-title">${escapeHtml(fileName)}</span>
        <button type="button" class="text-preview-close" title="关闭" aria-label="关闭预览">×</button>
      </div>
      <pre class="text-preview-content">${escapeHtml(content)}</pre>
    </div>
  `;

  const close = () => {
    overlay.remove();
    document.removeEventListener('keydown', onKey);
  };

  overlay.querySelector('.text-preview-close')?.addEventListener('click', close);
  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) close();
  });

  const onKey = (e: KeyboardEvent) => {
    if (e.key === 'Escape') close();
  };
  document.addEventListener('keydown', onKey);

  document.body.appendChild(overlay);
}

async function openPdfPreview(filePath: string, fileName: string): Promise<void> {
  const existing = document.querySelector('#pdf-preview-overlay');
  if (existing) existing.remove();

  let pdfDataUrl = '';
  try {
    const b64 = await invoke<string>('read_file_base64', { filePath });
    pdfDataUrl = `data:application/pdf;base64,${b64}`;
  } catch (e) {
    console.error('读取 PDF 失败:', e);
    return;
  }

  const overlay = document.createElement('div');
  overlay.id = 'pdf-preview-overlay';
  overlay.className = 'pdf-preview-overlay';
  overlay.innerHTML = `
    <div class="pdf-preview-dialog">
      <div class="pdf-preview-header">
        <span class="pdf-preview-title">${escapeHtml(fileName)}</span>
        <button type="button" class="pdf-preview-close" title="关闭" aria-label="关闭预览">×</button>
      </div>
      <iframe src="${pdfDataUrl}" class="pdf-preview-frame"></iframe>
    </div>
  `;

  const close = () => {
    overlay.remove();
    document.removeEventListener('keydown', onKey);
  };

  overlay.querySelector('.pdf-preview-close')?.addEventListener('click', close);
  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) close();
  });

  const onKey = (e: KeyboardEvent) => {
    if (e.key === 'Escape') close();
  };
  document.addEventListener('keydown', onKey);

  document.body.appendChild(overlay);
}

function openImageLightbox(src: string) {
  const existing = document.querySelector('#image-lightbox');
  if (existing) existing.remove();

  const overlay = document.createElement('div');
  overlay.id = 'image-lightbox';
  overlay.className = 'image-lightbox';
  overlay.innerHTML = `<img src="${src}" alt="预览" />`;
  overlay.addEventListener('click', () => overlay.remove());
  document.body.appendChild(overlay);

  // ESC 关闭
  const onKey = (e: KeyboardEvent) => {
    if (e.key === 'Escape') {
      overlay.remove();
      document.removeEventListener('keydown', onKey);
    }
  };
  document.addEventListener('keydown', onKey);
}

async function loadProjectFiles(): Promise<string[]> {
  const dir = getEffectiveProjectDir();
  if (!dir) return [];
  if (_cachedFileList !== null && _cachedProjectDir === dir) {
    return _cachedFileList;
  }
  try {
    const files = await invoke<string[]>('list_project_files', { projectDir: dir });
    _cachedFileList = files;
    _cachedProjectDir = dir;
    return files;
  } catch (e) {
    console.error('Failed to list project files:', e);
    return [];
  }
}

function invalidateFileCache() {
  _cachedFileList = null;
  _cachedProjectDir = '';
}

function getFileSuggestionsContainer(): HTMLDivElement | null {
  return document.querySelector('#file-suggestions');
}

function showFileSuggestions(files: string[], filter: string) {
  const container = getFileSuggestionsContainer();
  if (!container || files.length === 0) {
    hideFileSuggestions();
    return;
  }

  const lFilter = filter.toLowerCase();
  const filtered = lFilter
    ? files.filter((f) => f.toLowerCase().includes(lFilter)).slice(0, 100)
    : files.slice(0, 100);

  if (filtered.length === 0) {
    hideFileSuggestions();
    return;
  }

  container.innerHTML = filtered
    .map(
      (f, i) => {
        const isDir = f.endsWith('/');
        const displayPath = isDir ? f.slice(0, -1) : f;
        return `<div class="file-suggestion-item${i === 0 ? ' active' : ''}${isDir ? ' file-suggestion-item--dir' : ''}" data-path="${escapeHtml(f)}">
          <span class="file-suggestion-icon">${getFileSuggestionIcon(f)}</span>
          <span class="file-suggestion-path">${escapeHtml(displayPath)}</span>
        </div>`;
      },
    )
    .join('');

  container.style.display = 'block';

  // 绑定点击事件
  container.querySelectorAll('.file-suggestion-item').forEach((item) => {
    item.addEventListener('mousedown', (e) => {
      e.preventDefault(); // 阻止 blur 先触发
      const path = (item as HTMLElement).dataset.path || '';
      insertFileReference(path);
      hideFileSuggestions();
    });
  });
}

function hideFileSuggestions() {
  const container = getFileSuggestionsContainer();
  if (container) {
    container.style.display = 'none';
    container.innerHTML = '';
  }
}

/**
 * 剥离用户消息中的 @文件路径引用（用于展示）。
 * 只匹配含路径分隔符（/ 或 \）的 @引用，保留普通 @提及（如 @someone）。
 */
function stripFileRefsFromDisplay(text: string): string {
  return text.replace(/@[^\s@]*[/\\][^\s@]*/g, '').replace(/\s{2,}/g, ' ').trim();
}

/**
 * 根据文件路径判断文件类型，用于图标展示
 */
function isImageFile(filePath: string): boolean {
  const ext = filePath.split('.').pop()?.toLowerCase() || '';
  return ['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'bmp', 'ico', 'avif'].includes(ext);
}

function isOtherBinaryFile(filePath: string): boolean {
  const ext = filePath.split('.').pop()?.toLowerCase() || '';
  return ['pdf', 'zip', 'tar', 'gz', '7z', 'rar', 'mp4', 'mp3', 'mov', 'avi',
    'woff', 'woff2', 'ttf', 'eot', 'otf', 'exe', 'dll', 'so', 'dylib',
    'class', 'jar', 'war', 'wasm', 'bin', 'dat', 'db', 'sqlite',
    'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx', 'pages', 'numbers', 'key',
  ].includes(ext);
}

function getFileSuggestionIcon(filePath: string): string {
  // 目录
  if (filePath.endsWith('/')) return '📁';
  // 图片
  if (isImageFile(filePath)) return '🖼️';
  // 已知二进制
  if (isOtherBinaryFile(filePath)) return '📎';
  // 默认文本
  return '📄';
}

function getImageMime(filePath: string): string {
  const ext = filePath.split('.').pop()?.toLowerCase() || 'png';
  const mimeMap: Record<string, string> = {
    png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg',
    gif: 'image/gif', webp: 'image/webp', svg: 'image/svg+xml',
    bmp: 'image/bmp', ico: 'image/x-icon', avif: 'image/avif',
  };
  return mimeMap[ext] || 'image/png';
}

/** 消息中文件引用芯片的双击预览（与导入卡片复用同一套预览逻辑） */
async function previewFileByPath(rawPath: string): Promise<void> {
  const fullPath = resolveFilePath(rawPath);
  const fileName = rawPath.replace(/\/$/, '').split(/[/\\]/).pop() || rawPath;

  if (isImageFile(rawPath)) {
    try {
      const mime = getImageMime(rawPath);
      const b64 = await invoke<string>('read_file_base64', { filePath: fullPath });
      openImageLightbox(`data:${mime};base64,${b64}`);
    } catch (e) {
      console.error('加载图片预览失败:', e);
    }
    return;
  }

  const ext = rawPath.split('.').pop()?.toLowerCase() || '';

  if (ext === 'pdf') {
    try {
      await openPdfPreview(fullPath, fileName);
    } catch (e) {
      console.error('预览 PDF 失败:', e);
    }
    return;
  }

  if (isOtherBinaryFile(rawPath)) return;

  try {
    const content = await invoke<string>('read_file_content', { filePath: fullPath });
    openTextPreview(content, fileName);
  } catch (e) {
    console.error('读取文件失败:', e);
  }
}

function getActiveSuggestionIndex(): number {
  const container = getFileSuggestionsContainer();
  if (!container) return -1;
  const items = container.querySelectorAll('.file-suggestion-item');
  for (let i = 0; i < items.length; i++) {
    if (items[i].classList.contains('active')) return i;
  }
  return -1;
}

function selectSuggestion(index: number) {
  const container = getFileSuggestionsContainer();
  if (!container) return;
  const items = container.querySelectorAll('.file-suggestion-item');
  items.forEach((item) => item.classList.remove('active'));
  if (index >= 0 && index < items.length) {
    items[index].classList.add('active');
    items[index].scrollIntoView({ block: 'nearest' });
  }
}

function getCurrentAtFilter(): { before: string; filter: string } | null {
  const textarea = document.querySelector<HTMLTextAreaElement>('#message-input');
  if (!textarea) return null;

  const value = textarea.value;
  const cursorPos = textarea.selectionStart;
  const textBeforeCursor = value.substring(0, cursorPos);

  // 找到最后一个 @ 的位置（不在已完成的 @path 后面的）
  const lastAtIndex = textBeforeCursor.lastIndexOf('@');
  if (lastAtIndex === -1) return null;

  // @ 后面不能有空格、换行
  const afterAt = textBeforeCursor.substring(lastAtIndex + 1);
  if (afterAt.includes(' ') || afterAt.includes('\n') || afterAt.includes('@')) return null;

  return {
    before: textBeforeCursor.substring(0, lastAtIndex),
    filter: afterAt,
  };
}

async function handleFileSuggestionInput() {
  const atInfo = getCurrentAtFilter();
  if (!atInfo) {
    hideFileSuggestions();
    return;
  }

  const files = await loadProjectFiles();
  showFileSuggestions(files, atInfo.filter);
}

function insertFileReference(filePath: string) {
  const textarea = document.querySelector<HTMLTextAreaElement>('#message-input');
  if (!textarea) return;

  const atInfo = getCurrentAtFilter();
  if (!atInfo) return;

  const value = textarea.value;
  const cursorPos = textarea.selectionStart;
  const textAfter = value.substring(cursorPos);

  textarea.value = atInfo.before + '@' + filePath + ' ' + textAfter;

  // 将光标移到插入内容之后
  const newCursorPos = atInfo.before.length + filePath.length + 2; // @ + path + space
  textarea.setSelectionRange(newCursorPos, newCursorPos);
  textarea.focus();
  updateSendButtonState();
}

function handleFileSuggestionKeydown(e: KeyboardEvent) {
  const container = getFileSuggestionsContainer();
  if (!container || container.style.display === 'none') return;

  if (e.key === 'ArrowDown') {
    e.preventDefault();
    const idx = getActiveSuggestionIndex();
    const items = container.querySelectorAll('.file-suggestion-item');
    const nextIdx = idx < items.length - 1 ? idx + 1 : 0;
    selectSuggestion(nextIdx);
  } else if (e.key === 'ArrowUp') {
    e.preventDefault();
    const idx = getActiveSuggestionIndex();
    const items = container.querySelectorAll('.file-suggestion-item');
    const prevIdx = idx > 0 ? idx - 1 : items.length - 1;
    selectSuggestion(prevIdx);
  } else if (e.key === 'Enter' || e.key === 'Tab') {
    // IME 组字中回车用于上屏，不插入文件引用
    if (e.isComposing || e.keyCode === 229) {
      return;
    }
    const idx = getActiveSuggestionIndex();
    const items = container.querySelectorAll('.file-suggestion-item');
    if (idx >= 0 && idx < items.length) {
      e.preventDefault();
      const path = (items[idx] as HTMLElement).dataset.path || '';
      insertFileReference(path);
      hideFileSuggestions();
    }
  } else if (e.key === 'Escape') {
    e.preventDefault();
    hideFileSuggestions();
  }
}

// ── 导入外部文件/文件夹 ─────────────────────────────────────────────
function showImportMenu(anchor: HTMLElement): void {
  // 关闭已存在的菜单
  document.querySelector('.import-menu-overlay')?.remove();

  const rect = anchor.getBoundingClientRect();
  const overlay = document.createElement('div');
  overlay.className = 'profile-context-menu-overlay import-menu-overlay';
  overlay.innerHTML = `
    <div class="profile-context-menu" role="menu">
      <button type="button" class="profile-context-menu-item" data-action="file">导入文件</button>
      <button type="button" class="profile-context-menu-item" data-action="folder">导入文件夹</button>
    </div>
  `;

  const close = () => {
    overlay.remove();
    document.removeEventListener('keydown', onKeyDown);
  };
  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key === 'Escape') close();
  };
  overlay.addEventListener('click', (event) => {
    if (event.target === overlay) close();
  });
  overlay.querySelector('[data-action="file"]')?.addEventListener('click', () => {
    close();
    void handleImportExternalFile();
  });
  overlay.querySelector('[data-action="folder"]')?.addEventListener('click', () => {
    close();
    void handleImportExternalFolder();
  });

  document.addEventListener('keydown', onKeyDown);
  document.body.appendChild(overlay);

  // 默认弹在按钮上方；空间不够则改为下方
  const menu = overlay.querySelector('.profile-context-menu') as HTMLElement | null;
  if (menu) {
    const menuRect = menu.getBoundingClientRect();
    let top = rect.top - menuRect.height - 6;
    let left = rect.left;
    if (top < 8) top = rect.bottom + 6;
    if (left + menuRect.width > window.innerWidth) {
      left = Math.max(8, window.innerWidth - menuRect.width - 8);
    }
    menu.style.left = `${left}px`;
    menu.style.top = `${top}px`;
  }
}

async function handleImportExternalFile(): Promise<void> {
  const projectDir = getEffectiveProjectDir();
  if (!projectDir) {
    showCopyToastMsg('请先选择工作目录');
    return;
  }

  const textarea = document.querySelector<HTMLTextAreaElement>('#message-input');
  if (!textarea) return;

  try {
    const selected = await open({
      directory: false,
      multiple: true,
      title: '选择要导入的文件',
    });
    if (!selected) return;

    const paths = Array.isArray(selected) ? selected : [selected];
    const importedRefs: string[] = [];

    for (const filePath of paths) {
      try {
        const result = await invoke<ImportResult>('import_external_path', {
          source: filePath,
          projectDir,
        });
        // 直接使用绝对路径引用，不再复制文件
        importedRefs.push(result.absolute_path);
      } catch (err) {
        console.error('[import] 导入文件失败:', filePath, err);
      }
    }

    if (importedRefs.length > 0) {
      showCopyToastMsg(`已引用 ${importedRefs.length} 个文件`);
      updateSendButtonState();

      // 添加到预览栏
      for (const ref of importedRefs) {
        const isImg = isImageFile(ref);
        const parts = ref.replace(/\/$/, '').split(/[/\\]/).filter(Boolean);
        const fileName = parts[parts.length - 1] || ref;
        const refStr = wrapFileRef(ref);
        addImportedFileRef({ ref: refStr, fileName, isImage: isImg, isDir: false });
      }
    }
  } catch (err) {
    console.error('[import] 选择文件失败:', err);
  }
}

async function handleImportExternalFolder(): Promise<void> {
  const projectDir = getEffectiveProjectDir();
  if (!projectDir) {
    showCopyToastMsg('请先选择工作目录');
    return;
  }

  const textarea = document.querySelector<HTMLTextAreaElement>('#message-input');
  if (!textarea) return;

  try {
    const selected = await open({
      directory: true,
      multiple: false,
      title: '选择要导入的文件夹',
    });
    if (!selected || typeof selected !== 'string') return;

    const result = await invoke<ImportResult>('import_external_path', {
      source: selected,
      projectDir,
    });

    // 直接使用绝对路径引用，文件夹追加 / 后缀
    const ref = `${result.absolute_path}/`;
    updateSendButtonState();
    showCopyToastMsg('已引用文件夹');

    // 添加到预览栏
    const parts = ref.replace(/\/$/, '').split(/[/\\]/).filter(Boolean);
    const dirName = (parts[parts.length - 1] || ref) + '/';
    addImportedFileRef({ ref: wrapFileRef(ref), fileName: dirName, isImage: false, isDir: true });
  } catch (err) {
    console.error('[import] 导入文件夹失败:', err);
    showCopyToastMsg('导入文件夹失败');
  }
}

// ── 拖拽文件自动引用 ────────────────────────────────────────────────
let _lastDropTime = 0;
let _unlistenDragDrop: (() => void) | null = null;

async function bindDragDropFileRefs() {
  // 避免重复注册监听器
  if (_unlistenDragDrop) _unlistenDragDrop();
  const win = getCurrentWebviewWindow();

  _unlistenDragDrop = await win.onDragDropEvent(async (event) => {
    const dropTarget = document.querySelector('.main-content');

    if (event.payload.type === 'over') {
      dropTarget?.classList.add('drag-over');
    } else if (event.payload.type === 'leave') {
      dropTarget?.classList.remove('drag-over');
    } else if (event.payload.type === 'drop') {
      dropTarget?.classList.remove('drag-over');

      // 防止同一拖放操作重复触发（300ms 内忽略重复 drop）
      const now = Date.now();
      if (now - _lastDropTime < 300) return;
      _lastDropTime = now;

      const paths = event.payload.paths;
      if (!paths || paths.length === 0) return;

      const projectDir = getEffectiveProjectDir();
      if (!projectDir) {
        showCopyToastMsg('请先选择工作目录');
        return;
      }

      const projectFiles = await loadProjectFiles();
      const textarea = document.querySelector<HTMLTextAreaElement>('#message-input');
      if (!textarea) return;

      const refs: string[] = [];

      for (const fullPath of paths) {
        const normalizedPath = fullPath.replace(/\\/g, '/');
        const normalizedProjectDir = projectDir.replace(/\\/g, '/');
        const segments = normalizedPath.split('/').filter(Boolean);
        const fileName = segments[segments.length - 1] || '';

        // 按文件名匹配项目文件列表
        const matches = projectFiles.filter((f) => {
          const parts = f.split('/');
          return parts[parts.length - 1] === fileName;
        });

        if (matches.length === 1) {
          if (!refs.includes(matches[0])) refs.push(matches[0]);
        } else if (matches.length > 1) {
          const shortest = matches.reduce((a, b) => (a.length <= b.length ? a : b));
          if (!refs.includes(shortest)) refs.push(shortest);
        } else if (normalizedPath.startsWith(normalizedProjectDir)) {
          // 项目内文件（含 target/ 等被索引跳过的目录）→ 相对路径
          const relPath = normalizedPath.slice(normalizedProjectDir.length).replace(/^\//, '');
          if (relPath && !refs.includes(relPath)) refs.push(relPath);
        } else {
          // 外部文件/文件夹 → 验证后使用绝对路径
          try {
            const result = await invoke<ImportResult>(
              'import_external_path',
              { source: fullPath, projectDir }
            );
            const absRef = result.is_dir ? `${result.absolute_path}/` : result.absolute_path;
            if (!refs.includes(absRef)) refs.push(absRef);
          } catch (err) {
            console.error('[drop] 引用外部文件失败:', fullPath, err);
          }
        }
      }

      if (refs.length > 0) {
        updateSendButtonState();
        showCopyToastMsg(`已引用 ${refs.length} 个文件`);

        // 添加到预览栏
        for (const ref of refs) {
          const isDir = ref.endsWith('/');
          const isImg = isImageFile(ref);
          const cleanPath = ref.replace(/\/$/, '');
          const parts = cleanPath.split(/[/\\]/).filter(Boolean);
          const fileName = isDir ? (parts[parts.length - 1] || ref) + '/' : (parts[parts.length - 1] || ref);

          const refStr = wrapFileRef(ref);
          addImportedFileRef({ ref: refStr, fileName, isImage: isImg, isDir });
        }
      }
    }
  });
}

function showCopyToastMsg(msg: string): void {
  const existing = document.querySelector('.copy-toast');
  if (existing) existing.remove();

  const toast = document.createElement('div');
  toast.className = 'copy-toast';
  toast.innerHTML = `
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
      <polyline points="20 6 9 17 4 12"/>
    </svg>
    ${escapeHtml(msg)}
  `;
  document.body.appendChild(toast);

  requestAnimationFrame(() => {
    toast.classList.add('copy-toast--visible');
  });

  setTimeout(() => {
    toast.classList.remove('copy-toast--visible');
    setTimeout(() => toast.remove(), 300);
  }, 2000);
}

/**
 * 解析 prompt 中的 @file 引用。
 * - 文本文件：尝试读取内容拼入 prompt
 * - 图片/二进制/目录：保留 @path 引用让 CLI 处理
 * 返回 { prompt, displayPrompt, refs }：
 *   prompt        — 发给 CLI 的最终内容（含嵌入的文件文本和 @引用）
 *   displayPrompt — 用于消息气泡展示的干净文本（已剥离已解析的 @path 引用）
 *   refs          — 匹配到的文件引用列表
 */
async function resolveFileReferences(prompt: string): Promise<{ prompt: string; displayPrompt: string; refs: FileRef[] }> {
  const atPattern = /@([^\s@]+)/g;
  const rawRefs: string[] = [];
  let match: RegExpExecArray | null;
  const files = await loadProjectFiles();

  while ((match = atPattern.exec(prompt)) !== null) {
    rawRefs.push(match[1]);
  }

  if (rawRefs.length === 0) return { prompt, displayPrompt: prompt, refs: [] };

  const projectDir = getEffectiveProjectDir();

  // 分离：项目索引文件 vs 绝对路径 vs 其他（可能是未索引的项目内文件）
  const projectRefs = rawRefs.filter((ref) => files.some((f) => f === ref));
  const absoluteRefs = rawRefs.filter((ref) => isAbsolutePath(ref) && !projectRefs.includes(ref));
  const remainingRefs = rawRefs.filter((ref) => !projectRefs.includes(ref) && !absoluteRefs.includes(ref));

  // 没有任何匹配的引用，直接返回
  if (projectRefs.length === 0 && absoluteRefs.length === 0 && remainingRefs.length === 0) return { prompt, displayPrompt: prompt, refs: [] };
  if (projectRefs.length > 0 && !projectDir) return { prompt, displayPrompt: prompt, refs: [] };

  const fileRefs: FileRef[] = [];
  const embeddedContents: string[] = [];
  const unresolvedRefs: string[] = [];

  // ── 处理项目相对路径引用（嵌入文本文件内容） ──
  if (projectRefs.length > 0) {
    const dir = projectDir!.endsWith('/') ? projectDir! : projectDir! + '/';
    for (const ref of projectRefs) {
      const isDir = ref.endsWith('/');
      const isImg = isImageFile(ref);
      fileRefs.push({ path: ref, isImage: isImg || isDir });

      if (isDir) {
        unresolvedRefs.push(ref);
        continue;
      }
      if (isImg || isOtherBinaryFile(ref)) {
        unresolvedRefs.push(ref);
        continue;
      }

      try {
        const fullPath = dir + ref;
        const content = await invoke<string>('read_file_content', { filePath: fullPath });
        embeddedContents.push(`--- File: ${ref} ---\n${content}\n---\n`);
      } catch {
        unresolvedRefs.push(ref);
      }
    }
  }

  // ── 处理绝对路径引用（直接保留 @引用，由 CLI 自行读取文件） ──
  for (const ref of absoluteRefs) {
    const isDir = ref.endsWith('/');
    const isImg = isImageFile(ref);
    fileRefs.push({ path: ref, isImage: isImg || isDir });
    unresolvedRefs.push(ref);
  }

  // ── 处理未索引的项目相对路径（如 target/ 内的文件） ──
  for (const ref of remainingRefs) {
    if (projectDir) {
      const dir = projectDir.endsWith('/') ? projectDir : projectDir + '/';
      const fullPath = dir + ref;
      // 尝试读取验证文件是否存在
      try {
        await invoke<string>('read_file_content', { filePath: fullPath });
        // 文件存在 → 显示芯片，保留 @引用让 CLI 读取
        fileRefs.push({ path: ref, isImage: false });
        unresolvedRefs.push(ref);
      } catch {
        // 文件不存在，忽略（可能是其他 @ 语法如 @mention）
      }
    }
  }

  // ── 组装最终 prompt ──
  let cleanedPrompt = prompt;
  // 去掉项目相对路径的 @file 引用标签（内容已嵌入）
  for (const ref of projectRefs) {
    cleanedPrompt = cleanedPrompt.replace(new RegExp(`@${ref.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*`, 'g'), '');
  }
  // 绝对路径不剥离 @引用，留给 CLI 处理
  cleanedPrompt = cleanedPrompt.trim();

  let finalPrompt = embeddedContents.join('\n');
  if (finalPrompt) finalPrompt += '\n';
  if (unresolvedRefs.length > 0) {
    finalPrompt += unresolvedRefs.map((r) => `@${r}`).join(' ') + '\n';
  }
  finalPrompt += cleanedPrompt;

  // ── 生成展示用文本：剥离所有已解析的 @path 引用（芯片已展示文件信息） ──
  let displayContent = prompt;
  const resolvedRemainingRefs = remainingRefs.filter((ref) =>
    fileRefs.some((fr) => fr.path === ref)
  );
  for (const ref of [...projectRefs, ...absoluteRefs, ...resolvedRemainingRefs]) {
    const escaped = ref.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    displayContent = displayContent.replace(new RegExp(`@${escaped}\\s*`, 'g'), '');
  }
  displayContent = displayContent.trim();

  return { prompt: finalPrompt, displayPrompt: displayContent, refs: fileRefs };
}

/** 检测字符串是否为绝对路径（Unix: 以 / 开头；Windows: 以盘符开头如 C:\ 或 C:/） */
function isAbsolutePath(p: string): boolean {
  // Unix 绝对路径
  if (p.startsWith('/')) return true;
  // Windows 绝对路径: 盘符 + :\ 或 :/
  if (/^[A-Za-z]:[\\/]/.test(p)) return true;
  // Windows UNC 路径: \\
  if (p.startsWith('\\\\')) return true;
  return false;
}

/** 将文件路径解析为可读取的绝对路径（相对路径自动拼接项目目录） */
function resolveFilePath(filePath: string): string {
  if (isAbsolutePath(filePath)) return filePath;
  const dir = getEffectiveProjectDir();
  if (!dir) return filePath;
  return (dir.endsWith('/') ? dir : dir + '/') + filePath;
}

init();
