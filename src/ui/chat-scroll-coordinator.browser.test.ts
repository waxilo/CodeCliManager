import { afterEach, describe, expect, it } from 'vitest';
import { ChatScrollCoordinator } from './chat-scroll-coordinator';

let activeCoordinator: ChatScrollCoordinator | null = null;

function row(id: string): HTMLElement {
  const element = document.createElement('div');
  element.dataset.chatReconcileKey = `message:${id}`;
  element.textContent = id;
  element.style.height = '40px';
  element.style.flex = '0 0 40px';
  return element;
}

function setup(rowCount = 20): {
  viewport: HTMLElement;
  content: HTMLElement;
  sentinel: HTMLElement;
  button: HTMLButtonElement;
  coordinator: ChatScrollCoordinator;
} {
  document.body.innerHTML = `
    <div id="viewport" tabindex="0" style="height:200px;width:320px;overflow-y:auto;overflow-anchor:none">
      <div id="content" style="display:flex;flex-direction:column;min-height:100%">
        <div id="sentinel" style="height:1px;flex:0 0 1px"></div>
      </div>
    </div>
    <button id="follow" type="button">Follow</button>
  `;
  const viewport = document.querySelector<HTMLElement>('#viewport')!;
  const content = document.querySelector<HTMLElement>('#content')!;
  const sentinel = document.querySelector<HTMLElement>('#sentinel')!;
  const button = document.querySelector<HTMLButtonElement>('#follow')!;
  for (let index = 0; index < rowCount; index += 1) {
    content.insertBefore(row(`m${index}`), sentinel);
  }
  const coordinator = new ChatScrollCoordinator({
    viewport,
    content,
    sentinel,
    followButton: button,
    sessionKey: 'browser-session',
    mountEpoch: 1,
    transactionDebounceMs: 20,
  });
  activeCoordinator = coordinator;
  return { viewport, content, sentinel, button, coordinator };
}

function nextFrame(): Promise<void> {
  return new Promise((resolve) => requestAnimationFrame(() => resolve()));
}

function distanceToBottom(viewport: HTMLElement): number {
  return viewport.scrollHeight - viewport.clientHeight - viewport.scrollTop;
}

function detachByWheel(viewport: HTMLElement, scrollTop: number): void {
  viewport.dispatchEvent(new WheelEvent('wheel', { deltaY: -40, bubbles: true }));
  viewport.scrollTop = scrollTop;
  viewport.dispatchEvent(new Event('scroll'));
  viewport.dispatchEvent(new Event('scrollend'));
}

afterEach(() => {
  activeCoordinator?.destroy();
  activeCoordinator = null;
  document.body.innerHTML = '';
});

describe('ChatScrollCoordinator browser geometry', () => {
  it('FOLLOWING converges to the permanent sentinel after real content growth', async () => {
    const { viewport, content, sentinel, coordinator } = setup();
    coordinator.requestFollow();
    await nextFrame();
    expect(Math.abs(distanceToBottom(viewport))).toBeLessThanOrEqual(1);

    const commit = coordinator.beginContentCommit()!;
    for (let index = 20; index < 25; index += 1) {
      content.insertBefore(row(`m${index}`), sentinel);
    }
    coordinator.endContentCommit(commit);
    await nextFrame();

    expect(coordinator.mode).toBe('FOLLOWING');
    expect(Math.abs(distanceToBottom(viewport))).toBeLessThanOrEqual(1);
  });

  it('DETACHED preserves a visible anchor across a real prepend', async () => {
    const { viewport, content, sentinel, coordinator } = setup();
    coordinator.requestFollow();
    await nextFrame();
    detachByWheel(viewport, 320);
    expect(coordinator.mode).toBe('DETACHED');

    const anchor = content.querySelector<HTMLElement>('[data-chat-reconcile-key="message:m8"]')!;
    const beforeTop = anchor.getBoundingClientRect().top;
    const commit = coordinator.beginContentCommit()!;
    content.insertBefore(row('older'), content.firstElementChild ?? sentinel);
    coordinator.endContentCommit(commit);
    const afterTop = anchor.getBoundingClientRect().top;

    expect(coordinator.mode).toBe('DETACHED');
    expect(Math.abs(afterTop - beforeTop)).toBeLessThanOrEqual(1);
  });

  it('layout shortening cannot re-follow; the static button is the explicit recovery path', async () => {
    const { viewport, content, button, coordinator } = setup();
    coordinator.requestFollow();
    await nextFrame();
    detachByWheel(viewport, 300);
    expect(coordinator.mode).toBe('DETACHED');
    expect(button.hidden).toBe(false);

    const commit = coordinator.beginContentCommit()!;
    for (const child of [...content.children]) {
      if (!child.hasAttribute('id')) child.remove();
    }
    coordinator.endContentCommit(commit);
    await nextFrame();

    expect(distanceToBottom(viewport)).toBeLessThanOrEqual(1);
    expect(coordinator.mode).toBe('DETACHED');
    expect(button.hidden).toBe(false);

    button.click();
    await nextFrame();
    expect(coordinator.mode).toBe('FOLLOWING');
    expect(button.hidden).toBe(true);
    expect(Math.abs(distanceToBottom(viewport))).toBeLessThanOrEqual(1);
  });
});
