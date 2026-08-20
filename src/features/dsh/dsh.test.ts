import { describe, expect, it, beforeEach, vi } from 'vitest';
import { appState } from '../../state';
import {
  renderDshSectionHtml,
  mountDshSection,
  bindDshSectionEvents,
  refreshDshStatus as refreshDshStatusForTest,
} from './settings-section';

const statusMock = vi.fn();
const installMock = vi.fn();
const startMock = vi.fn();
const stopMock = vi.fn();
vi.mock('../../api', () => ({
  dshStatus: (...args: unknown[]) => statusMock(...args),
  dshInstall: (...args: unknown[]) => installMock(...args),
  dshStart: (...args: unknown[]) => startMock(...args),
  dshStop: (...args: unknown[]) => stopMock(...args),
}));

vi.mock('@tauri-apps/api/event', () => ({
  listen: vi.fn().mockResolvedValue(() => {}),
}));

function baseStatus(overrides: Partial<ReturnType<typeof statusMock> extends never ? never : object> = {}) {
  return {
    installedVersion: '0.1.0-rc.7',
    latestVersion: '0.1.0-rc.7',
    running: false,
    port: 3080,
    error: null,
    ...overrides,
  } as never;
}

describe('设置页「DSH 工作台」分区', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
    appState.dshStatus = null;
    appState.dshProgressText = '';
    statusMock.mockReset();
    installMock.mockReset();
    startMock.mockReset();
    stopMock.mockReset();
  });

  it('渲染版本、状态与按钮（未运行 / 停止按钮禁用）', async () => {
    statusMock.mockResolvedValue(baseStatus({ running: false }));
    document.body.innerHTML = '<div id="settings-dsh-view"></div>';
    appState.dshStatus = await statusMock();
    document.querySelector('#settings-dsh-view')!.innerHTML = renderDshSectionHtml();
    const html = document.querySelector('#settings-dsh-view')!.innerHTML;
    expect(html).toContain('0.1.0-rc.7');
    expect(html).toContain('未运行');
    const stopBtn = document.querySelector<HTMLButtonElement>('[data-dsh-action="stop"]')!;
    expect(stopBtn.disabled).toBe(true);
    // 提示行常驻占位（防布局跳动）：已最新时显示中性文案
    const hint = document.querySelector<HTMLElement>('[data-dsh-hint]')!;
    expect(hint).not.toBeNull();
    expect(hint.textContent).toContain('当前已是最新版本');
    expect(hint.classList.contains('is-muted')).toBe(true);
  });

  it('运行中：停止按钮可用，启动按钮变为「打开页面」，有新版本时提示', async () => {
    statusMock.mockResolvedValue(
      baseStatus({ running: true, latestVersion: '0.2.0' }),
    );
    document.body.innerHTML = '<div id="settings-dsh-view"></div>';
    appState.dshStatus = await statusMock();
    document.querySelector('#settings-dsh-view')!.innerHTML = renderDshSectionHtml();
    const html = document.querySelector('#settings-dsh-view')!.innerHTML;
    expect(html).toContain('运行中');
    expect(html).toContain('打开页面');
    expect(html).toContain('发现新版本');
    expect(
      document.querySelector<HTMLButtonElement>('[data-dsh-action="stop"]')!.disabled,
    ).toBe(false);
  });

  it('挂载后拉取状态并增量更新视图（不重建）', async () => {
    statusMock.mockResolvedValue(baseStatus());
    document.body.innerHTML = `<div id="settings-dsh-view">${renderDshSectionHtml()}</div>`;
    const section = document.querySelector<HTMLElement>('.dsh-section')!;
    // 初始为查询中占位
    expect(section.querySelector('[data-dsh-installed]')!.textContent).toBe('—');
    mountDshSection();
    await new Promise((r) => setTimeout(r, 10));
    expect(statusMock).toHaveBeenCalled();
    // 增量更新：版本与状态文本就位，且视图未被重建（同一节点）
    expect(document.querySelector('.dsh-section')).toBe(section);
    expect(section.querySelector('[data-dsh-installed]')!.textContent).toContain('0.1.0-rc.7');
    expect(section.querySelector('[data-dsh-latest]')!.textContent).toContain('0.1.0-rc.7');
    expect(section.querySelector('[data-dsh-status-text]')!.textContent).toContain('未运行');
  });

  it('未安装：按钮显示「安装」且可点击，调用 dshInstall 并展示结果', async () => {
    installMock.mockResolvedValue('安装完成');
    statusMock.mockResolvedValue(baseStatus({ installedVersion: null }));
    document.body.innerHTML = '<div id="settings-dsh-view"></div>';
    appState.dshStatus = await statusMock();
    document.querySelector('#settings-dsh-view')!.innerHTML = renderDshSectionHtml();
    const installBtn = document.querySelector<HTMLButtonElement>(
      '[data-dsh-action="install"]',
    )!;
    expect(installBtn.textContent).toContain('安装');
    expect(installBtn.disabled).toBe(false);
    const section = document.querySelector<HTMLElement>('.dsh-section')!;
    bindDshSectionEvents(section);
    installBtn.click();
    await new Promise((r) => setTimeout(r, 20));
    expect(installMock).toHaveBeenCalledTimes(1);
    expect(section.querySelector('[data-dsh-progress]')!.textContent).toContain('安装完成');
  });

  it('已安装且有新版本：按钮显示「更新」，可点击调用 dshInstall', async () => {
    installMock.mockResolvedValue('更新完成');
    statusMock.mockResolvedValue(baseStatus({ latestVersion: '9.9.9' }));
    document.body.innerHTML = '<div id="settings-dsh-view"></div>';
    appState.dshStatus = await statusMock();
    document.querySelector('#settings-dsh-view')!.innerHTML = renderDshSectionHtml();
    const installBtn = document.querySelector<HTMLButtonElement>(
      '[data-dsh-action="install"]',
    )!;
    expect(installBtn.textContent).toContain('更新');
    expect(installBtn.disabled).toBe(false);
    expect(document.querySelector('.dsh-update-hint')!.textContent).toContain('9.9.9');
    const section = document.querySelector<HTMLElement>('.dsh-section')!;
    bindDshSectionEvents(section);
    installBtn.click();
    await new Promise((r) => setTimeout(r, 20));
    expect(installMock).toHaveBeenCalledTimes(1);
  });

  it('已安装且无新版本：按钮显示「已是最新版本」并禁用', async () => {
    statusMock.mockResolvedValue(baseStatus());
    document.body.innerHTML = '<div id="settings-dsh-view"></div>';
    appState.dshStatus = await statusMock();
    document.querySelector('#settings-dsh-view')!.innerHTML = renderDshSectionHtml();
    const installBtn = document.querySelector<HTMLButtonElement>(
      '[data-dsh-action="install"]',
    )!;
    expect(installBtn.textContent).toContain('已是最新版本');
    expect(installBtn.disabled).toBe(true);
  });

  it('「启动服务」进入 DSH 模式（dshStart + dshModeActive）', async () => {
    startMock.mockResolvedValue(baseStatus({ running: true }));
    statusMock.mockResolvedValue(baseStatus());
    document.body.innerHTML = '<div id="settings-dsh-view"></div>';
    appState.dshStatus = await statusMock();
    document.querySelector('#settings-dsh-view')!.innerHTML = renderDshSectionHtml();
    const section = document.querySelector<HTMLElement>('.dsh-section')!;
    bindDshSectionEvents(section);
    document.querySelector<HTMLButtonElement>('[data-dsh-action="start"]')!.click();
    await new Promise((r) => setTimeout(r, 20));
    expect(startMock).toHaveBeenCalledTimes(1);
    expect(appState.dshModeActive).toBe(true);
  });

  it('停止服务：进行中显示「停止中…」，完成后文案与状态归位', async () => {
    stopMock.mockResolvedValue(baseStatus({ running: false }));
    // 首次查询：运行中；停止后刷新查询：已停止
    statusMock
      .mockResolvedValueOnce(baseStatus({ running: true }))
      .mockResolvedValue(baseStatus({ running: false }));
    document.body.innerHTML = '<div id="settings-dsh-view"></div>';
    appState.dshStatus = await statusMock();
    document.querySelector('#settings-dsh-view')!.innerHTML = renderDshSectionHtml();
    const section = document.querySelector<HTMLElement>('.dsh-section')!;
    bindDshSectionEvents(section);
    const stopBtn = document.querySelector<HTMLButtonElement>('[data-dsh-action="stop"]')!;
    expect(stopBtn.disabled).toBe(false);
    stopBtn.click();
    // 点击后立即进入 loading（dshStop 挂起时）
    expect(stopBtn.disabled).toBe(true);
    expect(stopBtn.textContent).toContain('停止中');
    await new Promise((r) => setTimeout(r, 20));
    // 完成后：文案恢复、按钮按新状态（running=false → 禁用）、状态刷新
    expect(stopBtn.textContent).toContain('停止服务');
    expect(stopBtn.disabled).toBe(true);
    expect(section.querySelector('[data-dsh-status-text]')!.textContent).toContain('未运行');
    expect(statusMock).toHaveBeenCalledTimes(2);
  });

  it('停止失败：文案与按钮状态仍归位（可再次点击）', async () => {
    stopMock.mockRejectedValue(new Error('boom'));
    statusMock.mockResolvedValue(baseStatus({ running: true }));
    document.body.innerHTML = '<div id="settings-dsh-view"></div>';
    appState.dshStatus = await statusMock();
    document.querySelector('#settings-dsh-view')!.innerHTML = renderDshSectionHtml();
    const section = document.querySelector<HTMLElement>('.dsh-section')!;
    bindDshSectionEvents(section);
    const stopBtn = document.querySelector<HTMLButtonElement>('[data-dsh-action="stop"]')!;
    stopBtn.click();
    await new Promise((r) => setTimeout(r, 20));
    // 停止失败：running 仍 true → 按钮恢复可点 + 文案归位
    expect(stopBtn.disabled).toBe(false);
    expect(stopBtn.textContent).toContain('停止服务');
  });

  it('停止进行中：其他刷新不改写停止按钮状态（防二次触发）', async () => {
    let resolveStop: (v: unknown) => void = () => {};
    stopMock.mockImplementation(() => new Promise((res) => { resolveStop = res; }));
    statusMock.mockResolvedValue(baseStatus({ running: true }));
    document.body.innerHTML = '<div id="settings-dsh-view"></div>';
    appState.dshStatus = await statusMock();
    document.querySelector('#settings-dsh-view')!.innerHTML = renderDshSectionHtml();
    const section = document.querySelector<HTMLElement>('.dsh-section')!;
    bindDshSectionEvents(section);
    const stopBtn = document.querySelector<HTMLButtonElement>('[data-dsh-action="stop"]')!;
    stopBtn.click();
    await Promise.resolve();
    // stop 挂起中：模拟其他路径触发的状态刷新
    await refreshDshStatusForTest();
    expect(stopBtn.disabled).toBe(true);
    expect(stopBtn.textContent).toContain('停止中');
    // 完成：归位
    resolveStop({ servers: [], configPath: '' });
    await new Promise((r) => setTimeout(r, 20));
    expect(stopBtn.textContent).toContain('停止服务');
  });

  it('「停止服务」调用 dshStop', async () => {
    stopMock.mockResolvedValue(baseStatus({ running: false }));
    // 首次查询：运行中；停止后刷新查询：已停止
    statusMock
      .mockResolvedValueOnce(baseStatus({ running: true }))
      .mockResolvedValue(baseStatus({ running: false }));
    document.body.innerHTML = '<div id="settings-dsh-view"></div>';
    appState.dshStatus = await statusMock();
    document.querySelector('#settings-dsh-view')!.innerHTML = renderDshSectionHtml();
    const section = document.querySelector<HTMLElement>('.dsh-section')!;
    bindDshSectionEvents(section);
    document.querySelector<HTMLButtonElement>('[data-dsh-action="stop"]')!.click();
    await new Promise((r) => setTimeout(r, 20));
    expect(stopMock).toHaveBeenCalledTimes(1);
  });
});

