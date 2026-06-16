import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { open } from '@tauri-apps/plugin-dialog';
import { renderMarkdown as _renderMarkdown } from './markdown';

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

interface PlatformConfig {
  name: string;
  command: string;
  args: string[];
  env_vars: Record<string, string>;
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
const CONVERSATION_MODELS_KEY = 'codemanager-conversation-models';
const SIDEBAR_WIDTH_STORAGE_KEY = 'codemanager-sidebar-width';
const SIDEBAR_COLLAPSED_STORAGE_KEY = 'codemanager-sidebar-collapsed';
const DEFAULT_SIDEBAR_WIDTH = 184;
const LEGACY_DEFAULT_SIDEBAR_WIDTH = 320;
const MIN_SIDEBAR_WIDTH = 160;
const MIN_MAIN_CONTENT_WIDTH = 300;
const SIDEBAR_RESIZER_WIDTH = 4;

interface StreamingState {
  thinking: string;
  content: string;
  thinkingDone: boolean;
}

let conversations: Conversation[] = [];
let platforms: Record<string, PlatformConfig> = {};
let currentPlatform = '';
let activeConversationId = '';
let editingConversationId: string | null = null;
let currentTime = new Date();
let pendingUserMessage: string | null = null;
/** pendingUserMessage 所属的会话 ID（确保消息不串会话） */
let pendingUserMessageConvId: string | null = null;
let transientSessionError: string | null = null;
let chatModelOptions: string[] = [];
let conversationModels: Record<string, string> = loadConversationModels();
/** 新会话尚未创建 ID 时，用户在聊天区临时选择的模型 */
let pendingSessionModel: string | null = null;
let compactingConversationId: string | null = null;
/** 新会话尚未创建 ID 时，用户选择的工作目录 */
let pendingProjectDir: string | null = null;
let chatModelPickerHighlightIndex = -1;
/** 跟踪用户折叠了哪些思考块（key: session ID 或 message ID） */
const collapsedThinkingBlocks = new Set<string>();
let sidebarWidth = DEFAULT_SIDEBAR_WIDTH;
let isSidebarCollapsed = false;

const streamingBySession = new Map<string, StreamingState>();
const pendingTextDelta = new Map<string, string>();
/** 正在运行的会话 ID 集合（后台执行的任务也包含在内） */
const runningSessions = new Set<string>();
let streamRefreshTimer: number | null = null;

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
      if (!Number.isNaN(parsed) && parsed >= MIN_SIDEBAR_WIDTH) {
        if (parsed === LEGACY_DEFAULT_SIDEBAR_WIDTH) {
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
  const resizer = document.querySelector('#sidebar-resizer') as HTMLElement | null;
  if (!resizer || isSidebarCollapsed) return;

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

function setSidebarCollapsed(collapsed: boolean) {
  isSidebarCollapsed = collapsed;
  saveSidebarCollapsed(collapsed);
  syncSidebarCollapsedUI();
}

function toggleSidebarCollapsed() {
  setSidebarCollapsed(!isSidebarCollapsed);
}

function initSidebarCollapsed() {
  isSidebarCollapsed = loadSidebarCollapsed();
}

function toggleTheme() {
  applyTheme(getCurrentTheme() === 'dark' ? 'light' : 'dark');
}

function loadConversationModels(): Record<string, string> {
  try {
    const raw = localStorage.getItem(CONVERSATION_MODELS_KEY);
    if (raw) {
      return JSON.parse(raw) as Record<string, string>;
    }
  } catch {
    // ignore invalid storage
  }
  return {};
}

function saveConversationModel(conversationId: string, model: string) {
  const trimmed = model.trim();
  if (!conversationId || !trimmed) return;
  conversationModels[conversationId] = trimmed;
  localStorage.setItem(CONVERSATION_MODELS_KEY, JSON.stringify(conversationModels));
}

function removeConversationModel(conversationId: string) {
  if (!conversationModels[conversationId]) {
    return;
  }
  delete conversationModels[conversationId];
  localStorage.setItem(CONVERSATION_MODELS_KEY, JSON.stringify(conversationModels));
}

function getConversationModelOverride(conversationId: string): string | null {
  const saved = conversationModels[conversationId];
  if (saved && chatModelOptions.includes(saved)) {
    return saved;
  }
  return null;
}

function applySessionModelSelection(model: string) {
  const trimmed = model.trim();
  if (!trimmed) {
    return;
  }

  if (activeConversationId) {
    saveConversationModel(activeConversationId, trimmed);
    return;
  }

  pendingSessionModel = trimmed;
}

function getActiveChatModelForRender(): string {
  if (activeConversationId) {
    const override = getConversationModelOverride(activeConversationId);
    if (override) {
      return override;
    }
  } else if (pendingSessionModel && chatModelOptions.includes(pendingSessionModel)) {
    return pendingSessionModel;
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
          <span class="chat-model-picker-option-label" title="${escapeHtml(model)}">${escapeHtml(model)}</span>
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

  applySessionModelSelection(trimmed);
  updateChatModelPicker();
  if (!activeConversationId) {
    void refreshModelInfo();
  }
}

async function loadChatModelOptions(): Promise<void> {
  try {
    const config = await invoke<ClaudeCodeApiConfig>('get_claude_api_config');
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
  } catch {
    chatModelOptions = [];
  }
  updateChatModelPicker();
}

async function init() {
  initPlatformClass();
  initTheme();
  initSidebarWidth();
  initSidebarCollapsed();
  await loadData();
  await loadChatModelOptions();
  render();
  if (!activeConversationId) {
    void refreshModelInfo();
  }
  setupEventListeners();
  window.addEventListener('resize', () => {
    applySidebarWidth(sidebarWidth);
  });
  setInterval(() => {
    currentTime = new Date();
    // 更新相对时间显示（仅更新 .compact-time 元素，不重建整个列表）
    document.querySelectorAll<HTMLElement>('.conversation-item').forEach((item) => {
      const id = item.dataset.id;
      if (!id) return;
      const conv = conversations.find(c => c.id === id);
      if (!conv) return;
      const timeEl = item.querySelector('.compact-time');
      const newTime = formatCompactTime(conv.updated_at);
      if (timeEl && newTime) {
        timeEl.textContent = newTime;
      }
    });
  }, 60000);
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

    if (pendingSessionModel && isViewingThis) {
      saveConversationModel(payload.conversation_id, pendingSessionModel);
      pendingSessionModel = null;
    }
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
      setTimeout(scrollMessageListToBottom, 100);
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
      hideSendingState();
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
    if (compactingConversationId && (!endedSessionId || endedSessionId === compactingConversationId)) {
      compactingConversationId = null;
    }
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

      if (isCurrentSession && (activeConversationId || transientSessionError)) {
        refreshChatContent();
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
    streamingBySession.set(sessionId, { thinking: '', content: '', thinkingDone: false });
  }
  return streamingBySession.get(sessionId)!;
}

function clearStreamingState(sessionId: string) {
  streamingBySession.delete(sessionId);
  pendingTextDelta.delete(sessionId);
  removeStreamingElements();
}

function handleMessageChunk(payload: MessageChunkPayload) {
  const { conversation_id: sid, kind, content } = payload;
  if (!sid) return;

  if (kind === 'session_created') {
    // pending -> 真实 session ID 转换
    runningSessions.delete('pending');
    runningSessions.add(sid);
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
    updateProjectDirControl();
    ensureChatViewVisible();
    updateConversationListSpinner();
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
      if (isActive) refreshStreamingUI(sid);
      break;
    case 'thinking_delta':
      state.thinking += content;
      if (isActive) scheduleStreamingRefresh(sid);
      break;
    case 'thinking_end':
      state.thinkingDone = true;
      if (isActive) refreshStreamingUI(sid);
      break;
    case 'text_start':
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

function flushPendingTextDelta(sessionId: string) {
  const pending = pendingTextDelta.get(sessionId);
  if (!pending) return;
  const state = getStreamingState(sessionId);
  state.content += pending;
  pendingTextDelta.set(sessionId, '');
}

function scheduleStreamingRefresh(sessionId: string) {
  if (streamRefreshTimer !== null) return;
  streamRefreshTimer = window.setTimeout(() => {
    streamRefreshTimer = null;
    flushPendingTextDelta(sessionId);
    refreshStreamingUI(sessionId);
  }, 200);
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
  const mainContent = document.querySelector('.main-content');
  if (!mainContent) return;
  if (!document.querySelector('#message-list')) {
    render();
    return;
  }
  refreshChatContent();
}

function removeStreamingElements() {
  document.querySelector('#streaming-thinking')?.remove();
  document.querySelector('#streaming-answer')?.remove();
}

function refreshStreamingUI(sessionId: string) {
  // 只有当 sessionId 匹配当前会话，或者是新聊天场景（无 activeConversationId 且 pending 消息属于无会话状态）时才更新
  if (sessionId !== activeConversationId && !(pendingUserMessage && !activeConversationId && !pendingUserMessageConvId)) return;

  const messageList = document.querySelector<HTMLDivElement>('#message-list');
  if (!messageList) return;

  removePendingAssistantIndicator();

  const state = getStreamingState(sessionId);

  // 思考元素：就地更新，保留用户折叠状态
  let thinkingEl = document.getElementById('streaming-thinking');
  if (state.thinking) {
    if (!thinkingEl) {
      thinkingEl = document.createElement('div');
      thinkingEl.id = 'streaming-thinking';
      thinkingEl.className = 'message assistant thinking-msg streaming';
      thinkingEl.innerHTML = `<div class="message-avatar">🧠</div><div class="message-content"></div>`;
      messageList.appendChild(thinkingEl);
    }
    const contentEl = thinkingEl.querySelector('.message-content');
    if (contentEl) {
      const isCollapsed = collapsedThinkingBlocks.has(sessionId);
      const label = state.thinkingDone ? '思考过程' : '思考中...';
      // 尝试只更新 <pre> 文本（保留 <details> 折叠状态）
      const existingPre = contentEl.querySelector('.thinking-content pre');
      const existingSummary = contentEl.querySelector('.thinking-summary');
      if (existingPre && existingSummary) {
        existingPre.textContent = state.thinking;
        existingSummary.textContent = label;
      } else {
        // 首次创建 <details> 元素
        contentEl.innerHTML = renderThinkingDetails(state.thinking, label, !isCollapsed);
        // 监听折叠事件，跟踪用户操作
        const detailsEl = contentEl.querySelector('.thinking-block');
        if (detailsEl) {
          detailsEl.addEventListener('toggle', () => {
            if (!(detailsEl as HTMLDetailsElement).open) {
              collapsedThinkingBlocks.add(sessionId);
            } else {
              collapsedThinkingBlocks.delete(sessionId);
            }
          });
        }
      }
    }
  } else if (thinkingEl) {
    thinkingEl.remove();
  }

  // 回答元素：就地更新而非删除重建
  let answerEl = document.getElementById('streaming-answer');
  if (state.content) {
    if (!answerEl) {
      answerEl = document.createElement('div');
      answerEl.id = 'streaming-answer';
      answerEl.className = 'message assistant streaming';
      answerEl.innerHTML = `<div class="message-avatar">AI</div><div class="message-content"><div class="markdown-body"></div></div>`;
      messageList.appendChild(answerEl);
    }
    const mdBody = answerEl.querySelector('.markdown-body');
    if (mdBody) {
      mdBody.innerHTML = renderMarkdown(state.content);
    }
  } else if (answerEl) {
    answerEl.remove();
  }

  if (isNearBottom()) {
    scrollMessageListToBottom();
  }
}

function scrollMessageListToBottom() {
  const messageList = document.querySelector<HTMLDivElement>('#message-list');
  if (messageList) {
    messageList.scrollTop = messageList.scrollHeight;
  }
}

/** 判断用户是否处于消息列表底部附近（阈值 80px），用于流式输出时的智能滚动 */
function isNearBottom(): boolean {
  const messageList = document.querySelector<HTMLDivElement>('#message-list');
  if (!messageList) return true;
  const threshold = 80;
  return messageList.scrollHeight - messageList.scrollTop - messageList.clientHeight < threshold;
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
  if (!text) {
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

function updateSendButtonState() {
  const sendBtn = document.querySelector<HTMLButtonElement>('#send-btn');
  if (!sendBtn || sendBtn.dataset.loading === 'true') {
    return;
  }
  sendBtn.disabled = !canSendMessage();
}

function setSendButtonLoading(loading: boolean) {
  const sendBtn = document.querySelector<HTMLButtonElement>('#send-btn');
  if (!sendBtn) {
    return;
  }
  sendBtn.dataset.loading = loading ? 'true' : 'false';
  sendBtn.classList.toggle('is-loading', loading);
  // loading 时按钮变为停止按钮，始终可点击；非 loading 时根据输入内容决定
  sendBtn.disabled = loading ? false : !canSendMessage();
  sendBtn.setAttribute('aria-label', loading ? '停止' : '发送');

  // 切换图标
  const sendIcon = sendBtn.querySelector('.send-icon') as SVGElement | null;
  const stopIcon = sendBtn.querySelector('.stop-icon') as SVGElement | null;
  if (sendIcon) sendIcon.style.display = loading ? 'none' : '';
  if (stopIcon) stopIcon.style.display = loading ? '' : 'none';

  // 流式输出时禁用输入框
  const input = document.querySelector<HTMLTextAreaElement>('#message-input');
  if (input) {
    input.disabled = loading;
    input.placeholder = loading
      ? 'AI 正在回答中...'
      : '输入你的问题，Enter 发送，Shift+Enter 换行...';
  }

  // 输入区域整体添加 loading 状态 class
  const inputArea = document.querySelector('.input-composer');
  if (inputArea) {
    inputArea.classList.toggle('is-loading', loading);
  }
}

function updateProjectDirControl() {
  const control = document.querySelector<HTMLButtonElement>('#project-dir-control');
  if (!control) {
    return;
  }

  const dir = getEffectiveProjectDir();
  const canPick = canPickProjectDirectory();
  const label = getProjectDirDisplayLabel(dir);
  const title = getProjectDirHoverTitle(dir);
  const labelEl = control.querySelector('.project-dir-label');
  if (labelEl) {
    labelEl.textContent = label;
    labelEl.setAttribute('title', title);
  }
  control.title = title;
  control.dataset.empty = dir ? 'false' : 'true';
  control.disabled = !canPick && !dir;
  control.classList.toggle('is-readonly', !canPick && Boolean(dir));
  control.classList.toggle('is-copyable', Boolean(dir) && !canPick);

  control.querySelector('.project-dir-toolbar-chevron')?.remove();
  control.querySelector('.project-dir-toolbar-copy')?.remove();
  if (dir && !canPick) {
    control.insertAdjacentHTML('beforeend', renderProjectDirCopyIconHtml().trim());
  } else if (canPick) {
    control.insertAdjacentHTML(
      'beforeend',
      '<span class="project-dir-toolbar-chevron" aria-hidden="true">▾</span>',
    );
  }

  updateSendButtonState();
}

function formatProjectDirShortName(dir: string): string {
  const trimmed = dir.trim();
  if (!trimmed) {
    return '';
  }
  if (trimmed === '/') {
    return '/';
  }
  if (/^[A-Za-z]:\\?$/.test(trimmed)) {
    return trimmed.replace(/\\$/, '');
  }
  const normalized = trimmed.replace(/[\\/]+$/, '');
  const segments = normalized.split(/[\\/]/).filter(Boolean);
  return segments[segments.length - 1] || trimmed;
}

function getProjectDirDisplayLabel(dir: string): string {
  return formatProjectDirShortName(dir) || '选择工作目录';
}

function getProjectDirHoverTitle(dir: string, canPick = canPickProjectDirectory()): string {
  const trimmed = dir.trim();
  if (!trimmed) {
    return '点击选择工作目录';
  }
  if (canPick) {
    return `工作目录: ${trimmed}（点击更换）`;
  }
  return `工作目录: ${trimmed}（点击复制）`;
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

function renderProjectDirCopyIconHtml(): string {
  return renderCopyIconHtml('project-dir-toolbar-copy');
}

async function copyTextToClipboard(text: string): Promise<boolean> {
  const trimmed = text.trim();
  if (!trimmed) {
    return false;
  }
  try {
    await navigator.clipboard.writeText(trimmed);
    return true;
  } catch {
    return false;
  }
}

function showCopyToast(): void {
  showCopyToastMsg('已复制');
}

function handleProjectDirClick() {
  if (canPickProjectDirectory()) {
    void pickProjectDirectory();
    return;
  }
  const dir = getEffectiveProjectDir().trim();
  if (dir) {
    copyTextToClipboard(dir).then((ok) => {
      if (ok) showCopyToast();
    });
  }
}

function handleSessionIdClick() {
  const control = document.querySelector<HTMLButtonElement>('#session-id-copy');
  const sessionId = control?.dataset.sessionId?.trim();
  if (!sessionId || sessionId === '—') {
    return;
  }
  copyTextToClipboard(sessionId).then((ok) => {
    if (ok) showCopyToast();
  });
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

function renderProjectDirToolbarHtml(): string {
  const dir = getEffectiveProjectDir();
  const canPick = canPickProjectDirectory();
  const label = getProjectDirDisplayLabel(dir);
  const title = getProjectDirHoverTitle(dir, canPick);

  return `
    <button
      type="button"
      class="project-dir-toolbar ${canPick ? '' : 'is-readonly'}${dir && !canPick ? ' is-copyable' : ''}"
      id="project-dir-control"
      data-empty="${dir ? 'false' : 'true'}"
      title="${escapeHtml(title)}"
      aria-label="${escapeHtml(title)}"
      ${!canPick && !dir ? 'disabled' : ''}
    >
      <span class="project-dir-toolbar-icon" aria-hidden="true">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>
        </svg>
      </span>
      <span class="project-dir-toolbar-label project-dir-label" title="${escapeHtml(title)}">${escapeHtml(label)}</span>
      ${dir && !canPick ? renderProjectDirCopyIconHtml() : canPick ? '<span class="project-dir-toolbar-chevron" aria-hidden="true">▾</span>' : ''}
    </button>
  `;
}

function renderInputComposerHtml(): string {
  return `
    <div class="input-area">
      <div class="input-composer">
        <div id="paste-attachments-bar" class="paste-attachments-bar" style="display:none"></div>
        <textarea
          id="message-input"
          class="input-composer-textarea"
          rows="1"
          placeholder="输入你的问题，Enter 发送，Shift+Enter 换行，@ 引用文件，粘贴图片..."
        ></textarea>
        <div id="file-suggestions" class="file-suggestions" style="display:none"></div>
        <div class="input-composer-toolbar">
          <div class="input-composer-toolbar-start"></div>
          <div class="input-composer-toolbar-end">
            ${renderProjectDirToolbarHtml()}
            ${renderChatModelPickerHtml()}
            ${renderContextIndicatorHtml()}
            ${renderSendButtonHtml()}
          </div>
        </div>
      </div>
    </div>
  `;
}

async function pickProjectDirectory() {
  if (!canPickProjectDirectory()) {
    return;
  }

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
    if (activeConversationId) {
      const conv = conversations.find((c) => c.id === activeConversationId);
      if (conv) {
        conv.project_dir = trimmed;
      }
    } else {
      pendingProjectDir = trimmed;
    invalidateFileCache();
    }
    updateProjectDirControl();

    const topbarMain = document.querySelector<HTMLDivElement>('.main-topbar-main');
    if (topbarMain && (activeConversationId || pendingUserMessage)) {
      topbarMain.innerHTML = renderChatHeaderHtml(undefined);
    }
  } catch (e) {
    console.error('Failed to pick project directory:', e);
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

function hasStartedConversation(): boolean {
  if (pendingUserMessage) {
    return true;
  }
  if (!activeConversationId) {
    return false;
  }
  const conv = conversations.find((c) => c.id === activeConversationId);
  return Boolean(conv && conv.messages.length > 0);
}

function canPickProjectDirectory(): boolean {
  return !hasStartedConversation();
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
  }
  conversations.sort((a, b) => b.updated_at - a.updated_at);
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

async function loadData() {
  try {
    const raw = await invoke<(Conversation & { projectDir?: string | null })[]>('get_conversations');
    conversations = raw.map(normalizeConversation);
    platforms = await invoke<Record<string, PlatformConfig>>('get_platforms');
    currentPlatform = await invoke<string>('get_current_platform');
    console.log('Current platform:', currentPlatform);
  } catch (e) {
    console.error('Failed to load data:', e);
  }
}

function formatCompactTime(timestamp: number): string {
  const date = new Date(timestamp * 1000);
  const diffInMinutes = Math.floor(Math.max(0, currentTime.getTime() - date.getTime()) / (1000 * 60));
  
  if (diffInMinutes < 1) return '<1m';
  if (diffInMinutes < 60) return `${diffInMinutes}m`;
  
  const diffInHours = Math.floor(diffInMinutes / 60);
  if (diffInHours < 24) return `${diffInHours}hr`;
  
  const diffInDays = Math.floor(diffInHours / 24);
  return `${diffInDays}d`;
}

function renderConversationList(): string {
  if (conversations.length === 0) {
    return '<div class="empty-state">No conversations yet</div>';
  }
  
  return conversations.map(c => {
    const isActive = c.id === activeConversationId;
    const isEditing = editingConversationId === c.id;
    const isRunning = runningSessions.has(c.id);
    const messageCount = c.messages.length;
    const platformName = platforms[c.platform]?.name || c.platform;
    const compactTime = formatCompactTime(c.updated_at);
    
    return `
      <div class="conversation-item ${isActive ? 'active' : ''} ${isEditing ? 'editing' : ''} ${isRunning ? 'running' : ''}" data-id="${c.id}">
        ${isActive && !isEditing ? '<div class="active-indicator"></div>' : ''}
        ${isEditing ? `
          <div class="conversation-edit-row">
            <input type="text"
                   class="edit-input"
                   id="edit-input-${c.id}"
                   value="${escapeHtml(c.title)}"
            />
            <div class="edit-action-buttons">
              <button type="button" class="edit-action-btn save" data-action="save-edit" data-id="${c.id}" title="Save">✓</button>
              <button type="button" class="edit-action-btn cancel" data-action="cancel-edit" title="Cancel">✕</button>
            </div>
          </div>
          <div class="conversation-meta">
            <span class="platform-tag">${platformName}</span>
            ${messageCount > 0 ? `<span class="message-count">${messageCount}</span>` : ''}
            ${compactTime ? `<span class="compact-time">${compactTime}</span>` : ''}
          </div>
        ` : `
          <div class="conversation-main">
            <div class="conversation-header">
              ${isRunning ? '<span class="conversation-spinner" title="AI 正在回答中..."></span>' : ''}
              <div class="conversation-title">${escapeHtml(c.title)}</div>
            </div>
            <div class="conversation-meta">
              <span class="platform-tag">${platformName}</span>
              ${messageCount > 0 ? `<span class="message-count">${messageCount}</span>` : ''}
            </div>
          </div>
          <div class="conversation-aside">
            ${compactTime ? `<span class="compact-time">${compactTime}</span>` : ''}
            <div class="action-buttons">
              <button type="button" class="action-btn edit" data-action="edit" data-id="${c.id}" title="重命名">✎</button>
              <button type="button" class="action-btn delete" data-action="delete" data-id="${c.id}" title="删除">🗑</button>
            </div>
          </div>
        `}
      </div>
    `;
  }).join('');
}

/** 仅更新侧边栏会话列表的转圈状态（局部 DOM 更新，不重建整个列表） */
function updateConversationListSpinner() {
  const items = document.querySelectorAll<HTMLElement>('.conversation-item');
  items.forEach((item) => {
    const id = item.dataset.id;
    if (!id) return;
    const isRunning = runningSessions.has(id);
    item.classList.toggle('running', isRunning);

    const header = item.querySelector('.conversation-header');
    if (!header) return;

    let spinner = header.querySelector<HTMLElement>('.conversation-spinner');
    if (isRunning && !spinner) {
      const el = document.createElement('span');
      el.className = 'conversation-spinner';
      el.title = 'AI 正在回答中...';
      header.insertBefore(el, header.firstChild);
    } else if (!isRunning && spinner) {
      spinner.remove();
    }
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

function renderTitlebarActions(): string {
  return `
    <button type="button" class="toolbar-settings-btn settings-btn" id="settings-btn" title="管理 Claude Code API 配置" aria-label="API 配置">
      <span class="toolbar-settings-btn-icon" aria-hidden="true">${renderApiConfigIcon()}</span>
      <span class="toolbar-settings-btn-label">API 配置</span>
    </button>
    <button type="button" class="toolbar-icon-btn theme-toggle-btn" id="theme-toggle-btn" title="${escapeHtml(getThemeToggleTitle())}" aria-label="${escapeHtml(getThemeToggleTitle())}">
      ${getThemeToggleIcon()}
    </button>
  `;
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
      <div class="app-container${isSidebarCollapsed ? ' is-sidebar-collapsed' : ''}">
      <div class="sidebar">
        <div class="sidebar-header">
          <div class="sidebar-header-actions">
            <button class="new-chat-btn" id="new-chat-btn">+ New Chat</button>
            <button type="button" class="refresh-btn" id="refresh-btn" title="扫描本地新会话" aria-label="刷新会话列表"><span class="refresh-icon">↻</span></button>
          </div>
        </div>
        <div class="conversation-list" id="conversation-list">
          ${renderConversationList()}
        </div>
      </div>
      <div
        class="sidebar-resizer"
        id="sidebar-resizer"
        role="separator"
        aria-orientation="vertical"
        aria-label="调整侧边栏宽度"
      ></div>
      <div class="main-content">
        ${activeConversationId || pendingUserMessage ? `
        <div class="main-topbar">
          <div class="main-topbar-main">
            ${renderChatHeaderHtml(conversations.find((c) => c.id === activeConversationId))}
          </div>
        </div>
        ` : ''}
        ${activeConversationId || pendingUserMessage ? renderChatContent() : renderEmptyState()}
        ${renderInputComposerHtml()}
      </div>
      </div>
    </div>
  `;
  
  attachEventListeners();
}

function attachEventListeners() {
  document.querySelector('#new-chat-btn')?.addEventListener('click', newChat);

  document.querySelector('#context-indicator-slot')?.addEventListener('click', (e) => {
    if ((e.target as HTMLElement).closest('.context-clickable')) {
      void compactActiveContext();
    }
  });

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
      const list = document.querySelector('#conversation-list');
      if (list) list.innerHTML = renderConversationList();
      overlay?.remove();
      if (btn) btn.disabled = false;
      btn?.classList.remove('is-loading');
    }
  });

  const listEl = document.querySelector('#conversation-list');
  if (listEl) {
    listEl.removeEventListener('click', handleConversationListClick);
    listEl.addEventListener('click', handleConversationListClick);
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

  const projectDirControl = document.querySelector('#project-dir-control');
  if (projectDirControl) {
    projectDirControl.removeEventListener('click', handleProjectDirClick);
    projectDirControl.addEventListener('click', handleProjectDirClick);
  }

  bindChatModelPickerEvents();
  bindSessionIdCopyEvents();
  bindSidebarResizer();
  document.querySelectorAll('.sidebar-toggle-btn').forEach((btn) => {
    btn.addEventListener('click', toggleSidebarCollapsed);
  });
  syncSidebarCollapsedUI();
  document.querySelector('#theme-toggle-btn')?.addEventListener('click', toggleTheme);
  document.querySelector('#settings-btn')?.addEventListener('click', () => {
    void openSettingsModal();
  });

  // 拖拽文件自动引用
  bindDragDropFileRefs();

  // 图片引用芯片点击大图预览（事件委托）
  document.querySelector('#message-list')?.addEventListener('click', (e) => {
    const chip = (e.target as HTMLElement).closest('.file-ref-chip') as HTMLElement | null;
    if (chip?.dataset.filePath) {
      viewImageFile(chip.dataset.filePath);
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
}

function handleConversationListClick(e: Event) {
  const target = e.target as HTMLElement;
  const actionEl = target.closest('[data-action]') as HTMLElement | null;

  if (actionEl) {
    e.preventDefault();
    e.stopPropagation();
    const action = actionEl.dataset.action;
    const id = actionEl.dataset.id;

    if (action === 'delete' && id) {
      void deleteConversation(id);
      return;
    }
    if (action === 'edit' && id) {
      startEdit(id);
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
  const modelInput = overlay.querySelector('.settings-model-config-summary') as HTMLInputElement | null;
  if (modelInput) modelInput.value = '由订阅 / 官方登录决定';
  setSettingsFormEditable(overlay, false);
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
    const listEl = overlay.querySelector('.settings-profile-list');
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

  const listEl = overlay.querySelector('.settings-profile-list');
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

async function openSettingsModal() {
  const overlay = document.createElement('div');
  overlay.className = 'settings-overlay';
  overlay.innerHTML = `
    <div class="settings-dialog settings-dialog-wide" role="dialog" aria-modal="true">
      <div class="settings-header">
        <div>
          <h3 class="settings-title">Claude Code API 配置</h3>
          <p class="settings-subtitle">保存多套 API 配置，一键切换并写入 Claude Code</p>
        </div>
        <button type="button" class="settings-close-btn" aria-label="关闭">✕</button>
      </div>
      <div class="settings-body">
        <aside class="settings-profiles">
          <div class="settings-profiles-header">
            <span>已保存配置</span>
            <span class="settings-profiles-hint">左键查看 · 右键应用 / 删除</span>
          </div>
          <div class="settings-profile-list"></div>
        </aside>
        <form class="settings-form" id="settings-form">
          <label class="settings-field">
            <span>配置名称</span>
            <input type="text" name="profileName" placeholder="例如：DeepSeek / 官方 Anthropic" />
          </label>
          <label class="settings-field">
            <span>API Base URL</span>
            <input type="url" name="baseUrl" placeholder="https://api.anthropic.com" />
          </label>
          <label class="settings-field">
            <span>API Key</span>
            <input type="password" name="apiKey" placeholder="sk-..." autocomplete="off" />
          </label>
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
      </div>
      <div class="settings-footer">
        <div class="settings-footer-left">
          <button type="button" class="settings-add-profile">+ 新建</button>
          <button type="button" class="settings-import-cc-switch">从 CC Switch 导入</button>
        </div>
        <div class="settings-footer-actions">
          <button type="button" class="settings-btn-secondary settings-apply-profile">应用</button>
          <button type="button" class="settings-btn-secondary settings-close-footer">取消</button>
          <button type="button" class="settings-btn-primary save-only">保存</button>
        </div>
      </div>
    </div>
  `;

  const close = () => {
    closeProfileContextMenu();
    document.removeEventListener('keydown', onEscapeKey);
    overlay.remove();
    void loadChatModelOptions();
  };

  const onEscapeKey = (event: KeyboardEvent) => {
    if (event.key !== 'Escape') return;

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
    const list = overlay.querySelector('.settings-profile-list') as HTMLElement | null;
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
  overlay.addEventListener('click', (event) => {
    if (event.target === overlay) close();
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

  overlay.querySelector('.settings-add-profile')?.addEventListener('click', () => {
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
    overlay.querySelectorAll('.settings-profile-item').forEach((item) => {
      item.classList.remove('selected');
    });
    fetchedModels = [];
    modelsFetchKey = '';
    customModels = [];
    setModelConfigFromConfig([], []);
    (overlay.querySelector('input[name="profileName"]') as HTMLInputElement | null)?.focus();
  });

  overlay.querySelector('.settings-import-cc-switch')?.addEventListener('click', async () => {
    const importBtn = overlay.querySelector('.settings-import-cc-switch') as HTMLButtonElement | null;
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

  document.body.appendChild(overlay);

  try {
    const initial = await refreshSettingsModal(overlay, null, handleProfileConfigLoaded);
    if (livePathEl) {
      livePathEl.textContent = `配置文件：${initial.state.current.configPath}`;
    }
    bindProfileListEvents();
    bindModelConfigEvents();
  } catch (e) {
    alert('加载 API 配置失败: ' + String(e));
    close();
  }
}

/** 将独立的 thinking 消息内容合并到后续 assistant 消息的 thinking 属性中 */
function mergeThinkingIntoAssistant(messages: Message[]): Message[] {
  const hiddenRoles = new Set(['tool_use', 'tool_result']);
  const result: Message[] = [];

  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];

    if (msg.role === 'thinking' && msg.content.trim()) {
      // 向后查找对应的 assistant 消息
      let targetIdx = -1;
      for (let j = i + 1; j < messages.length; j++) {
        const next = messages[j];
        if (next.role === 'thinking' || hiddenRoles.has(next.role)) continue;
        if (next.role === 'assistant' && next.content.trim()) targetIdx = j;
        break;
      }
      if (targetIdx >= 0) {
        // 将思考内容合并到目标 assistant 消息（浅拷贝避免修改原数据）
        const target = messages[targetIdx];
        const merged = { ...target, thinking: ((target.thinking || '') + '\n' + msg.content).trim() };
        messages[targetIdx] = merged;
        continue; // 跳过此 thinking 消息
      }
    }

    result.push(msg);
  }

  return result;
}

function filterVisibleMessages(messages: Message[]): Message[] {
  // 收集所有需要隐藏的内部角色
  const hiddenRoles = new Set(['tool_use', 'tool_result']);

  return messages.filter((msg, index) => {
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

    // 隐藏 tool_use 和 tool_result 消息
    if (hiddenRoles.has(msg.role)) return false;

    if (msg.role !== 'thinking') return true;
    // thinking 消息：如果后续（跳过其他 thinking / tool_use / tool_result）有内容的 assistant 消息则隐藏
    for (let i = index + 1; i < messages.length; i++) {
      const next = messages[i];
      if (next.role === 'thinking' || hiddenRoles.has(next.role)) continue;
      return !(next.role === 'assistant' && next.content.trim());
    }
    return true;
  });
}

function renderThinkingDetails(thinking: string, label: string, expanded: boolean, dataId?: string): string {
  const openAttr = expanded ? ' open' : '';
  const dataAttr = dataId ? ` data-thinking-id="${escapeHtml(dataId)}"` : '';
  return `
    <details class="thinking-block"${openAttr}${dataAttr}>
      <summary class="thinking-summary">${escapeHtml(label)}</summary>
      <div class="thinking-content"><pre>${escapeHtml(thinking)}</pre></div>
    </details>
  `;
}
function renderMessageHtml(msg: Message): string {
  if (msg.role === 'error') {
    return `
      <div class="message error">
        <div class="message-avatar">!</div>
        <div class="message-content message-error-content">
          <div class="message-error-title">调用失败</div>
          <div class="markdown-body">${renderMarkdown(msg.content)}</div>
          <div class="message-time">${formatTime(msg.timestamp)}</div>
        </div>
      </div>
    `;
  }

  const isThinking = msg.role === 'thinking';
  const avatarLabel = msg.role === 'user' ? 'You' : isThinking ? '🧠' : 'AI';
  const roleClass = isThinking ? 'assistant thinking-msg' : msg.role;

  let thinkingHtml = '';
  let contentHtml = '';
  const thinkingExpanded = !collapsedThinkingBlocks.has(msg.id);

  if (isThinking && msg.content.trim()) {
    thinkingHtml = renderThinkingDetails(msg.content, '思考过程', thinkingExpanded, msg.id);
  } else {
    // 始终显示思考内容（如果有），不论是否有正文
    if (msg.thinking && msg.thinking.trim()) {
      thinkingHtml = renderThinkingDetails(msg.thinking, '思考过程', thinkingExpanded, msg.id);
    }
    if (msg.content.trim()) {
      contentHtml = `<div class="markdown-body">${renderMarkdown(msg.content)}</div>`;
    }
  }

  // 用户消息：引用文件芯片和正文合并展示为一条消息
  const userRefs = msg.role === 'user' && msg.refs && msg.refs.length > 0
    ? renderFileRefChipsHtml(msg.refs)
    : '';

  return `
    <div class="message ${roleClass}">
      <div class="message-avatar">${avatarLabel}</div>
      <div class="message-content">
        ${userRefs}
        ${thinkingHtml}
        ${contentHtml}
        <div class="message-time">${formatTime(msg.timestamp)}</div>
      </div>
    </div>
  `;
}

function renderFileRefChipsHtml(refs: FileRef[]): string {
  // 为图片文件异步预加载缩略图
  setTimeout(() => {
    const dir = getEffectiveProjectDir();
    if (!dir) return;
    const baseDir = dir.endsWith('/') ? dir : dir + '/';
    const chips = document.querySelectorAll<HTMLElement>('.file-ref-chip[data-file-path] img.file-ref-chip-thumb');
    chips.forEach(async (img) => {
      const filePath = ((img as HTMLElement).parentElement as HTMLElement)?.dataset.filePath;
      if (!filePath || img.getAttribute('src') !== '') return;
      try {
        const mime = getImageMime(filePath);
        const b64 = await invoke<string>('read_file_base64', { filePath: baseDir + filePath });
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
            return `
        <span class="file-ref-chip${ref.isImage ? ' file-ref-chip--misc' : ''}" title="${escapeHtml(ref.path)}" ${isImg ? `data-file-path="${escapeHtml(ref.path)}"` : ''}>
          ${isImg ? `<img class="file-ref-chip-thumb" src="" alt="" loading="lazy" />` : ''}
          <span class="file-ref-chip-icon">${icon}</span>
          <span class="file-ref-chip-path">${escapeHtml(ref.path)}</span>
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

  if (compactingConversationId === conv.id) {
    return `
      <div class="context-indicator context-busy" title="正在压缩上下文…" aria-label="正在压缩上下文">
        <span class="context-spinner" aria-hidden="true"></span>
        <span class="context-indicator-pct">压缩中</span>
      </div>
    `;
  }

  const model = conv.last_model?.trim() || '';
  const windowSize = getContextWindowFor(tokens);
  const ratio = Math.min(1, tokens / windowSize);
  const pct = Math.round(ratio * 100);
  const remaining = Math.max(0, windowSize - tokens);
  const circumference = 2 * Math.PI * 7;
  const offset = circumference * (1 - ratio);
  const level = pct >= 90 ? 'danger' : pct >= 75 ? 'warn' : 'ok';
  const tip = `${model ? model + ' · ' : ''}上下文 ${formatTokenCount(tokens)} / ${formatTokenCount(windowSize)} · 剩余 ${formatTokenCount(remaining)}（已用 ${pct}%）· 点击压缩上下文`;

  return `
    <div class="context-indicator context-clickable context-${level}" role="button" tabindex="0" title="${escapeHtml(tip)}" aria-label="${escapeHtml(tip)}">
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

/** 点击上下文环形：确认后向当前会话发送 /compact 压缩历史，释放上下文空间 */
async function compactActiveContext(): Promise<void> {
  const id = activeConversationId;
  if (!id || compactingConversationId || runningSessions.has(id)) return;
  const conv = conversations.find((c) => c.id === id);
  if (!conv || !(conv.context_tokens && conv.context_tokens > 0)) return;

  const confirmed = await showConfirmDialog({
    title: '压缩上下文',
    message: '将当前会话历史总结压缩，以释放上下文窗口空间？',
    sub: '压缩后模型仅保留摘要、会丢失部分原始细节，并消耗少量额度。',
    confirmLabel: '压缩',
  });
  if (!confirmed) return;

  compactingConversationId = id;
  runningSessions.add(id);
  setSendButtonLoading(true);
  updateContextIndicator();
  updateConversationListSpinner();

  try {
    // /compact 是 Claude Code 内置命令，经 --resume 在该会话内执行
    await invoke('execute_prompt', { conversationId: id, prompt: '/compact' });
  } catch (e) {
    console.error('压缩上下文失败:', e);
    compactingConversationId = null;
    runningSessions.delete(id);
    setSendButtonLoading(false);
    updateContextIndicator();
    updateConversationListSpinner();
  }
}

function renderChatHeaderHtml(conversation: Conversation | undefined): string {
  const title = conversation?.title || 'New Chat';
  const platform = conversation?.platform || 'claude';
  const sessionId = conversation?.id || activeConversationId || '—';
  const canCopySessionId = sessionId !== '—';
  const sessionTitle = canCopySessionId
    ? `Session ID: ${sessionId}（点击复制）`
    : 'Session ID';

  return `
    <div class="chat-header-left">
      <h2>${escapeHtml(title)}</h2>
      <span class="platform-badge">${platforms[platform]?.name || platform}</span>
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
          ${renderCopyIconHtml('session-id-copy-icon')}
        </button>
      `
          : `<span class="session-id">${escapeHtml(sessionId)}</span>`
      }
    </div>
  `;
}

function renderChatContent(): string {
  const conversation = activeConversationId
    ? conversations.find((c) => c.id === activeConversationId)
    : undefined;

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

  return `
    <div class="message-list" id="message-list">
      ${filterVisibleMessages(mergeThinkingIntoAssistant(messages)).map(renderMessageHtml).join('')}
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
    // 当前模型与底部输入框保持一致：会话覆盖 → pending → 首个可用，再退回配置默认
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
          <div class="model-info-empty-text">正在使用 Claude 官方登录 / 订阅。如需改用第三方 API，点击右上角「API 配置」选择并「应用」。</div>
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
  activeConversationId = '';
  invalidateFileCache();
  pendingUserMessage = null;
  pendingUserMessageConvId = null;
  transientSessionError = null;
  pendingSessionModel = null;
  pendingProjectDir = null;
  render();
  void refreshModelInfo();
  
  setTimeout(() => {
    const input = document.querySelector<HTMLTextAreaElement>('#message-input');
    if (input) input.focus();
  }, 100);
}

// 发送消息：通过 invoke 到后端，后端启动 shell 并通过事件推送更新
async function sendMessage() {
  // 流式输出时禁止发送
  if (isSendButtonLoading()) return;

  const input = document.querySelector<HTMLTextAreaElement>('#message-input');
  const sendBtn = document.querySelector<HTMLButtonElement>('#send-btn');

  if (!input) return;

  const hasPastedImages = pasteAttachments.length > 0;
  if (!input.value.trim() && !hasPastedImages) return;
  if (sendBtn?.disabled) return;

  if (isNewChatSession() && !hasRequiredProjectDir()) {
    return;
  }

  let content = input.value.trim();
  input.value = '';

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

  // 所有引用（@file 引用 + 粘贴图片）合并
  const allRefs: FileRef[] = pasteRefs.map((a) => ({ path: a.path, isImage: true }));

  const { prompt: resolvedContent, refs: fileRefs } = await resolveFileReferences(promptWithPaste);

  // 合并 @file 引用
  for (const ref of fileRefs) {
    if (!allRefs.some((r) => r.path === ref.path)) {
      allRefs.push(ref);
    }
  }

  pendingUserMessage = resolvedContent;

  if (activeConversationId) {
    runningSessions.add(activeConversationId);
    const conv = conversations.find((c) => c.id === activeConversationId);
    if (conv) {
      conv.messages.push({
        id: `user-${Date.now()}`,
        role: 'user',
        content: resolvedContent,
        refs: allRefs.length > 0 ? allRefs : undefined,
        timestamp: Math.floor(Date.now() / 1000),
      });
      conv.updated_at = Math.floor(Date.now() / 1000);
    }
    clearStreamingState(activeConversationId);
    refreshChatContent();
    updateConversationListSpinner();
  } else {
    // 新会话，session ID 尚未确定，先标记为 pending
    runningSessions.add('pending');
    render();
  }

  // render() / refreshChatContent() 可能重建 DOM，需要在之后设置 loading 状态
  setSendButtonLoading(true);
  updateConversationListSpinner();

  try {
    const args: Record<string, string> = { prompt: resolvedContent };
    if (activeConversationId) {
      args.conversationId = activeConversationId;
    }
    const model = getActiveChatModel();
    if (model) {
      args.model = model;
    }
    if (!activeConversationId) {
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
    runningSessions.delete(activeConversationId || 'pending');
    hideSendingState();
    updateConversationListSpinner();
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
      } else if (isSendButtonLoading() && runningSessions.has(abortSessionId)) {
        // session-ended 完全未到达（进程可能还在），强制清理
        console.warn('[abort] session-ended 完全未到达，强制终止并清理');
        runningSessions.delete(abortSessionId);
        clearStreamingState(abortSessionId);
        hideSendingState();
        updateConversationListSpinner();
      }
    }, 3000);
  } catch (e) {
    console.error('Failed to abort session:', e);
    // 即使后端调用失败，也尝试清理 UI
    hideSendingState();
    updateConversationListSpinner();
  }
}

function handleSendButtonClick() {
  const sendBtn = document.querySelector<HTMLButtonElement>('#send-btn');
  if (!sendBtn) return;

  if (sendBtn.dataset.loading === 'true') {
    void abortSession();
  } else {
    void sendMessage();
  }
}

function removePendingAssistantIndicator() {
  document.querySelector('#pending-assistant')?.remove();
}

function showPendingAssistantIndicator(statusText = '正在请求模型...') {
  const messageList = document.querySelector<HTMLDivElement>('#message-list');
  if (!messageList) return;

  let pendingEl = document.querySelector('#pending-assistant') as HTMLDivElement | null;
  if (!pendingEl) {
    pendingEl = document.createElement('div');
    pendingEl.id = 'pending-assistant';
    pendingEl.className = 'message assistant pending';
    pendingEl.innerHTML = `
      <div class="message-avatar">AI</div>
      <div class="message-content message-pending-content">
        <span class="pending-dot"></span>
        <span class="pending-dot"></span>
        <span class="pending-dot"></span>
        <span class="pending-text"></span>
      </div>
    `;
    messageList.appendChild(pendingEl);
  }

  const textEl = pendingEl.querySelector('.pending-text');
  if (textEl) {
    textEl.textContent = statusText;
  }
  scrollMessageListToBottom();
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

  updateProjectDirControl();
  if (messageList) {
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
    messageList.innerHTML = filterVisibleMessages(mergeThinkingIntoAssistant(messages)).map(renderMessageHtml).join('');
    // 绑定思考块折叠事件，跟踪用户操作
    messageList.querySelectorAll('.thinking-block[data-thinking-id]').forEach((details) => {
      details.addEventListener('toggle', () => {
        const id = (details as HTMLElement).dataset.thinkingId;
        if (!id) return;
        if (!(details as HTMLDetailsElement).open) {
          collapsedThinkingBlocks.add(id);
        } else {
          collapsedThinkingBlocks.delete(id);
        }
      });
    });
    if (isSendButtonLoading()) {
      showPendingAssistantIndicator();
    } else {
      removePendingAssistantIndicator();
    }
    scrollMessageListToBottom();
  }
}

function handleKeydown(e: KeyboardEvent) {
  // 流式输出时，Enter 不发送消息
  if (isSendButtonLoading()) {
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
    sendMessage();
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
  activeConversationId = id;
  invalidateFileCache();

  void refreshConversationFromBackend(id).then(() => {
    render();

    // render() 重建整个 DOM 后，必须立即根据目标会话的运行状态恢复按钮
    // 不能放在 setTimeout 中，否则中间可能有其他事件干扰
    const thisSessionRunning = runningSessions.has(id);
    setSendButtonLoading(thisSessionRunning);
    updateConversationListSpinner();

    setTimeout(() => {
      const messageList = document.querySelector<HTMLDivElement>('#message-list');
      if (messageList) {
        messageList.scrollTop = messageList.scrollHeight;
      }
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
    pendingUserMessage = null;
    pendingUserMessageConvId = null;
    removeConversationModel(id);
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

async function viewImageFile(filePath: string) {
  try {
    const dir = getEffectiveProjectDir();
    if (!dir) return;
    const baseDir = dir.endsWith('/') ? dir : dir + '/';
    const mime = getImageMime(filePath);
    const b64 = await invoke<string>('read_file_base64', { filePath: baseDir + filePath });
    openImageLightbox(`data:${mime};base64,${b64}`);
  } catch (e) {
    console.error('Failed to load image for preview:', e);
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

// ── 拖拽文件自动引用 ────────────────────────────────────────────────
let _dragCounter = 0;

function bindDragDropFileRefs() {
  document.body.addEventListener('dragover', (e: DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
  });

  document.body.addEventListener('dragenter', (e: DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    _dragCounter++;
    if (_dragCounter === 1) {
      document.body.classList.add('drag-over');
    }
  });

  document.body.addEventListener('dragleave', (e: DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    _dragCounter--;
    if (_dragCounter <= 0) {
      _dragCounter = 0;
      document.body.classList.remove('drag-over');
    }
  });

  document.body.addEventListener('drop', async (e: DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    _dragCounter = 0;
    document.body.classList.remove('drag-over');

    const files = e.dataTransfer?.files;
    if (!files || files.length === 0) return;

    const projectDir = getEffectiveProjectDir();
    if (!projectDir) {
      showCopyToastMsg('请先选择工作目录');
      return;
    }

    const projectFiles = await loadProjectFiles();
    if (projectFiles.length === 0) {
      showCopyToastMsg('未能加载项目文件列表');
      return;
    }

    const textarea = document.querySelector<HTMLTextAreaElement>('#message-input');
    if (!textarea) return;

    const insertedRefs: string[] = [];
    for (let i = 0; i < files.length; i++) {
      const fileName = files[i].name;
      // 按文件名精确匹配项目文件列表
      const matches = projectFiles.filter((f) => {
        const parts = f.split('/');
        return parts[parts.length - 1] === fileName;
      });

      if (matches.length === 1) {
        // 唯一匹配，直接引用
        if (!insertedRefs.includes(matches[0])) {
          insertedRefs.push(matches[0]);
        }
      } else if (matches.length > 1) {
        // 多个同名文件，选择路径最短的（最接近根目录）
        const shortest = matches.reduce((a, b) => (a.length <= b.length ? a : b));
        if (!insertedRefs.includes(shortest)) {
          insertedRefs.push(shortest);
        }
      }
      // 不在项目文件列表中则忽略
    }

    if (insertedRefs.length > 0) {
      const currentValue = textarea.value.trimEnd();
      const refStr = insertedRefs.map((r) => `@${r}`).join(' ');
      textarea.value = currentValue ? `${currentValue} ${refStr} ` : `${refStr} `;
      textarea.focus();
      const newCursorPos = textarea.value.length;
      textarea.setSelectionRange(newCursorPos, newCursorPos);
      updateSendButtonState();
      showCopyToastMsg(`已引用 ${insertedRefs.length} 个文件`);
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
 * 返回 { prompt, refs }，refs 为匹配到的文件引用列表。
 */
async function resolveFileReferences(prompt: string): Promise<{ prompt: string; refs: FileRef[] }> {
  const atPattern = /@([^\s@]+)/g;
  const rawRefs: string[] = [];
  let match: RegExpExecArray | null;
  const files = await loadProjectFiles();

  while ((match = atPattern.exec(prompt)) !== null) {
    rawRefs.push(match[1]);
  }

  if (rawRefs.length === 0) return { prompt, refs: [] };

  // 精确匹配项目中的文件路径（含目录）
  const matchedRefs = rawRefs.filter((ref) => files.some((f) => f === ref));
  if (matchedRefs.length === 0) return { prompt, refs: [] };

  const projectDir = getEffectiveProjectDir();
  if (!projectDir) return { prompt, refs: [] };

  const dir = projectDir.endsWith('/') ? projectDir : projectDir + '/';
  const fileRefs: FileRef[] = [];
  const embeddedContents: string[] = [];
  const unresolvedRefs: string[] = [];

  for (const ref of matchedRefs) {
    const isDir = ref.endsWith('/');
    const isImg = isImageFile(ref);
    fileRefs.push({ path: ref, isImage: isImg || isDir });

    // 目录：直接保留 @path 引用
    if (isDir) {
      unresolvedRefs.push(ref);
      continue;
    }

    // 图片和已知二进制文件：保留 @path 引用
    if (isImg || isOtherBinaryFile(ref)) {
      unresolvedRefs.push(ref);
      continue;
    }

    // 尝试作为文本文件读取
    try {
      const fullPath = dir + ref;
      const content = await invoke<string>('read_file_content', { filePath: fullPath });
      embeddedContents.push(`--- File: ${ref} ---\n${content}\n---\n`);
    } catch {
      // 读取失败（实际是二进制文件），保留 @path 引用
      unresolvedRefs.push(ref);
    }
  }

  // 去掉 prompt 中的 @file 引用标签
  let cleanedPrompt = prompt;
  for (const ref of matchedRefs) {
    cleanedPrompt = cleanedPrompt.replace(new RegExp(`@${ref.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*`, 'g'), '');
  }
  cleanedPrompt = cleanedPrompt.trim();

  // 组装最终 prompt：嵌入内容 + 保留引用 + 用户消息
  let finalPrompt = embeddedContents.join('\n');
  if (finalPrompt) finalPrompt += '\n';
  if (unresolvedRefs.length > 0) {
    finalPrompt += unresolvedRefs.map((r) => `@${r}`).join(' ') + '\n';
  }
  finalPrompt += cleanedPrompt;

  return { prompt: finalPrompt, refs: fileRefs };
}

init();
