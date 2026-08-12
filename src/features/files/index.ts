import { appState } from '../../state';
import * as api from '../../api';
import { escapeHtml } from '../../utils';
import { showCopyToastMsg } from '../../ui';
import { open } from '@tauri-apps/plugin-dialog';
import { getCurrentWebviewWindow } from '@tauri-apps/api/webviewWindow';
import type { FileRef } from '../../types';
import { getEffectiveProjectDir } from '../chat/session-context';
import { init } from '../../app/bootstrap';
import { updateSendButtonState } from '../chat/session-context';
import { ImportedFileRef } from '../../state/app-state';
// ── @file 引用功能 ──────────────────────────────────────────────────

// ── 粘贴图片附件 ────────────────────────────────────────────────────

export function getPasteUploadsDir(): string {
  const dir = getEffectiveProjectDir();
  return dir.endsWith('/') ? dir + '.clipboard-uploads' : dir + '/.clipboard-uploads';
}

export async function handlePaste(e: ClipboardEvent) {
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
        await api.writeFileBytes(filePath, Array.from(new Uint8Array(buf)));

        const objectUrl = URL.createObjectURL(new Blob([buf], { type: item.type }));
        // 保存绝对路径：prompt、消息内容与文件芯片均使用绝对路径，
        // 避免切换会话（不同项目目录）后相对路径解析到错误位置
        appState.pasteAttachments.push({ path: filePath, name: fileName, objectUrl });
        renderPasteAttachmentsBar();
      } catch (e) {
        console.error('Failed to save pasted image:', e);
      }
    }
  }
}

export function renderPasteAttachmentsBar() {
  const bar = document.querySelector('#paste-attachments-bar');
  if (!bar) return;

  if (appState.pasteAttachments.length === 0) {
    (bar as HTMLElement).style.display = 'none';
    bar.innerHTML = '';
    return;
  }

  (bar as HTMLElement).style.display = 'flex';
  bar.innerHTML = appState.pasteAttachments
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
      if (!isNaN(idx) && appState.pasteAttachments[idx]) {
        URL.revokeObjectURL(appState.pasteAttachments[idx].objectUrl);
        appState.pasteAttachments.splice(idx, 1);
        renderPasteAttachmentsBar();
      }
    });
  });

  bar.querySelectorAll('.paste-attachment-thumb').forEach((thumb) => {
    thumb.addEventListener('click', () => {
      const idx = parseInt((thumb as HTMLElement).dataset.idx || '');
      if (!isNaN(idx) && appState.pasteAttachments[idx]) {
        openImageLightbox(appState.pasteAttachments[idx].objectUrl);
      }
    });
  });
}

export function clearPasteAttachments() {
  appState.pasteAttachments.forEach((att) => URL.revokeObjectURL(att.objectUrl));
  appState.pasteAttachments = [];
  renderPasteAttachmentsBar();
}

// ── @File[] 引用格式辅助函数 ────────────────────────────────────────

/** 将原始路径包装为 @File[path] 引用，去除 Windows canonicalize 产生的 \\?\ 前缀 */
export function wrapFileRef(path: string): string {
  const cleanPath = path.replace(/^\\\\\?\\/, '');
  return `@File[${cleanPath}]`;
}

/** 从 @File[path] 引用中提取路径 */
export function unwrapFileRef(ref: string): string {
  const m = ref.match(/^@File\[(.+)]$/);
  return m ? m[1] : ref;
}

/** 解析文本中所有 @File[path] 与 @path 引用，返回 FileRef 数组 */
export function parseFileRefs(text: string): FileRef[] {
  const results: FileRef[] = [];
  const seen = new Set<string>();

  // @File[path] 标签（导入文件 / 粘贴图片的持久化形式）
  const tagPattern = /@File\[([^\]]+)]/g;
  let match: RegExpExecArray | null;
  while ((match = tagPattern.exec(text)) !== null) {
    const path = match[1].replace(/\/$/, '');
    if (!seen.has(path)) {
      seen.add(path);
      results.push({ path, isImage: isImageFile(path) });
    }
  }

  // @path 形式（粘贴图片走 CLI 时以 @绝对路径 写入会话文件，如 @/abs/project/.clipboard-uploads/pasted-1.png），
  // 路径需包含分隔符，避免把 @user、@mention 等误判为文件引用
  const pathPattern = /@([^\s@]+[/\\][^\s@]*)/g;
  while ((match = pathPattern.exec(text)) !== null) {
    const raw = match[1];
    if (raw.startsWith('File[')) continue; // @File[...] 已在上方处理
    const path = raw.replace(/\/$/, '');
    if (path && !seen.has(path)) {
      seen.add(path);
      results.push({ path, isImage: isImageFile(path) });
    }
  }

  return results;
}

/** 从显示文本中剥离 @File[path] 引用 */
export function stripFileRefTags(text: string): string {
  return text.replace(/@File\[[^\]]+]\s*/g, '').replace(/\s{2,}/g, ' ').trim();
}

// ── 导入/拖放文件预览栏 ────────────────────────────────────────────

