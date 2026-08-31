import { appState, LOAD_EARLIER_STEP } from '../../state';
import type { Conversation } from '../../types';
import { initCodeCopyButtons, scheduleHighlighting, copyToClipboard } from '../../markdown';
import { bindInteractiveAskCards, syncPendingAskToInteractionHost } from '../permissions';
import { renderConversationMessageChunks, buildDisplayMessages, renderStreamingBlocksChunks, renderLiveToolChunks, mergeStreamBlocks, getToolAnchorBlockIndexes, ensureMessageWindowForActiveConversation, getActiveMessageWindowSize, incrementActiveMessageWindow, renderChatHeaderHtml } from './render-chat';
import type { RenderedMessageChunk } from './render-messages';
import { bindSessionIdCopyEvents } from './input-composer';
import { updateSendButtonState, isSendButtonLoading } from './session-context';
import { sendMessage } from './send';
import { handleRetryClick, handleUndoClick } from './retry';
import { refreshRunStatusStrip } from './run-status';
import { syncStreamingBlocksInPlace } from './streaming';
import { reconcileChatContent, stageAndReconcileChatContent } from './chat-reconciler';
import { canSendMessage } from './session-context';
import { getActiveSuggestionIndex, getFileSuggestionsContainer } from '../files/index';
import { getActiveConversation, conversationInstanceKey } from '../conversations/normalize';
import { scheduleUiRefresh } from '../../ui';
import { syncActiveProjectDir } from '../status-bar';
import {
  activeChatScrollSessionKey,
  beginMainChatContentCommit,
  detachMainChatScroll,
  endMainChatContentCommit,
  ensureMainChatScroll,
} from './chat-scroll';
import { previewFileByPath } from '../files/index';
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
        // 展开思考块 = 用户明确阅读内容：父消息列表进入 DETACHED，
        // 后续流式布局只能做锚点补偿，不能抢回到底部。
        detachMainChatScroll();
      } else {
        appState.expandedThinkingBlocks.delete(id);
      }
    });
  });

  // 文件引用芯片双击预览（事件委托挂在 #message-list 容器上：
  // 增量壳路径（ensureChatMessageShell 新建列表）与每次挂载后都有效，
  // 列表 innerHTML 重建不影响委托）
  if (!(container as HTMLElement).dataset.dblclickBound) {
    (container as HTMLElement).dataset.dblclickBound = '1';
    container.addEventListener('dblclick', (e) => {
      const chip = (e.target as HTMLElement).closest('.file-ref-chip') as HTMLElement | null;
      if (chip?.dataset.filePath) {
        void previewFileByPath(chip.dataset.filePath);
      }
    });
  }

  // 主消息 viewport 只由 ChatScrollCoordinator 管理；静态按钮由模板提供。
  ensureMainChatScroll();

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
  // 顶栏指纹一并重置：管理页 stash 恢复、测试隔离时避免误判旧 HTML。
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
    appState.pendingUserMessage ?? '',
    appState.pendingUserMessageConvId ?? '',
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
    appState.pendingUserMessage ?? '',
    appState.pendingUserMessageConvId ?? '',
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

// ── 稳定内容层 + cursor keyed reconcile ────────────────────────────────
// 所有解析先发生在 detached fragment；live content layer 只在最终同步 commit 中变化。
// 未变节点不 detach，中间插入只移动必要节点，sentinel 永远保持最后一个子节点。
const CHUNK_ASYNC_CHUNK_THRESHOLD = 80;
const CHUNK_ASYNC_BYTES_THRESHOLD = 300_000;
const CHUNK_BATCH = 20;
let mountGeneration = 0;

let mountedCallbacks: Array<() => void> = [];
let mountedCallbacksIdle = true;

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

