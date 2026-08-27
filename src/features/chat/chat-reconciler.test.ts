import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { RenderedMessageChunk } from './render-messages';
import {
  reconcileChatContent,
  stageAndReconcileChatContent,
  type ChatReconcileRequest,
} from './chat-reconciler';

function chunk(id: string, revision = 'r1', text = id): RenderedMessageChunk {
  return {
    id,
    renderKey: revision,
    html: `<article class="message" data-message-id="${id}">${text}</article>`,
  };
}

function shell(): { contentLayer: HTMLElement; sentinel: HTMLElement } {
  document.body.innerHTML = '<main id="layer"><button id="sentinel">end</button></main>';
  return {
    contentLayer: document.querySelector<HTMLElement>('#layer')!,
    sentinel: document.querySelector<HTMLElement>('#sentinel')!,
  };
}

function request(
  contentLayer: HTMLElement,
  sentinel: HTMLElement,
  chunks: readonly RenderedMessageChunk[],
  extras: Partial<Pick<ChatReconcileRequest, 'loadEarlier' | 'empty'>> = {},
): ChatReconcileRequest {
  return { contentLayer, sentinel, chunks, ...extras };
}

function message(contentLayer: HTMLElement, id: string): HTMLElement {
  const result = contentLayer.querySelector<HTMLElement>(`[data-message-id="${id}"]`);
  if (!result) throw new Error(`missing message ${id}`);
  return result;
}

function messageIds(contentLayer: HTMLElement): string[] {
  return Array.from(contentLayer.querySelectorAll<HTMLElement>('[data-message-id]')).map(
    (node) => node.dataset.messageId!,
  );
}

function removedNodes(observer: MutationObserver): Node[] {
  return observer.takeRecords().flatMap((record) => Array.from(record.removedNodes));
}

async function releaseFrame(
  releases: Array<() => void>,
  index: number,
): Promise<void> {
  expect(releases.length).toBeGreaterThan(index);
  releases[index]();
  await Promise.resolve();
}

