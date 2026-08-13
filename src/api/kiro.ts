import { invoke } from '@tauri-apps/api/core';
import type { KiroModelsStateData, KiroStatusData, KiroUsageData } from '../types';

export function kiroStatus(): Promise<KiroStatusData> {
  return invoke<KiroStatusData>('kiro_status');
}

export function kiroUsage(): Promise<KiroUsageData> {
  return invoke<KiroUsageData>('kiro_usage');
}

export function kiroRefreshToken(): Promise<KiroStatusData> {
  return invoke<KiroStatusData>('kiro_refresh_token');
}

export function kiroStart(port: number | null = null): Promise<KiroStatusData> {
  return invoke<KiroStatusData>('kiro_start', { port });
}

export function kiroStop(): Promise<KiroStatusData> {
  return invoke<KiroStatusData>('kiro_stop');
}

export function kiroModelsState(): Promise<KiroModelsStateData> {
  return invoke<KiroModelsStateData>('kiro_models_state');
}

export function kiroSyncModels(): Promise<KiroModelsStateData> {
  return invoke<KiroModelsStateData>('kiro_sync_models');
}

export function kiroSaveModelsConfig(config: {
  displayModels: string[];
  customModels: string[];
  defaultModel?: string | null;
}): Promise<KiroModelsStateData> {
  return invoke<KiroModelsStateData>('kiro_save_models_config', { config });
}

export function kiroSetDefaultModel(model: string): Promise<KiroModelsStateData> {
  return invoke<KiroModelsStateData>('kiro_set_default_model', { model });
}

/** 发送前确认已启用的 Kiro 代理与凭据可用，必要时自动恢复。 */
export function kiroPrepareSend(): Promise<KiroStatusData> {
  return invoke<KiroStatusData>('kiro_prepare_send');
}
