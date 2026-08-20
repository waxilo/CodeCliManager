import { appState } from '../../state';
import { shellApi } from '../../app/shell/api';
import * as api from '../../api';
import { showToast } from '../../ui';


/**
 * DSH 模式：整个主窗口切换为 DeepSeek Harness 页面（iframe 全屏）。
 * 切换是纯前端状态驱动：enterDshMode 先确保服务在跑，然后置位
 * dshModeActive 并全量重渲染；退出后恢复原视图（含管理页状态）。
 */

/** 渲染 DSH 全屏视图（替代整个 app-shell） */
export function renderDshEmbedHtml(): string {
  return `
    <div class="dsh-embed">
      <div class="dsh-embed-bar" data-tauri-drag-region="deep">
        <span class="dsh-embed-title">DeepSeek Harness</span>
        <div class="dsh-embed-actions">
          <button type="button" class="dsh-embed-btn" id="dsh-reload-btn" title="刷新页面">刷新</button>
          <button type="button" class="dsh-embed-btn primary" id="dsh-exit-btn" title="返回 CodeCliManager">← 返回 CCM</button>
        </div>
      </div>
      <iframe
        class="dsh-embed-frame"
        src="http://127.0.0.1:3080"
        title="DeepSeek Harness"
        sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-downloads"
      ></iframe>
    </div>
  `;
}

/** 进入 DSH 模式：确保服务在运行后切换页面 */
export async function enterDshMode(): Promise<void> {
  if (appState.dshModeActive) return;
  try {
    appState.dshStatus = await api.dshStart();
  } catch (e) {
    showToast('DSH 启动失败：' + String(e));
    return;
  }
  appState.dshModeActive = true;
  shellApi.render();
}

/** 退出 DSH 模式：恢复 CCM 界面 */
export function exitDshMode(): void {
  if (!appState.dshModeActive) return;
  appState.dshModeActive = false;
  shellApi.render();
}

/** 绑定 DSH 全屏视图的交互（返回 / 刷新 / 顶栏拖动与双击最大化） */
export function bindDshEmbedEvents(): void {
  document.querySelector('#dsh-exit-btn')?.addEventListener('click', exitDshMode);
  document.querySelector('#dsh-reload-btn')?.addEventListener('click', () => {
    const frame = document.querySelector<HTMLIFrameElement>('.dsh-embed-frame');
    if (frame) {
      const src = frame.src;
      frame.src = '';
      // 清空后重设，强制重新加载
      requestAnimationFrame(() => {
        frame.src = src;
      });
    }
  });

}
