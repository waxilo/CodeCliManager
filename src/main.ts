import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
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
  title: string;
  messages: Message[];
  project_dir?: string | null;
  updated_at: number;
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

type ModelFieldName = 'defaultModel' | 'haikuModel' | 'sonnetModel' | 'opusModel';
type ThemeMode = 'light' | 'dark';

const THEME_STORAGE_KEY = 'codemanager-theme';

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

function toggleTheme() {
  applyTheme(getCurrentTheme() === 'dark' ? 'light' : 'dark');
}

async function init() {
  initPlatformClass();
  initTheme();
  await loadData();
  render();
  setupEventListeners();
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
    const payload = event.payload;
    activeConversationId = payload.conversation_id;
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

    render();

    setTimeout(scrollMessageListToBottom, 100);
  });
  
  // 监听消息更新事件
  await listen<SessionEventPayload>('messages-updated', (event) => {
    const payload = event.payload;
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
    const existing = conversations.find((c) => c.id === sid);
    if (!existing) {
      conversations.unshift({
        id: sid,
        title: 'New Chat',
        messages: pendingUserMessage
          ? [{ id: `user-${Date.now()}`, role: 'user', content: pendingUserMessage, timestamp: Math.floor(Date.now() / 1000) }]
          : [],
        platform: 'claude',
        project_dir: content || null,
        created_at: Math.floor(Date.now() / 1000),
        updated_at: Math.floor(Date.now() / 1000),
      });
    } else if (content) {
      existing.project_dir = content;
    }
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

function getProjectDir(conversation: Conversation | undefined): string {
  if (!conversation) return '—';
  const dir = conversation.project_dir;
  return dir && dir.trim() ? dir : '—';
}

function normalizeConversation(
  raw: Conversation & { projectDir?: string | null; sourcePath?: string | null }
): Conversation {
  return {
    ...raw,
    project_dir: raw.project_dir ?? raw.projectDir ?? null,
    source_path: raw.source_path ?? raw.sourcePath ?? null,
  };
}

// 在内存中更新或添加会话
function updateOrAddConversation(conv: Conversation) {
  const normalized = normalizeConversation(conv as Conversation & { projectDir?: string | null });
  const idx = conversations.findIndex(c => c.id === normalized.id);
  if (idx >= 0) {
    const existing = conversations[idx];
    conversations[idx] = {
      ...normalized,
      project_dir: normalized.project_dir ?? existing.project_dir,
      source_path: normalized.source_path ?? existing.source_path,
      created_at: existing.created_at,
    };
  } else {
    conversations.unshift(normalized);
  }
  conversations.sort((a, b) => b.updated_at - a.updated_at);
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
        <div class="app-titlebar-drag" data-tauri-drag-region></div>
        <div class="app-titlebar-actions">
          ${renderTitlebarActions()}
        </div>
      </header>
      <div class="app-container">
      <div class="sidebar">
        <div class="sidebar-header">
          <h1>AI CLI Manager</h1>
          <button class="new-chat-btn" id="new-chat-btn">+ New Chat</button>
        </div>
        <div class="conversation-list" id="conversation-list">
          ${renderConversationList()}
        </div>
      </div>
      <div class="main-content">
        ${activeConversationId || pendingUserMessage ? `
        <div class="main-topbar">
          <div class="main-topbar-main">
            ${renderChatHeaderHtml(conversations.find((c) => c.id === activeConversationId))}
          </div>
        </div>
        ` : ''}
        ${activeConversationId || pendingUserMessage ? renderChatContent() : renderEmptyState()}
        <div class="input-area">
          <textarea id="message-input" rows="1" placeholder="Enter your message..."></textarea>
          <button class="send-btn" id="send-btn">Send</button>
        </div>
      </div>
      </div>
    </div>
  `;
  
  attachEventListeners();
}

function attachEventListeners() {
  document.querySelector('#new-chat-btn')?.addEventListener('click', newChat);

  const listEl = document.querySelector('#conversation-list');
  if (listEl) {
    listEl.removeEventListener('click', handleConversationListClick);
    listEl.addEventListener('click', handleConversationListClick);
  }

  const textarea = document.querySelector('#message-input') as HTMLTextAreaElement;
  if (textarea) {
    textarea.addEventListener('keydown', handleKeydown);
  }

  document.querySelector('#send-btn')?.addEventListener('click', sendMessage);
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
            <span class="settings-profile-meta">${escapeHtml(profile.defaultModel || profile.baseUrl || '未设置模型')}</span>
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
  (overlay.querySelector('input[name="defaultModel"]') as HTMLInputElement).value = config.defaultModel || '';
  (overlay.querySelector('input[name="haikuModel"]') as HTMLInputElement).value = config.haikuModel || '';
  (overlay.querySelector('input[name="sonnetModel"]') as HTMLInputElement).value = config.sonnetModel || '';
  (overlay.querySelector('input[name="opusModel"]') as HTMLInputElement).value = config.opusModel || '';

  const apiKeyInput = overlay.querySelector('input[name="apiKey"]') as HTMLInputElement;
  apiKeyInput.value = '';
  apiKeyInput.placeholder = config.hasApiKey ? '已配置，留空则不修改' : 'sk-...';
}

async function refreshSettingsModal(
  overlay: HTMLElement,
  selectedProfileId: string | null,
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
  updateSettingsFooterActions(overlay, state.profiles, resolvedSelectedId);
  return { state, selectedProfileId: resolvedSelectedId };
}

function updateSettingsFooterActions(
  overlay: HTMLElement,
  profiles: ApiProfileItem[],
  selectedProfileId: string | null,
) {
  const applyBtn = overlay.querySelector('.apply-profile') as HTMLButtonElement | null;
  const deleteBtn = overlay.querySelector('.delete-profile') as HTMLButtonElement | null;
  const selected = selectedProfileId
    ? profiles.find((profile) => profile.id === selectedProfileId)
    : null;

  if (applyBtn) {
    applyBtn.disabled = !selected || selected.isActive;
  }
  if (deleteBtn) {
    deleteBtn.disabled = !selected || selected.isActive;
  }
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
            <span>默认模型</span>
            <input
              type="text"
              name="defaultModel"
              class="settings-model-input"
              placeholder="claude-sonnet-4-20250514"
              data-model-field="defaultModel"
              readonly
            />
          </label>
          <div class="settings-model-grid">
            <label class="settings-field">
              <span>Haiku 模型</span>
              <input type="text" name="haikuModel" class="settings-model-input" placeholder="可选" data-model-field="haikuModel" readonly />
            </label>
            <label class="settings-field">
              <span>Sonnet 模型</span>
              <input type="text" name="sonnetModel" class="settings-model-input" placeholder="可选" data-model-field="sonnetModel" readonly />
            </label>
            <label class="settings-field">
              <span>Opus 模型</span>
              <input type="text" name="opusModel" class="settings-model-input" placeholder="可选" data-model-field="opusModel" readonly />
            </label>
          </div>
          <p class="settings-path settings-live-path"></p>
        </form>
      </div>
      <div class="settings-footer">
        <div class="settings-footer-left">
          <button type="button" class="settings-add-profile">+ 新建</button>
          <button type="button" class="settings-import-cc-switch">从 CC Switch 导入</button>
        </div>
        <div class="settings-footer-actions">
          <button type="button" class="settings-btn-secondary settings-btn-danger delete-profile">删除</button>
          <button type="button" class="settings-btn-primary save-only">保存</button>
          <button type="button" class="settings-btn-secondary apply-profile">应用</button>
        </div>
      </div>
    </div>
  `;

  const close = () => {
    document.removeEventListener('keydown', onEscapeKey);
    overlay.remove();
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

    event.preventDefault();
    close();
  };

  document.addEventListener('keydown', onEscapeKey);
  const livePathEl = overlay.querySelector('.settings-live-path') as HTMLElement | null;
  let fetchedModels: FetchedModel[] = [];
  let modelsFetchKey = '';

  const getModelsFetchKey = (): string => {
    const baseUrl =
      (overlay.querySelector('input[name="baseUrl"]') as HTMLInputElement | null)?.value.trim() || '';
    const apiKeyRaw =
      (overlay.querySelector('input[name="apiKey"]') as HTMLInputElement | null)?.value.trim() || '';
    const profileId = overlay.dataset.profileId || '';
    return `${baseUrl}|${profileId}|${apiKeyRaw}`;
  };

  const getModelFieldLabel = (field: ModelFieldName): string => {
    switch (field) {
      case 'haikuModel':
        return 'Haiku 模型';
      case 'sonnetModel':
        return 'Sonnet 模型';
      case 'opusModel':
        return 'Opus 模型';
      default:
        return '默认模型';
    }
  };

  const fetchModelsForSettings = async (): Promise<FetchedModel[]> => {
    const baseUrl = (overlay.querySelector('input[name="baseUrl"]') as HTMLInputElement | null)?.value.trim() || '';
    const apiKeyRaw = (overlay.querySelector('input[name="apiKey"]') as HTMLInputElement | null)?.value.trim();
    const profileId = overlay.dataset.profileId || null;

    if (!baseUrl) {
      throw new Error('请先填写 API Base URL');
    }

    fetchedModels = await invoke<FetchedModel[]>('fetch_api_models', {
      baseUrl,
      apiKey: apiKeyRaw || null,
      profileId,
    });
    modelsFetchKey = getModelsFetchKey();
    return fetchedModels;
  };

  const openModelPickerDialog = (field: ModelFieldName) => {
    if (document.querySelector('.model-picker-overlay')) {
      return;
    }

    const targetInput = overlay.querySelector(
      `[data-model-field="${field}"]`,
    ) as HTMLInputElement | null;
    if (!targetInput) return;

    const pickerOverlay = document.createElement('div');
    pickerOverlay.className = 'model-picker-overlay';
    pickerOverlay.innerHTML = `
      <div class="model-picker-dialog" role="dialog" aria-modal="true">
        <div class="model-picker-header">
          <h4 class="model-picker-title">选择${escapeHtml(getModelFieldLabel(field))}</h4>
          <button type="button" class="model-picker-close" aria-label="关闭">✕</button>
        </div>
        <div class="model-picker-toolbar">
          <input
            type="search"
            class="model-picker-search"
            placeholder="搜索或输入自定义模型名"
            value="${escapeHtml(targetInput.value)}"
          />
        </div>
        <div class="model-picker-list"></div>
        <p class="model-picker-tip">点击列表项快速选中，或在搜索框输入自定义模型名后点确定</p>
        <div class="model-picker-footer">
          <button type="button" class="model-picker-cancel">取消</button>
          <button type="button" class="model-picker-confirm">确定</button>
        </div>
      </div>
    `;

    const closePicker = () => pickerOverlay.remove();

    const applyValue = (value: string) => {
      const trimmed = value.trim();
      targetInput.value = trimmed;

      if (field === 'defaultModel' && trimmed) {
        (['haikuModel', 'sonnetModel', 'opusModel'] as const).forEach((subField) => {
          const subInput = overlay.querySelector(
            `[data-model-field="${subField}"]`,
          ) as HTMLInputElement | null;
          if (subInput) {
            subInput.value = trimmed;
          }
        });
      }

      closePicker();
    };

    const renderList = () => {
      const listEl = pickerOverlay.querySelector('.model-picker-list');
      const searchInput = pickerOverlay.querySelector('.model-picker-search') as HTMLInputElement | null;
      if (!listEl || !searchInput) return;

      const query = searchInput.value.trim().toLowerCase();
      if (fetchedModels.length === 0) {
        listEl.innerHTML = '<div class="model-picker-empty">暂无模型列表</div>';
        return;
      }

      const filtered = fetchedModels.filter((model) => {
        if (!query) return true;
        return (
          model.id.toLowerCase().includes(query) ||
          (model.ownedBy || '').toLowerCase().includes(query)
        );
      });

      if (filtered.length === 0) {
        listEl.innerHTML = '<div class="model-picker-empty">没有匹配的模型，可直接输入自定义名称</div>';
        return;
      }

      listEl.innerHTML = filtered
        .map(
          (model) => `
            <button type="button" class="model-picker-item" data-model-id="${escapeHtml(model.id)}">
              <span class="model-picker-item-id">${escapeHtml(model.id)}</span>
              ${model.ownedBy ? `<span class="model-picker-item-owner">${escapeHtml(model.ownedBy)}</span>` : ''}
            </button>
          `,
        )
        .join('');
    };

    pickerOverlay.querySelector('.model-picker-close')?.addEventListener('click', closePicker);
    pickerOverlay.querySelector('.model-picker-cancel')?.addEventListener('click', closePicker);
    pickerOverlay.addEventListener('click', (event) => {
      if (event.target === pickerOverlay) closePicker();
    });

    pickerOverlay.querySelector('.model-picker-confirm')?.addEventListener('click', () => {
      const searchInput = pickerOverlay.querySelector('.model-picker-search') as HTMLInputElement | null;
      applyValue(searchInput?.value || '');
    });

    pickerOverlay.querySelector('.model-picker-search')?.addEventListener('input', () => {
      renderList();
    });

    pickerOverlay.querySelector('.model-picker-search')?.addEventListener('keydown', (event) => {
      const keyboardEvent = event as KeyboardEvent;
      if (keyboardEvent.key === 'Enter') {
        keyboardEvent.preventDefault();
        const searchInput = pickerOverlay.querySelector('.model-picker-search') as HTMLInputElement | null;
        applyValue(searchInput?.value || '');
      }
    });

    pickerOverlay.querySelector('.model-picker-list')?.addEventListener('click', (event) => {
      const item = (event.target as HTMLElement).closest('.model-picker-item') as HTMLElement | null;
      const modelId = item?.dataset.modelId;
      if (!modelId) return;
      applyValue(modelId);
    });

    const runModelFetch = async () => {
      const listEl = pickerOverlay.querySelector('.model-picker-list');
      const baseUrl =
        (overlay.querySelector('input[name="baseUrl"]') as HTMLInputElement | null)?.value.trim() || '';

      if (!baseUrl) {
        if (listEl) {
          listEl.innerHTML = '<div class="model-picker-empty">请先填写 API Base URL</div>';
        }
        return;
      }

      if (listEl) {
        listEl.innerHTML = '<div class="model-picker-empty">正在拉取模型...</div>';
      }

      try {
        await fetchModelsForSettings();
        renderList();
      } catch (e) {
        if (listEl) {
          listEl.innerHTML = `<div class="model-picker-empty">拉取失败：${escapeHtml(String(e))}</div>`;
        }
      }
    };

    document.body.appendChild(pickerOverlay);

    const currentFetchKey = getModelsFetchKey();
    const baseUrl =
      (overlay.querySelector('input[name="baseUrl"]') as HTMLInputElement | null)?.value.trim() || '';
    if (!baseUrl) {
      const listEl = pickerOverlay.querySelector('.model-picker-list');
      if (listEl) {
        listEl.innerHTML = '<div class="model-picker-empty">请先填写 API Base URL</div>';
      }
    } else if (fetchedModels.length > 0 && modelsFetchKey === currentFetchKey) {
      renderList();
    } else {
      void runModelFetch();
    }

    const searchInput = pickerOverlay.querySelector('.model-picker-search') as HTMLInputElement | null;
    searchInput?.focus();
    searchInput?.select();
  };

  const bindModelPickerEvents = () => {
    overlay.querySelectorAll('.settings-model-input').forEach((input) => {
      input.addEventListener('click', () => {
        const field = (input as HTMLInputElement).dataset.modelField as ModelFieldName;
        openModelPickerDialog(field);
      });
    });
  };

  const bindProfileListEvents = () => {
    const list = overlay.querySelector('.settings-profile-list') as HTMLElement | null;
    if (!list || list.dataset.bound === 'true') {
      return;
    }
    list.dataset.bound = 'true';
    list.addEventListener('click', async (event) => {
      const target = event.target as HTMLElement;
      const item = target.closest('.settings-profile-item') as HTMLElement | null;
      if (!item) return;

      const profileId = item.dataset.profileId;
      if (!profileId) return;

      try {
        await refreshSettingsModal(overlay, profileId);
      } catch (e) {
        alert('加载 API 配置失败: ' + String(e));
      }
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

  overlay.querySelector('.apply-profile')?.addEventListener('click', async () => {
    const applyBtn = overlay.querySelector('.apply-profile') as HTMLButtonElement | null;
    const profileId = overlay.dataset.profileId;
    if (!profileId || !applyBtn || applyBtn.disabled) return;

    try {
      await invoke('switch_api_profile', { profileId });
      await refreshSettingsModal(overlay, profileId);
      if (livePathEl) {
        const state = await invoke<ApiProfilesState>('get_api_profiles_state');
        livePathEl.textContent = `配置文件：${state.current.configPath}`;
      }
    } catch (e) {
      alert('应用 API 配置失败: ' + String(e));
    }
  });

  overlay.querySelector('.delete-profile')?.addEventListener('click', async () => {
    const deleteBtn = overlay.querySelector('.delete-profile') as HTMLButtonElement | null;
    const profileId = overlay.dataset.profileId;
    if (!profileId || !deleteBtn || deleteBtn.disabled) return;

    const profileName =
      (overlay.querySelector('input[name="profileName"]') as HTMLInputElement | null)?.value.trim() ||
      '此配置';
    const confirmed = await showConfirmDialog({
      title: '删除配置',
      message: `确定要删除配置「${escapeHtml(profileName)}」吗？`,
      sub: '删除后无法恢复；若正在使用该配置，将自动切换到其他配置。',
      confirmLabel: '删除',
    });
    if (!confirmed) return;

    try {
      await invoke('delete_api_profile', { profileId });
      const refreshed = await refreshSettingsModal(overlay, null);
      if (livePathEl) {
        livePathEl.textContent = `配置文件：${refreshed.state.current.configPath}`;
      }
    } catch (e) {
      alert('删除配置失败: ' + String(e));
    }
  });

  overlay.querySelector('.settings-close-btn')?.addEventListener('click', close);
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
      const result = await invoke<ApiProfilesState>('upsert_api_profile', {
        profileId: profileId || null,
        name: profileName,
        config: {
          baseUrl: String(formData.get('baseUrl') || '').trim(),
          apiKey: apiKeyRaw || null,
          defaultModel: String(formData.get('defaultModel') || '').trim(),
          haikuModel: String(formData.get('haikuModel') || '').trim(),
          sonnetModel: String(formData.get('sonnetModel') || '').trim(),
          opusModel: String(formData.get('opusModel') || '').trim(),
        },
        apply: false,
      });

      const savedProfileId =
        profileId ||
        result.profiles.find((profile) => profile.name === profileName)?.id ||
        result.activeProfileId ||
        null;

      await refreshSettingsModal(overlay, savedProfileId);

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
        configPath: '',
      },
      '',
      null,
    );
    overlay.querySelectorAll('.settings-profile-item').forEach((item) => {
      item.classList.remove('selected');
    });
    updateSettingsFooterActions(overlay, [], null);
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
      await refreshSettingsModal(overlay, selectedId);

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
    const initial = await refreshSettingsModal(overlay, null);
    if (livePathEl) {
      livePathEl.textContent = `配置文件：${initial.state.current.configPath}`;
    }
    bindProfileListEvents();
    bindModelPickerEvents();
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
  const cwd = getProjectDir(conversation);

  return `
    <div class="chat-header-left">
      <h2>${escapeHtml(title)}</h2>
      <span class="platform-badge">${platforms[platform]?.name || platform}</span>
    </div>
    <div class="chat-header-meta">
      <span class="session-id" title="Session ID: ${escapeHtml(sessionId)}">${escapeHtml(sessionId)}</span>
      <span class="session-cwd" title="Working Directory: ${escapeHtml(cwd)}">${escapeHtml(cwd)}</span>
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
    </div>
  `;
}

function newChat() {
  activeConversationId = '';
  pendingUserMessage = null;
  transientSessionError = null;
  render();
  
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

  const content = input.value.trim();
  input.value = '';

  if (sendBtn) {
    sendBtn.disabled = true;
    sendBtn.textContent = 'Waiting...';
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
  const sendBtn = document.querySelector<HTMLButtonElement>('#send-btn');
  if (sendBtn) {
    sendBtn.disabled = false;
    sendBtn.textContent = 'Send';
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
  }
  
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
    const sendBtn = document.querySelector<HTMLButtonElement>('#send-btn');
    if (sendBtn?.disabled) {
      showPendingAssistantIndicator();
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
  render();
  
  setTimeout(() => {
    const messageList = document.querySelector<HTMLDivElement>('#message-list');
    if (messageList) {
      messageList.scrollTop = messageList.scrollHeight;
    }
  }, 100);
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
