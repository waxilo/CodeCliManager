import { appState } from '../../state';
import { escapeHtml } from '../../utils';
export function formatTokenCount(n: number): string {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1).replace(/\.0$/, '') + 'M';
  if (n >= 1000) return Math.round(n / 1000) + 'K';
  return String(n);
}

export function getContextWindowFor(tokens: number): number {
  // 用量超过 20 万即判定启用了 1M 上下文窗口，否则按标准 20 万
  return tokens > 200_000 ? 1_000_000 : 200_000;
}

/** 右下角上下文环形指示器（参考 Claude 桌面端），悬停显示剩余空间 */
export function renderContextIndicatorInner(): string {
  const conv = appState.activeConversationId
    ? appState.conversations.find((c) => c.id === appState.activeConversationId)
    : undefined;
  const tokens = conv?.context_tokens ?? 0;
  if (!conv || tokens <= 0) return '';

  const model = conv.last_model?.trim() || '';
  const windowSize = getContextWindowFor(tokens);
  const ratio = Math.min(1, tokens / windowSize);
  const pct = Math.round(ratio * 100);
  const remaining = Math.max(0, windowSize - tokens);
  const circumference = 2 * Math.PI * 7;
  const offset = circumference * (1 - ratio);
  const level = pct >= 90 ? 'danger' : pct >= 75 ? 'warn' : 'ok';
  const tip = `${model ? model + ' · ' : ''}上下文 ${formatTokenCount(tokens)} / ${formatTokenCount(windowSize)} · 剩余 ${formatTokenCount(remaining)}（已用 ${pct}%）`;

  return `
    <div class="context-indicator context-${level}" title="${escapeHtml(tip)}" aria-label="${escapeHtml(tip)}">
      <svg class="context-ring" viewBox="0 0 18 18" width="16" height="16" aria-hidden="true">
        <circle class="context-ring-bg" cx="9" cy="9" r="7" fill="none" stroke-width="2.5"></circle>
        <circle class="context-ring-fg" cx="9" cy="9" r="7" fill="none" stroke-width="2.5"
          stroke-dasharray="${circumference.toFixed(2)}" stroke-dashoffset="${offset.toFixed(2)}"
          transform="rotate(-90 9 9)" stroke-linecap="round"></circle>
      </svg>
      <span class="context-indicator-pct">${pct}%</span>
    </div>
  `;
}

export function renderContextIndicatorHtml(): string {
  return `<div class="context-indicator-slot" id="context-indicator-slot">${renderContextIndicatorInner()}</div>`;
}

export function updateContextIndicator(): void {
  const slot = document.querySelector('#context-indicator-slot');
  if (slot) slot.innerHTML = renderContextIndicatorInner();
}

