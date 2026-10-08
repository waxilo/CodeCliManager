import * as api from '../../api';

/** 关闭窗口时的行为：每次询问 / 最小化到托盘 / 直接退出 */
export type CloseBehavior = api.CloseBehavior;

const STORAGE_KEY = 'ccm.closeBehavior';

const VALID_BEHAVIORS: readonly CloseBehavior[] = ['ask', 'tray', 'exit'];

function isCloseBehavior(value: unknown): value is CloseBehavior {
  return typeof value === 'string' && (VALID_BEHAVIORS as readonly string[]).includes(value);
}

/** 读取用户上次记住的关闭行为，非法值一律回落为「每次询问」 */
export function getCloseBehavior(): CloseBehavior {
  const raw = localStorage.getItem(STORAGE_KEY);
  return isCloseBehavior(raw) ? raw : 'ask';
}

/**
 * 用户在关闭弹窗里勾了「记住我的选择」。
 * 本地与后端一起写：后端持有权威副本，命中「最小化到托盘 / 直接退出」时无需 IPC 往返。
 */
export function persistCloseBehavior(behavior: CloseBehavior): void {
  localStorage.setItem(STORAGE_KEY, behavior);
  void api.setCloseBehavior(behavior).catch((error) => {
    console.error('[resident] 同步关闭行为到后端失败:', error);
  });
}

/**
 * 后端在托盘右键菜单里改了关闭行为。
 * 只回写本地 —— 后端是改动发起方，再推回去只会来回抖动。
 */
export function syncCloseBehaviorFromBackend(value: unknown): void {
  if (!isCloseBehavior(value)) {
    console.error('[resident] 收到非法的关闭行为:', value);
    return;
  }
  localStorage.setItem(STORAGE_KEY, value);
}
