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
      <div class="dsh-embed-status" data-dsh-embed-status>正在加载 DeepSeek Harness…</div>
      <iframe
        class="dsh-embed-frame"
        src="http://127.0.0.1:3080"
        title="DeepSeek Harness"
        allow="clipboard-read; clipboard-write"
      ></iframe>
    </div>
  `;
}

/** iframe 加载超时（毫秒）：超过仍未触发 load 视为服务未响应。
 *  服务刚启动/自愈时可能较慢，超时后自动重载一次再给出未响应提示。 */
const IFRAME_LOAD_TIMEOUT_MS = 10_000;

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

/** 绑定 DSH 全屏视图的交互（返回 / 刷新 / 加载状态提示） */
export function bindDshEmbedEvents(): void {
  document.querySelector('#dsh-exit-btn')?.addEventListener('click', exitDshMode);
  const reloadBtn = document.querySelector<HTMLButtonElement>('#dsh-reload-btn');
  reloadBtn?.addEventListener('click', () => {
    const frame = document.querySelector<HTMLIFrameElement>('.dsh-embed-frame');
    const statusEl = document.querySelector<HTMLElement>('[data-dsh-embed-status]');
    if (frame) {
      const src = frame.src;
      frame.src = '';
      if (statusEl) {
        statusEl.hidden = false;
        statusEl.textContent = '正在重新加载 DeepSeek Harness…';
      }
      // 清空后重设，强制重新加载
      requestAnimationFrame(() => {
        frame.src = src;
      });
    }
  });

  // iframe 加载状态：成功隐藏提示；超时先自动重载一次，仍无响应再提示（可点刷新重试）
  const frame = document.querySelector<HTMLIFrameElement>('.dsh-embed-frame');
  const statusEl = document.querySelector<HTMLElement>('[data-dsh-embed-status]');
  if (frame && statusEl) {
    let settled = false;
    let retried = false;
    const fail = () => {
      if (settled) return;
      settled = true;
      statusEl.hidden = false;
      statusEl.textContent =
        'DSH 服务未响应（http://127.0.0.1:3080），请点击「刷新」重试，或到「设置 → DSH 更新」查看服务状态';
    };
    const timer = window.setTimeout(() => {
      if (settled) return;
      if (!retried) {
        // 服务可能刚启动/自愈中：自动重载一次
        retried = true;
        statusEl.hidden = false;
        statusEl.textContent = '正在重新加载 DeepSeek Harness…';
        const src = frame.src;
        frame.src = '';
        requestAnimationFrame(() => {
          frame.src = src;
        });
        return;
      }
      fail();
    }, IFRAME_LOAD_TIMEOUT_MS);
    frame.addEventListener('load', () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      statusEl.hidden = true;
    });
    // CSP 拦截诊断：若 iframe 因 frame-src 被阻止，明确提示（定位配置问题）
    document.addEventListener(
      'securitypolicyviolation',
      (e) => {
        if (settled) return;
        if (e.violatedDirective.includes('frame-src') || e.violatedDirective.includes('child-src')) {
          settled = true;
          clearTimeout(timer);
          statusEl.hidden = false;
          statusEl.textContent =
            'DSH 页面被内容安全策略（CSP）拦截：' + e.violatedDirective + '，请更新应用后重试';
        }
      },
      { once: true },
    );
  }
}
