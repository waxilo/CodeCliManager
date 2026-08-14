/** 后端 kiro_status 返回值（字段与 Rust KiroStatus 一一对应） */
export interface KiroStatusData {
  running: boolean;
  /** 本地是否具备 Kiro（凭据/环境变量/已运行），用于决定是否展示入口 */
  available: boolean;
  /** 用户是否启用过 Kiro（prefs.enabled）。未启用时发送前跳过 Kiro 预检 */
  enabled: boolean;
  port: number | null;
  hasKey: boolean;
  authSource: string;
  expiresAt: string | null;
  profileArn: string | null;
}

/** 后端 kiro_models_state / sync / save / set_default_model 返回值 */
export interface KiroModelsStateData {
  running: boolean;
  displayModels: string[];
  customModels: string[];
  /** 展示 + 自定义合并后的候选列表 */
  models: string[];
  defaultModel: string;
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
