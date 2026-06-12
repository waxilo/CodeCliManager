import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';

interface Message {
  id: string;
  role: string;
  content: string;
  timestamp: number;
}

interface Conversation {
  id: string;
  title: string;
  messages: Message[];
  platform: string;
  created_at: number;
  updated_at: number;
}

interface SessionEventPayload {
  conversation_id: string;
  title: string;
  messages: Message[];
  updated_at: number;
}

interface PlatformConfig {
  name: string;
  command: string;
  args: string[];
  env_vars: Record<string, string>;
}

let conversations: Conversation[] = [];
let platforms: Record<string, PlatformConfig> = {};
let currentPlatform = '';
let activeConversationId = '';
let editingConversationId: string | null = null;
let currentTime = new Date();

const app = document.querySelector<HTMLDivElement>('#app')!;

async function init() {
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
  // 监听会话创建事件
  await listen<SessionEventPayload>('session-created', (event) => {
    const payload = event.payload;
    activeConversationId = payload.conversation_id;
    
    // 更新会话列表中的这个会话
    updateOrAddConversation({
      id: payload.conversation_id,
      title: payload.title,
      messages: payload.messages,
      platform: 'claude',
      created_at: payload.updated_at,
      updated_at: payload.updated_at,
    });
    
    // 刷新界面并选中新会话
    render();
    
    setTimeout(() => {
      const messageList = document.querySelector<HTMLDivElement>('#message-list');
      if (messageList) {
        messageList.scrollTop = messageList.scrollHeight;
      }
    }, 100);
  });
  
  // 监听消息更新事件
  await listen<SessionEventPayload>('messages-updated', (event) => {
    const payload = event.payload;
    
    // 更新会话内容
    updateOrAddConversation({
      id: payload.conversation_id,
      title: payload.title,
      messages: payload.messages,
      platform: 'claude',
      created_at: payload.updated_at,
      updated_at: payload.updated_at,
    });
    
    // 如果是当前活动会话，刷新右侧内容
    if (payload.conversation_id === activeConversationId) {
      refreshChatContent();
    } else {
      // 更新左侧列表显示
      renderConversationList();
    }
  });
  
  // 监听会话结束事件
  await listen<string | null>('session-ended', (_event) => {
    // 会话结束，可以做一些清理工作
    // 例如：重新加载完整会话列表
    loadData().then(() => {
      renderConversationList();
    });
  });
}

// 在内存中更新或添加会话
function updateOrAddConversation(conv: Conversation) {
  const idx = conversations.findIndex(c => c.id === conv.id);
  if (idx >= 0) {
    conversations[idx] = conv;
  } else {
    conversations.unshift(conv);
  }
  // 按 updated_at 降序排序
  conversations.sort((a, b) => b.updated_at - a.updated_at);
}

async function loadData() {
  try {
    conversations = await invoke<Conversation[]>('get_conversations');
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
      <div class="conversation-item ${isActive ? 'active' : ''}" data-id="${c.id}">
        ${isActive ? '<div class="active-indicator"></div>' : ''}
        <div class="conversation-main" ${!isEditing ? `onclick="selectConversation('${c.id}')"` : ''}>
          <div class="conversation-header">
            <div class="conversation-title">${isEditing ? '' : escapeHtml(c.title)}</div>
            ${compactTime ? `<span class="compact-time">${compactTime}</span>` : ''}
          </div>
          <div class="conversation-meta">
            <span class="platform-tag">${platformName}</span>
            ${messageCount > 0 ? `<span class="message-count">${messageCount}</span>` : ''}
          </div>
        </div>
        ${isEditing ? `
          <div class="edit-container">
            <input type="text" 
                   class="edit-input" 
                   id="edit-input-${c.id}"
                   value="${escapeHtml(c.title)}"
                   onkeydown="handleEditKeydown(event, '${c.id}')"
            />
            <button class="edit-action-btn save" onclick="saveEdit('${c.id}')">✓</button>
            <button class="edit-action-btn cancel" onclick="cancelEdit()">✕</button>
          </div>
        ` : `
          <div class="action-buttons">
            <button class="action-btn edit" onclick="startEdit('${c.id}')" title="Edit">✎</button>
            <button class="action-btn delete" onclick="deleteConversation('${c.id}')" title="Delete">🗑</button>
          </div>
        `}
      </div>
    `;
  }).join('');
}

function render() {
  app.innerHTML = `
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
        ${activeConversationId ? renderChatContent() : renderEmptyState()}
        <div class="input-area">
          <textarea id="message-input" placeholder="Enter your message..."></textarea>
          <button class="send-btn" id="send-btn">Send</button>
        </div>
      </div>
    </div>
  `;
  
  attachEventListeners();
}

function attachEventListeners() {
  document.querySelector('#new-chat-btn')?.addEventListener('click', newChat);
  
  const textarea = document.querySelector('#message-input') as HTMLTextAreaElement;
  if (textarea) {
    textarea.addEventListener('keydown', handleKeydown);
  }
  
  document.querySelector('#send-btn')?.addEventListener('click', sendMessage);
  
  // Focus edit input if editing
  if (editingConversationId) {
    setTimeout(() => {
      const editInput = document.querySelector(`#edit-input-${editingConversationId}`) as HTMLInputElement;
      if (editInput) {
        editInput.focus();
        editInput.select();
      }
    }, 50);
  }
}

