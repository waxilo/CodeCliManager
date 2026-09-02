import { appState } from '../../state';
import { shellApi } from '../../app/shell/api';
import { formatDuration } from '../../utils';
import type {
  Message,
  SessionErrorPayload,
  MessageChunkPayload,
  StreamBlock,
  StreamingState,
  ActiveToolState,
  TodoItem,
} from '../../types';
import {
  renderMarkdown,
  renderMarkdownCached,
  initCodeCopyButtons,
  scheduleHighlighting,
} from '../../markdown';
import { getThinkingScroller } from './thinking-scroller';
import { updateSendButtonState, setSendButtonLoading } from './session-context';
import { updateOrAddConversation, findConversationById, assistantTextCovers } from '../conversations';
import { updateConversationListSpinner, refreshActiveTabContent } from '../sidebar';
import {
  extractToolUseId,
  processToolMessages,
} from './render-messages';
import { clearPendingRequestState, hideSendingState } from './session-context';
import {
  refreshRunStatusStrip,
  markSessionRunStart,
  setRunStatusOverride,
  transferSessionRunTimer,
} from './run-status';
import { scheduleUiRefresh } from '../../ui';
import { syncTodoPanelUI } from './todo-panel';
import { mergeStreamBlocks, getToolAnchorBlockIndexes } from './render-chat';
import { formatSubagentUsage } from './subagent-usage';

const TOOL_CHUNK_KINDS = new Set([
  'tool_use_start',
  'tool_use_end',
  'tool_result',
  'task_started',
  'task_progress',
  'todos_updated',
]);

function getActiveToolsMap(sessionId: string): Map<string, ActiveToolState> {
  let map = appState.activeToolsBySession.get(sessionId);
  if (!map) {
    map = new Map();
    appState.activeToolsBySession.set(sessionId, map);
  }
  return map;
}

function sessionHasActiveTools(sessionId: string): boolean {
  const map = appState.activeToolsBySession.get(sessionId);
  return Boolean(map && map.size > 0);
}

