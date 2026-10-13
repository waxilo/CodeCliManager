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
  /** Anthropic 协议入口；仅在代理运行时有值 */
  baseUrl: string;
  /** OpenAI 协议入口（origin + /openai/v1）；仅在代理运行时有值 */
  openaiBaseUrl: string;
  /** 脱敏密钥（明文只在后端写入剪贴板） */
  apiKeyMasked: string;
  hasApiKey: boolean;
  model: string;
}

/** 可复制的接入内容：单字段 + 整段配置（Anthropic / OpenAI 两套协议各有一份） */
export type KiroAccessCopyKind =
  | 'base_url'
  | 'openai_base_url'
  | 'api_key'
  | 'model'
  | 'env'
  | 'json'
  | 'openai_env'
  | 'openai_json';

/**
 * 需要明文密钥才能复制的内容类型。
 *
 * 必须与后端 `kiro_access_kind_needs_key` 保持一致：地址（`base_url` /
 * `openai_base_url`）与模型不依赖密钥，在未生成密钥时也应可复制。
 * 两侧一旦漂移，用户会看到「按钮可点但点了报错」。
 */
export const KIRO_COPY_KINDS_NEEDING_KEY: readonly KiroAccessCopyKind[] = [
  'api_key',
  'env',
  'json',
  'openai_env',
  'openai_json',
];
