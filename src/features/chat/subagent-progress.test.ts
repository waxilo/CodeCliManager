import { describe, expect, it, beforeEach } from 'vitest';
import { appState } from '../../state';
import { syncSubagentProgressUI, renderSubagentTabContent } from './subagent-progress';
import { flushHighlighting } from '../../markdown';
import type { Conversation } from '../../types';
import {
  renderSidebarTabsHtml,
  resetSidebarTabState,
  getActiveSidebarTab,
  setActiveSidebarTab,
} from '../sidebar/sidebar-tabs';

/** 构建带页签条 + 角标 + 内容容器的侧栏 fixture */
function buildSidebar(): void {
  document.body.innerHTML = `
    <div class="app-container">
      <div class="sidebar is-workspace">
        ${renderSidebarTabsHtml()}
        <div class="conversation-list" id="conversation-list"></div>
      </div>
    </div>
  `;
}

function addRunningTask(): void {
  appState.activeToolsBySession.set(
    'conv-1',
    new Map([
      [
        't1',
        {
          toolUseId: 't1',
          toolName: 'Task',
          input: { description: '子任务' },
          status: 'running',
          isError: false,
          startedAt: 1_000,
        },
      ],
    ]),
  );
}

describe('子代理进度同步（右侧面板已移除，改为侧栏「子代理」tab）', () => {
  beforeEach(() => {
    localStorage.clear();
    resetSidebarTabState();
    document.body.innerHTML = '';
    appState.activeToolsBySession.clear();
    appState.activeConversationId = 'conv-1';
  });

  it('0→n：自动切到「子代理」tab、更新角标、渲染行内容', () => {
    buildSidebar();
    addRunningTask();

    syncSubagentProgressUI();

    expect(getActiveSidebarTab()).toBe('subagents');
    const badge = document.querySelector('#subagent-tab-badge') as HTMLElement;
    expect(badge.hidden).toBe(false);
    expect(badge.textContent).toBe('1');
    expect(document.querySelector('.subagent-desc')?.textContent).toContain('子任务');
  });

  it('n→0：切回自动切换前的 tab（活跃会话）', () => {
    buildSidebar();
    addRunningTask();
    syncSubagentProgressUI();
    expect(getActiveSidebarTab()).toBe('subagents');

    appState.activeToolsBySession.clear();
    syncSubagentProgressUI();

    expect(getActiveSidebarTab()).toBe('active');
    const badge = document.querySelector('#subagent-tab-badge') as HTMLElement;
    expect(badge.hidden).toBe(true);
  });

  it('无子代理时不做任何切换', () => {
    buildSidebar();

    syncSubagentProgressUI();

    expect(getActiveSidebarTab()).toBe('active');
    expect(
      (document.querySelector('#subagent-tab-badge') as HTMLElement).hidden,
    ).toBe(true);

    // 手动停在子代理 tab 时无任务 → 渲染子代理空态（不切换、不清内容）
    setActiveSidebarTab('subagents');
    appState.activeToolsBySession.clear();
    syncSubagentProgressUI();
    expect(getActiveSidebarTab()).toBe('subagents');
    expect(document.querySelector('.sidebar-empty')?.textContent).toContain('暂无子代理');
  });

  it('运行中手动切回活跃会话，结束后不被打回子代理', () => {
    buildSidebar();
    addRunningTask();
    syncSubagentProgressUI();
    expect(getActiveSidebarTab()).toBe('subagents');

    // 用户手动切到活跃会话（persist=true 打断自动恢复）
    setActiveSidebarTab('active');

    appState.activeToolsBySession.clear();
    syncSubagentProgressUI();

    // 手动切换已打断恢复记录 → 结束仍停在活跃会话
    expect(getActiveSidebarTab()).toBe('active');
  });
});

