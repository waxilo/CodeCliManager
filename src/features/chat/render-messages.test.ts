import { describe, expect, it } from 'vitest';
import { processToolMessages, filterVisibleMessages, renderToolMessageHtml, renderMessageListHtml, parseErrorHint } from './render-messages';
import type { Message, TaskNotificationData } from '../../types';

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

  it('filterVisibleMessages 兜底过滤 <task-notification> 内部回执', () => {
    const out = filterVisibleMessages([
      {
        id: 'tn1',
        role: 'user',
        content:
          '<task-notification>\n<task-id>abc</task-id>\n<tool-use-id>call_1</tool-use-id>\n<status>completed</status>\n</task-notification>',
        timestamp: 1,
      },
      { id: 'a1', role: 'assistant', content: '答复', timestamp: 2 },
    ]);
    expect(out.map((m) => m.role)).toEqual(['assistant']);
  });

  it('Agent tool_use 保留并携带 history 合并的 taskNotification（报告/状态/用量）', () => {
    const msgs: Message[] = [
      {
        id: 'tu-agent',
        role: 'tool_use',
        content: JSON.stringify({
          name: 'Agent',
          tool_name: 'Agent',
          input: { description: '审查 UI', subagent_type: 'general-purpose' },
          id: 'call_04_1',
          taskNotification: {
            tool_use_id: 'call_04_1',
            status: 'completed',
            summary: 'Agent "审查 UI" finished',
            result: '## 报告\n\n正文',
            total_tokens: 100,
            tool_uses: 3,
            duration_ms: 5000,
          },
        }),
        timestamp: 1,
      },
    ];
    const out = processToolMessages(msgs);
    expect(out).toHaveLength(1);
    const td = out[0].toolData;
    expect(td?.toolName).toBe('Agent');
    expect(td?.toolUseId).toBe('call_04_1');
    expect(td?.taskNotification?.status).toBe('completed');
    expect(td?.taskNotification?.result).toContain('报告');
    expect(td?.taskNotification?.total_tokens).toBe(100);
    expect(td?.taskNotification?.duration_ms).toBe(5000);
  });
});

describe('renderToolMessageHtml Subagent 卡（taskNotification 分支）', () => {
  function toolMsg(taskNotification: TaskNotificationData | undefined): Message {
    return {
      id: 'tu-1',
      role: 'tool',
      content: '',
      timestamp: 1,
      toolData: {
        toolName: 'Agent',
        toolInput: { description: '审查 UI' },
        toolUseId: 'call_04_1',
        displayMode: 'collapsible',
        colorScheme: { border: '#a371f7', icon: '#a371f7', primary: '#a371f7' },
        taskNotification,
      },
    };
  }

  it('已完成 + 有报告：终态完成徽标、用量 meta、报告 Markdown 且默认展开', () => {
    const html = renderToolMessageHtml(
      toolMsg({
        tool_use_id: 'call_04_1',
        status: 'completed',
        summary: 'Agent "审查 UI" finished',
        result: '## 报告\n\n正文',
        total_tokens: 100,
        tool_uses: 3,
        duration_ms: 5000,
      }),
    );

    // 状态来自 taskNotification 权威终态，而非被丢弃的 tool_result（否则误判「运行中」）
    expect(html).toContain('tool-status-done');
    expect(html).toContain('>完成</span>');
    expect(html).not.toContain('tool-status-running');
    // 头部用量元信息 + 标题
    expect(html).toContain('100 tokens · 3 次工具 · 5.0s');
    expect(html).toContain('审查 UI');
    // 报告 Markdown 渲染但默认收起（非主要内容不抢占主视野，点击展开查看）
    expect(html).toContain('<details class="tool-collapsible">');
    expect(html).not.toContain('<details class="tool-collapsible" open');
    expect(html).toContain('markdown-body');
    expect(html).toContain('<p>正文</p>');
  });

  it('失败状态渲染失败徽标；无报告时不展开并显示空态占位', () => {
    const html = renderToolMessageHtml(
      toolMsg({ tool_use_id: 'call_04_1', status: 'error', total_tokens: 0 }),
    );

    expect(html).toContain('tool-status-error');
    expect(html).toContain('>失败</span>');
    expect(html).not.toContain(' open');
    expect(html).toContain('tool-subagent-empty');
    expect(html).not.toContain('100 tokens'); // 用量为 0 不显示 meta
  });
});

