import { appState } from '../../state';
import { shellApi } from '../../app/shell/api';
import type {
  Message,
  SessionErrorPayload,
  MessageChunkPayload,
  StreamBlock,
  StreamingState,
  ActiveToolState,
  TodoItem,
} from '../../types';
import { renderMarkdownCached as renderMarkdown, initCodeCopyButtons } from '../../markdown';
import { getThinkingScroller } from './thinking-scroller';
import { updateSendButtonState, setSendButtonLoading } from './session-context';
import { updateOrAddConversation, findConversationById, assistantTextCovers } from '../conversations';
import { updateConversationListSpinner } from '../sidebar';
import { renderThinkingDetails, extractToolUseId, processToolMessages } from './render-messages';
import { clearPendingRequestState, hideSendingState, removePendingAssistantIndicator, updatePendingStatus } from './retry';
import { ScrollController, scheduleUiRefresh } from '../../ui';
import { syncTodoPanelUI } from './todo-panel';

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
    if (!id || name !== 'Task') return false;
    const tools = getActiveToolsMap(sid);
    const existing = tools.get(id);
    tools.set(id, {
      toolUseId: id,
      toolName: name,
      input: existing?.input || {},
      status: 'running',
      startedAt: existing?.startedAt || Date.now(),
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
    if (!id || name !== 'Task') return false;
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
    state.status = isError ? 'failed' : 'done';
    state.isError = isError;
    state.toolResult = String(data?.content ?? '');
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

export function getStreamingState(sessionId: string): StreamingState {
  if (!appState.streamingBySession.has(sessionId)) {
    appState.streamingBySession.set(sessionId, { blocks: [], thinkingDone: false, currentBlockIdx: -1 });
  }
  return appState.streamingBySession.get(sessionId)!;
}

export function clearStreamingState(sessionId: string) {
  appState.streamingBySession.delete(sessionId);
  appState.pendingTextDelta.delete(sessionId);
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
    updateOrAddConversation({
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
      updateConversationListSpinner();
      if (isActive) {
        setSendButtonLoading(true);
      }
    }
  }

  switch (kind) {
    case 'thinking_start':
      state.thinkingDone = false;
      // 创建新的 thinking 块
      state.blocks.push({ type: 'thinking', content: '' });
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
      state.thinkingDone = true;
      if (isActive) refreshStreamingUI(sid);
      break;
    case 'text_start':
      // 创建新的 text 块
      state.blocks.push({ type: 'text', content: '', finalized: false });
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
        removePendingAssistantIndicator();
        updatePendingStatus(content);
      }
      break;
    case 'complete':
      flushPendingTextDelta(sid);
      state.blocks.forEach((block) => {
        if (block.type === 'text') block.finalized = true;
      });
      if (isActive) {
        refreshStreamingUI(sid);
        // result 已到但 session-ended 稍晚：先去掉「正在输出」，避免误以为还在生成
        document.querySelectorAll('.message-streaming-indicator').forEach((el) => el.remove());
        document.querySelectorAll('.message.streaming').forEach((el) => {
          el.classList.remove('streaming');
        });
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

export function handleSessionError(payload: SessionErrorPayload) {
  const sid = payload.conversationId || appState.activeConversationId || null;
  const errorText = payload.error.trim();
  if (!errorText) return;

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
    timestamp: Math.floor(Date.now() / 1000),
  };

  if (sid) {
    appState.transientSessionError = null;
    let conversation = findConversationById(sid);
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
    }

    const hasSameError = conversation.messages.some(
      (message) => message.role === 'error' && message.content === errorText,
    );
    if (!hasSameError) {
      conversation.messages.push(errorMessage);
      conversation.updated_at = errorMessage.timestamp;
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
  if (appState.isApiConfigViewActive || appState.isSettingsViewActive || appState.isMcpViewActive || appState.isKiroViewActive) return false;
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
  // DOM 只代表当前可见会话；后台会话清理不能碰当前会话的流式节点。
  if (sessionId && sessionId !== appState.activeConversationId) return;
  document.querySelectorAll('[id^="streaming-"]').forEach((el) => el.remove());
}

function updateStreamingTextBody(mdBody: HTMLElement, block: StreamBlock): boolean {
  if (block.finalized) {
    if (
      mdBody.dataset.renderMode !== 'markdown' ||
      mdBody.dataset.renderedContent !== block.content
    ) {
      mdBody.classList.remove('streaming-plain-text');
      mdBody.innerHTML = renderMarkdown(block.content);
      mdBody.dataset.renderMode = 'markdown';
      mdBody.dataset.renderedContent = block.content;
      mdBody.dataset.renderedLength = String(block.content.length);
      return true;
    }
    return false;
  }

  let renderedLength = Number(mdBody.dataset.renderedLength || 0);
  if (mdBody.dataset.renderMode !== 'plain' || renderedLength > block.content.length) {
    mdBody.textContent = '';
    mdBody.classList.add('streaming-plain-text');
    mdBody.dataset.renderMode = 'plain';
    mdBody.dataset.renderedContent = '';
    renderedLength = 0;
  }
  if (renderedLength < block.content.length) {
    mdBody.appendChild(document.createTextNode(block.content.slice(renderedLength)));
    mdBody.dataset.renderedLength = String(block.content.length);
  }
  return false;
}

export function refreshStreamingUI(sessionId: string) {
  // 只有当 sessionId 匹配当前会话时才更新
  if (sessionId !== appState.activeConversationId && !(appState.pendingUserMessage && !appState.activeConversationId && !appState.pendingUserMessageConvId)) return;

  const messageList = document.querySelector<HTMLDivElement>('#message-list');
  if (!messageList) return;

  removePendingAssistantIndicator();

  const state = getStreamingState(sessionId);

  // 先合并相邻的同类型块（thinking-thinking, text-text）
  const merged: StreamBlock[] = [];
  for (const block of state.blocks) {
    const last = merged[merged.length - 1];
    if (last && last.type === block.type && block.type === 'thinking') {
      last.content = last.content + '\n' + block.content;
    } else if (last && last.type === block.type && block.type === 'text') {
      last.content = last.content + '\n\n' + block.content;
      last.finalized = Boolean(last.finalized && block.finalized);
    } else {
      merged.push({ type: block.type, content: block.content, finalized: block.finalized });
    }
  }

  // 收集现有流式块元素，按索引索引
  const existingEls = new Map<number, HTMLElement>();
  messageList.querySelectorAll<HTMLElement>('[id^="streaming-block-"]').forEach((el) => {
    const idx = parseInt(el.id.replace('streaming-block-', ''), 10);
    if (!isNaN(idx)) existingEls.set(idx, el);
  });
  const usedIndices = new Set<number>();

  // 按合并后的块序列更新（就地更新已存在的元素，创建新元素）
  merged.forEach((block, idx) => {
    usedIndices.add(idx);
    const blockId = `streaming-block-${idx}`;
    const existingEl = existingEls.get(idx);

    if (block.type === 'thinking') {
      const label = state.thinkingDone ? '思考过程' : '思考中...';
      const isStreaming = !state.thinkingDone;
      const expanded = isStreaming || appState.expandedThinkingBlocks.has(sessionId);

      if (existingEl && existingEl.classList.contains('thinking-msg')) {
        // 就地更新：只更新 <pre> 文本和 <summary> 标签
        const pre = existingEl.querySelector('.thinking-content pre');
        const summary = existingEl.querySelector('.thinking-summary .thinking-label-text');
        if (pre) pre.textContent = block.content;
        if (summary) summary.textContent = label;
        // 更新流式状态类
        if (isStreaming) {
          existingEl.querySelector('.thinking-block')?.classList.add('streaming-active');
        } else {
          existingEl.querySelector('.thinking-block')?.classList.remove('streaming-active');
        }
        // 思考内容独立滚动
        const scrollEl = existingEl.querySelector<HTMLElement>('.thinking-content-scroll');
        if (scrollEl) getThinkingScroller(scrollEl, blockId).onNewContent();
      } else {
        // 删除旧元素（类型不匹配或不存在）
        existingEl?.remove();
        const el = document.createElement('div');
        el.id = blockId;
        el.className = 'message assistant thinking-msg streaming';
        el.innerHTML = `<div class="message-content">${renderThinkingDetails(block.content, label, expanded, undefined, isStreaming)}</div>`;
        messageList.appendChild(el);
        const detailsEl = el.querySelector('.thinking-block');
        if (detailsEl) {
          detailsEl.addEventListener('toggle', () => {
            if ((detailsEl as HTMLDetailsElement).open) {
              appState.expandedThinkingBlocks.add(sessionId);
            } else {
              appState.expandedThinkingBlocks.delete(sessionId);
            }
          });
        }
        // 新创建的思考块：初始化独立 ScrollController
        const scrollEl = el.querySelector<HTMLElement>('.thinking-content-scroll');
        if (scrollEl) getThinkingScroller(scrollEl, blockId).scrollToBottom();
        existingEls.set(idx, el);
      }
    } else if (block.type === 'text') {
      if (existingEl && !existingEl.classList.contains('thinking-msg')) {
        // 流式阶段仅追加纯文本；块完成后再做一次完整 Markdown 渲染。
        const mdBody = existingEl.querySelector('.markdown-body');
        if (mdBody && updateStreamingTextBody(mdBody as HTMLElement, block)) {
          initCodeCopyButtons(existingEl);
        }
      } else {
        existingEl?.remove();
        const el = document.createElement('div');
        el.id = blockId;
        el.className = 'message assistant streaming';
        el.innerHTML = `<div class="message-content">
          <div class="markdown-body"></div>
          <div class="message-footer">
            <span class="message-streaming-indicator">正在输出...</span>
          </div>
        </div>`;
        messageList.appendChild(el);
        const mdBody = el.querySelector<HTMLElement>('.markdown-body');
        if (mdBody && updateStreamingTextBody(mdBody, block)) {
          initCodeCopyButtons(el);
        }
        existingEls.set(idx, el);
      }
    }
  });

  // 移除不再需要的旧流式元素（块数量减少时）
  existingEls.forEach((el, idx) => {
    if (!usedIndices.has(idx)) {
      // 清理对应的 thinking scroller
      const blockId = `streaming-block-${idx}`;
      appState.thinkingScrollers.get(blockId)?.destroy();
      appState.thinkingScrollers.delete(blockId);
      el.remove();
    }
  });

  // Answer 区域自动置底
  appState.answerScroller?.onNewContent();
}

/** 初始化 Answer 区域 ScrollController（#message-list） */
export function initAnswerScroller(): void {
  const messageList = document.querySelector<HTMLDivElement>('#message-list');
  if (!messageList) return;

  // 销毁旧实例
  appState.answerScroller?.destroy();
  appState.thinkingScrollers.forEach((sc) => sc.destroy());
  appState.thinkingScrollers.clear();

  appState.answerScroller = new ScrollController(messageList, {
    resumePx: 20,
    leavePx: 80,
    createButton: true,
  });
}

/** 捕获消息列表重建前的滚动状态，用于输出结束后恢复（不打断用户阅读上方消息） */
export function captureScrollState(): { autoScroll: boolean; scrollTop: number } | null {
  if (!appState.answerScroller) return null;
  return { autoScroll: appState.answerScroller.autoScroll, scrollTop: appState.answerScroller.el.scrollTop };
}

/** 重建后恢复滚动状态：用户此前在底部 → 置底；否则保持其阅读位置，不强制跳回 */
export function restoreScrollState(snap: { autoScroll: boolean; scrollTop: number } | null): void {
  if (!appState.answerScroller) return;
  if (!snap || snap.autoScroll) {
    appState.answerScroller.scrollToBottom();
  } else {
    appState.answerScroller.restorePosition(snap.scrollTop, false);
  }
}

