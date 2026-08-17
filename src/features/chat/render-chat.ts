import { appState, MAX_VISIBLE_MESSAGES } from '../../state';
import type { Message, Conversation, StreamBlock, ActiveToolState } from '../../types';
import { escapeHtml, formatDuration } from '../../utils';
import { formatTokenCount } from './context-indicator';
import {
  renderMessageListHtml,
  renderMessageHtmlChunks,
  renderThinkingDetails,
  renderToolMessageHtml,
  TOOL_CONFIG_MAP,
  getDefaultToolConfig,
  type RenderedMessageChunk,
  extractToolName,
  extractToolUseId,
  extractToolResult,
} from './render-messages';
import { getEffectiveProjectDir } from './session-context';
import { renderCopyIconHtml, renderInputComposerHtml } from './input-composer';
import { dedupeAdjacentDuplicateMessages, getActiveConversation, conversationInstanceKey } from '../conversations/normalize';
import { normalizeMessageForCompare } from '../files/index';

/** tail-N 消息窗口：只保留尾部 windowSize 条；窗口起点是 tool_result 时回退纳入其 tool_use，避免结果无来源 */
export function splitMessageWindow(
  messages: Message[],
  windowSize: number,
): { visible: Message[]; totalHidden: number } {
  const size = Math.max(1, windowSize);
  if (messages.length <= size) {
    return { visible: messages, totalHidden: 0 };
  }
  let start = messages.length - size;
  while (start > 0 && messages[start].role === 'tool_result') {
    start -= 1;
  }
  return {
    visible: messages.slice(start),
    totalHidden: start,
  };
}

function renderLoadEarlierButtonHtml(hidden: number): string {
  return `
    <button type="button" class="load-earlier-btn" data-load-earlier title="加载更早的消息">
      <svg class="load-earlier-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="6 15 12 9 18 15"/></svg>
      <span class="load-earlier-label">加载更早的 ${hidden} 条消息</span>
    </button>
  `;
}

/** 当前会话的消息窗口大小（「加载更早」按会话独立累计，切换会话不丢失） */
export function getActiveMessageWindowSize(): number {
  const winKey = conversationInstanceKey(
    appState.activeConversationId || 'pending',
    appState.activeConversationSourcePath,
  );
  return appState.messageWindowSizeByConversation.get(winKey) ?? MAX_VISIBLE_MESSAGES;
}

/** 确保当前会话有窗口记录（幂等），返回其窗口大小 */
export function ensureMessageWindowForActiveConversation(): number {
  const winKey = conversationInstanceKey(
    appState.activeConversationId || 'pending',
    appState.activeConversationSourcePath,
  );
  const existing = appState.messageWindowSizeByConversation.get(winKey);
  if (existing) return existing;
  appState.messageWindowSizeByConversation.set(winKey, MAX_VISIBLE_MESSAGES);
  return MAX_VISIBLE_MESSAGES;
}

