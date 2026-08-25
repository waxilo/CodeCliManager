import { formatDuration } from '../../utils';
import { formatTokenCount } from './context-indicator';

/**
 * 统一构建子代理用量摘要文案（tokens · 次数 · 耗时），例如
 * `1.2K tokens · 3 次工具 · 5.0s`。
 *
 * 完成卡（taskNotification）、实时进度卡（tool.progress）与输入框上方进度条
 * 共用，保证同一子代理无论出现在哪个位置用量格式都一致；token 统一走紧凑格式。
 * 无任何可展示用量时返回空串（调用方据此跳过渲染）。
 */
export function formatSubagentUsage(usage: {
  totalTokens?: number;
  toolUses?: number;
  durationMs?: number;
}): string {
  const parts: string[] = [];
  if (usage.totalTokens) parts.push(`${formatTokenCount(usage.totalTokens)} tokens`);
  if (usage.toolUses) parts.push(`${usage.toolUses} 次工具`);
  if (usage.durationMs) parts.push(formatDuration(usage.durationMs));
  return parts.join(' · ');
}
