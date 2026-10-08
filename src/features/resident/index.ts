import { listen } from '@tauri-apps/api/event';
import * as api from '../../api';
import { showCloseDialog } from './close-dialog';
import {
  getCloseBehavior,
  persistCloseBehavior,
  syncCloseBehaviorFromBackend,
} from './close-behavior';

/** 后端 → 前端：主窗口收到关闭请求，需要用户裁决 */
export const EVENT_CLOSE_REQUESTED = 'resident:close-requested';
/** 后端 → 前端：关闭行为在托盘菜单里被改过，需要回写本地 */
export const EVENT_BEHAVIOR_CHANGED = 'resident:behavior-changed';

/** 关闭询问同一时刻只允许一个：连点关闭按钮不应叠出多个弹窗 */
let closeDialogOpen = false;

async function handleCloseRequested(): Promise<void> {
  if (closeDialogOpen) return;
  closeDialogOpen = true;
  try {
    const result = await showCloseDialog();
    // 用户取消：窗口保持打开，什么都不做
    if (!result) return;

    if (result.remember) {
      persistCloseBehavior(result.choice);
    }
    if (result.choice === 'tray') {
      await api.hideToTray();
    } else {
      await api.quitApp();
    }
  } catch (error) {
    console.error('[resident] 处理关闭请求失败:', error);
  } finally {
    closeDialogOpen = false;
  }
}

async function registerListeners(): Promise<boolean> {
  try {
    await listen(EVENT_CLOSE_REQUESTED, () => {
      void handleCloseRequested();
    });
    await listen<unknown>(EVENT_BEHAVIOR_CHANGED, (event) => {
      syncCloseBehaviorFromBackend(event.payload);
    });
    return true;
  } catch (error) {
    console.error('[resident] 注册常驻监听失败:', error);
    return false;
  }
}

/**
 * 初始化后台常驻：注册关闭询问监听，并把持久化的关闭行为同步给后端。
 *
 * 顺序很关键 —— 后端只有在收到同步后才会把「询问」当作可交互状态；
 * 若监听注册失败却仍把 `ask` 推给后端，用户点关闭时没人应答，窗口会关不掉。
 */
export async function initResident(): Promise<void> {
  const listenersReady = await registerListeners();
  const behavior = listenersReady ? getCloseBehavior() : 'tray';
  if (!listenersReady) {
    console.error('[resident] 关闭询问不可用，降级为「最小化到托盘」');
  }
  try {
    await api.setCloseBehavior(behavior);
  } catch (error) {
    console.error('[resident] 同步关闭行为失败:', error);
  }
}
