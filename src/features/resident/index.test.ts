import { describe, expect, it, beforeEach, vi } from 'vitest';

const listenMock = vi.fn();
const handlers = new Map<string, (event: { payload: unknown }) => void>();

vi.mock('@tauri-apps/api/event', () => ({
  listen: (event: string, handler: (payload: { payload: unknown }) => void) => {
    listenMock(event, handler);
    handlers.set(event, handler);
    return Promise.resolve(() => {});
  },
}));

const setCloseBehaviorMock = vi.fn((_behavior: string) => Promise.resolve());
const hideToTrayMock = vi.fn(() => Promise.resolve());
const quitAppMock = vi.fn(() => Promise.resolve());

vi.mock('../../api', () => ({
  setCloseBehavior: (behavior: string) => setCloseBehaviorMock(behavior),
  hideToTray: () => hideToTrayMock(),
  quitApp: () => quitAppMock(),
}));

const STORAGE_KEY = 'ccm.closeBehavior';

async function initWithStorage(value: string | null) {
  vi.resetModules();
  handlers.clear();
  listenMock.mockClear();
  setCloseBehaviorMock.mockClear();
  hideToTrayMock.mockClear();
  quitAppMock.mockClear();
  localStorage.clear();
  if (value !== null) localStorage.setItem(STORAGE_KEY, value);
  document.body.innerHTML = '';
  const module = await import('./index');
  await module.initResident();
  return module;
}

function emitCloseRequested() {
  handlers.get('resident:close-requested')?.({ payload: undefined });
}

function clickDialogButton(selector: string) {
  document.querySelector<HTMLButtonElement>(selector)?.click();
}

describe('后台常驻前端接线', () => {
  beforeEach(() => {
    localStorage.clear();
    document.body.innerHTML = '';
  });

  it('初始化后注册关闭询问与行为变更两个监听，并把持久化行为推给后端', async () => {
    await initWithStorage('ask');
    expect(handlers.has('resident:close-requested')).toBe(true);
    expect(handlers.has('resident:behavior-changed')).toBe(true);
    expect(setCloseBehaviorMock).toHaveBeenCalledWith('ask');
  });

  it('未持久化过时默认按「每次询问」同步给后端', async () => {
    await initWithStorage(null);
    expect(setCloseBehaviorMock).toHaveBeenCalledWith('ask');
  });

  it('localStorage 里是非法值时回落为 ask', async () => {
    await initWithStorage('nonsense');
    expect(setCloseBehaviorMock).toHaveBeenCalledWith('ask');
  });

  it('收到关闭请求 → 弹窗选「最小化到托盘」→ 调 hideToTray', async () => {
    await initWithStorage('ask');
    emitCloseRequested();
    expect(document.querySelector('.confirm-dialog-wide')).not.toBeNull();
    clickDialogButton('.confirm-btn.primary');
    await vi.waitFor(() => expect(hideToTrayMock).toHaveBeenCalledTimes(1));
    expect(quitAppMock).not.toHaveBeenCalled();
  });

  it('收到关闭请求 → 弹窗选「直接退出」→ 调 quitApp', async () => {
    await initWithStorage('ask');
    emitCloseRequested();
    clickDialogButton('.confirm-btn.danger');
    await vi.waitFor(() => expect(quitAppMock).toHaveBeenCalledTimes(1));
    expect(hideToTrayMock).not.toHaveBeenCalled();
  });

  it('勾选记住后落盘并同步后端', async () => {
    await initWithStorage('ask');
    emitCloseRequested();
    const checkbox = document.querySelector<HTMLInputElement>('.resident-remember-checkbox');
    if (!checkbox) throw new Error('复选框缺失');
    checkbox.checked = true;
    clickDialogButton('.confirm-btn.danger');
    await vi.waitFor(() => expect(localStorage.getItem(STORAGE_KEY)).toBe('exit'));
    expect(setCloseBehaviorMock).toHaveBeenLastCalledWith('exit');
  });

  it('未勾选记住则不落盘（下次仍询问）', async () => {
    await initWithStorage('ask');
    emitCloseRequested();
    clickDialogButton('.confirm-btn.primary');
    await vi.waitFor(() => expect(hideToTrayMock).toHaveBeenCalled());
    expect(localStorage.getItem(STORAGE_KEY)).toBe('ask');
  });

  it('取消关闭时既不隐藏也不退出', async () => {
    await initWithStorage('ask');
    emitCloseRequested();
    clickDialogButton('.confirm-btn.cancel');
    await vi.waitFor(() => expect(document.querySelector('.confirm-overlay')).toBeNull());
    expect(hideToTrayMock).not.toHaveBeenCalled();
    expect(quitAppMock).not.toHaveBeenCalled();
  });

  it('连点关闭只弹一个弹窗', async () => {
    await initWithStorage('ask');
    emitCloseRequested();
    emitCloseRequested();
    emitCloseRequested();
    expect(document.querySelectorAll('.confirm-dialog-wide')).toHaveLength(1);
  });

  it('托盘菜单改了关闭行为 → 只回写本地，不回推后端', async () => {
    await initWithStorage('ask');
    setCloseBehaviorMock.mockClear();
    handlers.get('resident:behavior-changed')?.({ payload: 'exit' });
    expect(localStorage.getItem(STORAGE_KEY)).toBe('exit');
    expect(setCloseBehaviorMock).not.toHaveBeenCalled();
  });

  it('行为变更事件里是非法值时不写本地', async () => {
    await initWithStorage('tray');
    handlers.get('resident:behavior-changed')?.({ payload: 42 });
    expect(localStorage.getItem(STORAGE_KEY)).toBe('tray');
  });
});
