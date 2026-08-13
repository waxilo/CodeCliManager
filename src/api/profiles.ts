import { invoke } from '@tauri-apps/api/core';
import type {
  ApiProfilesState,
  CcSwitchImportResult,
  ClaudeCodeApiConfig,
  DeepSeekBalanceData,
  FetchedModel,
} from '../types';

export function getApiProfilesState(): Promise<ApiProfilesState> {
  return invoke<ApiProfilesState>('get_api_profiles_state');
}

export function upsertApiProfile(args: Record<string, unknown>): Promise<ApiProfilesState> {
  return invoke<ApiProfilesState>('upsert_api_profile', args);
}

export function switchApiProfile(profileId: string): Promise<void> {
  return invoke('switch_api_profile', { profileId });
}

export function deleteApiProfile(profileId: string): Promise<void> {
  return invoke('delete_api_profile', { profileId });
}

export function importCcSwitchProfiles(): Promise<CcSwitchImportResult> {
  return invoke<CcSwitchImportResult>('import_cc_switch_profiles');
}

export function getApiProfileKeyMasked(profileId: string): Promise<string> {
  return invoke<string>('get_api_profile_key_masked', { profileId });
}

export function copyApiProfileKey(profileId: string): Promise<boolean> {
  return invoke<boolean>('copy_api_profile_key', { profileId });
}

export function getApiProfileConfig(profileId: string): Promise<ClaudeCodeApiConfig> {
  return invoke<ClaudeCodeApiConfig>('get_api_profile_config', { profileId });
}

export function setActiveDefaultModel(model: string): Promise<ClaudeCodeApiConfig> {
  return invoke<ClaudeCodeApiConfig>('set_active_default_model', { model });
}

export function useOfficialApi(): Promise<void> {
  return invoke('use_official_api');
}

export function getClaudeApiConfig(): Promise<ClaudeCodeApiConfig> {
  return invoke<ClaudeCodeApiConfig>('get_claude_api_config');
}

export function fetchApiModels(args: {
  baseUrl: string;
  apiKey?: string | null;
  profileId?: string | null;
}): Promise<FetchedModel[]> {
  return invoke<FetchedModel[]>('fetch_api_models', args);
}

export function fetchDeepseekBalance(args: {
  baseUrl?: string | null;
  apiKey?: string | null;
  profileId?: string | null;
}): Promise<DeepSeekBalanceData> {
  return invoke<DeepSeekBalanceData>('fetch_deepseek_balance', args);
}
