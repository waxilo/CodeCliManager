import { appState, LOAD_EARLIER_STEP } from '../../state';
import type { Conversation } from '../../types';
import { initCodeCopyButtons, scheduleHighlighting, copyToClipboard } from '../../markdown';
import { bindInteractiveAskCards, syncPendingAskToInteractionHost } from '../permissions';
import { renderConversationMessageChunks, buildDisplayMessages, renderStreamingBlocksChunks, renderLiveToolChunks, mergeStreamBlocks, ensureMessageWindowForActiveConversation, getActiveMessageWindowSize, incrementActiveMessageWindow, renderChatHeaderHtml } from './render-chat';
import type { RenderedMessageChunk } from './render-messages';
import { bindSessionIdCopyEvents } from './input-composer';
import { updateSendButtonState, isSendButtonLoading } from './session-context';
import { sendMessage } from './send';
import { handleRetryClick, handleUndoClick } from './retry';
import { refreshRunStatusStrip } from './run-status';
import { initAnswerScroller, captureScrollState, restoreScrollState, syncStreamingBlocksInPlace } from './streaming';
import { canSendMessage } from './session-context';
import { getActiveSuggestionIndex, getFileSuggestionsContainer } from '../files/index';
import { getActiveConversation, conversationInstanceKey } from '../conversations/normalize';
import { scheduleUiRefresh } from '../../ui';
export function setupMessageListPostRender(container: HTMLElement): void {
  // 对话流内 AskUserQuestion 可点选卡片
  bindInteractiveAskCards(container);

  // 进行中的 AskUserQuestion 钉到输入框上方（可点选卡不再混排进消息流）
  syncPendingAskToInteractionHost();

  // 初始化代码块复制按钮
  initCodeCopyButtons(container);

  // 分片空闲补语法高亮（冷首渲不阻塞，首帧后填充）
  scheduleHighlighting(container);

  // 绑定思考块折叠事件
  container.querySelectorAll('.thinking-block[data-thinking-id]').forEach((details) => {
    // 避免重复绑定
    if ((details as HTMLElement).dataset.thinkingBound === '1') return;
    (details as HTMLElement).dataset.thinkingBound = '1';
    details.addEventListener('toggle', () => {
      const id = (details as HTMLElement).dataset.thinkingId;
      if (!id) return;
      if ((details as HTMLDetailsElement).open) {
        appState.expandedThinkingBlocks.add(id);
        // 展开思考块 = 用户在看思考内容：暂停父消息列表自动跟随，
        // 避免下一 tick 置底把正在看的思考块拉走
        if (appState.answerScroller) {
          appState.answerScroller.autoScroll = false;
        }
      } else {
        appState.expandedThinkingBlocks.delete(id);
      }
    });
  });

  // 初始化 Answer 区域滚动控制器
  initAnswerScroller();

  // 「加载更早」按钮：扩大当前会话的消息窗口（按会话独立累计）
  container.querySelectorAll<HTMLElement>('.load-earlier-btn').forEach((btn) => {
    if (btn.dataset.bound === '1') return;
    btn.dataset.bound = '1';
    btn.addEventListener('click', () => {
      incrementActiveMessageWindow(LOAD_EARLIER_STEP);
      scheduleUiRefresh({ chat: true });
    });
  });

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
      const ok = await copyToClipboard(textToCopy);
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

/** 最近一次聊天重建时的内容指纹；连点同一会话 / 重复事件时用于跳过昂贵的 innerHTML 重建 */
let lastChatRenderKey = '';
/**
 * 最近一次重建时「已提交内容」的指纹（不含流式瞬态的工具签名）。
 * 运行中会话每次工具转态都会变 full key，但已提交消息没变——
 * 管理页退出用它判断「是否真的需要整列表重建」，避免流式中每次进出都强制重建。
 */
let lastCommittedChatRenderKey = '';

/**
 * 强制下次 refreshChatContent 重建聊天区（忽略指纹跳过）。
 * 管理页增量进出时主视图 DOM 被摘下保存，期间会话可能推进；
 * 挂回后必须重置指纹，避免「指纹未变」跳过导致展示 stash 时的旧内容。
 */
export function resetChatRenderKey(): void {
  lastChatRenderKey = '';
  lastCommittedChatRenderKey = '';
  // 会话实例/顶栏指纹一并重置：管理页 stash 恢复、测试隔离时避免误判「未切会话」
  lastDiffSessionKey = '';
  lastTopbarHtml = '';
}

/** 最近一次 refreshChatContent 计算并写入 DOM 的内容指纹（'' = 尚未渲染 / 已被 reset） */
export function getLastChatRenderKey(): string {
  return lastChatRenderKey;
}

/** 当前 appState 对应的聊天内容指纹（与 refreshChatContent 内部使用的 key 一致） */
export function getCurrentChatRenderKey(): string {
  return chatRenderKey(getActiveConversation());
}

/** 最近一次 refreshChatContent 写入的「已提交内容」指纹（不含工具签名） */
export function getLastCommittedChatRenderKey(): string {
  return lastCommittedChatRenderKey;
}

/** 当前 appState 对应的「已提交内容」指纹（不含工具签名） */
export function getCurrentCommittedChatRenderKey(): string {
  return committedChatRenderKey(getActiveConversation());
}

/** 进行中 AskUserQuestion 的 requestId 签名（含 'pending' 槽回退，对齐 syncPendingAskToInteractionHost）。
 * 问答出现/消失会改变该签名 → 触发一次聊天重建，setupMessageListPostRender 里同步输入框上方的问卡。 */
function pendingAskSignature(sid: string): string {
  const direct = appState.pendingAskQuestions.get(sid)?.requestId ?? '';
  if (direct) return direct;
  if (appState.activeConversationId) {
    return appState.pendingAskQuestions.get('pending')?.requestId ?? '';
  }
  return '';
}

/** 当前会话流式状态的轻量签名：块数 + 各块内容长度/时长/完成标记 + 工具卡状态/进度。
 *  并入 chatRenderKey——流式 delta / 工具转态 / 子代理进度时内容变化，统一 diff 需感知。 */
function streamingSignature(): string {
  const sid = appState.activeConversationId || 'pending';
  const state = appState.streamingBySession.get(sid);
  const blocksSig = state
    ? state.blocks
        .map((b) =>
          `${b.type[0]}:${b.content.length}:${b.durationMs ?? 0}:${b.finalized ? 'f' : 'p'}`,
        )
        .join(',')
    : '';
  const tools = appState.activeToolsBySession.get(sid);
  const toolsSig = tools
    ? [...tools.entries()]
        .map(([id, t]) =>
          `${id}:${t.status}:${(t.toolResult || '').length}:${t.isError ? 'E' : ''}:${t.progress?.totalTokens ?? 0}:${t.progress?.toolUses ?? 0}:${t.progress?.durationMs ?? 0}`,
        )
        .join(',')
    : '';
  return `${blocksSig}|${toolsSig}`;
}

function chatRenderKey(conversation: Conversation | undefined): string {
  const msgs = conversation?.messages ?? [];
  const last = msgs[msgs.length - 1];
  const sid = appState.activeConversationId || 'pending';
  return [
    appState.activeConversationId || '',
    appState.activeConversationSourcePath || '',
    conversation?.updated_at ?? '',
    msgs.length,
    last?.id ?? '',
    last?.timestamp ?? '',
    getActiveMessageWindowSize(),
    appState.runningSessions.has(appState.activeConversationId) ? 'r' : '',
    appState.pendingUserMessage ? 'p' : '',
    appState.transientSessionError ? 'e' : '',
    pendingAskSignature(sid),
    streamingSignature(),
  ].join('|');
}

/**
 * 「已提交内容」指纹：只跟踪真实消息列表变化，供管理页退出时判断是否整列表重建。
 * - 剔除运行标志：turn-continued / queued-prompt-dispatched 只改 runningSessions 不改消息，
 *   否则运行中会话每次进出管理页都误判 contentChanged 强制重建聊天区（Win 切回卡顿主因）。
 * - 剔除 updated_at：后台 messages-updated 可能只前移时间戳而消息未变，会误判重建。
 * - 剔除 pendingAskSignature：问卡钉在 #interaction-host（不在消息列表），由
 *   syncPendingAskToInteractionHost 独立同步，不需要重建消息列表。
 * 子代理（Task）卡不在主输出页面展示，运行中工具转态也不需要重建主消息列表——
 * 主列表只随已提交内容 / 流式块变化，进行中子代理由右侧子代理清单栏独立同步。
 */
function committedChatRenderKey(conversation: Conversation | undefined): string {
  const msgs = conversation?.messages ?? [];
  const last = msgs[msgs.length - 1];
  return [
    appState.activeConversationId || '',
    appState.activeConversationSourcePath || '',
    msgs.length,
    last?.id ?? '',
    last?.timestamp ?? '',
    getActiveMessageWindowSize(),
    appState.pendingUserMessage ? 'p' : '',
    appState.transientSessionError ? 'e' : '',
  ].join('|');
}

interface RenderedConversationEntry {
  renderKey: string;
  topbarHtml: string;
  loadEarlier: string;
  chunks: RenderedMessageChunk[];
  empty: string | null;
}

/**
 * 按会话实例的渲染结果缓存：连点 A→B→A 时，回切 A 直接复用上次渲染的 HTML 字符串，
 * 跳过整条渲染管线（工具配对 / markdown 缓存查找 / 逐消息拼接 / 事件重绑）。
 * 键包含 expandedThinkingBlocks 签名——展开/折叠思考块后切走再切回不会退回旧态。
 */
const renderCache = new Map<string, RenderedConversationEntry>();
const RENDER_CACHE_MAX = 6;

/** 历史消息部分（不含流式块/工具卡）的渲染缓存：
 *  流式 tick（100ms）中已提交内容未变 → 直接复用上次的 chunk HTML，
 *  跳过整条历史渲染管线（工具配对 / markdown 缓存查找 / 逐消息拼接），
 *  长会话流式输出的 CPU 开销从「每次全量重建」降到「只算流式块 + diff」。
 *  键 = committedKey + 思考块展开签名 + 运行标记（showUndo 依赖）。 */
const historyRenderCache = new Map<string, { loadEarlier: string; chunks: RenderedMessageChunk[]; empty: string | null }>();
const HISTORY_RENDER_CACHE_MAX = 8;

export function renderCacheKey(conversation: Conversation | undefined): string {
  const thinkingSignature = [...appState.expandedThinkingBlocks].sort().join(',');
  return `${chatRenderKey(conversation)}|t:${thinkingSignature}`;
}

// ── 键控 DOM diff 挂载：消息节点级复用，根治整列表 innerHTML 重建 ──
// applyChatDom 把「新渲染的 chunks」与「#message-list 现有节点」做键控 diff：
//  - id + renderKey 未变 → 复用既有节点（保留事件监听、思考块展开态、工具卡折叠态、滚动位置），
//    仅做 DOM 移动，零解析零重建；
//  - 内容/状态变化 → 只重建该条消息（单条 template 解析）；
//  - 已移除的消息 → 删除节点。
// 这样管理页切回 / 消息落盘时，绝大多数节点原样保留，不再 MB 级 innerHTML 写入。
// 仅当「首次渲染 / 切换会话（无现成节点）」或「新建节点过多」时回退到分块挂载，
// 批间 requestAnimationFrame 让出主线程。
const CHUNK_ASYNC_CHUNK_THRESHOLD = 80;
/** 消息 HTML 总长超过该字节数即分块（≈ MB 级解析临界） */
const CHUNK_ASYNC_BYTES_THRESHOLD = 300_000;
const CHUNK_BATCH = 20;
/** 挂载代数：异步分块期间若发生新的重建（切会话/重渲染），旧挂载的剩余批立即放弃 */
let mountGeneration = 0;

/** 挂载完成后的回调队列（bootstrap / render / session-events 注册流式块恢复等） */
let mountedCallbacks: Array<() => void> = [];
/** true = 无进行中的挂载；此时 afterChatMounted 立即执行 */
let mountedCallbacksIdle = true;

/**
 * 在消息列表挂载完成后执行回调。
 * 同步挂载立即执行；异步分块挂载在最后一批插入完成后执行。
 * 用于替代调用方在 refreshChatContent() 返回后直接 refreshStreamingUI——
 * 长列表分块期间 DOM 未就绪，流式块恢复必须等挂载完成。
 */
export function afterChatMounted(cb: () => void): void {
  if (mountedCallbacksIdle) {
    cb();
    return;
  }
  mountedCallbacks.push(cb);
}

function fireMountedCallbacks(): void {
  const cbs = mountedCallbacks;
  mountedCallbacks = [];
  mountedCallbacksIdle = true;
  for (const cb of cbs) {
    try {
      cb();
    } catch (e) {
      console.error('[chat-mount] 挂载完成回调异常:', e);
    }
  }
}

/** 单条 chunk HTML → 元素（复用 stream 挂载的 template 解析） */
function createElementFromHtml(html: string): HTMLElement | null {
  const tmp = document.createElement('template');
  tmp.innerHTML = html;
  return tmp.content.firstElementChild as HTMLElement | null;
}

interface ChatMountSlot {
  kind: 'reuse' | 'create';
  node: HTMLElement | null; // reuse 时有效
  chunk?: RenderedMessageChunk; // create 时有效
}

/** 同步执行槽位：按序 append，复用节点零解析，新建节点单条解析 */
function syncMountSlots(messageList: HTMLElement, slots: ChatMountSlot[]): void {
  for (const slot of slots) {
    if (slot.kind === 'reuse' && slot.node) {
      messageList.appendChild(slot.node);
    } else if (slot.kind === 'create' && slot.chunk) {
      const el = createElementFromHtml(slot.chunk.html);
      if (el) {
        el.dataset.renderKey = slot.chunk.renderKey;
        messageList.appendChild(el);
      }
    }
  }
}

/**
 * 流式 tick 的典型形态是「已挂载节点前缀完全一致 + 末尾新增」。
 * 此时走纯追加挂载：不摘除/重插任何现有节点，scrollTop 由浏览器自然保持，
 * 无需 capture/restore 硬拉回（remove-all 再重插会 clamp 滚动位置，是跳动残余来源）。
 * 条件：无「加载更早」头部、列表里除消息节点外无残留、现有节点按序与新序列前缀匹配、
 * 且新增数量不多（同步 append 不阻塞主线程）。
 */
export function canAppendOnly(messageList: HTMLElement, chunks: RenderedMessageChunk[], loadEarlier: string): boolean {
  if (loadEarlier !== '') return false;
  // 列表里除消息节点外只允许「回到底部」按钮（answerScroller 挂在 messageList 内），
  // 其余残留（问卡等）会使追加位置不干净
  for (const child of messageList.children) {
    const cls = (child as HTMLElement).classList;
    if (cls?.contains('message') || cls?.contains('scroll-to-bottom-btn')) continue;
    return false;
  }
  const existing = messageList.querySelectorAll<HTMLElement>(
    '.message[data-stream-id], .message[data-message-id]',
  );
  if (existing.length > chunks.length) return false; // 有删除 → 不能纯追加
  if (chunks.length - existing.length > CHUNK_BATCH) return false; // 新增太多 → 走分块
  let i = 0;
  for (const el of existing) {
    const chunk = chunks[i];
    if (!chunk) return false;
    const id = el.dataset.streamId || el.dataset.messageId;
    if (id !== chunk.id || el.dataset.renderKey !== chunk.renderKey) return false;
    i += 1;
  }
  return true;
}

/** 异步分块挂载（仅新建节点）：批间让出主线程，完成后统一后处理 + 滚动恢复 */
function asyncMountCreateSlots(
  messageList: HTMLElement,
  slots: ChatMountSlot[],
  scrollSnap: { autoScroll: boolean; scrollTop: number } | null,
  gen: number,
): void {
  let index = 0;
  const mountNextBatch = () => {
    // 已被新重建取代，或管理页摘走了 message-list（脱离文档）：放弃剩余批
    if (gen !== mountGeneration) return;
    if (!messageList.isConnected) {
      fireMountedCallbacks();
      return;
    }
    const frag = document.createDocumentFragment();
    const end = Math.min(index + CHUNK_BATCH, slots.length);
    for (; index < end; index++) {
      const slot = slots[index];
      if (slot.kind === 'reuse' && slot.node) {
        frag.append(slot.node);
      } else if (slot.kind === 'create' && slot.chunk) {
        const el = createElementFromHtml(slot.chunk.html);
        if (el) {
          el.dataset.renderKey = slot.chunk.renderKey;
          frag.append(el);
        }
      }
    }
    messageList.appendChild(frag);
    if (index < slots.length) {
      requestAnimationFrame(mountNextBatch);
      return;
    }
    // 全部插入完成：后处理 + 滚动恢复 + 完成回调（流式块恢复等）
    setupMessageListPostRender(messageList);
    restoreScrollState(scrollSnap);
    fireMountedCallbacks();
  };
  requestAnimationFrame(mountNextBatch);
}

/** 最近写入的 topbar HTML：流式 tick 中顶栏未变则跳过重写（避免重置下拉等交互状态） */
let lastTopbarHtml = '';

/** 把已生成的 topbar / 消息列表写入 DOM（键控 diff + 分块保底），并重绑事件、恢复滚动状态 */
function applyChatDom(
  topbarHtml: string,
  loadEarlier: string,
  chunks: RenderedMessageChunk[],
  empty: string | null,
): void {
  const messageList = document.querySelector<HTMLDivElement>('#message-list');
  const topbarMain = document.querySelector<HTMLDivElement>('.main-topbar-main');

  if (topbarMain && topbarHtml !== lastTopbarHtml) {
    topbarMain.innerHTML = topbarHtml;
    lastTopbarHtml = topbarHtml;
    bindSessionIdCopyEvents();
  }

  updateSendButtonState();
  // 输入框下方状态条不随消息列表重建（composer 常驻），但全量渲染后需同步一次
  refreshRunStatusStrip();

  if (!messageList) {
    // 管理页停留期间 message-list 被摘下：无 DOM 可写，直接完成回调
    fireMountedCallbacks();
    return;
  }

  // 重建前记录滚动状态：输出结束时若用户在阅读上方消息，重建后不应强制跳回底部
  const scrollSnap = captureScrollState();
  const gen = ++mountGeneration;
  // 注意：异步分块挂载进行中再触发新一轮重建会清空并丢弃旧队列回调——
  // 当前所有注册方（流式块恢复等）每次重建都会重新注册，丢旧队列无实际影响；
  // 未来若有「仅某次挂载后执行一次」的注册方需改为继承旧队列。
  mountedCallbacks = [];
  mountedCallbacksIdle = false;

  // 空状态：无消息时。保留「回到底部」按钮（answerScroller 常驻 messageList，
  // 直接 innerHTML 覆盖会销毁它且 initAnswerScroller 的元素守卫不会再重建）。
  if (chunks.length === 0) {
    const bottomBtn = messageList.querySelector('.scroll-to-bottom-btn');
    messageList.innerHTML = loadEarlier + (empty ?? '');
    if (bottomBtn) messageList.appendChild(bottomBtn);
    setupMessageListPostRender(messageList);
    restoreScrollState(scrollSnap);
    fireMountedCallbacks();
    return;
  }

  // ── 键控 diff：索引现有消息节点（历史消息 data-message-id / 流式块与工具卡 data-stream-id） ──
  const existingById = new Map<string, HTMLElement>();
  messageList.querySelectorAll<HTMLElement>('.message[data-stream-id], .message[data-message-id]').forEach((el) => {
    const id = el.dataset.streamId || el.dataset.messageId;
    if (id && !existingById.has(id)) existingById.set(id, el);
  });

  // 规划槽位：复用（id+renderKey 相同）/ 新建
  const slots: ChatMountSlot[] = [];
  let createCount = 0;
  let totalBytes = loadEarlier.length;
  for (const chunk of chunks) {
    totalBytes += chunk.html.length;
    const existing = existingById.get(chunk.id);
    if (existing && existing.dataset.renderKey === chunk.renderKey) {
      slots.push({ kind: 'reuse', node: existing });
    } else {
      slots.push({ kind: 'create', node: null, chunk });
      createCount += 1;
    }
  }

  // ── 快速路径：纯追加挂载（现有节点前缀匹配时）——滚动位置自然保持 ──
  // 必须在 remove-all 之前判断：慢路径会摘除全部节点（scrollTop 被 clamp）。
  if (canAppendOnly(messageList, chunks, loadEarlier)) {
    const existingCount = messageList.querySelectorAll<HTMLElement>(
      '.message[data-stream-id], .message[data-message-id]',
    ).length;
    for (let i = existingCount; i < chunks.length; i++) {
      const el = createElementFromHtml(chunks[i].html);
      if (el) {
        el.dataset.renderKey = chunks[i].renderKey;
        messageList.appendChild(el);
      }
    }
    // 追加后恢复滚动意图：用户在底部（autoScroll）→ 跟随新内容置底；
    // 用户已上滑 → restorePosition 设为旧值（追加未触碰 scrollTop，等同无操作）。
    // 与慢路径一致，保证「底部跟随」在流式输出时不间断。
    restoreScrollState(scrollSnap);
    setupMessageListPostRender(messageList);
    fireMountedCallbacks();
    return;
  }

  // 旧节点不再需要：先摘除（复用节点在挂载时被重新 append，顺序由 slots 决定）
  existingById.forEach((el) => {
    if (el.parentElement === messageList) el.remove();
  });
  // 移除旧的「加载更早」按钮与空状态（头部/空态由本次渲染重写）
  messageList.querySelector('.load-earlier-btn')?.remove();
  messageList.querySelector('.conversation-empty-state')?.remove();
  // 流式块 / 实时工具卡已纳入统一 diff（data-stream-id 索引）：不在新序列中的自然被摘除，
  // 不再单独清理，避免「清掉 → 重建」的闪烁。
  // 其余非消息节点（问卡残留等）一并清掉，保证列表结构纯净；
  // 「回到底部」按钮（answerScroller 常驻 messageList）保留。
  Array.from(messageList.children).forEach((child) => {
    const cls = (child as HTMLElement).classList;
    if (cls?.contains('message') || cls?.contains('scroll-to-bottom-btn')) return;
    child.remove();
  });

  if (loadEarlier) {
    messageList.insertAdjacentHTML('afterbegin', loadEarlier);
  }

  // 新建节点少 → 同步 diff 挂载（复用节点零解析，仅新建单条解析）
  if (createCount === 0 || (createCount <= CHUNK_ASYNC_CHUNK_THRESHOLD && totalBytes <= CHUNK_ASYNC_BYTES_THRESHOLD)) {
    syncMountSlots(messageList, slots);
    setupMessageListPostRender(messageList);
    restoreScrollState(scrollSnap);
    fireMountedCallbacks();
    return;
  }

  // 新建节点多（首次渲染长会话 / 大规模变化）→ 分块挂载让出主线程
  asyncMountCreateSlots(messageList, slots, scrollSnap, gen);
}

/**
 * 流式块 + 实时工具卡穿插成单一序列：
 * 工具卡插到「工具开始时的流式块」之后（blockIndexAtStart 是原始块序号，
 * 先经 mergeStreamBlocks 的 rawStart/rawEnd 换算到合并后块索引），
 * 无锚点的工具卡（早期进入的会话）按序排到所有流式块之后。
 */
function interleaveStreamAndToolChunks(
  chunks: RenderedMessageChunk[],
  streamChunks: RenderedMessageChunk[],
  toolChunks: RenderedMessageChunk[],
): RenderedMessageChunk[] {
  if (toolChunks.length === 0) return [...chunks, ...streamChunks];

  const sid = appState.activeConversationId || 'pending';
  const state = appState.streamingBySession.get(sid);
  const merged = state ? mergeStreamBlocks(state.blocks) : [];
  const rawToMerged = (raw: number): number => {
    for (let i = 0; i < merged.length; i++) {
      if (raw >= merged[i].rawStart && raw <= merged[i].rawEnd) return i;
    }
    return -1;
  };

  const anchored: Array<{ idx: number; chunk: RenderedMessageChunk }> = [];
  // 工具开始时尚无任何流式块（blockIndexAtStart = -1：工具先于思考，常见于
  // kiro/OpenAI 兼容上游的 tool_use 先于 reasoning 输出）→ 工具是更早的内容，
  // 排到所有流式块之前，保持真实时间顺序（否则后出现的思考块会跑到工具卡上面）。
  const head: RenderedMessageChunk[] = [];
  // 锚点超出合并后块范围（块被合并/清理后的旧工具）：兜底排最后
  const tail: RenderedMessageChunk[] = [];
  for (const tc of toolChunks) {
    const mi = tc.anchorBlockIndex != null && tc.anchorBlockIndex >= 0
      ? rawToMerged(tc.anchorBlockIndex)
      : -1;
    if (mi >= 0) anchored.push({ idx: mi, chunk: tc });
    else if (tc.anchorBlockIndex != null && tc.anchorBlockIndex >= 0) tail.push(tc);
    else head.push(tc);
  }

  // renderLiveToolChunks 已按锚点排序，anchored 天然有序；同锚点多个工具保持顺序
  const out: RenderedMessageChunk[] = [];
  let ai = 0;
  for (let i = 0; i < streamChunks.length; i++) {
    out.push(streamChunks[i]);
    while (ai < anchored.length && anchored[ai].idx === i) {
      out.push(anchored[ai].chunk);
      ai += 1;
    }
  }
  for (; ai < anchored.length; ai++) out.push(anchored[ai].chunk);
  return [...chunks, ...head, ...out, ...tail];
}

/** 最近一次 diff 挂载的会话实例 key：切会话时旧会话的滚动位置/跟随状态不应带到新会话 */
let lastDiffSessionKey = '';

/**
 * 重建聊天区内容。返回是否真正重建了 DOM（false = 指纹未变被跳过），
 * 供调度器执行器决定是否需要重跑流式块恢复。
 */
export function refreshChatContent(): boolean {
  if (!appState.activeConversationId && !appState.pendingUserMessage && !appState.transientSessionError) return false;

  const conversation = getActiveConversation();

  // 切会话后先重置消息窗口，再算指纹，避免「上一会话的扩展窗口」导致多一次冗余重建
  ensureMessageWindowForActiveConversation();

  // 切会话：先置底（capture 到 autoScroll=true → restore 走 scrollToBottom），
  // 避免把旧会话的阅读位置/关闭跟随状态恢复到新会话列表
  const sessionKey = conversationInstanceKey(
    appState.activeConversationId || 'pending',
    appState.activeConversationSourcePath,
  );
  const sessionChanged = sessionKey !== lastDiffSessionKey;
  lastDiffSessionKey = sessionKey;
  if (sessionChanged) {
    appState.answerScroller?.scrollToBottom();
  }

  // 内容指纹未变（连点同一会话 / 重复消息事件）：跳过昂贵的内联 HTML 重建，
  // 流式块也得以保留；只轻量同步发送按钮状态。
  const key = chatRenderKey(conversation);
  if (key === lastChatRenderKey && document.querySelector('#message-list')) {
    updateSendButtonState();
    return false;
  }
  const committedKey = committedChatRenderKey(conversation);
  const committedChanged = committedKey !== lastCommittedChatRenderKey;

  // 管理页停留期间消息列表被摘下：仅工具/流式转态（已提交内容未变）时，
  // 渲染结果无处落盘纯属浪费，直接跳过整条渲染管线；已提交内容变化时仍渲染入缓存，
  // 让退出 contentChanged 路径走缓存命中。
  // 注意：此早退**不更新指纹**——stash 期间流式推进的签名保留为"未渲染"状态，
  // 退出后指纹不等 → diff 重建补上 stash 期间新增的块/工具卡（否则新块永久缺失）。
  if (!document.querySelector('#message-list') && !committedChanged) {
    updateSendButtonState();
    return false;
  }
  lastChatRenderKey = key;
  lastCommittedChatRenderKey = committedKey;

  // 按会话渲染缓存命中：回切 A 时直接复用上次渲染的 HTML 字符串，跳过整条渲染管线
  const cacheKey = conversationInstanceKey(
    appState.activeConversationId || 'pending',
    appState.activeConversationSourcePath,
  );
  const renderKey = renderCacheKey(conversation);
  const cached = renderCache.get(cacheKey);
  if (cached && cached.renderKey === renderKey) {
    renderCache.delete(cacheKey);
    renderCache.set(cacheKey, cached);
    applyChatDom(cached.topbarHtml, cached.loadEarlier, cached.chunks, cached.empty);
    return true;
  }

  // 完整渲染：历史消息 + 流式块 + 实时工具卡统一为一个序列，同一 diff 挂载。
  // 流式块/工具卡带稳定 id 与 renderKey：delta 更新时只重建对应块，
  // 历史消息节点复用——不再「清流式块 → 重建 → 重建流式块」导致闪烁。
  const topbarHtml = renderChatHeaderHtml(conversation);
  // 历史消息渲染缓存命中（流式 tick 已提交内容未变）：复用上次 chunk HTML。
  // 键含 updated_at：后台可能原地编辑既有消息（长度/末条不变），此时强制重渲染保正确。
  const thinkingSig = [...appState.expandedThinkingBlocks].sort().join(',');
  const historyKey =
    committedKey + '|u:' + (conversation?.updated_at ?? '') + '|t:' + thinkingSig + '|r:' +
    (appState.runningSessions.has(appState.activeConversationId) ? '1' : '0');
  let loadEarlier: string;
  let chunks: RenderedMessageChunk[];
  let empty: string | null;
  const historyCached = historyRenderCache.get(historyKey);
  if (historyCached) {
    ({ loadEarlier, chunks, empty } = historyCached);
  } else {
    const messages = buildDisplayMessages(conversation);
    ({ loadEarlier, chunks, empty } = renderConversationMessageChunks(messages));
    historyRenderCache.set(historyKey, { loadEarlier, chunks, empty });
    if (historyRenderCache.size > HISTORY_RENDER_CACHE_MAX) {
      const oldest = historyRenderCache.keys().next().value;
      if (oldest !== undefined) historyRenderCache.delete(oldest);
    }
  }

  const sid = appState.activeConversationId || 'pending';
  const streamState = appState.streamingBySession.get(sid);
  const streamChunks = streamState
    ? renderStreamingBlocksChunks(streamState.blocks)
    : [];
  const tools = appState.activeToolsBySession.get(sid);
  const toolChunks = tools && tools.size > 0 ? renderLiveToolChunks([...tools.values()]) : [];

  // 流式块 + 实时工具卡统一为一个序列：工具卡插到「工具开始时的流式块」之后，
  // 与历史消息同一 diff 挂载（思考-工具-思考按真实顺序穿插，参考 DSH/Codex）。
  const allChunks = interleaveStreamAndToolChunks(chunks, streamChunks, toolChunks);
  applyChatDom(topbarHtml, loadEarlier, allChunks, empty);

  // diff 挂载完成后补一次流式块内容同步：
  // 新建/重建的 text 占位块在此填充内容、thinking scroller 挂载。
  // 同步挂载 → afterChatMounted 立即执行；分块异步挂载 → 最后一批完成后执行。
  // 幂等（text 按 dataset 增量追加），覆盖「diff 之后无后续流式事件」的终态重建。
  if (streamState || (tools && tools.size > 0)) {
    afterChatMounted(() => syncStreamingBlocksInPlace(sid));
  }

  // 缓存本次渲染结果（不含流式块的「已提交消息」快照）：renderKey 含流式签名，
  // 流式更新时 miss → 走完整 diff（历史复用）；会话快照仍供回切 A→B→A 复用。
  renderCache.set(cacheKey, { renderKey, topbarHtml, loadEarlier, chunks, empty });
  if (renderCache.size > RENDER_CACHE_MAX) {
    const oldest = renderCache.keys().next().value;
    if (oldest !== undefined) renderCache.delete(oldest);
  }
  return true;
}

export function handleKeydown(e: KeyboardEvent) {
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
    // 互动问答进行中：Enter 提交选项/自定义回答，不发成普通追问
    if (appState.activeQuestionEnterHandler) {
      if (appState.activeQuestionEnterHandler()) return;
      return;
    }
    // 运行中也允许 Enter：有内容则追问，无内容不触发停止
    if (isSendButtonLoading() && !canSendMessage()) {
      return;
    }
    void sendMessage();
  }
}