describe('renderMessageListHtml 全流程：真实 81f4d1ee 数据形态的 Agent 子代理卡', () => {
  // 复刻 Rust parse_claude_session 对会话 81f4d1ee 的输出形态：
  // 5 条 Agent tool_use（content 内嵌 taskNotification，tool_result 被导入层丢弃）。
  // 历史渲染不展示子代理卡（Task/Agent 一律不渲染，避免收起横线占满历史界面）；
  // 子代理调用过程与结果由实时卡与对话文本承载。
  function realSessionMessages(): Message[] {
    const user: Message = { id: 'u1', role: 'user', content: '审查项目', timestamp: 1 };
    const agent = (call: string, desc: string, report: string): Message => ({
      id: `tu-${call}`,
      role: 'tool_use',
      content: JSON.stringify({
        name: 'Agent',
        tool_name: 'Agent',
        input: { description: desc, subagent_type: 'general-purpose', prompt: `长 prompt ${desc}` },
        id: call,
        taskNotification: {
          tool_use_id: call,
          status: 'completed',
          summary: `Agent "${desc}" finished`,
          result: report,
          total_tokens: 100,
          tool_uses: 3,
          duration_ms: 5000,
        },
      }),
      timestamp: 1,
    });
    const assistant: Message = { id: 'a1', role: 'assistant', content: '审查完成，报告如下', timestamp: 1 };
    return [
      user,
      agent('call_00_YGQOELetYqhM5guoxD0m2172', '审查前端工程与架构', '## 报告一\n\n前端审查正文'),
      agent('call_01_kVb40HZR4AdMgNXUBg7b8946', '审查 Rust 后端工程与安全', '## 报告二\n\n后端审查正文'),
      agent('call_02_jPUwGLTpEcu6YYG6nCqE8182', '审查功能正确性与边界', '## 报告三\n\n功能审查正文'),
      agent('call_03_NW21Hv9euZ86U7Ge3wLK4700', '审查兼容性与构建发布', '## 报告四\n\n兼容性审查正文'),
      agent('call_04_WK4xGAr2L1NVRrBZNAaO9561', '审查 UI/UX 与可访问性', '## 报告五\n\nUI 审查正文'),
      assistant,
    ];
  }

  it('历史会话不渲染子代理卡：5 条 Agent tool_use 全部不展示（含通知/结果）', () => {
    const html = renderMessageListHtml(realSessionMessages());
    // 子代理卡（含报告）不进入历史渲染，避免一排收起横线
    expect(html.match(/subagent-task-card/g) || []).toHaveLength(0);
    expect(html).not.toContain('call_00_YGQOELetYqhM5guoxD0m2172');
    expect(html).not.toContain('call_04_WK4xGAr2L1NVRrBZNAaO9561');
    expect(html).not.toContain('tool-status-running');
    // 对话文本保留
    expect(html).toContain('审查完成，报告如下');
  });

  it('历史会话不渲染子代理卡：即使有 tool_result 或 taskNotification 也不展示', () => {
    const msgs = realSessionMessages();
    // 给 call_04 补一个真实 tool_result（有数据 → 子代理卡仍不渲染）
    msgs.splice(6, 0, {
      id: 'tr-04',
      role: 'tool_result',
      content: JSON.stringify({
        content: '## 报告\n\nUI 审查正文',
        tool_use_id: 'call_04_WK4xGAr2L1NVRrBZNAaO9561',
        is_error: false,
      }),
      timestamp: 1,
    });
    const html = renderMessageListHtml(msgs);
    expect(html.match(/subagent-task-card/g) || []).toHaveLength(0);
    expect(html).not.toContain('call_04_WK4xGAr2L1NVRrBZNAaO9561');
    expect(html).not.toContain('>完成</span>');
    // 其他工具（如 AskUserQuestion / TodoWrite）不受影响
  });
});

describe('错误提示友好化 parseErrorHint', () => {
  it('502 Improperly formed request → 提示推理网关拒绝并给出处理建议', () => {
    const res = parseErrorHint(
      'API Error: 502 Improperly formed request. This is a server-side issue, usually temporary — try again in a moment. If it persists, check your inference gateway (127.0.0.1:5050).',
    );
    expect(res.isKnown).toBe(true);
    expect(res.hint).toContain('推理网关');
    expect(res.hint).toContain('502');
    expect(res.hint).toContain('切换模型');
  });

  it('[ede_diagnostic] → 提示本轮没有生成有效内容', () => {
    const res = parseErrorHint(
      '[ede_diagnostic] result_type=user last_content_type=n/a stop_reason=null',
    );
    expect(res.isKnown).toBe(true);
    expect(res.hint).toContain('没有生成有效内容');
  });

  it('合并内容（502 + ede_diagnostic）优先按真实 API 错误提示', () => {
    const res = parseErrorHint(
      'API Error: 502 Improperly formed request. try again in a moment.\n' +
        '[ede_diagnostic] result_type=user last_content_type=n/a stop_reason=null',
    );
    expect(res.isKnown).toBe(true);
    expect(res.hint).toContain('推理网关');
    expect(res.hint).toContain('502');
  });

  it('提取报文里的实际网关地址，而非硬编码 5050', () => {
    const res = parseErrorHint(
      'API Error: 502 Improperly formed request. check your inference gateway (127.0.0.1:59999).',
    );
    expect(res.hint).toContain('127.0.0.1:59999');
    expect(res.hint).not.toContain('5050');
  });

  it('通用 API Error 取首行作为提示', () => {
    const res = parseErrorHint('API Error: 上游超时\n更多细节');
    expect(res.isKnown).toBe(true);
    expect(res.hint).toBe('上游超时');
  });

  it('无法识别的普通错误原样返回', () => {
    const res = parseErrorHint('shell failed');
    expect(res.isKnown).toBe(false);
    expect(res.hint).toBe('shell failed');
  });

  it('空内容返回默认提示', () => {
    const res = parseErrorHint('');
    expect(res.isKnown).toBe(true);
    expect(res.hint).toContain('模型调用失败');
  });
});
