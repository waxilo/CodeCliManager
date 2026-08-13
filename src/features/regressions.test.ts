import { describe, expect, it, beforeEach } from 'vitest';
import { projectRelativePath, stripFileRefsFromDisplay } from './files';
import { dedupeAdjacentDuplicateMessages } from './conversations/normalize';
import { handleMessageChunk } from './chat/streaming';
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
