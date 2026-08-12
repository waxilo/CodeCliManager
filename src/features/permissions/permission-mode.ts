import type { PermissionMode } from '../../types';
import * as api from '../../api';
import { PERMISSION_MODE_STORAGE_KEY } from '../../state';

export function normalizeModelKey(model?: string | null): string {
  const trimmed = (model || '').trim();
  return !trimmed || trimmed === 'default' ? '' : trimmed;
}

export function getPermissionMode(): PermissionMode {
  const stored = localStorage.getItem(PERMISSION_MODE_STORAGE_KEY);
  return stored === 'silent' ? 'silent' : 'ask';
}

export function setPermissionMode(mode: PermissionMode): void {
  localStorage.setItem(PERMISSION_MODE_STORAGE_KEY, mode);
  void api.setPermissionModeApi(mode).catch((e) => {
    console.warn('[permission] 同步权限模式失败:', e);
  });
}

export async function syncPermissionModeToBackend(): Promise<void> {
  try {
    await api.setPermissionModeApi(getPermissionMode());
  } catch (e) {
    console.warn('[permission] 初始化权限模式失败:', e);
  }
}
