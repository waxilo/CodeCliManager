import { describe, expect, it } from 'vitest';
import { processToolMessages } from './render-messages';
import type { Message } from '../../types';

function toolUse(id: string | undefined, name: string, input: Record<string, unknown>): Message {
  const obj: Record<string, unknown> = { name, input };
  if (id) obj.id = id;
  return { id: `tu-${id ?? 'anon'}`, role: 'tool_use', content: JSON.stringify(obj), timestamp: 1 };
}

function toolResult(toolUseId: string | undefined, content: string, extra?: Record<string, unknown>): Message {
  const obj: Record<string, unknown> = { content };
  if (toolUseId) obj.tool_use_id = toolUseId;
  if (extra) Object.assign(obj, extra);
  return { id: `tr-${toolUseId ?? 'anon'}`, role: 'tool_result', content: JSON.stringify(obj), timestamp: 1 };
}

describe('processToolMessages 单遍配对', () => {
  it('带 id 的 tool_use 配到同 id 的 tool_result，输出为合并工具消息', () => {
    const msgs = [
      toolUse('bash-1', 'Bash', { command: 'ls' }),
      toolResult('bash-1', 'file.txt'),
    ];
    const out = processToolMessages(msgs);
    expect(out).toHaveLength(1);
    expect(out[0].role).toBe('tool');
    expect(out[0].toolData?.toolName).toBe('Bash');
    expect(out[0].toolData?.toolUseId).toBe('bash-1');
    expect(out[0].toolData?.toolResult).toBe('file.txt');
    expect(out[0].toolData?.isError).toBe(false);
  });

  it('同 id 多对连续配对按流顺序一一对应', () => {
    const msgs = [
      toolUse('r1', 'Read', { file_path: 'a' }),
      toolUse('r2', 'Read', { file_path: 'b' }),
      toolResult('r1', 'A content'),
      toolResult('r2', 'B content'),
    ];
    const out = processToolMessages(msgs);
    expect(out).toHaveLength(2);
    expect(out[0].toolData?.toolResult).toBe('A content');
    expect(out[0].toolData?.toolUseId).toBe('r1');
    expect(out[1].toolData?.toolResult).toBe('B content');
    expect(out[1].toolData?.toolUseId).toBe('r2');
  });

  it('同 id 连续 tool_use 时结果按序配给最早者，后者无结果', () => {
    const msgs = [
      toolUse('x', 'Bash', { command: '1' }),
      toolUse('x', 'Bash', { command: '2' }),
      toolResult('x', 'out'),
    ];
    const out = processToolMessages(msgs);
    expect(out).toHaveLength(2);
    expect(out[0].toolData?.toolResult).toBe('out');
    expect(out[1].toolData?.toolResult).toBeUndefined();
  });

  it('无 id 的 tool_use 可配带 id 的结果（原 !toolUseId 语义，取最早）', () => {
    const msgs = [
      toolUse(undefined, 'Bash', { command: 'ls' }),
      toolUse('x', 'Read', { file_path: 'a' }),
      toolResult('x', 'out'),
    ];
    const out = processToolMessages(msgs);
    expect(out).toHaveLength(2);
    // 最早的无 id tool_use 优先拿到结果
    expect(out[0].toolData?.toolResult).toBe('out');
    expect(out[0].toolData?.toolUseId).toBeUndefined();
    expect(out[1].toolData?.toolResult).toBeUndefined();
  });

  it('无 id 的 tool_result 配最早未配对的 tool_use（任意 id）', () => {
    const msgs = [
      toolUse('r1', 'Read', { file_path: 'a' }),
      toolUse('r2', 'Read', { file_path: 'b' }),
      toolResult(undefined, 'out'),
    ];
    const out = processToolMessages(msgs);
    expect(out).toHaveLength(2);
    expect(out[0].toolData?.toolResult).toBe('out');
    expect(out[0].toolData?.toolUseId).toBe('r1');
    expect(out[1].toolData?.toolResult).toBeUndefined();
  });

  it('AskUserQuestion 把 answers 并入 toolInput', () => {
    const questions = [{ question: '继续吗', options: ['是', '否'] }];
    const msgs = [
      toolUse('ask-1', 'AskUserQuestion', { questions }),
      toolResult('ask-1', '', {
        toolUseResult: { answers: { '继续吗': '是' }, questions },
      }),
    ];
    const out = processToolMessages(msgs);
    expect(out).toHaveLength(1);
    expect(out[0].toolData?.toolInput?.answers).toEqual({ '继续吗': '是' });
    expect(out[0].toolData?.toolInput?.questions).toEqual(questions);
  });

  it('孤立 tool_result 被跳过，普通消息保序保留', () => {
    const msgs = [
      { id: 'u1', role: 'user' as const, content: 'hi', timestamp: 1 },
      toolResult('missing', 'orphan'),
      { id: 'a1', role: 'assistant' as const, content: 'hello', timestamp: 1 },
    ];
    const out = processToolMessages(msgs);
    expect(out.map((m) => m.role)).toEqual(['user', 'assistant']);
  });
});