describe('chat cursor reconciler', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
    vi.restoreAllMocks();
  });

  it('appends only the new root and keeps existing roots connected', () => {
    const { contentLayer, sentinel } = shell();
    reconcileChatContent(request(contentLayer, sentinel, [chunk('a'), chunk('b')]));
    const a = message(contentLayer, 'a');
    const b = message(contentLayer, 'b');
    const observer = new MutationObserver(() => undefined);
    observer.observe(contentLayer, { childList: true });

    reconcileChatContent(request(contentLayer, sentinel, [chunk('a'), chunk('b'), chunk('c')]));

    expect(messageIds(contentLayer)).toEqual(['a', 'b', 'c']);
    expect(message(contentLayer, 'a')).toBe(a);
    expect(message(contentLayer, 'b')).toBe(b);
    expect(a.isConnected).toBe(true);
    expect(b.isConnected).toBe(true);
    expect(removedNodes(observer)).toEqual([]);
    expect(contentLayer.lastChild).toBe(sentinel);
  });

  it('inserts in the middle with insertBefore without moving neighbours', () => {
    const { contentLayer, sentinel } = shell();
    reconcileChatContent(request(contentLayer, sentinel, [chunk('a'), chunk('c')]));
    const a = message(contentLayer, 'a');
    const c = message(contentLayer, 'c');
    const insertBefore = vi.spyOn(contentLayer, 'insertBefore');
    const observer = new MutationObserver(() => undefined);
    observer.observe(contentLayer, { childList: true });

    reconcileChatContent(request(contentLayer, sentinel, [chunk('a'), chunk('b'), chunk('c')]));

    const b = message(contentLayer, 'b');
    expect(messageIds(contentLayer)).toEqual(['a', 'b', 'c']);
    expect(message(contentLayer, 'a')).toBe(a);
    expect(message(contentLayer, 'c')).toBe(c);
    expect(insertBefore).toHaveBeenCalledWith(b, c);
    expect(insertBefore).not.toHaveBeenCalledWith(a, expect.anything());
    expect(insertBefore).not.toHaveBeenCalledWith(c, expect.anything());
    expect(removedNodes(observer)).toEqual([]);
  });

  it('replaces only the root whose revision changed and never clears a non-empty layer', () => {
    const { contentLayer, sentinel } = shell();
    reconcileChatContent(request(contentLayer, sentinel, [chunk('a'), chunk('b'), chunk('c')]));
    const a = message(contentLayer, 'a');
    const oldB = message(contentLayer, 'b');
    const c = message(contentLayer, 'c');
    const childCountsBeforeRemoval: number[] = [];
    const nativeRemoveChild = contentLayer.removeChild.bind(contentLayer);
    vi.spyOn(contentLayer, 'removeChild').mockImplementation(<T extends Node>(node: T): T => {
      childCountsBeforeRemoval.push(contentLayer.childNodes.length);
      return nativeRemoveChild(node) as T;
    });
    const observer = new MutationObserver(() => undefined);
    observer.observe(contentLayer, { childList: true });

    reconcileChatContent(
      request(contentLayer, sentinel, [chunk('a'), chunk('b', 'r2', 'updated'), chunk('c')]),
    );

    const newB = message(contentLayer, 'b');
    expect(newB).not.toBe(oldB);
    expect(newB.textContent).toBe('updated');
    expect(message(contentLayer, 'a')).toBe(a);
    expect(message(contentLayer, 'c')).toBe(c);
    expect(a.isConnected).toBe(true);
    expect(c.isConnected).toBe(true);
    expect(oldB.isConnected).toBe(false);
    expect(childCountsBeforeRemoval.every((count) => count > 1)).toBe(true);
    expect(removedNodes(observer)).toEqual([oldB]);
    expect(contentLayer.lastChild).toBe(sentinel);
  });

  it('deletes obsolete roots last without detaching retained roots', () => {
    const { contentLayer, sentinel } = shell();
    reconcileChatContent(request(contentLayer, sentinel, [chunk('a'), chunk('b'), chunk('c')]));
    const a = message(contentLayer, 'a');
    const b = message(contentLayer, 'b');
    const c = message(contentLayer, 'c');
    const observer = new MutationObserver(() => undefined);
    observer.observe(contentLayer, { childList: true });

    reconcileChatContent(request(contentLayer, sentinel, [chunk('a'), chunk('c')]));

    expect(messageIds(contentLayer)).toEqual(['a', 'c']);
    expect(message(contentLayer, 'a')).toBe(a);
    expect(message(contentLayer, 'c')).toBe(c);
    expect(a.isConnected).toBe(true);
    expect(c.isConnected).toBe(true);
    expect(b.isConnected).toBe(false);
    expect(removedNodes(observer)).toEqual([b]);
    expect(contentLayer.lastChild).toBe(sentinel);
  });

  it('reconciles loadEarlier and empty plan items around message roots', () => {
    const { contentLayer, sentinel } = shell();
    const loadEarlier = {
      revision: 'page-1',
      html: '<button class="load-earlier">Load earlier</button>',
    };
    reconcileChatContent(
      request(contentLayer, sentinel, [chunk('a')], {
        loadEarlier,
        empty: '<p class="empty">Nothing here</p>',
      }),
    );
    const loadNode = contentLayer.querySelector<HTMLElement>('.load-earlier')!;
    const a = message(contentLayer, 'a');

    reconcileChatContent(request(contentLayer, sentinel, [chunk('a')], { loadEarlier }));
    expect(contentLayer.firstChild).toBe(loadNode);
    expect(message(contentLayer, 'a')).toBe(a);
    expect(contentLayer.querySelector('.empty')).toBeNull();

    reconcileChatContent(
      request(contentLayer, sentinel, [], {
        empty: { revision: 'empty-1', html: '<p class="empty">Nothing here</p>' },
      }),
    );
    expect(contentLayer.querySelector('.load-earlier')).toBeNull();
    expect(contentLayer.querySelector('.empty')?.textContent).toBe('Nothing here');
    expect(contentLayer.lastChild).toBe(sentinel);
  });

  it('preserves the permanent sentinel identity as the final child across every operation', () => {
    const { contentLayer, sentinel } = shell();
    const originalSentinel = sentinel;

    reconcileChatContent(request(contentLayer, sentinel, [chunk('a'), chunk('b')]));
    reconcileChatContent(request(contentLayer, sentinel, [chunk('x'), chunk('a', 'r2')]));
    reconcileChatContent(request(contentLayer, sentinel, [], { empty: '<p>empty</p>' }));

    expect(document.querySelector('#sentinel')).toBe(originalSentinel);
    expect(originalSentinel.isConnected).toBe(true);
    expect(originalSentinel.parentNode).toBe(contentLayer);
    expect(contentLayer.lastChild).toBe(originalSentinel);
  });

  it('stages large additions detached over frames and commits only after all parsing', async () => {
    const { contentLayer, sentinel } = shell();
    reconcileChatContent(request(contentLayer, sentinel, [chunk('old')]));
    const old = message(contentLayer, 'old');
    const initialChildren = Array.from(contentLayer.childNodes);
    const releases: Array<() => void> = [];
    const stagedConnectivity: boolean[][] = [];

    const pending = stageAndReconcileChatContent(
      request(contentLayer, sentinel, [
        chunk('a'),
        chunk('b'),
        chunk('c'),
        chunk('d'),
        chunk('e'),
      ]),
      {
        batchSize: 2,
        yieldToFrame: () => new Promise<void>((resolve) => releases.push(resolve)),
        onStageBatch: (nodes) => stagedConnectivity.push(nodes.map((node) => node.isConnected)),
      },
    );

    expect(stagedConnectivity).toEqual([[false, false]]);
    expect(Array.from(contentLayer.childNodes)).toEqual(initialChildren);
    expect(old.isConnected).toBe(true);

    await releaseFrame(releases, 0);
    expect(stagedConnectivity).toEqual([[false, false], [false, false]]);
    expect(Array.from(contentLayer.childNodes)).toEqual(initialChildren);

    await releaseFrame(releases, 1);
    expect(stagedConnectivity).toEqual([[false, false], [false, false], [false]]);
    expect(Array.from(contentLayer.childNodes)).toEqual(initialChildren);

    await releaseFrame(releases, 2);
    await expect(pending).resolves.toMatchObject({ status: 'committed' });
    expect(messageIds(contentLayer)).toEqual(['a', 'b', 'c', 'd', 'e']);
    expect(old.isConnected).toBe(false);
    expect(contentLayer.lastChild).toBe(sentinel);
  });

  it('a newer generation cancels an older staged commit and leaves no staged nodes live', async () => {
    const { contentLayer, sentinel } = shell();
    reconcileChatContent(request(contentLayer, sentinel, [chunk('base')]));
    const base = message(contentLayer, 'base');
    const releases: Array<() => void> = [];
    const oldStaged: HTMLElement[] = [];

    const oldPending = stageAndReconcileChatContent(
      request(contentLayer, sentinel, [chunk('old-a'), chunk('old-b'), chunk('old-c')]),
      {
        batchSize: 1,
        yieldToFrame: () => new Promise<void>((resolve) => releases.push(resolve)),
        onStageBatch: (nodes) => oldStaged.push(...nodes),
      },
    );
    expect(messageIds(contentLayer)).toEqual(['base']);

    const newer = reconcileChatContent(
      request(contentLayer, sentinel, [chunk('base'), chunk('new')]),
    );
    expect(newer.inserted).toBe(1);
    expect(message(contentLayer, 'base')).toBe(base);

    await releaseFrame(releases, 0);
    await expect(oldPending).resolves.toMatchObject({ status: 'cancelled' });
    expect(messageIds(contentLayer)).toEqual(['base', 'new']);
    expect(oldStaged.every((node) => !node.isConnected)).toBe(true);
    expect(contentLayer.lastChild).toBe(sentinel);
  });
});
