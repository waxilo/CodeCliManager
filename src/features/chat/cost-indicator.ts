import { appState } from '../../state';
import type { SessionUsage } from '../../types';
import { formatTokenCount } from './context-indicator';

function getActiveUsage(): SessionUsage | null {
  const sessionId = appState.activeConversationId;
  if (!sessionId) return null;
  return appState.usageBySession.get(sessionId) || null;
}

/** 工具栏右下角的成本 / Token 消耗指示器（当前会话累计） */
export function renderCostIndicatorHtml(): string {
  const usage = getActiveUsage();
  if (!usage) return '';

  const parts: string[] = [];
  if (usage.inputTokens || usage.outputTokens) {
    parts.push(`↑${formatTokenCount(usage.inputTokens)} ↓${formatTokenCount(usage.outputTokens)}`);
  }
  if (usage.cacheRead || usage.cacheCreation) {
    parts.push(`ⓒ${formatTokenCount(usage.cacheRead + usage.cacheCreation)}`);
  }
  if (typeof usage.costUsd === 'number') {
    parts.push(`$${usage.costUsd.toFixed(4)}`);
  }
  if (parts.length === 0) return '';

  const tip = `本会话累计消耗 · ${parts.join(' · ')}`;
  return `
    <span class="cost-indicator" id="cost-indicator" title="${tip}" aria-label="${tip}">
      ${parts.join(' · ')}
    </span>`;
}

/** 增量事件 / 会话切换后刷新指示器（无用量时隐藏） */
export function updateCostIndicator(): void {
  const html = renderCostIndicatorHtml();
  const existing = document.querySelector('#cost-indicator');
  if (!html) {
    existing?.remove();
    return;
  }
  if (existing) {
    const next = document.createElement('template');
    next.innerHTML = html;
    existing.replaceWith(next.content.firstElementChild!);
    return;
  }
  // 渲染时无用量 → 指示器未创建；插到 context 环之前，保持 模型/成本/上下文/发送 的稳定顺序
  const contextSlot = document.querySelector('#context-indicator-slot');
  const ref = contextSlot || document.querySelector('.input-composer-toolbar-end');
  ref?.insertAdjacentHTML('beforebegin', html);
}
