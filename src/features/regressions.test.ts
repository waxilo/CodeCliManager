import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { projectRelativePath, stripFileRefsFromDisplay } from './files';
import {
  dedupeAdjacentDuplicateMessages,
  normalizeSessionEventPayload,
  updateOrAddConversation,
  findConversationById,
  mergeRemoteAndLocalMessages,
  assistantTextCovers,
} from './conversations/normalize';
import {
  handleMessageChunk,
  handleSessionError,
  purgeTerminalTools,
  reconcileActiveToolsWithHistory,
  commitStreamingAssistantToConversation,
  ensureAssistantPresent,
  getStreamingAssistantText,
} from './chat/streaming';
import { showConfirmDialog } from '../ui/confirm-dialog';
import { appState } from '../state';
import { resetSidebarTabState } from './sidebar/sidebar-tabs';
import type { Message, MessageChunkPayload } from '../types';

function message(id: string, role: Message['role'], content: string): Message {
  return { id, role, content, timestamp: 1 };
}

function chunk(conversation_id: string, kind: string, content = ''): MessageChunkPayload {
  return { conversation_id, kind, content };
}

function resetSessionState() {
  appState.runningSessions.clear();
  appState.abortingSessions.clear();
  appState.modelRestartingSessions.clear();
  appState.streamingBySession.clear();
  appState.pendingTextDelta.clear();
  appState.streamRefreshBySession.clear();
  appState.activeConversationId = '';
  appState.pendingUserMessage = null;
  appState.pendingUserMessageConvId = null;
}

describe('file reference boundaries', () => {
  it('requires a path component boundary', () => {
    expect(projectRelativePath('/tmp/app', '/tmp/app/src/a.ts')).toBe('src/a.ts');
    expect(projectRelativePath('/tmp/app', '/tmp/application/a.ts')).toBeNull();
  });

  it('preserves unresolved at-path text', () => {
    expect(stripFileRefsFromDisplay('contact user@example.com/path')).toBe('contact user@example.com/path');
    expect(stripFileRefsFromDisplay('check @not/a/file')).toBe('check @not/a/file');
  });
});

describe('message deduplication', () => {
  it('preserves real repeated and similar messages', () => {
    const messages = [
      message('a1', 'assistant', 'same prefix'),
      message('a2', 'assistant', 'same prefix with more detail'),
      message('u1', 'user', 'retry'),
      message('u2', 'user', 'retry'),
    ];
    expect(dedupeAdjacentDuplicateMessages(messages)).toEqual(messages);
  });

  it('replaces an exact temporary message with its persisted counterpart', () => {
    const persisted = message('persisted', 'assistant', 'done');
    expect(
      dedupeAdjacentDuplicateMessages([
        message('stream-assistant-1', 'assistant', 'done'),
        persisted,
      ]),
    ).toEqual([persisted]);
  });
});

describe('confirm dialog escaping and dismissal', () => {
  afterEach(() => {
    document.querySelector('.confirm-overlay')?.remove();
  });

  it('escapes message HTML instead of injecting it', async () => {
    const promise = showConfirmDialog({
      title: 't',
      message: '<img src=x onerror="window.__pwned=1">',
    });
    const dialog = document.querySelector('.confirm-dialog');
    expect(dialog).toBeTruthy();
    expect(dialog?.querySelector('.confirm-message')?.innerHTML).not.toContain('<img');
    expect(dialog?.querySelector('.confirm-message')?.textContent).toContain(
      '<img src=x onerror=',
    );
    (dialog?.querySelector('.confirm-btn.cancel') as HTMLButtonElement).click();
    await expect(promise).resolves.toBe(false);
  });

  it('closes on Escape and resolves false', async () => {
    const promise = showConfirmDialog({ title: 't', message: 'm' });
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    await expect(promise).resolves.toBe(false);
    expect(document.querySelector('.confirm-overlay')).toBeNull();
  });

  it('resolves true on danger button click', async () => {
    const promise = showConfirmDialog({ title: 't', message: 'm', confirmLabel: '确定' });
    const dialog = document.querySelector('.confirm-dialog') as HTMLElement;
    (dialog.querySelector('.confirm-btn.danger') as HTMLButtonElement).click();
    await expect(promise).resolves.toBe(true);
  });
});

