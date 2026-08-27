import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ChatScrollCoordinator,
  type ChatScrollCoordinatorOptions,
} from './chat-scroll-coordinator';

interface RectValues {
  top: number;
  bottom: number;
}

interface Harness {
  viewport: HTMLElement;
  content: HTMLElement;
  message: HTMLElement;
  sentinel: HTMLElement;
  button: HTMLButtonElement;
  coordinator: ChatScrollCoordinator;
  frames: FrameRequestCallback[];
  resizeCallbacks: ResizeObserverCallback[];
  scrollWrites: number[];
  setScrollTop(value: number): void;
  setMessageRect(values: RectValues): void;
}

function rect(values: RectValues): DOMRect {
  return {
    x: 0,
    y: values.top,
    width: 100,
    height: values.bottom - values.top,
    top: values.top,
    right: 100,
    bottom: values.bottom,
    left: 0,
    toJSON: () => ({}),
  };
}

function createHarness(
  overrides: Partial<Pick<ChatScrollCoordinatorOptions, 'sessionKey' | 'mountEpoch'>> = {},
): Harness {
  document.body.innerHTML = `
    <div id="viewport" tabindex="0">
      <div id="content">
        <article id="message">message</article>
        <div id="sentinel"></div>
      </div>
    </div>
    <button id="follow" type="button">Follow</button>
  `;
  const viewport = document.querySelector<HTMLElement>('#viewport')!;
  const content = document.querySelector<HTMLElement>('#content')!;
  const message = document.querySelector<HTMLElement>('#message')!;
  const sentinel = document.querySelector<HTMLElement>('#sentinel')!;
  const button = document.querySelector<HTMLButtonElement>('#follow')!;

  let scrollTop = 0;
  let messageRect = { top: 20, bottom: 120 };
  const scrollWrites: number[] = [];
  Object.defineProperties(viewport, {
    scrollTop: {
      configurable: true,
      get: () => scrollTop,
      set: (value: number) => {
        scrollTop = value;
        scrollWrites.push(value);
      },
    },
    scrollHeight: { configurable: true, value: 1000 },
    clientHeight: { configurable: true, value: 200 },
  });
  viewport.getBoundingClientRect = () => rect({ top: 0, bottom: 200 });
  message.getBoundingClientRect = () => rect(messageRect);
  sentinel.getBoundingClientRect = () => rect({ top: 1000 - scrollTop, bottom: 1000 - scrollTop });

  const frames: FrameRequestCallback[] = [];
  const requestFrame = vi.fn((callback: FrameRequestCallback): number => {
    frames.push(callback);
    return frames.length;
  });
  const resizeCallbacks: ResizeObserverCallback[] = [];
  const createResizeObserver = vi.fn((callback: ResizeObserverCallback): ResizeObserver => {
    resizeCallbacks.push(callback);
    return {
      observe: vi.fn(),
      unobserve: vi.fn(),
      disconnect: vi.fn(),
    };
  });

  const coordinator = new ChatScrollCoordinator({
    viewport,
    content,
    sentinel,
    followButton: button,
    sessionKey: overrides.sessionKey ?? 'session-a',
    mountEpoch: overrides.mountEpoch ?? 1,
    requestFrame,
    cancelFrame: vi.fn(),
    createResizeObserver,
  });

  return {
    viewport,
    content,
    message,
    sentinel,
    button,
    coordinator,
    frames,
    resizeCallbacks,
    scrollWrites,
    setScrollTop: (value: number) => {
      scrollTop = value;
    },
    setMessageRect: (values: RectValues) => {
      messageRect = values;
    },
  };
}

function wheel(viewport: HTMLElement, deltaY: number): void {
  viewport.dispatchEvent(new WheelEvent('wheel', { deltaY, bubbles: true }));
}