function parseChunkJson(content: string): Record<string, unknown> | null {
  if (!content?.trim()) return null;
  try {
    const parsed = JSON.parse(content) as unknown;
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/** CLI task_notification：completed/failed/stopped；旧版可能是 success/error */
function isTerminalTaskStatus(status: string): boolean {
  return (
    status === 'completed' ||
    status === 'success' ||
    status === 'failed' ||
    status === 'error' ||
    status === 'stopped'
  );
}

function isFailedTaskStatus(status: string): boolean {
  return status === 'failed' || status === 'error' || status === 'stopped';
}

/** 子代理「启动成功」元数据结果（新版 Claude Code 的 Task/Agent 异步启动时，
 *  主链立即收到 "Async agent launched successfully" 这类 tool_result）。
 *  它不是子代理的完成结果：不能作为「完成」信号（实时卡 / reconcile 均需排除）。 */
export function isSubagentLaunchMetadata(text: string): boolean {
  const t = (text || '').trim();
  return (
    t.includes('Async agent launched successfully') ||
    t.includes('launched successfully') ||
    t.includes('internal metadata') ||
    t.includes('agentId:')
  );
}

function findActiveTool(
  tools: Map<string, ActiveToolState>,
  toolUseId: string,
  taskId = '',
): ActiveToolState | undefined {
  if (toolUseId && tools.has(toolUseId)) return tools.get(toolUseId);
  if (taskId) {
    for (const state of tools.values()) {
      if (state.taskId === taskId || state.toolUseId === taskId) return state;
    }
  }
  return undefined;
}

function refreshActiveToolUI(sessionId: string) {
  refreshRunStatusStrip();
  if (appState.activeConversationId === sessionId) {
    // 统一走中央调度器合并；聊天重建后由执行器负责恢复流式块
    scheduleUiRefresh({ chat: true, subagent: true, todo: true });
  }
}

/** 历史落盘后：同步完成态并从 active 清掉，避免与历史卡片重复 */
export function reconcileActiveToolsWithHistory(sessionId: string, messages: Message[]) {
  const tools = appState.activeToolsBySession.get(sessionId);
  if (!tools || tools.size === 0) return;

  const processed = processToolMessages(messages);
  for (const [toolUseId, state] of [...tools.entries()]) {
    const found = processed.find(
      (m) =>
        m.role === 'tool' &&
        (m.toolData?.toolUseId === toolUseId ||
          m.toolData?.toolUseId === state.taskId ||
          extractToolUseId(m.content) === toolUseId ||
          (state.taskId && extractToolUseId(m.content) === state.taskId)),
    );
    if (!found) {
      // Scenario A：历史里完全找不到该 Task。已终态的是一轮结束后的残留，清掉；
      // running 的可能是 tool_use 尚未落盘，保留避免闪断。
      if (state.status === 'done' || state.status === 'failed') {
        tools.delete(toolUseId);
      }
      continue;
    }
    if (found.toolData?.toolResult !== undefined) {
      // 子代理「启动成功」元数据（Async agent launched…）不是完成信号：
      // 保持运行中，等 task-notification completed / 真实结果（历史卡由通知展示完成态）
      if (!found.toolData.isError && isSubagentLaunchMetadata(found.toolData.toolResult)) {
        continue;
      }
      // 先写入完成态，再删除：即使后续 UI 竞态也能读到正确状态
      state.status = found.toolData.isError ? 'failed' : 'done';
      state.isError = found.toolData.isError;
      state.toolResult = found.toolData.toolResult;
      state.input = found.toolData.toolInput || state.input;
      tools.delete(toolUseId);
    } else if (state.status === 'running') {
      // 历史已有 tool_use 但尚无 result：保留 running，避免闪断
      state.input = found.toolData?.toolInput || state.input;
    }
  }
  if (tools.size === 0) {
    appState.activeToolsBySession.delete(sessionId);
  }
  appState.activeToolsBySession.delete('pending');
}

/** 清除某会话已终态（done/failed）的 Task，供 turn-complete 轮次切换时调用。 */
export function purgeTerminalTools(sessionId: string): void {
  const tools = appState.activeToolsBySession.get(sessionId);
  if (!tools || tools.size === 0) return;
  for (const [id, state] of [...tools.entries()]) {
    if (state.status === 'done' || state.status === 'failed') {
      tools.delete(id);
    }
  }
  if (tools.size === 0) {
    appState.activeToolsBySession.delete(sessionId);
  }
}

/** 会话进程结束/出错时清空其全部 active tools。 */
export function clearSessionTools(sessionId: string): void {
  appState.activeToolsBySession.delete(sessionId);
}

function handleToolChunk(sid: string, kind: string, content: string): boolean {
  const data = parseChunkJson(content);
  if (kind === 'tool_use_start') {
    const id = String(data?.id || '');
    const name = String(data?.name || 'Task');
    if (!id) return false;
    const tools = getActiveToolsMap(sid);
    const existing = tools.get(id);
    // 记录工具开始时的流式块序号：实时渲染时把工具卡插到该块之后，
    // 实现「思考-工具-思考」按真实顺序穿插（参考 DSH/Codex）。
    const blockIndexAtStart = getStreamingState(sid).currentBlockIdx;
    tools.set(id, {
      toolUseId: id,
      toolName: name,
      input: existing?.input || {},
      status: 'running',
      startedAt: existing?.startedAt || Date.now(),
      blockIndexAtStart,
    });
    // pending → 真实 session
    const pendingTools = appState.activeToolsBySession.get('pending');
    if (pendingTools && sid !== 'pending') {
      for (const [pid, pstate] of pendingTools) {
        if (!tools.has(pid)) tools.set(pid, pstate);
      }
      appState.activeToolsBySession.delete('pending');
    }
    refreshActiveToolUI(sid);
    return true;
  }

  if (kind === 'tool_use_end') {
    const id = String(data?.id || '');
    const name = String(data?.name || 'Task');
    if (!id) return false;
    const tools = getActiveToolsMap(sid);
    const input =
      data?.input && typeof data.input === 'object'
        ? (data.input as Record<string, unknown>)
        : {};
    const existing = tools.get(id);
    tools.set(id, {
      toolUseId: id,
      toolName: name,
      input: Object.keys(input).length ? input : existing?.input || {},
      status: 'running',
      startedAt: existing?.startedAt || Date.now(),
      // 保留开始时的流式块序号：覆盖状态不能丢锚点，否则工具卡穿插位置错乱
      blockIndexAtStart: existing?.blockIndexAtStart,
      // task_started 可能先于 content_block_stop 到达：保留已设置的描述/进度
      description: existing?.description,
      progress: existing?.progress,
    });
    refreshActiveToolUI(sid);
    return true;
  }

  if (kind === 'tool_result') {
    const toolUseId = String(data?.tool_use_id || data?.toolUseId || '');
    const taskId = String(data?.task_id || data?.taskId || '');
    if (!toolUseId && !taskId) return false;
    const tools = appState.activeToolsBySession.get(sid) || appState.activeToolsBySession.get('pending');
    if (!tools) return false;
    const state = findActiveTool(tools, toolUseId, taskId);
    if (!state) return false;
    const isError = Boolean(data?.is_error || data?.isError);
    const resultText = String(data?.content ?? '');
    // 子代理「启动成功」元数据（Async agent launched…）不是完成结果：
    // 保持运行中，等 task-notification completed / 真实结果到达
    if (!isError && isSubagentLaunchMetadata(resultText)) {
      refreshActiveToolUI(sid);
      return true;
    }
    state.status = isError ? 'failed' : 'done';
    state.isError = isError;
    state.toolResult = resultText;
    // 保留到 messages-updated 再 reconcile 删除，避免完成态卡片闪断
    refreshActiveToolUI(sid);
    return true;
  }

  if (kind === 'task_started') {
    // 官方子代理进度：补充描述，确保子代理卡片立即可见
    const toolUseId = String(data?.tool_use_id || data?.toolUseId || '');
    const taskId = String(data?.task_id || data?.taskId || '');
    if (!toolUseId && !taskId) return false;
    const tools = getActiveToolsMap(sid);
    const key = toolUseId || taskId;
    const existing = findActiveTool(tools, toolUseId, taskId);
    const description =
      String(data?.description || '') || String(data?.prompt || '') || existing?.description;
    const next: ActiveToolState = {
      toolUseId: existing?.toolUseId || key,
      toolName: 'Task',
      input: existing?.input || {},
      status: existing?.status === 'done' || existing?.status === 'failed' ? existing.status : 'running',
      startedAt: existing?.startedAt || Date.now(),
      // 保留开始时的流式块序号（task_started 可能先于 tool_use_start 到达）
      blockIndexAtStart: existing?.blockIndexAtStart,
      taskId: taskId || existing?.taskId,
      description,
      progress: existing?.progress,
      toolResult: existing?.toolResult,
      isError: existing?.isError,
    };
    tools.set(next.toolUseId, next);
    refreshActiveToolUI(sid);
    return true;
  }

  if (kind === 'task_progress') {
    const toolUseId = String(data?.tool_use_id || data?.toolUseId || '');
    const taskId = String(data?.task_id || data?.taskId || '');
    if (!toolUseId && !taskId) return false;
    const tools = getActiveToolsMap(sid);
    let state = findActiveTool(tools, toolUseId, taskId);
    // 通知可能早于 tool_use_start：先占位，避免进度丢失
    if (!state) {
      const key = toolUseId || taskId;
      state = {
        toolUseId: key,
        toolName: 'Task',
        input: {},
        status: 'running',
        startedAt: Date.now(),
        taskId: taskId || undefined,
      };
      tools.set(key, state);
    }
    if (taskId) state.taskId = taskId;
    const status = String(data?.status || '');
    state.progress = {
      status: status || state.progress?.status,
      totalTokens: Number(data?.total_tokens ?? state.progress?.totalTokens) || state.progress?.totalTokens,
      toolUses: Number(data?.tool_uses ?? state.progress?.toolUses) || state.progress?.toolUses,
      durationMs: Number(data?.duration_ms ?? state.progress?.durationMs) || state.progress?.durationMs,
    };
    if (isTerminalTaskStatus(status)) {
      state.status = isFailedTaskStatus(status) ? 'failed' : 'done';
      state.isError = isFailedTaskStatus(status);
    }
    refreshActiveToolUI(sid);
    return true;
  }

  if (kind === 'todos_updated') {
    const todos = Array.isArray(data?.todos) ? data.todos : null;
    if (!todos) return false;
    appState.todosBySession.set(sid, todos as TodoItem[]);
    if (appState.activeConversationId === sid) {
      syncTodoPanelUI();
    }
    return true;
  }

  return false;
}

function ensureStreamSegmentIds(state: StreamingState): void {
  let next = state.nextSegmentIndex ?? 0;
  for (const block of state.blocks) {
    if (!block.segmentId) {
      block.segmentId = `streaming-block-${next}`;
    }
    const match = /^streaming-block-(\d+)$/.exec(block.segmentId);
    if (match) next = Math.max(next, Number(match[1]) + 1);
  }
  state.nextSegmentIndex = next;
}

function createStreamBlock(state: StreamingState, type: 'thinking' | 'text'): StreamBlock {
  ensureStreamSegmentIds(state);
  const index = state.nextSegmentIndex ?? 0;
  state.nextSegmentIndex = index + 1;
  return {
    segmentId: `streaming-block-${index}`,
    type,
    content: '',
    finalized: false,
  };
}

export function getStreamingState(sessionId: string): StreamingState {
  if (!appState.streamingBySession.has(sessionId)) {
    appState.streamingBySession.set(sessionId, {
      blocks: [],
      thinkingDone: false,
      nextSegmentIndex: 0,
      currentBlockIdx: -1,
    });
  }
  const state = appState.streamingBySession.get(sessionId)!;
  ensureStreamSegmentIds(state);
  return state;
}

export function clearStreamingState(sessionId: string) {
  appState.streamingBySession.delete(sessionId);
  appState.pendingTextDelta.delete(sessionId);
  // 流式块 id 是位置键（streaming-block-N）：跨轮/跨会话会复用同名键，
  // 清理展开态，避免下一轮/下一会话的新块被旧展开状态自动展开
  for (const key of [...appState.expandedThinkingBlocks]) {
    if (key.startsWith('streaming-block-')) {
      appState.expandedThinkingBlocks.delete(key);
    }
  }
  // 清理已消失块的 thinking scroller（destroy 幂等，map 不随会话增长）
  for (const [key, sc] of [...appState.thinkingScrollers]) {
    if (key.startsWith('streaming-block-')) {
      sc.destroy();
      appState.thinkingScrollers.delete(key);
    }
  }
  removeStreamingElements(sessionId);
  const refresh = appState.streamRefreshBySession.get(sessionId);
  if (refresh?.rafId !== null && refresh?.rafId !== undefined) {
    cancelAnimationFrame(refresh.rafId);
  }
  appState.streamRefreshBySession.delete(sessionId);
}

/** 从流式块提取已生成的助手文本 */
export function getStreamingAssistantText(sessionId: string): string {
  flushPendingTextDelta(sessionId);
  const state = appState.streamingBySession.get(sessionId);
  if (!state) return '';
  return state.blocks
    .filter((block) => block.type === 'text')
    .map((block) => block.content)
    .join('\n\n')
    .trim();
}

/**
 * 在清掉流式 UI 前，把已生成的助手文本写入会话，避免 JSONL 尚未落盘时刷新导致“消息消失”。
 */
export function commitStreamingAssistantToConversation(sessionId: string): void {
  if (!sessionId) return;
  const text = getStreamingAssistantText(sessionId);
  if (!text) return;

  const conversation = findConversationById(sessionId);
  if (!conversation) return;

  const last = conversation.messages[conversation.messages.length - 1];
  if (last?.role === 'assistant') {
    const prev = last.content || '';
    const isTemp = String(last.id).startsWith('stream-assistant-');
    const extendsExisting =
      prev === text ||
      text.startsWith(prev) ||
      prev.startsWith(text.slice(0, Math.min(80, text.length)));
    if (isTemp || extendsExisting) {
      if (text.length >= prev.length) {
        last.content = text;
      }
      conversation.updated_at = Math.floor(Date.now() / 1000);
      return;
    }
    // 远程已有同源最终内容（如只落最终报告、本地含进度前缀）：不重复追加流式文本
    if (assistantTextCovers(prev, text)) {
      conversation.updated_at = Math.floor(Date.now() / 1000);
      return;
    }
  }

  if (last?.role === 'user' || last?.role === 'assistant' || !last) {
    conversation.messages.push({
      id: `stream-assistant-${Date.now()}`,
      role: 'assistant',
      content: text,
      timestamp: Math.floor(Date.now() / 1000),
    });
    conversation.updated_at = Math.floor(Date.now() / 1000);
  }
}

/** 会话消息若已「内容级」包含最新助手回复则不再补；否则在用户消息后补一条流式文本。 */
export function ensureAssistantPresent(sessionId: string, streamedText: string): void {
  if (!sessionId || !streamedText) return;
  const conversation = findConversationById(sessionId);
  if (!conversation) return;

  // 任一 assistant 已覆盖流式文本（相等 / 超集 / 结尾最终消息）→ 不再补，避免叠两层
  const covered = conversation.messages.some(
    (m) =>
      m.role === 'assistant' &&
      (m.content || '').trim() &&
      assistantTextCovers(m.content || '', streamedText),
  );
  if (covered) return;

  const last = conversation.messages[conversation.messages.length - 1];
  const hasAssistant = conversation.messages.some((m) => m.role === 'assistant');
  if (last?.role === 'user' || !hasAssistant) {
    conversation.messages.push({
      id: `stream-assistant-${Date.now()}`,
      role: 'assistant',
      content: streamedText,
      timestamp: Math.floor(Date.now() / 1000),
    });
    conversation.updated_at = Math.floor(Date.now() / 1000);
  }
}

/** 将当前缓冲的文本追加到当前 text 块的 content */
export function flushPendingTextDelta(sessionId: string) {
  const pending = appState.pendingTextDelta.get(sessionId);
  if (!pending) return;
  const state = getStreamingState(sessionId);
  const block = state.blocks[state.currentBlockIdx];
  if (block && block.type === 'text') {
    block.content += pending;
  }
  appState.pendingTextDelta.set(sessionId, '');
}

export function handleMessageChunk(payload: MessageChunkPayload) {
  const { conversation_id: sid, kind, content } = payload;
  if (!sid) return;

  // 新进程已开始输出：切模型重启保护结束。
  // 先捕获再清除，避免本条 chunk 自身把重启中的会话误判为可恢复忙碌。
  const wasModelRestarting = appState.modelRestartingSessions.has(sid);
  appState.modelRestartingSessions.delete(sid);

  const isToolChunk = TOOL_CHUNK_KINDS.has(kind);
  // 常驻进程本轮结束后（turn-complete）可能立刻开始新一轮输出：
  // 新内容块应允许恢复忙碌，而不是被当作迟到的旧块丢弃——否则进程在跑、界面却停在「已结束」。
  const isContentStreamChunk =
    kind === 'thinking_start' ||
    kind === 'thinking_delta' ||
    kind === 'thinking_end' ||
    kind === 'text_start' ||
    kind === 'text_delta' ||
    kind === 'text_end' ||
    kind === 'stream_end';
  const canReBusyAfterTurn =
    isContentStreamChunk &&
    !appState.abortingSessions.has(sid) &&
    !wasModelRestarting;
  if (
    kind !== 'session_created' &&
    !appState.runningSessions.has(sid) &&
    !appState.runningSessions.has('pending') &&
    !canReBusyAfterTurn &&
    !(isToolChunk && (sessionHasActiveTools(sid) || kind === 'tool_use_start'))
  ) {
    return;
  }

  if (kind === 'session_created') {
    // pending -> 真实 session ID 转换
    const projectDir = content?.trim() || '';
    const pendingRunKey = `new:${projectDir}`;
    let runId = appState.runIdsBySession.get(pendingRunKey);
    let matchedKey = pendingRunKey;
    if (!runId) {
      const pendingRuns = [...appState.runIdsBySession.entries()].filter(([key]) => key.startsWith('new:'));
      if (pendingRuns.length === 1) {
        [matchedKey, runId] = pendingRuns[0];
      }
    }
    if (runId) {
      appState.runIdsBySession.delete(matchedKey);
      appState.runIdsBySession.set(sid, runId);
    }
    appState.runningSessions.delete('pending');
    appState.runningSessions.add(sid);
    transferSessionRunTimer('pending', sid);
    const pendingModel = appState.sessionProcessModels.get('pending');
    if (pendingModel !== undefined) {
      appState.sessionProcessModels.set(sid, pendingModel);
      appState.sessionProcessModels.delete('pending');
    }
    const pendingTools = appState.activeToolsBySession.get('pending');
    if (pendingTools && pendingTools.size > 0) {
      const tools = getActiveToolsMap(sid);
      for (const [id, state] of pendingTools) {
        if (!tools.has(id)) tools.set(id, state);
      }
      appState.activeToolsBySession.delete('pending');
    }
    // 仅在尚未激活会话时设置 appState.activeConversationId，避免打断用户已切换的视图
    const existing = findConversationById(sid);
    if (!appState.activeConversationId) {
      appState.activeConversationId = sid;
      // 若后端已先回填 source_path（罕见顺序），同步 active 路径避免匹配不到
      if (existing?.source_path) {
        appState.activeConversationSourcePath = existing.source_path;
      }
    }
    const now = Math.floor(Date.now() / 1000);
    // 只有当 appState.pendingUserMessage 属于此会话时才使用（防止串会话）
    const pendingMatchesThisSession = appState.pendingUserMessage &&
      (!appState.pendingUserMessageConvId || appState.pendingUserMessageConvId === sid);
    const added = updateOrAddConversation({
      id: sid,
      title: existing?.title || 'New Chat',
      messages: existing?.messages ?? (pendingMatchesThisSession
        ? [{ id: `user-${Date.now()}`, role: 'user', content: appState.pendingUserMessage!, timestamp: now }]
        : []),
      platform: 'claude',
      project_dir: content?.trim() || existing?.project_dir || null,
      source_path: existing?.source_path ?? null,
      created_at: existing?.created_at ?? now,
      updated_at: now,
    });
    // 新会话加入列表后立即重建侧边栏当前 tab：pending 阶段已渲染出 #message-list，
    // ensureChatViewVisible 只刷新聊天区，列表若不重建新会话不会出现，直到手动刷新。
    if (added) refreshActiveTabContent();
    // 此时尚无会话数据，保留 appState.pendingUserMessage 以确保用户消息可见
    updateSendButtonState();
    ensureChatViewVisible();
    updateConversationListSpinner();
    // ensureChatViewVisible 可能调用了 shellApi.render()，需要恢复按钮 loading 状态
    // 只有当 pending 消息属于此会话时才设置 loading（防止串会话）
    if (sid === appState.activeConversationId || (!appState.activeConversationId && appState.pendingUserMessage && !appState.pendingUserMessageConvId)) {
      setSendButtonLoading(true);
    }
    return;
  }

  if (isToolChunk) {
    handleToolChunk(sid, kind, content);
    return;
  }

  // 所有会话都累积流式数据（包括后台运行的会话）
  const state = getStreamingState(sid);
  const isActive = sid === appState.activeConversationId || (!appState.activeConversationId && appState.pendingUserMessage && !appState.pendingUserMessageConvId);

  // 常驻会话追问：上一轮 turn-complete 后 CLI 可能立刻开始下一轮，需重新标记忙碌
  if (
    kind === 'thinking_start' ||
    kind === 'text_start' ||
    kind === 'thinking_delta' ||
    kind === 'text_delta'
  ) {
    if (
      !appState.runningSessions.has(sid) &&
      !appState.abortingSessions.has(sid) &&
      !wasModelRestarting
    ) {
      appState.runningSessions.add(sid);
      markSessionRunStart(sid);
      updateConversationListSpinner();
      if (isActive) {
        setSendButtonLoading(true);
      }
    }
  }

  switch (kind) {
    case 'thinking_start':
      // 新内容恢复：清除 api_retry 等临时状态文案
      appState.runStatusOverride.delete(sid);
      state.thinkingDone = false;
      // 创建新的 thinking 块
      state.blocks.push(createStreamBlock(state, 'thinking'));
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
      {
        state.thinkingDone = true;
        // 后端下发 {"duration_ms": N}：记录到当前 thinking 块，标题展示思考时长
        const durationMs = parseChunkJson(content)?.duration_ms;
        const block = state.blocks[state.currentBlockIdx];
        if (block && block.type === 'thinking') {
          block.finalized = true;
          if (typeof durationMs === 'number' && durationMs > 0) {
            block.durationMs = durationMs;
          }
        }
      }
      if (isActive) refreshStreamingUI(sid);
      break;
    case 'text_start':
      // 新内容恢复：清除 api_retry 等临时状态文案
      appState.runStatusOverride.delete(sid);
      // 创建新的 text 块
      state.blocks.push(createStreamBlock(state, 'text'));
      state.currentBlockIdx = state.blocks.length - 1;
      break;
    case 'text_delta':
      appState.pendingTextDelta.set(sid, (appState.pendingTextDelta.get(sid) || '') + content);
      if (isActive) scheduleStreamingRefresh(sid);
      break;
    case 'text_end':
      flushPendingTextDelta(sid);
      {
        const block = state.blocks[state.currentBlockIdx];
        if (block?.type === 'text') block.finalized = true;
      }
      if (isActive) refreshStreamingUI(sid);
      break;
    case 'stream_end':
      flushPendingTextDelta(sid);
      state.blocks.forEach((block) => {
        if (block.type === 'text') block.finalized = true;
      });
      if (isActive) refreshStreamingUI(sid);
      break;
    case 'error':
      flushPendingTextDelta(sid);
      clearStreamingState(sid);
      break;
    case 'api_retry':
      if (isActive) {
        // 临时状态：输入框下方状态条展示重试文案，下一个内容块到达时清除
        setRunStatusOverride(sid, content?.trim() || '正在重试…');
      }
      break;
    case 'complete':
      flushPendingTextDelta(sid);
      state.blocks.forEach((block) => {
        if (block.type === 'text') block.finalized = true;
      });
      if (isActive) {
        refreshStreamingUI(sid);
      }
      break;
    default:
      break;
  }
}

export function scheduleStreamingRefresh(sessionId: string) {
  let refresh = appState.streamRefreshBySession.get(sessionId);
  if (!refresh) {
    refresh = { rafId: null, pending: false, lastTime: 0 };
    appState.streamRefreshBySession.set(sessionId, refresh);
  }
  if (refresh.pending) return;
  refresh.pending = true;

  const doRefresh = (timestamp: number) => {
    const current = appState.streamRefreshBySession.get(sessionId);
    if (!current) return;
    if (timestamp - current.lastTime < 100) {
      current.rafId = requestAnimationFrame(doRefresh);
      return;
    }
    current.lastTime = timestamp;
    current.rafId = null;
    current.pending = false;
    flushPendingTextDelta(sessionId);
    if (appState.activeConversationId === sessionId) {
      refreshStreamingUI(sessionId);
    }
  };

  refresh.rafId = requestAnimationFrame(doRefresh);
}

function inferSessionErrorCode(payload: SessionErrorPayload, errorText: string): string | undefined {
  if (payload.code) return payload.code;
  if (/same body is already in progress/i.test(errorText)) return 'singleflight_wait_timeout';
  if (/\[ede_diagnostic\]/i.test(errorText) && /stop_reason=tool_use/i.test(errorText)) {
    return 'kiro_invalid_tool_stream';
  }
  if (/empty assistant response/i.test(errorText)) return 'kiro_empty_response';
  return undefined;
}

function recoverableErrorStatus(code: string | undefined): string {
  switch (code) {
    case 'kiro_duplicate_inflight':
    case 'singleflight_wait_timeout':
      return 'Kiro 正在等待上一请求完成…';
    case 'upstream_busy':
    case 'upstream_rate_limit':
      return 'Kiro 服务繁忙，正在自动重试…';
    default:
      return '遇到临时错误，正在自动恢复…';
  }
}

export function handleSessionError(payload: SessionErrorPayload) {
  const sid = payload.conversationId || appState.activeConversationId || null;
  const errorText = payload.error.trim();
  if (!errorText) return;
  const errorCode = inferSessionErrorCode(payload, errorText);
  const isLegacyDerivedDiagnostic =
    !payload.code && /\[ede_diagnostic\]/i.test(errorText);

  if (payload.technical) {
    console.warn('[session-error] 已抑制衍生技术诊断:', errorCode || 'technical', errorText);
    return;
  }

  if (payload.recoverable) {
    setRunStatusOverride(sid || 'pending', recoverableErrorStatus(errorCode));
    return;
  }

  // 兼容旧版后端：真实主错误之后 Claude Code 可能再补一条 ede_diagnostic。
  // 该诊断只是同一失败的第二症状，不应结束会话两次或污染永久错误卡。
  if (isLegacyDerivedDiagnostic && sid) {
    const conversation = findConversationById(sid);
    const last = conversation?.messages[conversation.messages.length - 1];
    const nowSec = Math.floor(Date.now() / 1000);
    if (last?.role === 'error' && nowSec - last.timestamp <= 120) {
      console.warn('[session-error] 已抑制旧版衍生诊断:', errorText);
      return;
    }
  }

  setRunStatusOverride(sid || 'pending', null);

  // 最终会话错误意味着后端将结束（或已结束）该会话进程：清掉运行/停止标记。
  // 否则「切模型重启 / 重新生成后进程异常退出」时，session-ended 会被
  // runningSessions 拦截忽略，输入框状态条与时长永远停在「执行中」。
  if (sid) {
    appState.runningSessions.delete(sid);
    appState.abortingSessions.delete(sid);
    appState.modelRestartingSessions.delete(sid);
  } else {
    appState.runningSessions.delete('pending');
    appState.abortingSessions.delete('pending');
    appState.modelRestartingSessions.delete('pending');
  }

  const isCurrentSession = !sid || sid === appState.activeConversationId;
  if (isCurrentSession) clearPendingRequestState();
  clearStreamingState(sid || 'pending');
  clearSessionTools(sid || 'pending');
  clearSessionTools('pending');
  if (isCurrentSession) hideSendingState();

  const errorMessage: Message = {
    id: `error-${Date.now()}`,
    role: 'error',
    content: errorText,
    errorCode,
    errorDetail: payload.detail?.trim() || errorText,
    timestamp: Math.floor(Date.now() / 1000),
  };

  if (sid) {
    appState.transientSessionError = null;
    const existingConversation = findConversationById(sid);
    let conversation = existingConversation;
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
      appState.conversations.unshift(conversation);
      // 会话创建即失败（无 session_created 事件）：同样要刷新侧边栏，否则新会话不出现
      refreshActiveTabContent();
    }

    const nowSec = Math.floor(Date.now() / 1000);
    const last = conversation.messages[conversation.messages.length - 1];
    // 同一失败回合往往连发多条 session-error（真实 API 错误 + Claude Code 的内部
    // `[ede_diagnostic]` 等），它们都是同一个问题，别刷成多张卡。相邻错误消息几乎只
    // 可能来自同一回合（不同回合之间总有用户/助手消息隔开），故把「紧接着的最近错误」
    // 合并进一张卡；用 120s 窗口挡住跨回合误合并。
    const lastIsRecentError =
      !!last && last.role === 'error' && nowSec - last.timestamp <= 120;

    if (lastIsRecentError && !last.errorDetail?.includes(errorText) && !last.content.includes(errorText)) {
      // 第一条是用户主提示；后续同回合错误只进入折叠详情，不污染主文案。
      last.errorDetail = [last.errorDetail || last.content, errorText].filter(Boolean).join('\n');
      conversation.updated_at = nowSec;
    } else {
      const hasSameError = conversation.messages.some(
        (message) => message.role === 'error' && message.content === errorText,
      );
      if (!hasSameError) {
        conversation.messages.push(errorMessage);
        conversation.updated_at = errorMessage.timestamp;
      }
    }
    if (isCurrentSession) {
      appState.pendingUserMessage = null;
      appState.pendingUserMessageConvId = null;
    }
  } else {
    appState.transientSessionError = errorText;
  }

  updateConversationListSpinner();
  if (isCurrentSession) {
    // ensureChatViewVisible 内部已处理：无壳→同步 render；有壳→调度合并刷新
    ensureChatViewVisible();
  }
}

/**
 * 确保聊天视图可见。返回是否走了全量渲染（true = DOM 已同步重建，调用方无需再安排刷新）；
 * 否则已有 #message-list 时安排一次合并后的聊天刷新。
 */
export function ensureChatViewVisible(): boolean {
  // 全屏管理页占用主区域时，不因后台流式事件强制切回聊天视图
  if (appState.isApiConfigViewActive || appState.isSettingsViewActive || appState.isSkillsViewActive || appState.isKiroViewActive) return false;
  const mainContent = document.querySelector('.main-content');
  if (!mainContent) return false;
  if (!document.querySelector('#message-list')) {
    shellApi.render();
    return true;
  }
  scheduleUiRefresh({ chat: true });
  return false;
}

export function removeStreamingElements(sessionId?: string) {
  // DOM 清理由最终 render plan 的 cursor reconcile 统一提交，禁止在状态清理时先缩短列表。
  if (sessionId && sessionId !== appState.activeConversationId) return;
  scheduleUiRefresh({ chat: true });
}

function updateStreamingTextBody(mdBody: HTMLElement, block: StreamBlock): boolean {
  const renderedContent = mdBody.dataset.renderedContent || '';
  const renderMode = block.finalized ? 'markdown' : 'streaming-markdown';
  if (mdBody.dataset.renderMode === renderMode && renderedContent === block.content) {
    return false;
  }

  // 已完成消息可复用 Markdown LRU 缓存；流式前缀只渲染一次，不进入缓存，
  // 避免长回复的每个增量版本挤占缓存。marked 能容错未闭合围栏/列表，
  // 后续 delta 到达后的下一次 100ms 刷新会立即反映最新结构。
  mdBody.classList.remove('streaming-plain-text');
  mdBody.innerHTML = block.finalized
    ? renderMarkdownCached(block.content)
    : renderMarkdown(block.content);
  mdBody.dataset.renderMode = renderMode;
  mdBody.dataset.renderedContent = block.content;
  mdBody.dataset.renderedLength = String(block.content.length);
  return true;
}

/**
 * 就地同步已挂载的流式块内容（不重建 DOM）：
 * - thinking 块：更新 <pre> 文本 / 标题 / 时长 / streaming-active 类 / 独立滚动
 * - text 块：流式阶段纯文本追加，完成态渲染 markdown（幂等，按 dataset 增量）
 * 块结构变化（新增块 / 工具卡穿插）由统一 diff（refreshChatContent）处理；
 * 挂载完成后（diff 新建/重建的占位块）也调用本函数填充内容。
 */
export function syncStreamingBlocksInPlace(sessionId: string): void {
  const messageList = document.querySelector<HTMLDivElement>('#message-list');
  if (!messageList) return;
  // 只读状态：不创建空条目（纯工具会话 / 已清理会话不应残留空状态）
  const state = appState.streamingBySession.get(sessionId);
  if (!state) return;
  // 与 renderStreamingBlocksChunks 内部 mergeStreamBlocks 语义一致（同一组工具锚点，
  // 否则就地路径与 diff 路径计算出的块边界不一致，工具卡会在最终化后被折叠到错误位置）
  const anchorTools = appState.activeToolsBySession.get(sessionId);
  const noMergeAfterRaw = getToolAnchorBlockIndexes(anchorTools ? [...anchorTools.values()] : []);
  const merged = mergeStreamBlocks(state.blocks, noMergeAfterRaw);
  merged.forEach((block) => {
    const blockId = block.segmentId ?? `streaming-block-${block.rawStart}`;
    const existingEl = messageList.querySelector<HTMLElement>(
      `.message[data-stream-id="${blockId}"]`,
    );
    if (!existingEl) return; // 尚未挂载（diff 下一轮创建，届时挂载完成后再次同步）

    if (block.type === 'thinking') {
      const finalized = Boolean(block.finalized);
      const label = finalized ? '思考过程' : '思考中...';
      const isStreaming = !finalized;
      const pre = existingEl.querySelector('.thinking-content pre');
      const summary = existingEl.querySelector('.thinking-summary .thinking-label-text');
      if (pre) pre.textContent = block.content;
      if (summary) summary.textContent = label;
      const durationEl = existingEl.querySelector('.thinking-summary .thinking-duration');
      if (!isStreaming && durationEl) {
        durationEl.textContent = block.durationMs ? formatDuration(block.durationMs) : '思考完成';
      }
      existingEl.querySelector('.thinking-block')?.classList.toggle('streaming-active', isStreaming);
      // 结束态就地移除消息的 streaming 类（renderKey 恒定，diff 不再重建）
      existingEl.classList.toggle('streaming', isStreaming);
      const scrollEl = existingEl.querySelector<HTMLElement>('.thinking-content-scroll');
      if (scrollEl) getThinkingScroller(scrollEl, blockId).onNewContent();
    } else {
      // text 块：就地追加文本（diff 的 renderKey 不含内容，节点稳定复用）
      const mdBody = existingEl.querySelector<HTMLElement>('.markdown-body');
      if (mdBody && updateStreamingTextBody(mdBody, block)) {
        initCodeCopyButtons(existingEl);
        scheduleHighlighting(existingEl);
      }
      // 结束态就地移除 streaming 类（renderKey 恒定，diff 不再重建）
      existingEl.classList.toggle('streaming', !block.finalized);
    }
  });

  // 就地更新运行中 Task/Agent 卡的进度行（tokens · 工具次数 · 耗时）：
  // 工具卡 renderKey 不含进度字段，进度 tick 不重建节点（快路径保持生效）
  const tools = appState.activeToolsBySession.get(sessionId);
  if (tools) {
    for (const [id, tool] of tools) {
      if (tool.toolName !== 'Task' && tool.toolName !== 'Agent') continue;
      const cardEl = messageList.querySelector<HTMLElement>(
        `[data-stream-id="live-tool-${id}"]`,
      );
      if (!cardEl) continue;
      const metaEl = cardEl.querySelector('.tool-card-header .tool-meta');
      if (!metaEl) continue;
      metaEl.textContent = formatSubagentUsage({
        totalTokens: tool.progress?.totalTokens,
        toolUses: tool.progress?.toolUses,
        durationMs: tool.progress?.durationMs,
      });
    }
  }

}

/** 流式状态变化只调度唯一聊天 commit；DOM patch 与几何恢复由该 commit 统一完成。 */
export function refreshStreamingUI(sessionId: string) {
  if (sessionId !== appState.activeConversationId && !(appState.pendingUserMessage && !appState.activeConversationId && !appState.pendingUserMessageConvId)) return;

  refreshRunStatusStrip();
  scheduleUiRefresh({ chat: true });
}