export function addImportedFileRef(entry: ImportedFileRef): void {
  // 避免重复
  if (appState.importedFileRefs.some((e) => e.ref === entry.ref)) return;
  appState.importedFileRefs.push(entry);
  renderImportedFileBar();
}

export function renderImportedFileBar(): void {
  const bar = document.querySelector('#imported-file-bar');
  if (!bar) return;

  if (appState.importedFileRefs.length === 0) {
    (bar as HTMLElement).style.display = 'none';
    bar.innerHTML = '';
    return;
  }

  (bar as HTMLElement).style.display = 'flex';
  bar.innerHTML = appState.importedFileRefs
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
      if (!isNaN(idx) && appState.importedFileRefs[idx]) {
        removeImportedFileRef(idx);
      }
    });
  });

  // 双击卡片预览（图片 / txt）
  bar.querySelectorAll('.imported-file-card').forEach((card) => {
    card.addEventListener('dblclick', () => {
      const idx = parseInt((card as HTMLElement).dataset.idx || '');
      if (!isNaN(idx) && appState.importedFileRefs[idx]) {
        void previewImportedFile(idx);
      }
    });
  });
}

export function removeImportedFileRef(idx: number): void {
  const entry = appState.importedFileRefs[idx];
  if (!entry) return;
  appState.importedFileRefs.splice(idx, 1);
  renderImportedFileBar();
  updateSendButtonState();
}

export function clearImportedFileRefs(): void {
  appState.importedFileRefs = [];
  renderImportedFileBar();
}

