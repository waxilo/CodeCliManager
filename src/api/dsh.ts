import { invoke } from '@tauri-apps/api/core';
import type { DshStatusData } from '../types';

export function dshStatus(): Promise<DshStatusData> {
  return invoke<DshStatusData>('dsh_status');
}

export function dshInstall(): Promise<string> {
  return invoke<string>('dsh_install');
}

export function dshStart(): Promise<DshStatusData> {
  return invoke<DshStatusData>('dsh_start');
}

export function dshStop(): Promise<DshStatusData> {
  return invoke<DshStatusData>('dsh_stop');
}