describe('cross-session conversation identity', () => {
  beforeEach(() => {
    resetSessionState();
    appState.conversations = [];
  });

  it('normalizeSessionEventPayload preserves source_path', () => {
    const payload = normalizeSessionEventPayload({
      conversation_id: 'c1',
      title: 't',
      messages: [],
      project_dir: '/proj',
      source_path: '/proj/abc.jsonl',
      updated_at: 100,
    });
    expect(payload.source_path).toBe('/proj/abc.jsonl');
  });

  it('does not duplicate a conversation when its source_path is backfilled', () => {
    // 新会话先以 source_path=null 落地（session_created chunk 阶段）
    updateOrAddConversation({
      id: 'c1',
      title: 'New',
      messages: [],
      platform: 'claude',
      project_dir: '/proj',
      source_path: null,
      created_at: 1,
      updated_at: 1,
    });
    // 后端 messages-updated 携带真实 source_path 回填
    updateOrAddConversation({
      id: 'c1',
      title: 'New',
      messages: [message('m1', 'assistant', 'hi')],
      platform: 'claude',
      project_dir: '/proj',
      source_path: '/proj/abc.jsonl',
      created_at: 1,
      updated_at: 2,
    });
    expect(appState.conversations.filter((c) => c.id === 'c1')).toHaveLength(1);
  });

  it('keeps one entry when a loaded conversation receives a messages-updated event', () => {
    // loadData 生成的条目：带真实 source_path
    updateOrAddConversation({
      id: 'c1',
      title: 'C1',
      messages: [message('u1', 'user', 'hello')],
      platform: 'claude',
      project_dir: '/proj',
      source_path: '/proj/abc.jsonl',
      created_at: 1,
      updated_at: 1,
    });
    const before = appState.conversations.length;

    // Rust 发出的 messages-updated（经 normalizeSessionEventPayload 保留 source_path）
    const payload = normalizeSessionEventPayload({
      conversation_id: 'c1',
      title: 'C1',
      messages: [message('u1', 'user', 'hello'), message('a1', 'assistant', 'reply')],
      project_dir: '/proj',
      source_path: '/proj/abc.jsonl',
      updated_at: 3,
    });
    const existing = findConversationById(payload.conversation_id, payload.source_path);
    const merged = mergeRemoteAndLocalMessages(payload.messages, existing?.messages);
    updateOrAddConversation({
      id: payload.conversation_id,
      title: payload.title,
      messages: merged,
      platform: 'claude',
      project_dir: payload.project_dir,
      source_path: payload.source_path,
      created_at: 1,
      updated_at: payload.updated_at,
    });

    expect(appState.conversations.length).toBe(before);
    const entry = appState.conversations.find((c) => c.id === 'c1');
    expect(entry?.messages).toHaveLength(2);
  });
});

describe('新建会话后侧边栏刷新', () => {
  beforeEach(() => {
    // 提供 #conversation-list 供 refreshActiveTabContent 落盘；无 .main-content，
    // ensureChatViewVisible 提前返回 false，避免触发 shellApi.render()
    document.body.innerHTML = '<div id="conversation-list"></div>';
    resetSessionState();
    resetSidebarTabState();
    appState.conversations = [];
    appState.newConversationIds.clear();
  });

  it('session_created chunk 首落盘新会话时重建侧边栏，新会话立即出现', () => {
    appState.pendingUserMessage = 'hello';
    appState.pendingUserMessageConvId = null;

    handleMessageChunk(chunk('conv-new', 'session_created', '/proj'));

    expect(appState.conversations.some((c) => c.id === 'conv-new')).toBe(true);
    const listHtml = document.querySelector('#conversation-list')!.innerHTML;
    expect(listHtml).toContain('conv-new');
    expect(listHtml).toContain('New Chat');
  });

  it('既有会话重复收到 session_created 不新增、不重建侧边栏', () => {
    handleMessageChunk(chunk('conv-dup', 'session_created', '/proj'));
    const htmlAfterFirst = document.querySelector('#conversation-list')!.innerHTML;
    expect(htmlAfterFirst).toContain('conv-dup');

    handleMessageChunk(chunk('conv-dup', 'session_created', '/proj'));

    expect(appState.conversations.filter((c) => c.id === 'conv-dup')).toHaveLength(1);
    expect(document.querySelector('#conversation-list')!.innerHTML).toBe(htmlAfterFirst);
  });

  it('会话创建即失败（session-error 无 session_created）也刷新侧边栏', () => {
    appState.activeConversationId = 'conv-err';

    handleSessionError({ conversationId: 'conv-err', error: 'shell failed' });

    expect(appState.conversations.some((c) => c.id === 'conv-err')).toBe(true);
    expect(document.querySelector('#conversation-list')!.innerHTML).toContain('conv-err');
  });
});

