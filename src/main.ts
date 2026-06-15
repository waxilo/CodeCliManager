import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { open } from '@tauri-apps/plugin-dialog';
import { renderMarkdown } from './markdown';

interface Message {
  id: string;
  role: string;
  content: string;
  thinking?: string;
  timestamp: number;
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
let transientSessionError: string | null = null;
let chatModelOptions: string[] = [];
let conversationModels: Record<string, string> = loadConversationModels();
/** 新会话尚未创建 ID 时，用户在聊天区临时选择的模型 */
let pendingSessionModel: string | null = null;
/** 新会话尚未创建 ID 时，用户选择的工作目录 */
let pendingProjectDir: string | null = null;
let chatModelPickerHighlightIndex = -1;
let sidebarWidth = DEFAULT_SIDEBAR_WIDTH;
let isSidebarCollapsed = false;

const streamingBySession = new Map<string, StreamingState>();
const pendingTextDelta = new Map<string, string>();
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
    chatModelOptions = merged;
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
    renderConversationList();
  }, 60000);
}

// 设置事件监听器 - 监听后端发送的实时事件
async function setupEventListeners() {
  // 监听流式消息块（thinking / answer 实时分离）
  await listen<MessageChunkPayload>('message-chunk', (event) => {
    handleMessageChunk(event.payload);
  });

  // 监听会话创建事件
  await listen<SessionEventPayload>('session-created', (event) => {
    const payload = normalizeSessionEventPayload(event.payload);
    activeConversationId = payload.conversation_id;
    pendingUserMessage = null;
    transientSessionError = null;

    if (pendingSessionModel) {
      saveConversationModel(payload.conversation_id, pendingSessionModel);
      pendingSessionModel = null;
    }
    pendingProjectDir = null;

    updateOrAddConversation({
      id: payload.conversation_id,
      title: payload.title,
      messages: payload.messages,
      platform: 'claude',
      project_dir: payload.project_dir,
      created_at: payload.updated_at,
      updated_at: payload.updated_at,
    });

    clearStreamingState(payload.conversation_id);
    hideSendingState();

    render();

    setTimeout(scrollMessageListToBottom, 100);
  });
  
  // 监听消息更新事件
  await listen<SessionEventPayload>('messages-updated', (event) => {
    const payload = normalizeSessionEventPayload(event.payload);
    pendingUserMessage = null;
    transientSessionError = null;

    updateOrAddConversation({
      id: payload.conversation_id,
      title: payload.title,
      messages: payload.messages,
      platform: 'claude',
      project_dir: payload.project_dir,
      created_at: payload.updated_at,
      updated_at: payload.updated_at,
    });

    clearStreamingState(payload.conversation_id);
    hideSendingState();

    const listEl = document.querySelector('#conversation-list');
    if (listEl) {
      listEl.innerHTML = renderConversationList();
    }

    if (payload.conversation_id === activeConversationId) {
      refreshChatContent();
    }
  });
  
  // 监听会话错误事件
  await listen<SessionErrorPayload>('session-error', (event) => {
    handleSessionError(event.payload);
  });

  // 监听会话结束事件
  await listen<string | null>('session-ended', (_event) => {
    hideSendingState();
    pendingUserMessage = null;

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

      const listEl = document.querySelector('#conversation-list');
      if (listEl) {
        listEl.innerHTML = renderConversationList();
      }
      if (activeConversationId || transientSessionError) {
        refreshChatContent();
      }
    });
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
    activeConversationId = sid;
    pendingUserMessage = null;
    const now = Math.floor(Date.now() / 1000);
    const existing = conversations.find((c) => c.id === sid);
    updateOrAddConversation({
      id: sid,
      title: existing?.title || 'New Chat',
      messages: existing?.messages ?? (pendingUserMessage
        ? [{ id: `user-${Date.now()}`, role: 'user', content: pendingUserMessage, timestamp: now }]
        : []),
      platform: 'claude',
      project_dir: content?.trim() || existing?.project_dir || null,
      source_path: existing?.source_path ?? null,
      created_at: existing?.created_at ?? now,
      updated_at: now,
    });
    updateProjectDirControl();
    ensureChatViewVisible();
    return;
  }

  const isActive = sid === activeConversationId || (!activeConversationId && pendingUserMessage);
  if (!isActive) return;

  const state = getStreamingState(sid);

  switch (kind) {
    case 'thinking_start':
      state.thinking = '';
      state.thinkingDone = false;
      refreshStreamingUI(sid);
      break;
    case 'thinking_delta':
      state.thinking += content;
      scheduleStreamingRefresh(sid);
      break;
    case 'thinking_end':
      state.thinkingDone = true;
      refreshStreamingUI(sid);
      break;
    case 'text_start':
      break;
    case 'text_delta':
      pendingTextDelta.set(sid, (pendingTextDelta.get(sid) || '') + content);
      scheduleStreamingRefresh(sid);
      break;
    case 'text_end':
    case 'stream_end':
      flushPendingTextDelta(sid);
      refreshStreamingUI(sid);
      break;
    case 'error':
      flushPendingTextDelta(sid);
      clearStreamingState(sid);
      break;
    case 'api_retry':
      removePendingAssistantIndicator();
      updatePendingStatus(content);
      break;
    case 'complete':
      flushPendingTextDelta(sid);
      refreshStreamingUI(sid);
      hideSendingState();
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
  }, 80);
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
  if (sessionId !== activeConversationId && !(pendingUserMessage && !activeConversationId)) return;

  const messageList = document.querySelector<HTMLDivElement>('#message-list');
  if (!messageList) return;

  removeStreamingElements();
  removePendingAssistantIndicator();

  const state = getStreamingState(sessionId);

  if (state.thinking && !state.content) {
    const thinkingEl = document.createElement('div');
    thinkingEl.id = 'streaming-thinking';
    thinkingEl.className = 'message assistant thinking-msg streaming';
    thinkingEl.innerHTML = `
      <div class="message-avatar">🧠</div>
      <div class="message-content">
        ${renderThinkingDetails(
          state.thinking,
          state.thinkingDone ? '思考过程' : '思考中...',
          true,
        )}
      </div>
    `;
    messageList.appendChild(thinkingEl);
  }

  if (state.content) {
    const answerEl = document.createElement('div');
    answerEl.id = 'streaming-answer';
    answerEl.className = 'message assistant streaming';
    answerEl.innerHTML = `
      <div class="message-avatar">AI</div>
      <div class="message-content">
        <div class="markdown-body">${renderMarkdown(state.content)}</div>
      </div>
    `;
    messageList.appendChild(answerEl);
  }

  scrollMessageListToBottom();
}