function getStableChatLayer(messageList: HTMLElement): {
  contentLayer: HTMLElement;
  sentinel: HTMLElement;
} | null {
  const contentLayer = messageList.querySelector<HTMLElement>(':scope > [data-chat-content]');
  const sentinel = contentLayer?.querySelector<HTMLElement>(':scope > [data-chat-bottom]') ?? null;
  return contentLayer && sentinel ? { contentLayer, sentinel } : null;
}

function countChangedChunks(contentLayer: HTMLElement, chunks: readonly RenderedMessageChunk[]): number {
  const existing = new Map<string, string>();
  contentLayer.querySelectorAll<HTMLElement>(':scope > .message[data-stream-id], :scope > .message[data-message-id]')
    .forEach((node) => {
      const id = node.dataset.streamId || node.dataset.messageId;
      if (id) existing.set(id, node.dataset.renderKey ?? '');
    });
  return chunks.reduce(
    (count, chunk) => count + (existing.get(chunk.id) === chunk.renderKey ? 0 : 1),
    0,
  );
}

/** 最近写入的 topbar HTML：流式 tick 中顶栏未变则跳过重写（避免重置下拉等交互状态） */
let lastTopbarHtml = '';

/** 把已生成的 topbar / 消息列表写入 DOM（键控 diff + 分块保底），并重绑事件、恢复滚动状态 */
function applyChatDom(
  topbarHtml: string,
  loadEarlier: string,
  chunks: RenderedMessageChunk[],
  empty: string | null,
  afterReconcile?: () => void,
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

  const stableLayer = getStableChatLayer(messageList);
  if (!stableLayer) {
    console.error('[chat-mount] 缺少稳定 content layer 或 bottom sentinel');
    fireMountedCallbacks();
    return;
  }

  const gen = ++mountGeneration;
  const commitSessionKey = activeChatScrollSessionKey();
  mountedCallbacks = [];
  mountedCallbacksIdle = false;

  const request = {
    contentLayer: stableLayer.contentLayer,
    sentinel: stableLayer.sentinel,
    chunks,
    loadEarlier,
    empty,
  };
  const changedCount = countChangedChunks(stableLayer.contentLayer, chunks);
  const totalBytes = loadEarlier.length + (empty?.length ?? 0) +
    chunks.reduce((sum, chunk) => sum + chunk.html.length, 0);

  let scrollCommit: ReturnType<typeof beginMainChatContentCommit> = null;
  const finishCommit = () => {
    if (gen !== mountGeneration) {
      endMainChatContentCommit(scrollCommit);
      scrollCommit = null;
      return;
    }
    if (!messageList.isConnected) {
      // 管理页可能在 detached staging 期间摘下主视图。强制返回后重提最终计划，
      // 否则已提交的 render key 会让刷新早退，留下未填充的流式占位块。
      lastChatRenderKey = '';
      mountedCallbacks = [];
      mountedCallbacksIdle = true;
      endMainChatContentCommit(scrollCommit);
      scrollCommit = null;
      return;
    }
    try {
      afterReconcile?.();
      setupMessageListPostRender(messageList);
      fireMountedCallbacks();
    } finally {
      endMainChatContentCommit(scrollCommit);
      scrollCommit = null;
    }
  };

  if (
    changedCount > CHUNK_ASYNC_CHUNK_THRESHOLD ||
    totalBytes > CHUNK_ASYNC_BYTES_THRESHOLD
  ) {
    void stageAndReconcileChatContent(request, {
      batchSize: CHUNK_BATCH,
      shouldCommit: () =>
        gen === mountGeneration &&
        messageList.isConnected &&
        stableLayer.contentLayer.isConnected &&
        activeChatScrollSessionKey() === commitSessionKey,
      beforeCommit: () => {
        scrollCommit = beginMainChatContentCommit();
      },
    })
      .then((result) => {
        if (result.status === 'committed') {
          finishCommit();
          return;
        }
        if (gen !== mountGeneration) return;
        lastChatRenderKey = '';
        mountedCallbacks = [];
        mountedCallbacksIdle = true;
      })
      .catch((error) => {
        endMainChatContentCommit(scrollCommit);
        scrollCommit = null;
        if (gen !== mountGeneration) return;
        console.error('[chat-mount] 离屏 staging 失败:', error);
        lastChatRenderKey = '';
        mountedCallbacks = [];
        mountedCallbacksIdle = true;
      });
    return;
  }

  scrollCommit = beginMainChatContentCommit();
  try {
    reconcileChatContent(request);
    finishCommit();
  } catch (error) {
    endMainChatContentCommit(scrollCommit);
    scrollCommit = null;
    lastChatRenderKey = '';
    mountedCallbacks = [];
    mountedCallbacksIdle = true;
    throw error;
  }
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
  const noMergeAfterRaw = new Set(
    toolChunks.flatMap((chunk) =>
      chunk.anchorBlockIndex != null && chunk.anchorBlockIndex >= 0
        ? [chunk.anchorBlockIndex]
        : [],
    ),
  );
  const merged = state ? mergeStreamBlocks(state.blocks, noMergeAfterRaw) : [];
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

function combineWithCurrentStreaming(
  historyChunks: RenderedMessageChunk[],
): { chunks: RenderedMessageChunk[]; sid: string; hasStreaming: boolean } {
  const sid = appState.activeConversationId || 'pending';
  const streamState = appState.streamingBySession.get(sid);
  const tools = appState.activeToolsBySession.get(sid);
  const toolStates = tools ? [...tools.values()] : [];
  const noMergeAfterRaw = getToolAnchorBlockIndexes(toolStates);
  const streamChunks = streamState
    ? renderStreamingBlocksChunks(streamState.blocks, noMergeAfterRaw)
    : [];
  const toolChunks = toolStates.length > 0 ? renderLiveToolChunks(toolStates) : [];
  return {
    chunks: interleaveStreamAndToolChunks(historyChunks, streamChunks, toolChunks),
    sid,
    hasStreaming: Boolean(streamState || toolStates.length > 0),
  };
}

/**
 * 重建聊天区内容。返回是否真正重建了 DOM（false = 指纹未变被跳过），
 * 供调度器执行器决定是否需要重跑流式块恢复。
 */
export function refreshChatContent(): boolean {
  if (!appState.activeConversationId && !appState.pendingUserMessage && !appState.transientSessionError) return false;

  const conversation = getActiveConversation();

  // 切会话后先重置消息窗口，再算指纹，避免「上一会话的扩展窗口」导致多一次冗余重建
  ensureMessageWindowForActiveConversation();

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
    const combined = combineWithCurrentStreaming(cached.chunks);
    applyChatDom(
      cached.topbarHtml,
      cached.loadEarlier,
      combined.chunks,
      cached.empty,
      combined.hasStreaming ? () => syncStreamingBlocksInPlace(combined.sid) : undefined,
    );
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

  const combined = combineWithCurrentStreaming(chunks);

  // 历史、流式段与实时工具卡先组合成唯一最终序列；流式内容填充也在同一滚动事务内完成。
  applyChatDom(
    topbarHtml,
    loadEarlier,
    combined.chunks,
    empty,
    combined.hasStreaming ? () => syncStreamingBlocksInPlace(combined.sid) : undefined,
  );

  // 底栏工作目录：切会话 / 新会话 / 发送（pending）都会走到这里，幂等同步
  syncActiveProjectDir();

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
    // 互动问答进行中：Enter 提交当前会话对应的问卡（后台会话的卡不拦截主输入框）
    const askHandlers = appState.activeQuestionEnterHandlers;
    const askHandler =
      askHandlers.get(appState.activeConversationId || 'pending') ?? askHandlers.get('pending');
    if (askHandler) {
      if (askHandler()) return;
      return;
    }
    // 运行中也允许 Enter：有内容则追问，无内容不触发停止
    if (isSendButtonLoading() && !canSendMessage()) {
      return;
    }
    void sendMessage();
  }
}
