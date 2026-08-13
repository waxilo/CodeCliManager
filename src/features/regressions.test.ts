import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { projectRelativePath, stripFileRefsFromDisplay } from './files';
import {
  dedupeAdjacentDuplicateMessages,
  normalizeSessionEventPayload,
  updateOrAddConversation,
  findConversationById,
  mergeRemoteAndLocalMessages,
} from './conversations/normalize';
import { handleMessageChunk, purgeTerminalTools, reconcileActiveToolsWithHistory } from './chat/streaming';
import { showConfirmDialog } from '../ui/confirm-dialog';
import { appState } from '../state';
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
