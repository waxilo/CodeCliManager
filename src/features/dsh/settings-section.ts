import { appState } from '../../state';
import * as api from '../../api';
import { escapeHtml } from '../../utils';
import { listen } from '@tauri-apps/api/event';
import { enterDshMode } from './embed';
import type { DshStatusData } from '../../types';

/** 设置页「DSH 工作台」分区：版本 / 一键安装更新 / 服务启停 / 打开页面 */
export function renderDshSectionHtml(): string {
  const s = appState.dshStatus;
  // 未查询到（初始/失败）时显示 —，不误导为「未安装」
  const installed = s?.installedVersion ? escapeHtml(s.installedVersion) : '—';
  const latest = s?.latestVersion ? escapeHtml(s.latestVersion) : '—';
  const running = Boolean(s?.running);
  const hasUpdate =
    s?.installedVersion && s?.latestVersion && s.installedVersion !== s.latestVersion;
  // 已安装 → 更新按钮；未安装 → 安装按钮；已最新 → 禁用
  const installLabel = !s?.installedVersion
    ? '安装'
    : hasUpdate
      ? '更新'
      : '已是最新版本';
  const installDisabled = Boolean(s?.installedVersion && !hasUpdate);
  // 常驻提示行：内容按状态变化但始终占位，避免整块高度突变导致页面跳动
  const hintText = !s?.installedVersion
    ? '尚未安装 DSH，可点击「安装」'
    : hasUpdate
      ? `发现新版本 ${escapeHtml(s?.latestVersion || '')}，可一键更新`
      : '当前已是最新版本';
  const hintClass = !s?.installedVersion || hasUpdate ? '' : ' is-muted';
  return `
    <div class="settings-update-view" id="settings-dsh-view">
      <div class="dsh-section">
        <div class="dsh-header">
          <h3 class="dsh-title">DSH 更新</h3>
          <span class="dsh-subtitle">DeepSeek Harness（npm 全局包 @deepseek-ai/dsh）安装与更新</span>
        </div>
        <div class="dsh-info-grid">
          <div class="dsh-info-item">
            <span class="dsh-info-label">已装版本</span>
            <span class="dsh-info-value" data-dsh-installed>${installed}</span>
          </div>
          <div class="dsh-info-item">
            <span class="dsh-info-label">最新版本</span>
            <span class="dsh-info-value" data-dsh-latest>${latest}</span>
          </div>
          <div class="dsh-info-item">
            <span class="dsh-info-label">服务状态</span>
            <span class="dsh-info-value">
              <span class="dsh-status-dot ${running ? 'is-running' : ''}" data-dsh-status-dot></span>
              <span data-dsh-status-text>${running ? '运行中' : '未运行'}</span>
            </span>
          </div>
        </div>
        <p class="dsh-update-hint${hintClass}" data-dsh-hint>${hintText}</p>
        <div class="dsh-actions">
          <button type="button" class="settings-btn-primary" data-dsh-action="install"${installDisabled ? ' disabled' : ''} title="${installDisabled ? '当前已是最新版本' : hasUpdate ? '更新到最新版本' : '安装 DSH 到 npm 全局'}">${installLabel}</button>
          <button type="button" class="dsh-btn" data-dsh-action="start">${running ? '打开页面' : '启动服务'}</button>
          <button type="button" class="dsh-btn" data-dsh-action="stop" ${running ? '' : 'disabled'}>停止服务</button>
          <button type="button" class="dsh-btn" data-dsh-action="refresh">刷新状态</button>
        </div>
        <p class="dsh-progress" data-dsh-progress hidden></p>
        <p class="dsh-error" data-dsh-error hidden></p>
      </div>
    </div>
  `;
}

/** 挂载分区：绑定按钮 + 拉取状态 + 监听安装进度 */
export function mountDshSection(): void {
  const section = document.querySelector<HTMLElement>('.dsh-section');
  if (!section) return;
  bindDshSectionEvents(section);
  void refreshDshStatus();
}

export function bindDshSectionEvents(section: HTMLElement): void {
  section.querySelectorAll<HTMLButtonElement>('[data-dsh-action]').forEach((btn) => {
    if ((btn as HTMLElement).dataset.bound === '1') return;
    (btn as HTMLElement).dataset.bound = '1';
    btn.addEventListener('click', () => {
      const action = btn.dataset.dshAction;
      if (action === 'refresh') {
        void refreshDshStatus();
      } else if (action === 'install') {
        void runDshInstall(section, btn);
      } else if (action === 'start') {
        void runDshStart(section, btn);
      } else if (action === 'stop') {
        void runDshStop(section);
      }
    });
  });
}

async function refreshDshStatus(): Promise<void> {
  try {
    appState.dshStatus = await api.dshStatus();
  } catch {
    appState.dshStatus = null;
  }
  const view = document.querySelector('#settings-dsh-view');
  if (!view) return;
  const section = view.querySelector<HTMLElement>('.dsh-section');
  if (!section) {
    // 视图尚未渲染（刷新被提前调用）：整块渲染一次
    view.innerHTML = renderDshSectionHtml();
    const fresh = view.querySelector<HTMLElement>('.dsh-section');
    if (fresh) bindDshSectionEvents(fresh);
    return;
  }
  // 增量更新：只改文本/按钮状态，避免整块重建引起布局跳动
  applyDshStatus(section, appState.dshStatus);
}