function scrollMessageListToBottom() {
  const messageList = document.querySelector<HTMLDivElement>('#message-list');
  if (messageList) {
    messageList.scrollTop = messageList.scrollHeight;
  }
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
  sendBtn.disabled = loading || !canSendMessage();
  sendBtn.setAttribute('aria-label', loading ? '发送中' : '发送');
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

function handleProjectDirClick() {
  if (canPickProjectDirectory()) {
    void pickProjectDirectory();
    return;
  }
  const dir = getEffectiveProjectDir().trim();
  if (dir) {
    void copyTextToClipboard(dir);
  }
}

function handleSessionIdClick() {
  const control = document.querySelector<HTMLButtonElement>('#session-id-copy');
  const sessionId = control?.dataset.sessionId?.trim();
  if (!sessionId || sessionId === '—') {
    return;
  }
  void copyTextToClipboard(sessionId);
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
      <svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
        <path d="M12 19V5"/>
        <path d="m5 12 7-7 7 7"/>
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
        <textarea
          id="message-input"
          class="input-composer-textarea"
          rows="1"
          placeholder="输入你的问题，Enter 发送，Shift+Enter 换行..."
        ></textarea>
        <div class="input-composer-toolbar">
          <div class="input-composer-toolbar-start"></div>
          <div class="input-composer-toolbar-end">
            ${renderProjectDirToolbarHtml()}
            ${renderChatModelPickerHtml()}
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
    const messageCount = c.messages.length;
    const platformName = platforms[c.platform]?.name || c.platform;
    const compactTime = formatCompactTime(c.updated_at);
    
    return `
      <div class="conversation-item ${isActive ? 'active' : ''} ${isEditing ? 'editing' : ''}" data-id="${c.id}">
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
          <button class="new-chat-btn" id="new-chat-btn">+ New Chat</button>
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

  document.querySelector('#refresh-btn')?.addEventListener('click', async () => {
    const btn = document.querySelector('#refresh-btn') as HTMLButtonElement | null;
    if (btn) {
      btn.disabled = true;
      btn.textContent = '⏳';
    }
    try {
      await loadData();
      const listEl = document.querySelector('#conversation-list');
      if (listEl) {
        listEl.innerHTML = renderConversationList();
      }
    } finally {
      if (btn) {
        btn.disabled = false;
        btn.textContent = '↻';
      }
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
  }

  document.querySelector('#send-btn')?.addEventListener('click', sendMessage);

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
      <button
        type="button"
        class="profile-context-menu-item profile-context-menu-item-danger"
        data-action="delete"
        ${options.isActive ? 'disabled' : ''}
        ${options.isActive ? 'title="无法删除正在使用的配置"' : ''}
      >删除</button>
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
  if (profiles.length === 0) {
    return '<div class="settings-profile-empty">暂无保存的配置</div>';
  }

  return profiles
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

function fillSettingsForm(
  overlay: HTMLElement,
  config: ClaudeCodeApiConfig,
  profileName = '',
  profileId: string | null = null,
) {
  overlay.dataset.profileId = profileId || '';
  (overlay.querySelector('input[name="profileName"]') as HTMLInputElement).value = profileName;
  (overlay.querySelector('input[name="baseUrl"]') as HTMLInputElement).value = config.baseUrl || '';

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

    list.addEventListener('click', async (event) => {
      const target = event.target as HTMLElement;
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

      let message = `已从 CC Switch 导入 ${result.importedCount} 个配置`;
      if (result.skippedCount > 0) {
        message += `，跳过 ${result.skippedCount} 个重复或无效项`;
        if (result.skippedNames.length > 0) {
          message += `：${result.skippedNames.join('、')}`;
        }
      }
      message += '。导入后不会自动切换生效配置。';
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

function filterVisibleMessages(messages: Message[]): Message[] {
  return messages.filter((msg, index) => {
    if (msg.role !== 'thinking') return true;
    for (let i = index + 1; i < messages.length; i++) {
      const next = messages[i];
      if (next.role === 'thinking') continue;
      return !(next.role === 'assistant' && next.content.trim());
    }
    return true;
  });
}

function renderThinkingDetails(thinking: string, label: string, expanded: boolean): string {
  const openAttr = expanded ? ' open' : '';
  return `
    <details class="thinking-block"${openAttr}>
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

  if (isThinking && msg.content.trim()) {
    thinkingHtml = renderThinkingDetails(msg.content, '思考过程', false);
  } else {
    if (msg.thinking && msg.thinking.trim() && !msg.content.trim()) {
      thinkingHtml = renderThinkingDetails(msg.thinking, '思考过程', false);
    }
    if (msg.content.trim()) {
      contentHtml = `<div class="markdown-body">${renderMarkdown(msg.content)}</div>`;
    }
  }

  return `
    <div class="message ${roleClass}">
      <div class="message-avatar">${avatarLabel}</div>
      <div class="message-content">
        ${thinkingHtml}
        ${contentHtml}
        <div class="message-time">${formatTime(msg.timestamp)}</div>
      </div>
    </div>
  `;
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
  if (pendingUserMessage && !messages.some((m) => m.role === 'user' && m.content === pendingUserMessage)) {
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
      ${filterVisibleMessages(messages).map(renderMessageHtml).join('')}
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
    const modelName = activeProfile?.defaultModel || state.current?.defaultModel || '';
    const profileName = activeProfile?.name || '';
    const baseUrl = activeProfile?.baseUrl || state.current?.baseUrl || '';

    if (modelName || profileName) {
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
          <div class="model-info-body">
            ${profileName ? `<div class="model-info-row"><span class="model-info-key">配置方案</span><span class="model-info-value">${escapeHtml(profileName)}</span></div>` : ''}
            ${baseUrl ? `<div class="model-info-row"><span class="model-info-key">API 地址</span><span class="model-info-value model-info-url">${escapeHtml(baseUrl)}</span></div>` : ''}
            ${modelName ? `<div class="model-info-row"><span class="model-info-key">默认模型</span><span class="model-info-value model-info-model">${escapeHtml(modelName)}</span></div>` : ''}
          </div>
        </div>
      `;
    }
  } catch {
    // 静默处理错误，不阻塞页面渲染
  }
}

function newChat() {
  activeConversationId = '';
  pendingUserMessage = null;
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
  const input = document.querySelector<HTMLTextAreaElement>('#message-input');
  const sendBtn = document.querySelector<HTMLButtonElement>('#send-btn');

  if (!input || !input.value.trim()) return;
  if (sendBtn?.disabled) return;

  if (isNewChatSession() && !hasRequiredProjectDir()) {
    return;
  }

  const content = input.value.trim();
  input.value = '';

  if (sendBtn) {
    setSendButtonLoading(true);
  }

  pendingUserMessage = content;

  if (activeConversationId) {
    const conv = conversations.find((c) => c.id === activeConversationId);
    if (conv) {
      conv.messages.push({
        id: `user-${Date.now()}`,
        role: 'user',
        content,
        timestamp: Math.floor(Date.now() / 1000),
      });
      conv.updated_at = Math.floor(Date.now() / 1000);
    }
    clearStreamingState(activeConversationId);
    refreshChatContent();
  } else {
    render();
  }

  try {
    const args: Record<string, string> = { prompt: content };
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
    hideSendingState();
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
    if (pendingUserMessage && !messages.some((m) => m.role === 'user' && m.content === pendingUserMessage)) {
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
    messageList.innerHTML = filterVisibleMessages(messages).map(renderMessageHtml).join('');
    if (isSendButtonLoading()) {
      showPendingAssistantIndicator();
    } else {
      removePendingAssistantIndicator();
    }
    scrollMessageListToBottom();
  }
}

function handleKeydown(e: KeyboardEvent) {
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
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

// 全局函数 - 用于 HTML 模板中调用
function selectConversation(id: string) {
  activeConversationId = id;
  void refreshConversationFromBackend(id).then(() => {
    render();

    setTimeout(() => {
      const messageList = document.querySelector<HTMLDivElement>('#message-list');
      if (messageList) {
        messageList.scrollTop = messageList.scrollHeight;
      }
    }, 100);
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

init();
