import { invoke } from '@tauri-apps/api/core';
import type { KiroStatusData, KiroUsageData } from '../types';

export function kiroStatus(): Promise<KiroStatusData> {
  return invoke<KiroStatusData>('kiro_status');
}

export function kiroUsage(): Promise<KiroUsageData> {
  return invoke<KiroUsageData>('kiro_usage');
}

export function kiroStart(port: number | null = null): Promise<KiroStatusData> {
  return invoke<KiroStatusData>('kiro_start', { port });
}

export function kiroStop(): Promise<KiroStatusData> {
  return invoke<KiroStatusData>('kiro_stop');
}
