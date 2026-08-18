import { appState } from '../../state';
import { escapeHtml } from '../../utils';
import { showCopyToastMsg } from '../../ui';
import { selectConversation, deleteConversation, exportConversationToMarkdown, startEdit, deleteWorkspaceConversations } from '../conversations';
import { newChatInWorkspace } from './workspace-grouping';
import { openPathInFileManager, openPathInShell } from '../chat/input-composer';
import { cancelEdit, saveEdit, handleEditKeydown } from '../conversations/edit-export';
import { UNCATEGORIZED_WORKSPACE_KEY, toggleWorkspaceExpanded } from './render-list';
import { copyTextToClipboard } from '../../utils/clipboard';
export function handleConversationListKeydown(e: Event) {
  const event = e as KeyboardEvent;
  const target = event.target as HTMLElement;

  // 编辑输入框：Enter 提交 / Escape 取消（委托随 #conversation-list 常驻，
  // 列表 innerHTML 重建后编辑态按键依然有效）
  const editInput = target.closest<HTMLInputElement>('input.edit-input');
  if (editInput && (event.key === 'Enter' || event.key === 'Escape')) {
    const id = editInput.id.replace('edit-input-', '');
    const sourcePath = editInput.dataset.sourcePath || null;
    if (id) {
      handleEditKeydown(event, id, sourcePath);
      return;
    }
  }

  if (event.key !== 'Enter' && event.key !== ' ') return;

  // 焦点在卡片内的操作按钮上时交给按钮自身处理，避免同时触发展开
  if (target.closest('button')) return;

  const header = target.closest<HTMLElement>('.workspace-header');
  const key = header?.dataset.workspace;
  if (!header || !key) return;

  event.preventDefault();
  toggleWorkspaceExpanded(key);
}

export function handleConversationListClick(e: Event) {
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

    const sourcePath = actionEl.dataset.sourcePath || null;

    if (action === 'more' && id) {
      toggleConversationMenu(id, sourcePath, actionEl as HTMLElement);
      return;
    }
    if (action === 'save-edit' && id) {
      void saveEdit(id, sourcePath);
      return;
    }
    if (action === 'cancel-edit') {
      cancelEdit();
    }
    return;
  }

  if (appState.editingConversationId) return;

  const item = target.closest('.conversation-item') as HTMLElement | null;
  const id = item?.dataset.id;
  const sourcePath = item?.dataset.sourcePath || null;
  if (id) {
    selectConversation(id, sourcePath);
  }
}

export function handleConversationListContextMenu(e: Event) {
  const target = e.target as HTMLElement;
  const event = e as MouseEvent;

  // 会话条目右键 → 会话操作菜单（重命名 / 导出 / 删除），锚定鼠标位置
  const item = target.closest<HTMLElement>('.conversation-item');
  if (item) {
    const id = item.dataset.id;
    const sourcePath = item.dataset.sourcePath || null;
    if (!id) return;
    e.preventDefault();
    e.stopPropagation();
    toggleConversationMenu(id, sourcePath, item, event);
    return;
  }

  // 工作区 header 右键 → 项目操作菜单
  const workspaceHeader = target.closest('.workspace-header') as HTMLElement | null;
  if (!workspaceHeader) return;

  // 排除「未分类」分组
  const workspacePath = workspaceHeader.dataset.workspace;
  if (!workspacePath || workspacePath === UNCATEGORIZED_WORKSPACE_KEY) return;

  e.preventDefault();
  e.stopPropagation();
  toggleWorkspaceMenu(workspacePath, workspaceHeader, event);
}

export function closeWorkspaceContextMenu() {
  document.querySelector('.ws-menu-overlay')?.remove();
}

/**
 * 工作区（项目）操作菜单。
 * - 由 ⋮ 按钮触发时锚定按钮右下角
 * - 由右键触发时锚定鼠标位置
 */
export function toggleWorkspaceMenu(workspacePath: string, anchorEl: HTMLElement, event?: MouseEvent) {
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

export function closeConversationMenu() {
  document.querySelector('.conv-menu-overlay')?.remove();
  closeWorkspaceContextMenu();
}

/**
 * 会话操作菜单。
 * - 由 ⋮ 按钮触发时锚定按钮右下角
 * - 由右键触发时锚定鼠标位置
 */
export function toggleConversationMenu(
  conversationId: string,
  sourcePath: string | null,
  anchorEl: HTMLElement,
  event?: MouseEvent,
) {
  const existing = document.querySelector<HTMLElement>('.conv-menu-overlay');
  if (
    existing?.dataset.convId === conversationId &&
    (existing.dataset.sourcePath || null) === sourcePath
  ) {
    return closeConversationMenu();
  }
  closeConversationMenu();

  const { right, bottom, top: anchorTop } = anchorEl.getBoundingClientRect();
  const escapedSourcePath = escapeHtml(sourcePath || '');

  const overlay = document.createElement('div');
  overlay.className = 'conv-menu-overlay';
  overlay.dataset.convId = conversationId;
  overlay.dataset.sourcePath = sourcePath || '';
  overlay.innerHTML = `
    <div class="conv-menu-dropdown">
      <button type="button" class="conv-menu-item" data-action="edit" data-id="${conversationId}" data-source-path="${escapedSourcePath}">重命名</button>
      <button type="button" class="conv-menu-item" data-action="export" data-id="${conversationId}" data-source-path="${escapedSourcePath}">导出为 Markdown</button>
      <button type="button" class="conv-menu-item is-danger" data-action="delete" data-id="${conversationId}" data-source-path="${escapedSourcePath}">删除</button>
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
    const sourcePath = btn.dataset.sourcePath || null;
    closeMenu();
    if (action === 'edit' && id) startEdit(id, sourcePath);
    if (action === 'export' && id) void exportConversationToMarkdown(id, sourcePath);
    if (action === 'delete' && id) void deleteConversation(id, sourcePath);
  });

  document.body.appendChild(overlay);

  requestAnimationFrame(() => {
    const menu = overlay.querySelector<HTMLElement>('.conv-menu-dropdown');
    if (!menu) return;
    const r = menu.getBoundingClientRect();
    if (event) {
      // 右键：锚定鼠标位置，超出视口时折回
      const left = event.clientX + r.width > window.innerWidth ? Math.max(8, event.clientX - r.width) : event.clientX;
      const top = event.clientY + r.height > window.innerHeight ? Math.max(8, event.clientY - r.height) : event.clientY;
      menu.style.left = `${Math.max(8, left)}px`;
      menu.style.top = `${Math.max(8, top)}px`;
    } else {
      // ⋮ 按钮：右对齐于按钮下方
      menu.style.left = `${Math.max(8, right - r.width)}px`;
      menu.style.top = `${bottom + r.height > window.innerHeight ? Math.max(8, anchorTop - r.height - 4) : bottom + 4}px`;
    }
  });
}

