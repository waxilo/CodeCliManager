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

/** 后端 kiro_proxy_access / kiro_reset_proxy_key 返回值：给其它 Agent 复用的接入字段 */
export interface KiroAccessData {
  running: boolean;
  /** 代理实际监听端口；未运行时为 null */
  port: number | null;
  /** 仅在代理运行时有值 */
  baseUrl: string;
  /** 脱敏密钥（明文只在后端写入剪贴板） */
  apiKeyMasked: string;
  hasApiKey: boolean;
  model: string;
}

/** 可复制的接入内容：单字段 + 整段配置 */
export type KiroAccessCopyKind = 'base_url' | 'api_key' | 'model' | 'env' | 'json';
