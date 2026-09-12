import { invoke } from '@tauri-apps/api/core';
import type {
  KiroAccessCopyKind,
  KiroAccessData,
  KiroModelsStateData,
  KiroStatusData,
  KiroUsageData,
} from '../types';

let statusRequest: Promise<KiroStatusData> | null = null;
let usageRequest: Promise<KiroUsageData> | null = null;
let modelsStateRequest: Promise<KiroModelsStateData> | null = null;
let accessRequest: Promise<KiroAccessData> | null = null;

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

/** 外部接入信息：把本机代理接到其它 Agent 时要复制的地址 / 密钥 / 模型。 */
export function kiroProxyAccess(): Promise<KiroAccessData> {
  if (accessRequest) return accessRequest;
  accessRequest = invoke<KiroAccessData>('kiro_proxy_access').finally(() => {
    accessRequest = null;
  });
  return accessRequest;
}

/** 复制接入信息到系统剪贴板（明文密钥不经过前端）。 */
export function kiroCopyAccess(kind: KiroAccessCopyKind): Promise<boolean> {
  return invoke<boolean>('kiro_copy_access', { kind });
}

/** 重置代理密钥；代理运行中会被后端拒绝。 */
export function kiroResetProxyKey(): Promise<KiroAccessData> {
  return invoke<KiroAccessData>('kiro_reset_proxy_key');
}
