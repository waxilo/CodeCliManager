import type { ApiProfileItem, DeepSeekBalanceData, KiroUsageData } from '../../types';
export function formatKiroExpiry(expiresAt: string | null): string {
  if (!expiresAt) return '—';
  const ms = Date.parse(expiresAt);
  if (Number.isNaN(ms)) return expiresAt;
  const remaining = ms - Date.now();
  if (remaining <= 0) return '已过期';
  const minutes = Math.floor(remaining / 60000);
  if (minutes < 60) return `${minutes} 分钟后`;
  const hours = Math.floor(minutes / 60);
  const leftMin = minutes % 60;
  return `${hours} 小时${leftMin > 0 ? ` ${leftMin} 分` : ''}后`;
}

export function isDeepSeekBaseUrl(baseUrl: string): boolean {
  return baseUrl.trim().toLowerCase().includes('deepseek.com');
}

export function formatUsageNumber(value: number): string {
  if (!Number.isFinite(value)) return '0';
  if (Number.isInteger(value)) return String(value);
  return value.toFixed(2).replace(/\.?0+$/, '');
}

export function formatKiroUsageText(usage: KiroUsageData): string {
  const used = formatUsageNumber(usage.currentUsage);
  const limit = formatUsageNumber(usage.usageLimit);
  const remaining = formatUsageNumber(usage.remaining);
  const percent = Number.isFinite(usage.percentUsed) ? usage.percentUsed.toFixed(1) : '0.0';
  const plan = usage.subscriptionTitle ? `${usage.subscriptionTitle} · ` : '';
  let text = `${plan}${used} / ${limit}（剩余 ${remaining}，${percent}%）`;

  const resetTs = usage.nextResetAt ? Date.parse(usage.nextResetAt) : Number.NaN;
  const hasResetTs = !Number.isNaN(resetTs);
  let days = usage.daysUntilReset;
  // 上游常给 daysUntilReset=0，若还有未来的重置时间则按日期重算
  if (hasResetTs) {
    const computed = Math.max(0, Math.ceil((resetTs - Date.now()) / 86_400_000));
    if (days == null || (days <= 0 && computed > 0)) {
      days = computed;
    }
  }

  if (days != null && days > 0) {
    text += ` · ${days} 天后重置`;
    if (hasResetTs) {
      text += `（${new Date(resetTs).toLocaleDateString()}）`;
    }
  } else if (hasResetTs && resetTs > Date.now()) {
    text += ` · 重置 ${new Date(resetTs).toLocaleDateString()}`;
  } else if (days === 0 || (hasResetTs && resetTs <= Date.now())) {
    text += ' · 今天重置';
  }
  return text;
}

export function formatDeepSeekBalanceText(balance: DeepSeekBalanceData): string {
  const avail = balance.isAvailable ? '可用' : '不足';
  return `${balance.totalBalance} ${balance.currency}（赠送 ${balance.grantedBalance} / 充值 ${balance.toppedUpBalance} · ${avail}）`;
}

export function isKiroProfile(profile: ApiProfileItem | undefined): boolean {
  return Boolean(profile && profile.name === 'Kiro');
}

