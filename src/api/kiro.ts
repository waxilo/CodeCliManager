import { invoke } from '@tauri-apps/api/core';
import type { KiroModelsStateData, KiroStatusData, KiroUsageData } from '../types';

let statusRequest: Promise<KiroStatusData> | null = null;
let usageRequest: Promise<KiroUsageData> | null = null;
let modelsStateRequest: Promise<KiroModelsStateData> | null = null;

export function kiroStatus(): Promise<KiroStatusData> {
  if (statusRequest) return statusRequest;
  statusRequest = invoke<KiroStatusData>('kiro_status').finally(() => {
    statusRequest = null;
  });
  return statusRequest;
}

export function kiroUsage(): Promise<KiroUsageData> {
  if (usageRequest) return usageRequest;
  usageRequest = invoke<KiroUsageData>('kiro_usage').finally(() => {
    usageRequest = null;
  });
  return usageRequest;
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
  if (modelsStateRequest) return modelsStateRequest;
  modelsStateRequest = invoke<KiroModelsStateData>('kiro_models_state').finally(() => {
    modelsStateRequest = null;
  });
  return modelsStateRequest;
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
