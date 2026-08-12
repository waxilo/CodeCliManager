/** 后端 kiro_status 返回值（字段与 Rust KiroStatus 一一对应） */
export interface KiroStatusData {
  running: boolean;
  port: number | null;
  hasKey: boolean;
  authSource: string;
  expiresAt: string | null;
  profileArn: string | null;
}

/** 后端 kiro_usage 返回值 */
export interface KiroUsageData {
  subscriptionTitle: string | null;
  subscriptionType: string | null;
  currentUsage: number;
  usageLimit: number;
  remaining: number;
  percentUsed: number;
  nextResetAt: string | null;
  daysUntilReset: number | null;
  overageStatus: string | null;
  currency: string | null;
  email: string | null;
}