function renderChatContent(): string {
  const conversation = conversations.find(c => c.id === activeConversationId);
  if (!conversation) return '';
  
  return `
    <div class="chat-header">
      <h2>${escapeHtml(conversation.title)}</h2>
      <span class="platform-badge">${platforms[conversation.platform]?.name || conversation.platform}</span>
    </div>
    <div class="message-list" id="message-list">
      ${conversation.messages.map(msg => `
        <div class="message ${msg.role}">
          <div class="message-avatar">${msg.role === 'user' ? 'You' : 'AI'}</div>
          <div class="message-content">
            <pre>${escapeHtml(msg.content)}</pre>
            <div class="message-time">${formatTime(msg.timestamp)}</div>
          </div>
        </div>
      `).join('')}
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
  
  const content = input.value.trim();
  input.value = '';
  
  if (sendBtn) sendBtn.disabled = true;
  
  try {
    // 发送消息到后端，后端启动 shell 并通过事件系统推送更新
    await invoke('execute_prompt', { 
      prompt: content,
      conversation_id: activeConversationId || undefined
    });
  } catch (e) {
    console.error('Failed to send message:', e);
    alert('Failed to send message: ' + String(e));
    if (sendBtn) sendBtn.disabled = false;
  }
}

// 只刷新右侧聊天内容
function refreshChatContent() {
  const mainContent = document.querySelector<HTMLDivElement>('.main-content');
  if (!mainContent || !activeConversationId) return;
  
  const conversation = conversations.find((c: Conversation) => c.id === activeConversationId);
  if (!conversation) return;
  
  const messageList = document.querySelector<HTMLDivElement>('#message-list');
  const chatHeader = document.querySelector<HTMLDivElement>('.chat-header');
  
  if (chatHeader) {
    chatHeader.innerHTML = `
      <h2>${escapeHtml(conversation.title)}</h2>
      <span class="platform-badge">${platforms[conversation.platform]?.name || conversation.platform}</span>
    `;
  }
  
  if (messageList) {
    messageList.innerHTML = conversation.messages.map((msg: Message) => `
      <div class="message ${msg.role}">
        <div class="message-avatar">${msg.role === 'user' ? 'You' : 'AI'}</div>
        <div class="message-content">
          <pre>${escapeHtml(msg.content)}</pre>
          <div class="message-time">${formatTime(msg.timestamp)}</div>
        </div>
      </div>
    `).join('');
    
    messageList.scrollTop = messageList.scrollHeight;
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
  if (confirm('Are you sure you want to delete this conversation?')) {
    await invoke('delete_conversation', { conversation_id: id });
    await loadData();
    if (activeConversationId === id) {
      activeConversationId = conversations.length > 0 ? conversations[0].id : '';
    }
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
  
  const newTitle = input.value.trim();
  if (!newTitle) {
    cancelEdit();
    return;
  }
  
  try {
    await invoke('update_conversation_title', {
      conversation_id: id,
      title: newTitle
    });
    await loadData();
    editingConversationId = null;
    render();
  } catch (e) {
    console.error('Failed to update title:', e);
    alert('Failed to update title: ' + String(e));
  }
}

function handleEditKeydown(e: KeyboardEvent, id: string) {
  if (e.key === 'Enter') {
    e.preventDefault();
    saveEdit(id);
  } else if (e.key === 'Escape') {
    e.preventDefault();
    cancelEdit();
  }
}

// 将函数暴露到全局作用域
(window as any).selectConversation = selectConversation;
(window as any).deleteConversation = deleteConversation;
(window as any).startEdit = startEdit;
(window as any).cancelEdit = cancelEdit;
(window as any).saveEdit = saveEdit;
(window as any).handleEditKeydown = handleEditKeydown;

init();