describe('子代理 tab：从会话历史回退展示', () => {
  function convWithAgentTasks(): Conversation {
    return {
      id: 'conv-hist',
      title: '历史会话',
      messages: [
        {
          id: 'm-tu-a',
          role: 'tool_use',
          content:
            '{"type":"tool_use","id":"toolu_a","name":"Agent","input":{"description":"子代理A","subagent_type":"general-purpose"}}',
          timestamp: 1,
        },
        {
          id: 'm-tr-a',
          role: 'tool_result',
          content: '{"type":"tool_result","tool_use_id":"toolu_a","content":"完成"}',
          timestamp: 2,
        },
        {
          id: 'm-tu-b',
          role: 'tool_use',
          content:
            '{"type":"tool_use","id":"toolu_b","name":"Agent","input":{"description":"子代理B","subagent_type":"general-purpose"}}',
          timestamp: 3,
        },
        {
          id: 'm-tr-b',
          role: 'tool_result',
          content:
            '{"type":"tool_result","tool_use_id":"toolu_b","is_error":true,"content":"失败"}',
          timestamp: 4,
        },
      ],
      platform: 'claude',
      project_dir: '/proj',
      created_at: 1,
      updated_at: 2,
    };
  }

  beforeEach(() => {
    localStorage.clear();
    resetSidebarTabState();
    appState.conversations = [];
    appState.activeToolsBySession.clear();
    appState.runningSessions.clear();
    appState.activeConversationId = '';
    appState.activeConversationSourcePath = null;
  });

  it('会话从磁盘加载（无实时进度）时，展示历史中的 Agent 子代理与完成状态', () => {
    appState.conversations = [convWithAgentTasks()];
    appState.activeConversationId = 'conv-hist';

    const html = renderSubagentTabContent();

    expect(html).toContain('子代理A');
    expect(html).toContain('子代理B');
    // 1 成功 1 失败，无运行中 → 「子代理完成 · 1/2（1 失败）」
    expect(html).toContain('子代理完成 · 1/2（1 失败）');
    expect(html).toContain('data-tool-use-id="toolu_a"');
    expect(html).toContain('data-tool-use-id="toolu_b"');
  });

  it('历史中无子代理调用时展示空态', () => {
    appState.conversations = [
      {
        id: 'conv-empty',
        title: 'x',
        messages: [{ id: 'm1', role: 'user', content: 'hi', timestamp: 1 }],
        platform: 'claude',
        project_dir: null,
        created_at: 1,
        updated_at: 1,
      },
    ];
    appState.activeConversationId = 'conv-empty';

    expect(renderSubagentTabContent()).toContain('暂无子代理');
  });

  it('实时进度存在时优先展示实时状态（不读历史）', () => {
    appState.conversations = [convWithAgentTasks()];
    appState.activeConversationId = 'conv-hist';
    // 实时：1 个进行中的 Task（历史里没有该 toolUseId）
    appState.activeToolsBySession.set(
      'conv-hist',
      new Map([
        [
          'toolu_live',
          {
            toolUseId: 'toolu_live',
            toolName: 'Task',
            input: { description: '实时子代理' },
            status: 'running',
            startedAt: 1_000,
          },
        ],
      ]),
    );

    const html = renderSubagentTabContent();

    expect(html).toContain('实时子代理');
    // 历史里的已结束子代理不在此展示（避免与消息流工具卡重复）
    expect(html).not.toContain('子代理A');
    expect(html).not.toContain('子代理B');
  });

  it('history 合并 taskNotification 时展示完成状态，报告可点击展开', () => {
    appState.conversations = [
      {
        id: 'conv-report',
        title: '报告会话',
        messages: [
          {
            id: 'm-tu-report',
            role: 'tool_use',
            content: JSON.stringify({
              name: 'Agent',
              tool_name: 'Agent',
              input: { description: '子代理A' },
              id: 'toolu_report',
              taskNotification: {
                tool_use_id: 'toolu_report',
                status: 'completed',
                summary: 'Agent "子代理A" finished',
                result: '## 报告正文\n\n这里是要看的输出。',
                total_tokens: 100,
                tool_uses: 3,
                duration_ms: 5000,
              },
            }),
            timestamp: 1,
          },
        ],
        platform: 'claude',
        project_dir: null,
        created_at: 1,
        updated_at: 1,
      },
    ];
    appState.activeConversationId = 'conv-report';

    const html = renderSubagentTabContent();

    expect(html).toContain('子代理A');
    expect(html).toContain('完成'); // 状态来自 taskNotification 权威终态
    expect(html).toContain('data-tool-use-id="toolu_report"');
    // 报告以 <details> 展开 + Markdown 渲染正文 + 用量元信息
    expect(html).toContain('<details class="subagent-item"');
    expect(html).toContain('报告正文');
    expect(html).toContain('100 tokens');
    expect(html).toContain('3 次工具');
    // summary 不再是无消费字段：渲染为报告头部来源行（引号经 escapeHtml 转义）
    expect(html).toContain('subagent-report-summary');
    expect(html).toContain('Agent &quot;子代理A&quot; finished');
  });

  it('报告内代码块经 refreshActiveTabContent 接入延迟高亮', () => {
    buildSidebar();
    appState.conversations = [
      {
        id: 'conv-hl',
        title: 'x',
        messages: [
          {
            id: 'm-tu-hl',
            role: 'tool_use',
            content: JSON.stringify({
              name: 'Agent',
              input: { description: '子代理' },
              id: 'toolu_hl',
              taskNotification: {
                tool_use_id: 'toolu_hl',
                status: 'completed',
                summary: 'Agent "子代理" finished',
                result: '```ts\nconst a = 1;\n```',
                total_tokens: 10,
              },
            }),
            timestamp: 1,
          },
        ],
        platform: 'claude',
        project_dir: null,
        created_at: 1,
        updated_at: 1,
      },
    ];
    appState.activeConversationId = 'conv-hl';
    setActiveSidebarTab('subagents'); // 触发 refreshActiveTabContent → scheduleHighlighting
    flushHighlighting();

    // highlightBlock 已删除 data-hl-lang 占位标记，只留 hlDone 标记与 hljs span
    const code = document.querySelector<HTMLElement>('.subagent-report code');
    expect(code).toBeTruthy();
    expect(code?.dataset.hlDone).toBe('1');
    expect(code?.innerHTML).toContain('hljs-'); // hljs 已补上 token span
  });

  it('历史 Agent 无 taskNotification 且无 result 时退化为普通行，不渲染展开器', () => {
    appState.conversations = [
      {
        id: 'conv-plain',
        title: 'x',
        messages: [
          {
            id: 'm-tu-plain',
            role: 'tool_use',
            content: JSON.stringify({
              name: 'Agent',
              tool_name: 'Agent',
              input: { description: '仅启动的子代理' },
              id: 'toolu_plain',
            }),
            timestamp: 1,
          },
        ],
        platform: 'claude',
        project_dir: null,
        created_at: 1,
        updated_at: 1,
      },
    ];
    appState.activeConversationId = 'conv-plain';

    const html = renderSubagentTabContent();

    expect(html).toContain('仅启动的子代理');
    expect(html).not.toContain('<details');
  });
});
