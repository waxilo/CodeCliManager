import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * 自绘窗口控制的渲染门槛与行为。
 *
 * 重点在「什么时候不渲染」：dev 时用 Chrome 打开，UA 同样含 "win"，
 * 只看 platform-windows 会在浏览器里渲染出一组点了就抛错的按钮，所以必须同时要求 Tauri 运行时。
 */

const win = vi.hoisted(() => ({
  close: vi.fn().mockResolvedValue(undefined),
  minimize: vi.fn().mockResolvedValue(undefined),
  toggleMaximize: vi.fn().mockResolvedValue(undefined),
  isMaximized: vi.fn().mockResolvedValue(false),
  onResized: vi.fn().mockResolvedValue(() => {}),
}));

vi.mock('@tauri-apps/api/window', () => ({
  getCurrentWindow: () => win,
}));

type GlobalWithTauri = typeof globalThis & { isTauri?: boolean };

function setEnv(isWindows: boolean, inTauri: boolean): void {
  document.documentElement.classList.toggle('platform-windows', isWindows);
  (globalThis as GlobalWithTauri).isTauri = inTauri;
}

/** 模块内有「只建一次」的窗口级状态，每个用例都要拿全新实例 */
async function load(): Promise<typeof import('./window-controls')> {
  vi.resetModules();
  return import('./window-controls');
}

describe('自绘窗口控制', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
    vi.clearAllMocks();
  });

  afterEach(() => {
    document.documentElement.classList.remove('platform-windows');
    delete (globalThis as GlobalWithTauri).isTauri;
  });

  it('Windows + Tauri：渲染最小化 / 最大化 / 关闭三个按钮', async () => {
    setEnv(true, true);
    const mod = await load();
    document.body.innerHTML = mod.renderWindowControls();

    expect(mod.shouldRenderWindowControls()).toBe(true);
    expect(document.querySelector('#window-min-btn')).not.toBeNull();
    expect(document.querySelector('#window-max-btn')).not.toBeNull();
    expect(document.querySelector('#window-close-btn')).not.toBeNull();
  });

  it('浏览器：有 platform-windows 但没有 Tauri 时不渲染（否则一点就抛错）', async () => {
    setEnv(true, false);
    const mod = await load();

    expect(mod.shouldRenderWindowControls()).toBe(false);
    expect(mod.renderWindowControls()).toBe('');
  });

  it('macOS：保留原生红绿灯，不渲染自绘按钮', async () => {
    setEnv(false, true);
    const mod = await load();

    expect(mod.renderWindowControls()).toBe('');
  });

  it('非 Tauri 环境下绑定是空操作，不会去申请窗口实例', async () => {
    setEnv(true, false);
    const mod = await load();
    mod.bindWindowControls();

    expect(win.minimize).not.toHaveBeenCalled();
    expect(win.onResized).not.toHaveBeenCalled();
  });

  it('关闭走 close()：复用 CloseRequested → 常驻模块决策，而不是 destroy() 直毁窗口', async () => {
    setEnv(true, true);
    const mod = await load();
    document.body.innerHTML = mod.renderWindowControls();
    mod.bindWindowControls();

    document.querySelector<HTMLButtonElement>('#window-close-btn')!.click();

    expect(win.close).toHaveBeenCalledTimes(1);
  });

  it('最大化按钮调用 toggleMaximize；窗口 resize 后按钮切到「还原」文案', async () => {
    setEnv(true, true);
    const mod = await load();
    document.body.innerHTML = mod.renderWindowControls();
    mod.bindWindowControls();

    const maxBtn = document.querySelector<HTMLElement>('#window-max-btn')!;
    // 绑定后先按当前状态同步一次（未最大化 ⇒ 显示「最大化」）
    await vi.waitFor(() => expect(maxBtn.getAttribute('title')).toBe('最大化'));

    maxBtn.click();
    expect(win.toggleMaximize).toHaveBeenCalledTimes(1);

    // 模拟窗口最大化时触发的 resize：直接调已注册的处理器
    const handler = win.onResized.mock.calls[0]?.[0] as unknown as (() => void) | undefined;
    expect(typeof handler).toBe('function');
    win.isMaximized.mockResolvedValueOnce(true);
    handler!();

    await vi.waitFor(() => {
      expect(maxBtn.classList.contains('is-maximized')).toBe(true);
      expect(maxBtn.getAttribute('title')).toBe('还原');
    });
  });

  it('同一节点重复绑定不叠加监听，窗口级 resize 也只挂一次', async () => {
    setEnv(true, true);
    const mod = await load();
    document.body.innerHTML = mod.renderWindowControls();
    mod.bindWindowControls();
    mod.bindWindowControls();

    document.querySelector<HTMLButtonElement>('#window-min-btn')!.click();

    expect(win.minimize).toHaveBeenCalledTimes(1);
    expect(win.onResized).toHaveBeenCalledTimes(1);
  });
});
