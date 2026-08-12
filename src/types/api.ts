export interface ClaudeCodeApiConfig {
  baseUrl: string;
  hasApiKey: boolean;
  defaultModel: string;
  haikuModel: string;
  sonnetModel: string;
  opusModel: string;
  displayModels?: string[];
  customModels?: string[];
  configPath: string;
}

export interface ApiProfileItem {
  id: string;
  name: string;
  baseUrl: string;
  defaultModel: string;
  hasApiKey: boolean;
  isActive: boolean;
}

export interface ApiProfilesState {
  activeProfileId: string | null;
  profiles: ApiProfileItem[];
  current: ClaudeCodeApiConfig;
}

export interface CcSwitchImportResult {
  importedCount: number;
  skippedCount: number;
  skippedNames: string[];
  ccSwitchPath: string;
  state: ApiProfilesState;
}

export interface FetchedModel {
  id: string;
  ownedBy?: string | null;
}

/** 后端 fetch_deepseek_balance 返回值 */
export interface DeepSeekBalanceData {
  isAvailable: boolean;
  currency: string;
  totalBalance: string;
  grantedBalance: string;
  toppedUpBalance: string;
}
