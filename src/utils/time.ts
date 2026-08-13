/** 把后端时间戳（秒或毫秒）统一为毫秒 */
export function toMillis(ts: number | null | undefined): number {
  if (!ts) return 0;
  // 小于 1e12 视为秒级时间戳
  return ts < 1e12 ? ts * 1000 : ts;
}

/** 相对时间（完整版，用于项目卡片元信息） */
export function formatRelativeTime(ts: number | null | undefined): string {
  const ms = toMillis(ts);
  if (!ms) return '';

  const diff = Date.now() - ms;
  if (diff < 60_000) return '刚刚';
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} 分钟前`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)} 小时前`;
  if (diff < 172_800_000) return '昨天';
  if (diff < 604_800_000) return `${Math.floor(diff / 86_400_000)} 天前`;

  const date = new Date(ms);
  const sameYear = date.getFullYear() === new Date().getFullYear();
  const md = `${date.getMonth() + 1}/${date.getDate()}`;
  return sameYear ? md : `${date.getFullYear()}/${md}`;
}

/** 极简时间（用于会话行右侧，尽量少占宽度） */
export function formatCompactTime(ts: number | null | undefined): string {
  const ms = toMillis(ts);
  if (!ms) return '';

  const diff = Date.now() - ms;
  if (diff < 60_000) return '刚刚';
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}分`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}时`;
  if (diff < 172_800_000) return '昨天';
  if (diff < 604_800_000) return `${Math.floor(diff / 86_400_000)}天`;

  const date = new Date(ms);
  return `${date.getMonth() + 1}/${date.getDate()}`;
}

export function formatTime(timestamp: number): string {
  const date = new Date(toMillis(timestamp));
  return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}