/** 增量应用 DSH 状态到已渲染的视图（不重建 DOM，布局稳定） */
function applyDshStatus(section: HTMLElement, s: DshStatusData | null): void {
  const installedEl = section.querySelector('[data-dsh-installed]');
  if (installedEl) installedEl.textContent = s?.installedVersion || '—';
  const latestEl = section.querySelector('[data-dsh-latest]');
  if (latestEl) latestEl.textContent = s?.latestVersion || '—';
  const running = Boolean(s?.running);
  const dot = section.querySelector<HTMLElement>('[data-dsh-status-dot]');
  dot?.classList.toggle('is-running', running);
  const statusText = section.querySelector('[data-dsh-status-text]');
  if (statusText) statusText.textContent = running ? '运行中' : '未运行';

  const hasUpdate = Boolean(
    s?.installedVersion && s?.latestVersion && s.installedVersion !== s.latestVersion,
  );
  const installBtn = section.querySelector<HTMLButtonElement>(
    '[data-dsh-action="install"]',
  );
  if (installBtn) {
    const label = !s?.installedVersion ? '安装' : hasUpdate ? '更新' : '已是最新版本';
    installBtn.textContent = label;
    installBtn.disabled = Boolean(s?.installedVersion && !hasUpdate);
    installBtn.title = installBtn.disabled
      ? '当前已是最新版本'
      : hasUpdate
        ? '更新到最新版本'
        : '安装 DSH 到 npm 全局';
  }
  const startBtn = section.querySelector<HTMLButtonElement>('[data-dsh-action="start"]');
  if (startBtn) startBtn.textContent = running ? '打开页面' : '启动服务';
  const stopBtn = section.querySelector<HTMLButtonElement>('[data-dsh-action="stop"]');
  if (stopBtn) stopBtn.disabled = !running;

  const hintEl = section.querySelector('[data-dsh-hint]');
  if (hintEl) {
    hintEl.textContent = !s?.installedVersion
      ? '尚未安装 DSH，可点击「安装」'
      : hasUpdate
        ? `发现新版本 ${s?.latestVersion || ''}，可一键更新`
        : '当前已是最新版本';
    hintEl.classList.toggle('is-muted', Boolean(s?.installedVersion) && !hasUpdate);
  }
}

async function runDshInstall(section: HTMLElement, btn: HTMLButtonElement): Promise<void> {
  const progressEl = section.querySelector<HTMLElement>('[data-dsh-progress]')!;
  const errorEl = section.querySelector<HTMLElement>('[data-dsh-error]')!;
  progressEl.hidden = false;
  errorEl.hidden = true;
  btn.disabled = true;
  btn.textContent = '安装中…';

  // 进度事件监听（首次调用时挂一次，防重复）
  if (!(section as HTMLElement & { __dshProgressBound?: boolean }).__dshProgressBound) {
    (section as HTMLElement & { __dshProgressBound?: boolean }).__dshProgressBound = true;
    void listen<{ text: string }>('dsh-progress', (event) => {
      const text = event.payload?.text ?? '';
      if (text.trim()) appState.dshProgressText = text.trim();
      const el = document.querySelector<HTMLElement>('[data-dsh-progress]');
      if (el) {
        el.hidden = false;
        el.textContent = appState.dshProgressText;
      }
    });
  }

  try {
    const result = await api.dshInstall();
    appState.dshProgressText = '';
    progressEl.textContent = result || '安装完成';
    showDshMessage(section, result || '安装完成', false);
  } catch (e) {
    progressEl.hidden = true;
    errorEl.textContent = `安装失败：${String(e)}`;
    errorEl.hidden = false;
  } finally {
    btn.disabled = false;
    btn.textContent = '一键安装 / 更新';
    await refreshDshStatus();
  }
}

async function runDshStart(section: HTMLElement, btn: HTMLButtonElement): Promise<void> {
  btn.disabled = true;
  btn.textContent = '启动中…';
  try {
    await enterDshMode();
  } catch (e) {
    showDshMessage(section, `启动失败：${String(e)}`, true);
  } finally {
    await refreshDshStatus();
  }
}

async function runDshStop(section: HTMLElement): Promise<void> {
  // 停止是阻塞操作（可能等待端口释放）：按钮禁用 + loading 文案反馈
  const stopBtn = section.querySelector<HTMLButtonElement>('[data-dsh-action="stop"]');
  if (stopBtn) {
    stopBtn.disabled = true;
    stopBtn.textContent = '停止中…';
  }
  try {
    await api.dshStop();
  } catch {
    // 忽略：刷新状态即可
  } finally {
    await refreshDshStatus();
  }
}

function showDshMessage(section: HTMLElement, text: string, isError: boolean): void {
  const errorEl = section.querySelector<HTMLElement>('[data-dsh-error]');
  const progressEl = section.querySelector<HTMLElement>('[data-dsh-progress]');
  if (isError && errorEl) {
    errorEl.textContent = text;
    errorEl.hidden = false;
    if (progressEl) progressEl.hidden = true;
  } else if (progressEl) {
    progressEl.textContent = text;
    progressEl.hidden = false;
  }
}