/** 点击「加载更早」：扩大当前会话的消息窗口并返回新值 */
export function incrementActiveMessageWindow(step: number): number {
  const winKey = conversationInstanceKey(
    appState.activeConversationId || 'pending',
    appState.activeConversationSourcePath,
  );
  const size = getActiveMessageWindowSize() + step;
  appState.messageWindowSizeByConversation.set(winKey, size);
  return size;
}
export function renderChatHeaderHtml(conversation: Conversation | undefined): string {
  const hasMessages = (conversation?.messages.length ?? 0) > 0;
  const title = hasMessages ? (conversation?.title || '新会话') : '新会话';
  const sessionId = conversation?.id || appState.activeConversationId || '—';
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

export function buildDisplayMessages(conversation: Conversation | undefined): Message[] {
  // 子代理（Task）不在主输出页面展示：主页面只显示用户/助手对话与普通工具卡，
  // 子代理执行态由侧边栏「子代理」标签页承载；已提交的 Task 卡同样过滤，
  // 避免历史里混排「子代理」卡片（会话数据完整保留，仅不渲染）。
  // 注意：历史 tool_use 是原始 role（tool_use/tool_result），要按 content 里的
  // tool_name 识别 Task，并连带其 tool_result 一起移除，否则孤立结果会错配到 Agent 卡。
  const taskToolUseIds = new Set<string>();
  const messages = [...(conversation?.messages ?? [])].filter((m) => {
    // 已配对的内嵌工具消息（pending-* 乐观态）
    if (m.role === 'tool' && m.toolData?.toolName === 'Task') return false;
    // 原始 tool_use：Task 记录其 id 供结果配对移除，Agent 保留（主视图展示子代理完成卡）
    if (m.role === 'tool_use') {
      if (extractToolName(m.content) === 'Task') {
        const id = extractToolUseId(m.content);
        if (id) taskToolUseIds.add(id);
        return false;
      }
      return true;
    }
    // 原始 tool_result：Task 的结果一并移除，避免无主结果污染配对
    if (m.role === 'tool_result') {
      const resultToolUseId = extractToolResult(m.content).toolUseId;
      return !(resultToolUseId && taskToolUseIds.has(resultToolUseId));
    }
    return true;
  });
  // 只有当 appState.pendingUserMessage 属于当前会话时才显示（防止串会话）
  const pendingBelongsToThisConv = appState.pendingUserMessage &&
    (appState.pendingUserMessageConvId === appState.activeConversationId || (!appState.pendingUserMessageConvId && !appState.activeConversationId));
  if (pendingBelongsToThisConv && appState.pendingUserMessage && !messages.some((m) => m.role === 'user' && normalizeMessageForCompare(m.content) === normalizeMessageForCompare(appState.pendingUserMessage))) {
    messages.push({
      // 稳定 id：pending 期间多次重建 diff 复用同一节点（每次生成新 id 会导致
      // 气泡闪烁且快路径永远失配）。内容变化由 messageRenderKey 驱动重建。
      id: 'pending-user',
      role: 'user',
      content: appState.pendingUserMessage,
      timestamp: Math.floor(Date.now() / 1000),
    });
  }
  if (appState.transientSessionError) {
    messages.push({
      id: `transient-error-${Date.now()}`,
      role: 'error',
      content: appState.transientSessionError,
      timestamp: Math.floor(Date.now() / 1000),
    });
  }

  // 进行中的 AskUserQuestion 不再注入消息流：可点选卡片由 syncPendingAskToInteractionHost
  // 钉到输入框上方（#interaction-host），避免长输出会话中「选择卡」与正文混排、滚动被顶走。
  // 已选结果由会话历史回写展示。

  // 进行中的 Task（Subagent）同样不注入消息流：运行中子代理由侧边栏「子代理」标签页
  // 承载，主输出页面只保留用户/助手正文。

  return dedupeAdjacentDuplicateMessages(messages);
}

export function renderConversationMessagesInnerHtml(messages: Message[]): string {
  // 确保当前会话有窗口记录（「加载更早」按会话独立累计）
  ensureMessageWindowForActiveConversation();

  // tail-N 窗口：只渲染尾部最多 MAX_VISIBLE_MESSAGES 条，顶部提供「加载更早」按钮
  const { visible, totalHidden } = splitMessageWindow(messages, getActiveMessageWindowSize());
  const loadEarlierHtml = totalHidden > 0 ? renderLoadEarlierButtonHtml(totalHidden) : '';
  const messageHtml = renderMessageListHtml(visible);
  if (loadEarlierHtml || messageHtml) return loadEarlierHtml + messageHtml;

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

/**
 * 同 renderConversationMessagesInnerHtml，但返回「消息级 HTML 块数组 + 头部块」，
 * 供 applyChatDom 键控 diff 挂载——复用未变消息节点，避免长会话一次性
 * innerHTML 写入阻塞 WebView2 主线程。语义与拼接版完全一致：
 * `loadEarlier + chunks.map(c => c.html).join('')` 即拼接版结果。
 */
export function renderConversationMessageChunks(messages: Message[]): {
  loadEarlier: string;
  chunks: RenderedMessageChunk[];
  empty: string | null;
} {
  ensureMessageWindowForActiveConversation();

  const { visible, totalHidden } = splitMessageWindow(messages, getActiveMessageWindowSize());
  const loadEarlier = totalHidden > 0 ? renderLoadEarlierButtonHtml(totalHidden) : '';
  const chunks = renderMessageHtmlChunks(visible);
  if (loadEarlier || chunks.length > 0) {
    return { loadEarlier, chunks, empty: null };
  }
  return {
    loadEarlier: '',
    chunks: [],
    empty: `
      <div class="conversation-empty-state">
        <span class="conversation-empty-state-icon" aria-hidden="true">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">
            <path d="M21 15a2 2 0 0 1-2 2H8l-5 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>
          </svg>
        </span>
        <strong>会话内容已撤回</strong>
        <span>在下方输入消息，重新开始这段会话</span>
      </div>
    `,
  };
}

export function renderChatContent(): string {
  const conversation = getActiveConversation();

  const messages = buildDisplayMessages(conversation);

  return `
    <div class="message-list" id="message-list">
      ${renderConversationMessagesInnerHtml(messages)}
    </div>
  `;
}

// ── 统一渲染管线：流式块 / 实时工具卡 → chunk（与历史消息同构，供同一 diff 挂载） ──

/** 合并后的流式块：rawStart/rawEnd 记录覆盖的原始块索引区间，
 *  供工具卡（blockIndexAtStart 为原始序号）换算到合并后的插入位置。 */
export interface MergedStreamBlock extends StreamBlock {
  rawStart: number;
  rawEnd: number;
}

/** 合并相邻同类型流式块（thinking-thinking / text-text），语义与旧 refreshStreamingUI 一致 */
export function mergeStreamBlocks(blocks: StreamBlock[]): MergedStreamBlock[] {
  const merged: MergedStreamBlock[] = [];
  let rawCursor = 0;
  for (const block of blocks) {
    const last = merged[merged.length - 1];
    // 相邻同类型块合并；已完成块不与未完成块合并（拆开）——
    // 否则已渲染 markdown 的 text / 已结束的 thinking 会被新块的未完成态污染回退
    const sameType = last && last.type === block.type && (block.type === 'thinking' || block.type === 'text');
    const merges = Boolean(sameType && !(last!.finalized && !block.finalized));
    if (merges) {
      if (block.type === 'thinking') {
        last!.content = last!.content + '\n' + block.content;
        if (block.durationMs != null) last!.durationMs = block.durationMs;
      } else {
        last!.content = last!.content + '\n\n' + block.content;
      }
      last!.finalized = Boolean(last!.finalized && block.finalized);
      last!.rawEnd = rawCursor;
    } else {
      merged.push({
        type: block.type,
        content: block.content,
        finalized: block.finalized,
        durationMs: block.durationMs,
        rawStart: rawCursor,
        rawEnd: rawCursor,
      });
    }
    rawCursor += 1;
  }
  return merged;
}

/**
 * 把流式块（thinking / text）渲染为消息 chunk。
 * id 使用稳定键 `streaming-block-{i}`：diff 挂载时按 id 复用节点，
 * 内容变化（renderKey 变）只重建该块，避免整列表重建导致的闪烁。
 * 根节点带 data-stream-id：与历史消息的 data-message-id 一并被 applyChatDom 索引。
 */
export function renderStreamingBlocksChunks(blocks: StreamBlock[]): RenderedMessageChunk[] {
  const merged = mergeStreamBlocks(blocks);
  return merged.map((block, i) => {
    const id = `streaming-block-${i}`;
    // 思考块展开状态按块独立记录（expandedThinkingBlocks 键 = streaming-block-N），
    // 修复旧实现「多个思考块共享 sessionId 展开态」的问题
    const thinkingExpanded = appState.expandedThinkingBlocks.has(id);
    if (block.type === 'thinking') {
      // per-block finalized：一轮多个思考块互不影响（thinkingDone 全局字段已弃用）
      const finalized = Boolean(block.finalized);
      const label = finalized ? '思考过程' : '思考中...';
      const isStreaming = !finalized;
      const html = `<div class="message assistant thinking-msg${isStreaming ? ' streaming' : ''}" data-stream-id="${escapeHtml(id)}">
        <div class="message-content">${renderThinkingDetails(
          block.content,
          label,
          thinkingExpanded,
          id,
          isStreaming,
          block.durationMs,
        )}</div>
      </div>`;
      return {
        id,
        // renderKey 恒定：内容/结束态/展开态全部由 syncStreamingBlocksInPlace 就地更新，
        // diff 只响应结构变化（新增块）——finalize 不重建节点，快路径全程生效。
        renderKey: 'thinking',
        html,
      };
    }
    // text 块：diff 时按恒定 renderKey 复用节点——高频 delta 与 finalize（markdown 渲染）
    // 均由 syncStreamingBlocksInPlace 就地完成，避免每帧/结束态重建 DOM。
    // 内容经根节点 data-stream-id 定位，挂载完成后由同步函数填充。
    const html = `<div class="message assistant${block.finalized ? '' : ' streaming'}" data-stream-id="${escapeHtml(id)}">
      <div class="message-content">
        <div class="markdown-body streaming-plain-text"></div>
      </div>
    </div>`;
    return {
      id,
      renderKey: 'text',
      html,
    };
  });
}

/**
 * 渲染运行中/刚完成的实时工具卡 chunk（id 稳定，按状态展示运行/完成/错误）。
 * 子代理（Task/Agent）附带实时进度行；anchorBlockIndex 供 refresh 穿插到
 * 工具开始时的流式块之后（思考-工具-思考按真实顺序，参考 DSH/Codex）。
 */
export function renderLiveToolChunks(tools: ActiveToolState[]): RenderedMessageChunk[] {
  // 按「开始块序号 + 开始时间」稳定排序，保证穿插与展示顺序确定
  const sorted = [...tools].sort((a, b) => {
    const ai = a.blockIndexAtStart ?? Number.MAX_SAFE_INTEGER;
    const bi = b.blockIndexAtStart ?? Number.MAX_SAFE_INTEGER;
    if (ai !== bi) return ai - bi;
    return a.startedAt - b.startedAt;
  });
  return sorted.map((tool) => {
    const id = `live-tool-${tool.toolUseId}`;
    const config = TOOL_CONFIG_MAP[tool.toolName] || getDefaultToolConfig();
    const progressLine =
      tool.toolName === 'Task' || tool.toolName === 'Agent'
        ? renderLiveSubagentProgressLine(tool)
        : '';
    const html = `<div class="message tool live-tool-card${tool.status === 'running' ? ' streaming' : ''}" data-stream-id="${escapeHtml(id)}">
      <div class="message-content">${renderToolMessageHtml({
        id,
        role: 'tool',
        content: '',
        timestamp: Math.floor(tool.startedAt / 1000),
        toolData: {
          toolName: tool.toolName,
          toolInput: tool.input || {},
          toolResult: tool.status === 'done' || tool.status === 'failed' ? tool.toolResult : undefined,
          isError: tool.status === 'failed',
          toolUseId: tool.toolUseId,
          displayMode: config.displayMode,
          colorScheme: {
            border: config.borderColor,
            icon: config.iconColor,
            primary: config.borderColor,
          },
        },
      })}${progressLine}</div>
    </div>`;
    return {
      id,
      anchorBlockIndex: tool.blockIndexAtStart,
      // renderKey 只含结构性字段（状态/结果/输入）：进度字段（tokens/工具次数/耗时）
      // 由 syncStreamingBlocksInPlace 就地更新进度行——进度 tick 不触发节点重建，
      // 快路径（纯追加）在工具活跃期保持生效，滚动不被摘除/重插干扰。
      renderKey: `tool|${tool.status}|${(tool.toolResult || '').length}|${Object.keys(tool.input).length}`,
      html,
    };
  });
}

/** 运行中子代理的实时进度行（tokens · 工具次数 · 耗时 + 状态徽标），
 *  完成/失败后展示终态徽标，等待历史落盘接管（样式见 tool-cards.css）。 */
function renderLiveSubagentProgressLine(tool: ActiveToolState): string {
  const parts: string[] = [];
  if (tool.progress?.totalTokens) parts.push(`${formatTokenCount(tool.progress.totalTokens)} tokens`);
  if (tool.progress?.toolUses) parts.push(`${tool.progress.toolUses} 次工具`);
  if (tool.progress?.durationMs) parts.push(formatDuration(tool.progress.durationMs));
  const meta = parts.length ? `<span class="tool-meta">${parts.join(' · ')}</span>` : '';
  const badge =
    tool.status === 'failed'
      ? '<span class="tool-status tool-status-error">子代理失败</span>'
      : tool.status === 'done'
        ? '<span class="tool-status tool-status-done">子代理完成</span>'
        : '<span class="tool-status tool-status-running">子代理执行中</span>';
  return `
    <div class="live-subagent-progress">
      ${meta}
      ${badge}
    </div>
  `;
}

/**
 * 聊天主区的唯一结构来源。全量渲染（performRender）与增量挂载（ensureChatMessageShell）
 * 都从这里取结构，杜绝两个路径在 DOM 顺序 / 类名上漂移。
 *
 * shellOnly 时消息列表留空（内容由 refreshChatContent 填充），
 * 供空状态 → 会话的增量路径挂载；全量渲染则直接内嵌消息。
 */
export function renderChatAreaHtml(opts: { shellOnly?: boolean } = {}): string {
  const conversation = getActiveConversation();
  const hasActive = Boolean(appState.activeConversationId || appState.pendingUserMessage);
  const messagesHtml =
    hasActive && !opts.shellOnly
      ? renderConversationMessagesInnerHtml(buildDisplayMessages(conversation))
      : '';

  return `
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
    ${hasActive ? `
    <div class="main-topbar">
      <div class="main-topbar-main">
        ${renderChatHeaderHtml(conversation)}
      </div>
    </div>
    ` : ''}
    ${hasActive
      ? `<div class="message-list" id="message-list">${messagesHtml}</div>`
      : renderEmptyState()}
    ${renderInputComposerHtml()}
  `;
}

export function renderEmptyState(): string {
  return `
    <div class="empty-chat">
      <div class="empty-icon">💬</div>
      <h2>开始新对话</h2>
      <p>从下拉选择 API 配置，开始与你的 AI CLI 对话</p>
      <div class="empty-chat-model-info" id="empty-chat-model-info"></div>
    </div>
  `;
}