describe('ChatScrollCoordinator', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
    vi.restoreAllMocks();
  });

  it('does not let standalone scroll or layout callbacks change mode', () => {
    const harness = createHarness();
    harness.setScrollTop(300);

    harness.viewport.dispatchEvent(new Event('scroll'));
    expect(harness.coordinator.mode).toBe('FOLLOWING');

    wheel(harness.viewport, -10);
    expect(harness.coordinator.mode).toBe('DETACHED');

    harness.resizeCallbacks[0]([], {} as ResizeObserver);
    harness.resizeCallbacks[1]([], {} as ResizeObserver);
    expect(harness.coordinator.mode).toBe('DETACHED');
  });

  it('compensates a DETACHED content commit with the visible anchor', () => {
    const harness = createHarness();
    harness.setScrollTop(400);
    harness.coordinator.detach();
    expect(harness.coordinator.mode).toBe('DETACHED');

    const commit = harness.coordinator.beginContentCommit();
    expect(commit).not.toBeNull();
    harness.setMessageRect({ top: 70, bottom: 170 });
    harness.coordinator.endContentCommit(commit!);

    expect(harness.scrollWrites).toEqual([450]);
    expect(harness.coordinator.mode).toBe('DETACHED');
  });

  it('does not compensate layout while a user gesture is active', () => {
    const harness = createHarness();
    harness.setScrollTop(400);
    wheel(harness.viewport, -10);
    expect(harness.coordinator.mode).toBe('DETACHED');

    const commit = harness.coordinator.beginContentCommit()!;
    harness.setMessageRect({ top: 70, bottom: 170 });
    harness.coordinator.endContentCommit(commit);

    expect(harness.scrollWrites).toEqual([]);
    expect(harness.coordinator.mode).toBe('DETACHED');
  });

  it('coalesces content and viewport layout work into one FOLLOWING RAF write', () => {
    const harness = createHarness();
    const first = harness.coordinator.beginContentCommit();
    const second = harness.coordinator.beginContentCommit();
    expect(first).not.toBeNull();
    expect(second).not.toBeNull();

    harness.coordinator.endContentCommit(first!);
    harness.coordinator.endContentCommit(second!);
    harness.resizeCallbacks[0]([], {} as ResizeObserver);
    harness.resizeCallbacks[1]([], {} as ResizeObserver);

    expect(harness.frames).toHaveLength(1);
    expect(harness.scrollWrites).toEqual([]);
    harness.frames[0](0);
    expect(harness.scrollWrites).toEqual([800]);
    expect(harness.coordinator.mode).toBe('FOLLOWING');
  });

  it('invalidates old epoch commits, observers, and queued RAF callbacks', () => {
    const harness = createHarness({ sessionKey: 'current', mountEpoch: 7 });
    const oldCommit = harness.coordinator.beginContentCommit();
    expect(oldCommit).not.toBeNull();
    harness.coordinator.endContentCommit(oldCommit!);
    expect(harness.frames).toHaveLength(1);

    harness.coordinator.setMountIdentity({ sessionKey: 'current', mountEpoch: 8 });
    expect(harness.frames).toHaveLength(2); // 新 epoch 初始 tail 对齐
    harness.resizeCallbacks[0]([], {} as ResizeObserver);
    harness.frames[0](0); // 旧 epoch 回调
    expect(harness.scrollWrites).toEqual([]);

    harness.coordinator.endContentCommit(oldCommit!);
    expect(harness.frames).toHaveLength(2); // 旧 commit 不再排任何工作

    const currentCommit = harness.coordinator.beginContentCommit();
    expect(currentCommit?.mountEpoch).toBe(8);
    harness.coordinator.endContentCommit(currentCommit!);
    expect(harness.frames).toHaveLength(2); // 与新 epoch 已排队的 follow 合并
    harness.frames[1](0);
    expect(harness.scrollWrites).toEqual([800]);
  });

  it('invalidates a queued callback when its mount is destroyed', () => {
    const harness = createHarness();
    const commit = harness.coordinator.beginContentCommit();
    harness.coordinator.endContentCommit(commit!);
    expect(harness.frames).toHaveLength(1);

    harness.coordinator.destroy();
    harness.frames[0](0);
    expect(harness.scrollWrites).toEqual([]);
  });

  it('falls back to numeric scrollTop when snapshotting a disconnected viewport', () => {
    const harness = createHarness();
    harness.setScrollTop(345);
    harness.coordinator.detach();
    harness.viewport.remove();

    expect(harness.coordinator.snapshotSession()).toMatchObject({
      mode: 'DETACHED',
      scrollTop: 345,
      anchorKey: null,
    });
  });

  it('shows the static button only while DETACHED and click requests follow', () => {
    const harness = createHarness();
    expect(harness.button.hidden).toBe(true);
    expect(harness.button.getAttribute('aria-hidden')).toBe('true');

    harness.setScrollTop(300);
    wheel(harness.viewport, -10);
    expect(harness.coordinator.mode).toBe('DETACHED');
    expect(harness.button.hidden).toBe(false);
    expect(harness.button.getAttribute('aria-hidden')).toBe('false');

    harness.button.click();
    expect(harness.coordinator.mode).toBe('FOLLOWING');
    expect(harness.button.hidden).toBe(true);
    expect(harness.frames).toHaveLength(1);
    harness.frames[0](0);
    expect(harness.scrollWrites).toEqual([800]);
  });
});