describe('subagent tool cleanup', () => {
  beforeEach(() => {
    resetSessionState();
    appState.activeToolsBySession.clear();
  });

  it('purges terminal tasks but keeps running ones on turn-complete', () => {
    const sid = 'session-tools-1';
    appState.activeToolsBySession.set(
      sid,
      new Map([
        ['done-1', { toolUseId: 'done-1', toolName: 'Task', input: {}, status: 'done', startedAt: 1 }],
        ['fail-1', { toolUseId: 'fail-1', toolName: 'Task', input: {}, status: 'failed', startedAt: 1 }],
        ['run-1', { toolUseId: 'run-1', toolName: 'Task', input: {}, status: 'running', startedAt: 1 }],
      ]),
    );

    purgeTerminalTools(sid);

    const after = appState.activeToolsBySession.get(sid);
    expect(after?.size).toBe(1);
    expect(after?.has('run-1')).toBe(true);
  });

  it('removes a terminal task missing from history when reconciling (Scenario A)', () => {
    const sid = 'session-tools-2';
    appState.activeToolsBySession.set(
      sid,
      new Map([
        ['ghost-done', { toolUseId: 'ghost-done', toolName: 'Task', input: {}, status: 'done', startedAt: 1 }],
        ['ghost-run', { toolUseId: 'ghost-run', toolName: 'Task', input: {}, status: 'running', startedAt: 1 }],
      ]),
    );

    // 历史里完全没有这些 Task（截断/未落盘）
    reconcileActiveToolsWithHistory(sid, []);

    const after = appState.activeToolsBySession.get(sid);
    expect(after?.has('ghost-done')).toBe(false);
    expect(after?.has('ghost-run')).toBe(true);
  });
});

describe('resident session re-busy after turn-complete', () => {
  beforeEach(resetSessionState);

  it('re-marks a session as running when a continuing turn streams after turn-complete', () => {
    const sid = 'session-resident-1';

    // 模拟：turn-complete 已清 runningSessions，但 CLI 常驻进程立刻开始新一轮输出。
    // 旧守卫会把 text_start/text_delta 当迟到块丢弃，导致界面停在「已结束」。
    handleMessageChunk(chunk(sid, 'text_start'));
    handleMessageChunk(chunk(sid, 'text_delta', '继续输出'));

    expect(appState.runningSessions.has(sid)).toBe(true);
  });

  it('does not re-busy a session being aborted', () => {
    const sid = 'session-aborting-1';
    appState.abortingSessions.add(sid);

    handleMessageChunk(chunk(sid, 'text_start'));
    handleMessageChunk(chunk(sid, 'text_delta', '迟到内容'));

    expect(appState.runningSessions.has(sid)).toBe(false);
  });

  it('keeps a session running during model restart and clears the restart flag on first output', () => {
    const sid = 'session-restart-1';
    // 切模型重启：send.ts 同时标记 running 与 modelRestarting
    appState.runningSessions.add(sid);
    appState.modelRestartingSessions.add(sid);

    handleMessageChunk(chunk(sid, 'text_start'));
    handleMessageChunk(chunk(sid, 'text_delta', '新进程输出'));

    expect(appState.runningSessions.has(sid)).toBe(true);
    expect(appState.modelRestartingSessions.has(sid)).toBe(false);
  });
});

describe('assistantTextCovers content-level coverage', () => {
  it('short progress does not cover the longer final stream text', () => {
    const progress = '正在读取代码...';
    const report = '# CodeCliManager 项目分析报告\n\n完整内容';
    expect(assistantTextCovers(progress, `${progress}\n\n${report}`)).toBe(false);
    expect(assistantTextCovers(report, `${progress}\n\n${report}`)).toBe(true);
  });

  it('covers exact, superset, tail, and whitespace-normalized text', () => {
    expect(assistantTextCovers('报告正文', '报告正文')).toBe(true);
    expect(assistantTextCovers('前缀\n\n报告正文', '报告正文')).toBe(true);
    expect(assistantTextCovers('报告\n正文', '报告 正文')).toBe(true);
    expect(assistantTextCovers('', '报告')).toBe(false);
    expect(assistantTextCovers('报告', '')).toBe(false);
  });
});

