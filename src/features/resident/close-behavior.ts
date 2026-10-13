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
 * 后端在托盘右键菜单里改了关闭行为。
 *
 * 这是**唯一**的偏好写入路径：关闭弹窗不再提供「记住我的选择」，
 * 用户想改偏好一律走托盘菜单，避免两个入口各写一份、互不感知。
 */
export function syncCloseBehaviorFromBackend(value: unknown): void {
  if (!isCloseBehavior(value)) {
    console.error('[resident] 收到非法的关闭行为:', value);
    return;
  }
  localStorage.setItem(STORAGE_KEY, value);
}
