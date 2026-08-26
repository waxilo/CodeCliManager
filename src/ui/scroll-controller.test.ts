import { describe, expect, it, vi, beforeEach } from 'vitest';
import { ScrollController } from './scroll-controller';

function setup(): { el: HTMLElement; onUserScroll: ReturnType<typeof vi.fn> } {
  document.body.innerHTML = '<div id="sc" style="height:200px"></div>';
  const el = document.querySelector<HTMLElement>('#sc')!;
  return { el, onUserScroll: vi.fn() };
}

function wheel(el: HTMLElement, deltaY: number): WheelEvent {
  const e = new WheelEvent('wheel', { deltaY, bubbles: true, cancelable: true });
  el.dispatchEvent(e);
  return e;
}

describe('ScrollController 用户滚动与自动跟随', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
    vi.restoreAllMocks();
  });

  it('wheel 向上 → 关闭自动跟随并触发 onUserScroll', () => {
    const { el, onUserScroll } = setup();
    const sc = new ScrollController(el, { resumePx: 20, onUserScroll });
    expect(sc.autoScroll).toBe(true);
    wheel(el, -100);
    expect(sc.autoScroll).toBe(false);
    expect(onUserScroll).toHaveBeenCalledTimes(1);
  });

  it('wheel 向下但不在底部（内容未到底）→ 仍触发 onUserScroll（查看中）', () => {
    const { el, onUserScroll } = setup();
    new ScrollController(el, { resumePx: 20, onUserScroll });
    // 内容远高于视口：scrollHeight 大、scrollTop 0（非底部）
    Object.defineProperty(el, 'scrollHeight', { value: 2000, configurable: true });
    Object.defineProperty(el, 'clientHeight', { value: 200, configurable: true });
    wheel(el, 100);
    expect(onUserScroll).toHaveBeenCalledTimes(1);
  });

  it('scroll 上移（拖动滚动条/PageUp）：任何幅度都关闭跟随（无死区）', () => {
    const { el, onUserScroll } = setup();
    const sc = new ScrollController(el, { resumePx: 20, onUserScroll });
    Object.defineProperty(el, 'scrollHeight', { value: 2000, configurable: true });
    Object.defineProperty(el, 'clientHeight', { value: 200, configurable: true });
    // 先滚到中间（lastScrollTop 记录）
    Object.defineProperty(el, 'scrollTop', { value: 500, configurable: true });
    el.dispatchEvent(new Event('scroll'));
    expect(onUserScroll).not.toHaveBeenCalled(); // 向下/保持不关
    // 上移 30px（落在旧 20-80px 死区内）→ 必须关闭
    Object.defineProperty(el, 'scrollTop', { value: 470, configurable: true });
    el.dispatchEvent(new Event('scroll'));
    expect(onUserScroll).toHaveBeenCalledTimes(1);
    expect(sc.autoScroll).toBe(false);
    sc.destroy();
  });

  it('wheel 向下在底部 → 恢复自动跟随，不触发 onUserScroll', () => {
    const { el, onUserScroll } = setup();
    const sc = new ScrollController(el, { resumePx: 20, onUserScroll });
    sc.autoScroll = false;
    // 滚动到底部
    Object.defineProperty(el, 'scrollHeight', { value: 200, configurable: true });
    Object.defineProperty(el, 'clientHeight', { value: 200, configurable: true });
    Object.defineProperty(el, 'scrollTop', { value: 0, configurable: true });
    wheel(el, 100);
    expect(sc.autoScroll).toBe(true);
    expect(onUserScroll).not.toHaveBeenCalled();
  });

  it('用户在已排队置底前上滑时，下一帧不会抢回到底部', () => {
    const { el } = setup();
    const callbacks: FrameRequestCallback[] = [];
    vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => {
      callbacks.push(cb);
      return callbacks.length;
    });
    vi.stubGlobal('cancelAnimationFrame', vi.fn());
    Object.defineProperty(el, 'scrollHeight', { value: 2000, configurable: true, writable: true });
    Object.defineProperty(el, 'clientHeight', { value: 200, configurable: true });
    Object.defineProperty(el, 'scrollTop', { value: 1800, configurable: true, writable: true });

    const sc = new ScrollController(el, { resumePx: 20, createButton: true });
    sc.onNewContent();
    expect(callbacks).toHaveLength(1);

    // 模拟用户实际向上滚动后的浏览器位置（wheel 事件本身在 jsdom 不会改变 scrollTop）。
    el.scrollTop = 1600;
    wheel(el, -80);
    expect(sc.autoScroll).toBe(false);
    callbacks[0](0);

    expect(el.scrollTop).toBe(1600);
    expect(el.querySelector('.scroll-to-bottom-btn')?.classList.contains('has-new-content')).toBe(true);
    sc.destroy();
  });

  it('stopWheelPropagation：可滚动且未到边界时拦截；不可滚动/到边界时链条给父容器', () => {
    const { el } = setup();
    // 可滚动 + 在中间（scrollTop=500）→ 拦截
    const sc = new ScrollController(el, { resumePx: 20, stopWheelPropagation: true });
    Object.defineProperty(el, 'scrollHeight', { value: 2000, configurable: true });
    Object.defineProperty(el, 'clientHeight', { value: 200, configurable: true });
    Object.defineProperty(el, 'scrollTop', { value: 500, configurable: true });
    const stopSpy1 = vi.fn();
    const e1 = new WheelEvent('wheel', { deltaY: -100, bubbles: true, cancelable: true });
    e1.stopPropagation = stopSpy1;
    el.dispatchEvent(e1);
    expect(stopSpy1).toHaveBeenCalled();
    sc.destroy();

    // 可滚动但已到顶（scrollTop=0，向上滚）→ 不拦截，链条给父容器
    const sc2 = new ScrollController(el, { resumePx: 20, stopWheelPropagation: true });
    Object.defineProperty(el, 'scrollHeight', { value: 2000, configurable: true });
    Object.defineProperty(el, 'clientHeight', { value: 200, configurable: true });
    Object.defineProperty(el, 'scrollTop', { value: 0, configurable: true });
    const stopSpy2 = vi.fn();
    const e2 = new WheelEvent('wheel', { deltaY: -100, bubbles: true, cancelable: true });
    e2.stopPropagation = stopSpy2;
    el.dispatchEvent(e2);
    expect(stopSpy2).not.toHaveBeenCalled();
    sc2.destroy();

    // 不可滚动（scrollHeight <= clientHeight）→ 不拦截
    const sc3 = new ScrollController(el, { resumePx: 20, stopWheelPropagation: true });
    Object.defineProperty(el, 'scrollHeight', { value: 200, configurable: true });
    Object.defineProperty(el, 'clientHeight', { value: 200, configurable: true });
    Object.defineProperty(el, 'scrollTop', { value: 0, configurable: true });
    const stopSpy3 = vi.fn();
    const e3 = new WheelEvent('wheel', { deltaY: 100, bubbles: true, cancelable: true });
    e3.stopPropagation = stopSpy3;
    el.dispatchEvent(e3);
    expect(stopSpy3).not.toHaveBeenCalled();
    sc3.destroy();
  });
});