describe('mergeRemoteAndLocalMessages keeps the final report on premature refresh', () => {
  beforeEach(() => {
    resetSessionState();
    appState.conversations = [];
  });

  const progress = '正在读取代码...';
  const report = '# CodeCliManager 项目分析报告\n\n最终完整报告内容';
  const streamedFull = `${progress}\n\n${report}`;

  it('premature remote (only progress + Task cards) must not drop local stream text', () => {
    const local = [
      message('user-1720000000', 'user', '分析这个项目'),
      message('stream-assistant-1720000001', 'assistant', streamedFull),
    ];
    // 子代理 Task 已落盘、但最终报告尚未写入 JSONL 的提前快照
    const remotePremature = [
      message('u1', 'user', '分析这个项目'),
      message('a1', 'assistant', progress),
      message('t1', 'tool_use', '{"name":"Task","id":"task-1"}'),
      message('t2', 'tool_result', '{"tool_use_id":"task-1"}'),
    ];

    const merged = mergeRemoteAndLocalMessages(remotePremature, local);

    // 最终报告必须仍在
    expect(merged.some((m) => m.content === streamedFull)).toBe(true);
    expect(merged.some((m) => m.role === 'assistant' && (m.content || '').includes('# CodeCliManager 项目分析报告'))).toBe(true);
  });

  it('flushed remote (report present) dedups the local stream bubble', () => {
    const local = [
      message('user-1720000000', 'user', '分析这个项目'),
      message('stream-assistant-1720000001', 'assistant', streamedFull),
    ];
    const remoteFlushed = [
      message('u1', 'user', '分析这个项目'),
      message('a1', 'assistant', progress),
      message('a2', 'assistant', report),
    ];

    const merged = mergeRemoteAndLocalMessages(remoteFlushed, local);

    expect(merged.filter((m) => m.content === report)).toHaveLength(1);
    expect(merged.some((m) => m.content === streamedFull)).toBe(false);
    // 远端已含完整报告，最终 assistant 文本只出现一次，不叠两层
    const assistants = merged.filter((m) => m.role === 'assistant');
    expect(assistants.map((m) => m.content)).toEqual([progress, report]);
  });
});

describe('commitStreamingAssistantToConversation / ensureAssistantPresent', () => {
  beforeEach(() => {
    resetSessionState();
    appState.conversations = [];
  });

  const progress = '正在读取代码...';
  const report = '# CodeCliManager 项目分析报告\n\n最终完整报告内容';
  const streamedFull = `${progress}\n\n${report}`;

  it('does not duplicate a stream bubble when remote already covers the text', () => {
    const sid = 'session-commit-1';
    updateOrAddConversation({
      id: sid,
      title: 'T',
      messages: [message('u1', 'user', 'hi'), message('a1', 'assistant', report)],
      platform: 'claude',
      project_dir: null,
      source_path: null,
      created_at: 1,
      updated_at: 1,
    });
    appState.streamingBySession.set(sid, {
      blocks: [
        { type: 'text', content: progress, finalized: true },
        { type: 'text', content: report, finalized: true },
      ],
      thinkingDone: true,
      currentBlockIdx: 1,
    });

    commitStreamingAssistantToConversation(sid);

    const conv = findConversationById(sid)!;
    expect(conv.messages.filter((m) => m.role === 'assistant')).toHaveLength(1);
    expect(conv.messages[conv.messages.length - 1].content).toBe(report);
  });

  it('grows the temporary stream bubble to the full text', () => {
    const sid = 'session-commit-2';
    updateOrAddConversation({
      id: sid,
      title: 'T',
      messages: [
        message('u1', 'user', 'hi'),
        message('stream-assistant-1', 'assistant', progress),
      ],
      platform: 'claude',
      project_dir: null,
      source_path: null,
      created_at: 1,
      updated_at: 1,
    });
    appState.streamingBySession.set(sid, {
      blocks: [
        { type: 'text', content: progress, finalized: true },
        { type: 'text', content: report, finalized: true },
      ],
      thinkingDone: true,
      currentBlockIdx: 1,
    });

    commitStreamingAssistantToConversation(sid);

    const conv = findConversationById(sid)!;
    expect(getStreamingAssistantText(sid)).toBe(streamedFull);
    expect(conv.messages[conv.messages.length - 1].content).toBe(streamedFull);
  });

  it('ensureAssistantPresent is a no-op when an assistant already covers the streamed text', () => {
    const sid = 'session-ensure-1';
    updateOrAddConversation({
      id: sid,
      title: 'T',
      messages: [message('u1', 'user', 'hi'), message('a1', 'assistant', report)],
      platform: 'claude',
      project_dir: null,
      source_path: null,
      created_at: 1,
      updated_at: 1,
    });

    ensureAssistantPresent(sid, streamedFull);

    const conv = findConversationById(sid)!;
    expect(conv.messages.filter((m) => m.role === 'assistant')).toHaveLength(1);
  });

  it('ensureAssistantPresent appends the reply when the conversation lacks it', () => {
    const sid = 'session-ensure-2';
    updateOrAddConversation({
      id: sid,
      title: 'T',
      messages: [message('u1', 'user', 'hi')],
      platform: 'claude',
      project_dir: null,
      source_path: null,
      created_at: 1,
      updated_at: 1,
    });

    ensureAssistantPresent(sid, 'hello');

    const conv = findConversationById(sid)!;
    expect(
      conv.messages.some((m) => m.role === 'assistant' && m.content === 'hello'),
    ).toBe(true);
  });
});
