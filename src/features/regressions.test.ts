import { describe, expect, it } from 'vitest';
import { projectRelativePath, stripFileRefsFromDisplay } from './files';
import { dedupeAdjacentDuplicateMessages } from './conversations/normalize';
import type { Message } from '../types';

function message(id: string, role: Message['role'], content: string): Message {
  return { id, role, content, timestamp: 1 };
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