export async function previewImportedFile(idx: number): Promise<void> {
  const entry = appState.importedFileRefs[idx];
  if (!entry) return;
  if (entry.isDir) return;

  const filePath = unwrapFileRef(entry.ref);

  if (entry.isImage) {
    try {
      const mime = getImageMime(filePath);
      const b64 = await api.readFileBase64(filePath);
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
    const content = await api.readFileContent(filePath);
    openTextPreview(content, entry.fileName);
  } catch (e) {
    console.error('读取文件失败:', e);
  }
}

export function openTextPreview(content: string, fileName: string) {
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

export async function openPdfPreview(filePath: string, fileName: string): Promise<void> {
  const existing = document.querySelector('#pdf-preview-overlay');
  if (existing) existing.remove();

  let pdfDataUrl = '';
  try {
    const b64 = await api.readFileBase64(filePath);
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

export function openImageLightbox(src: string) {
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

export async function loadProjectFiles(): Promise<string[]> {
  const dir = getEffectiveProjectDir();
  if (!dir) return [];
  if (appState._cachedFileList !== null && appState._cachedProjectDir === dir) {
    return appState._cachedFileList;
  }
  try {
    const files = await api.listProjectFiles(dir );
    appState._cachedFileList = files;
    appState._cachedProjectDir = dir;
    return files;
  } catch (e) {
    console.error('Failed to list project files:', e);
    return [];
  }
}

export function invalidateFileCache() {
  appState._cachedFileList = null;
  appState._cachedProjectDir = '';
}

export function getFileSuggestionsContainer(): HTMLDivElement | null {
  return document.querySelector('#file-suggestions');
}

export function showFileSuggestions(files: string[], filter: string) {
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

export function hideFileSuggestions() {
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
export function stripFileRefsFromDisplay(text: string): string {
  return text.replace(/@[^\s@]*[/\\][^\s@]*/g, '').replace(/\s{2,}/g, ' ').trim();
}

/**
 * 去重比较用归一化：剥离 @File[] 标签与 @path 文件引用，得到纯文本。
 * 发送时展示内容（command.messageContent）与会话文件回传内容（command.prompt）
 * 在引用形式上不一致（@File[] vs @相对路径），直接比较会误判为两条消息，
 * 归一化后可正确识别为同一条用户消息，避免“发送两遍”的重复气泡。
 */
export function normalizeMessageForCompare(content: string | null | undefined): string {
  const clean = stripFileRefTags(stripFileRefsFromDisplay(content || '')).trim();
  if (clean) return clean;
  // 纯附件消息（如图片）无文字可比较，改用附件路径作键，
  // 避免两条不同图片消息都被归一化为空串而误判为同一消息
  const refs = parseFileRefs(content || '');
  return refs.length > 0 ? refs.map((r) => r.path).sort().join('|') : '';
}

/**
 * 根据文件路径判断文件类型，用于图标展示
 */
export function isImageFile(filePath: string): boolean {
  const ext = filePath.split('.').pop()?.toLowerCase() || '';
  return ['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'bmp', 'ico', 'avif'].includes(ext);
}

export function isOtherBinaryFile(filePath: string): boolean {
  const ext = filePath.split('.').pop()?.toLowerCase() || '';
  return ['pdf', 'zip', 'tar', 'gz', '7z', 'rar', 'mp4', 'mp3', 'mov', 'avi',
    'woff', 'woff2', 'ttf', 'eot', 'otf', 'exe', 'dll', 'so', 'dylib',
    'class', 'jar', 'war', 'wasm', 'bin', 'dat', 'db', 'sqlite',
    'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx', 'pages', 'numbers', 'key',
  ].includes(ext);
}

export function getFileSuggestionIcon(filePath: string): string {
  // 目录
  if (filePath.endsWith('/')) return '📁';
  // 图片
  if (isImageFile(filePath)) return '🖼️';
  // 已知二进制
  if (isOtherBinaryFile(filePath)) return '📎';
  // 默认文本
  return '📄';
}

export function getImageMime(filePath: string): string {
  const ext = filePath.split('.').pop()?.toLowerCase() || 'png';
  const mimeMap: Record<string, string> = {
    png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg',
    gif: 'image/gif', webp: 'image/webp', svg: 'image/svg+xml',
    bmp: 'image/bmp', ico: 'image/x-icon', avif: 'image/avif',
  };
  return mimeMap[ext] || 'image/png';
}

/** 消息中文件引用芯片的双击预览（与导入卡片复用同一套预览逻辑） */
export async function previewFileByPath(rawPath: string): Promise<void> {
  const fullPath = resolveFilePath(rawPath);
  const fileName = rawPath.replace(/\/$/, '').split(/[/\\]/).pop() || rawPath;

  if (isImageFile(rawPath)) {
    try {
      const mime = getImageMime(rawPath);
      const b64 = await api.readFileBase64(fullPath );
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
    const content = await api.readFileContent(fullPath );
    openTextPreview(content, fileName);
  } catch (e) {
    console.error('读取文件失败:', e);
  }
}

export function getActiveSuggestionIndex(): number {
  const container = getFileSuggestionsContainer();
  if (!container) return -1;
  const items = container.querySelectorAll('.file-suggestion-item');
  for (let i = 0; i < items.length; i++) {
    if (items[i].classList.contains('active')) return i;
  }
  return -1;
}

export function selectSuggestion(index: number) {
  const container = getFileSuggestionsContainer();
  if (!container) return;
  const items = container.querySelectorAll('.file-suggestion-item');
  items.forEach((item) => item.classList.remove('active'));
  if (index >= 0 && index < items.length) {
    items[index].classList.add('active');
    items[index].scrollIntoView({ block: 'nearest' });
  }
}

export function getCurrentAtFilter(): { before: string; filter: string } | null {
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

export async function handleFileSuggestionInput() {
  const atInfo = getCurrentAtFilter();
  if (!atInfo) {
    hideFileSuggestions();
    return;
  }

  const files = await loadProjectFiles();
  showFileSuggestions(files, atInfo.filter);
}

export function insertFileReference(filePath: string) {
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

export function handleFileSuggestionKeydown(e: KeyboardEvent) {
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
export function showImportMenu(anchor: HTMLElement): void {
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

export async function handleImportExternalFile(): Promise<void> {
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
        const result = await api.importExternalPath({
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

export async function handleImportExternalFolder(): Promise<void> {
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

    const result = await api.importExternalPath({
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

export async function bindDragDropFileRefs() {
  // 避免重复注册监听器
  if (appState._unlistenDragDrop) appState._unlistenDragDrop();
  const win = getCurrentWebviewWindow();

  appState._unlistenDragDrop = await win.onDragDropEvent(async (event) => {
    const dropTarget = document.querySelector('.main-content');

    if (event.payload.type === 'over') {
      dropTarget?.classList.add('drag-over');
    } else if (event.payload.type === 'leave') {
      dropTarget?.classList.remove('drag-over');
    } else if (event.payload.type === 'drop') {
      dropTarget?.classList.remove('drag-over');

      // 防止同一拖放操作重复触发（300ms 内忽略重复 drop）
      const now = Date.now();
      if (now - appState._lastDropTime < 300) return;
      appState._lastDropTime = now;

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
            const result = await api.importExternalPath({ source: fullPath, projectDir });
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

/**
 * 解析 prompt 中的 @file 引用。
 * - 文本文件：尝试读取内容拼入 prompt
 * - 图片/二进制/目录：保留 @path 引用让 CLI 处理
 * 返回 { prompt, displayPrompt, refs }：
 *   prompt        — 发给 CLI 的最终内容（含嵌入的文件文本和 @引用）
 *   displayPrompt — 用于消息气泡展示的干净文本（已剥离已解析的 @path 引用）
 *   refs          — 匹配到的文件引用列表
 */
export async function resolveFileReferences(prompt: string): Promise<{ prompt: string; displayPrompt: string; refs: FileRef[] }> {
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
        const content = await api.readFileContent(fullPath );
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
        await api.readFileContent(fullPath );
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
export function isAbsolutePath(p: string): boolean {
  // Unix 绝对路径
  if (p.startsWith('/')) return true;
  // Windows 绝对路径: 盘符 + :\ 或 :/
  if (/^[A-Za-z]:[\\/]/.test(p)) return true;
  // Windows UNC 路径: \\
  if (p.startsWith('\\\\')) return true;
  return false;
}

/** 将文件路径解析为可读取的绝对路径（相对路径自动拼接项目目录） */
export function resolveFilePath(filePath: string): string {
  if (isAbsolutePath(filePath)) return filePath;
  const dir = getEffectiveProjectDir();
  if (!dir) return filePath;
  return (dir.endsWith('/') ? dir : dir + '/') + filePath;
}

init();
