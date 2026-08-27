import type { RenderedMessageChunk } from './render-messages';

const RECONCILE_KEY_ATTRIBUTE = 'data-chat-reconcile-key';
const RECONCILE_REVISION_ATTRIBUTE = 'data-chat-reconcile-revision';
const MESSAGE_KEY_PREFIX = 'message:';
const LOAD_EARLIER_KEY = 'aux:load-earlier';
const EMPTY_KEY = 'aux:empty';

/** A non-message root which participates in the same keyed reconciliation. */
export interface ChatReconcilePlanItem {
  html: string;
  revision: string;
}

/**
 * `string` is accepted so refresh.ts can pass its existing HTML fields directly.
 * In that form the HTML itself is the revision.
 */
export type ChatAuxiliaryPlanItem = string | ChatReconcilePlanItem;

export interface ChatReconcileRequest {
  /** Stable parent whose direct children are owned by this reconciler. */
  contentLayer: HTMLElement;
  /** Permanent final child. It is never replaced or removed. */
  sentinel: Node;
  chunks: readonly RenderedMessageChunk[];
  loadEarlier?: ChatAuxiliaryPlanItem | null;
  empty?: ChatAuxiliaryPlanItem | null;
}

export interface ChatReconcileResult {
  reused: number;
  inserted: number;
  replaced: number;
  removed: number;
}

export interface ChatReconcileStageOptions {
  /** Number of new roots parsed between frame yields. Defaults to 20. */
  batchSize?: number;
  /** Injectable frame boundary, primarily useful to hosts and deterministic tests. */
  yieldToFrame?: () => Promise<void>;
  /** Final host/session guard checked after staging and before touching live DOM. */
  shouldCommit?: () => boolean;
  /** Called after detached staging and immediately before the live DOM commit. */
  beforeCommit?: () => void;
  /** Called immediately after a successful live DOM commit. */
  afterCommit?: () => void;
  /** Called after each detached parse batch. Every supplied node is disconnected. */
  onStageBatch?: (nodes: readonly HTMLElement[]) => void;
}

export type StagedChatReconcileResult =
  | { status: 'committed'; generation: number; result: ChatReconcileResult }
  | { status: 'cancelled'; generation: number };

type DesiredKind = 'message' | 'load-earlier' | 'empty';

interface DesiredItem {
  key: string;
  revision: string;
  html: string;
  kind: DesiredKind;
}

interface ExistingItem {
  node: HTMLElement;
  revision: string;
}

interface PlannedSlot {
  item: DesiredItem;
  node: HTMLElement | null;
  reuse: boolean;
  replacement: boolean;
}

interface ReconciliationPlan {
  request: ChatReconcileRequest;
  slots: PlannedSlot[];
  staging: DocumentFragment;
}

const generations = new WeakMap<HTMLElement, number>();

function nextGeneration(contentLayer: HTMLElement): number {
  const generation = (generations.get(contentLayer) ?? 0) + 1;
  generations.set(contentLayer, generation);
  return generation;
}

function isCurrentGeneration(contentLayer: HTMLElement, generation: number): boolean {
  return generations.get(contentLayer) === generation;
}

function normalizeAuxiliary(
  value: ChatAuxiliaryPlanItem | null | undefined,
  key: string,
  kind: Exclude<DesiredKind, 'message'>,
): DesiredItem | null {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value === 'string') {
    return { key, kind, html: value, revision: value };
  }
  return { key, kind, html: value.html, revision: value.revision };
}

function desiredItems(request: ChatReconcileRequest): DesiredItem[] {
  if (request.sentinel.parentNode !== request.contentLayer) {
    throw new Error('chat reconciler sentinel must be a direct child of contentLayer');
  }

  const result: DesiredItem[] = [];
  const loadEarlier = normalizeAuxiliary(request.loadEarlier, LOAD_EARLIER_KEY, 'load-earlier');
  if (loadEarlier) result.push(loadEarlier);

  const seenIds = new Set<string>();
  for (const chunk of request.chunks) {
    if (seenIds.has(chunk.id)) {
      throw new Error(`chat reconciler received duplicate chunk id: ${chunk.id}`);
    }
    seenIds.add(chunk.id);
    result.push({
      key: `${MESSAGE_KEY_PREFIX}${chunk.id}`,
      revision: chunk.renderKey,
      html: chunk.html,
      kind: 'message',
    });
  }

  if (request.chunks.length === 0) {
    const empty = normalizeAuxiliary(request.empty, EMPTY_KEY, 'empty');
    if (empty) result.push(empty);
  }
  return result;
}

function identityOf(node: HTMLElement): { key: string; revision: string } | null {
  const storedKey = node.getAttribute(RECONCILE_KEY_ATTRIBUTE);
  if (storedKey) {
    return {
      key: storedKey,
      revision:
        node.getAttribute(RECONCILE_REVISION_ATTRIBUTE) ?? node.dataset.renderKey ?? '',
    };
  }

  const messageId = node.dataset.streamId ?? node.dataset.messageId;
  if (!messageId) return null;
  return {
    key: `${MESSAGE_KEY_PREFIX}${messageId}`,
    revision: node.dataset.renderKey ?? '',
  };
}

function indexExisting(request: ChatReconcileRequest): Map<string, ExistingItem[]> {
  const existing = new Map<string, ExistingItem[]>();
  let node: ChildNode | null = request.contentLayer.firstChild;
  while (node && node !== request.sentinel) {
    if (node instanceof HTMLElement) {
      const identity = identityOf(node);
      if (identity) {
        const entries = existing.get(identity.key) ?? [];
        entries.push({ node, revision: identity.revision });
        existing.set(identity.key, entries);
      }
    }
    node = node.nextSibling;
  }
  return existing;
}

function createPlan(request: ChatReconcileRequest): ReconciliationPlan {
  const items = desiredItems(request);
  const existing = indexExisting(request);
  const claimed = new Set<HTMLElement>();
  const slots: PlannedSlot[] = [];

  for (const item of items) {
    const candidates = existing.get(item.key) ?? [];
    const exact = candidates.find(
      (candidate) => !claimed.has(candidate.node) && candidate.revision === item.revision,
    );
    if (exact) {
      claimed.add(exact.node);
      slots.push({ item, node: exact.node, reuse: true, replacement: false });
      continue;
    }
    slots.push({
      item,
      node: null,
      reuse: false,
      replacement: candidates.some((candidate) => !claimed.has(candidate.node)),
    });
  }

  return { request, slots, staging: document.createDocumentFragment() };
}

function parseRoot(item: DesiredItem): HTMLElement {
  const template = document.createElement('template');
  template.innerHTML = item.html;

  let root: HTMLElement | null = null;
  for (const child of template.content.childNodes) {
    if (child.nodeType === Node.TEXT_NODE && child.textContent?.trim() === '') continue;
    if (child.nodeType === Node.COMMENT_NODE) continue;
    if (!(child instanceof HTMLElement) || root !== null) {
      throw new Error(`chat reconciler item ${item.key} must render exactly one HTML root`);
    }
    root = child;
  }
  if (!root) {
    throw new Error(`chat reconciler item ${item.key} must render exactly one HTML root`);
  }

  root.setAttribute(RECONCILE_KEY_ATTRIBUTE, item.key);
  root.setAttribute(RECONCILE_REVISION_ATTRIBUTE, item.revision);
  if (item.kind === 'message') root.dataset.renderKey = item.revision;
  return root;
}

function stageSlot(plan: ReconciliationPlan, slot: PlannedSlot): HTMLElement {
  const root = parseRoot(slot.item);
  slot.node = root;
  plan.staging.append(root);
  return root;
}

function canReachWithoutCrossingSentinel(
  cursor: ChildNode | null,
  target: ChildNode,
  sentinel: Node,
): boolean {
  let node = cursor;
  while (node && node !== sentinel) {
    if (node === target) return true;
    node = node.nextSibling;
  }
  return false;
}

/**
 * Applies a fully staged plan. Obsolete roots are deliberately removed only
 * after every desired root has been placed.
 */
function commitPlan(plan: ReconciliationPlan): ChatReconcileResult {
  const { contentLayer, sentinel } = plan.request;
  if (sentinel.parentNode !== contentLayer) {
    throw new Error('chat reconciler sentinel changed parent before commit');
  }

  const claimed = new Set<Node>();
  let cursor: ChildNode | null = contentLayer.firstChild;
  let reused = 0;
  let inserted = 0;
  let replaced = 0;

  for (const slot of plan.slots) {
    const node = slot.node;
    if (!node) throw new Error(`chat reconciler item ${slot.item.key} was not staged`);
    claimed.add(node);

    if (slot.reuse) {
      if (node.parentNode !== contentLayer) {
        throw new Error(`chat reconciler reusable item ${slot.item.key} left contentLayer`);
      }
      reused += 1;
      if (canReachWithoutCrossingSentinel(cursor, node, sentinel)) {
        // It is already in the right relative order. Skipping obsolete nodes here
        // avoids detach/reinsert churn when deleting or replacing a predecessor.
        cursor = node.nextSibling;
        continue;
      }
    } else if (slot.replacement) {
      replaced += 1;
    } else {
      inserted += 1;
    }

    const reference = cursor?.parentNode === contentLayer ? cursor : sentinel;
    contentLayer.insertBefore(node, reference);
    cursor = node.nextSibling;
  }

  let removed = 0;
  for (const child of Array.from(contentLayer.childNodes)) {
    if (child === sentinel || claimed.has(child)) continue;
    contentLayer.removeChild(child);
    removed += 1;
  }

  if (contentLayer.lastChild !== sentinel) {
    throw new Error('chat reconciler failed to preserve sentinel as the final child');
  }
  return { reused, inserted, replaced, removed };
}

/**
 * Synchronous keyed reconciliation. Parsing still happens in a detached
 * fragment first, so malformed HTML cannot partially mutate the live layer.
 * Calling it invalidates any older staged reconciliation for the same layer.
 */
export function reconcileChatContent(request: ChatReconcileRequest): ChatReconcileResult {
  nextGeneration(request.contentLayer);
  const plan = createPlan(request);
  for (const slot of plan.slots) {
    if (!slot.reuse) stageSlot(plan, slot);
  }
  return commitPlan(plan);
}

function defaultYieldToFrame(): Promise<void> {
  return new Promise((resolve) => {
    if (typeof requestAnimationFrame === 'function') {
      requestAnimationFrame(() => resolve());
    } else {
      setTimeout(resolve, 0);
    }
  });
}

/**
 * Parses new/revised roots in detached batches. The live layer is untouched
 * until all batches finish; a newer sync or async request cancels this commit.
 */
export async function stageAndReconcileChatContent(
  request: ChatReconcileRequest,
  options: ChatReconcileStageOptions = {},
): Promise<StagedChatReconcileResult> {
  const batchSize = options.batchSize ?? 20;
  if (!Number.isInteger(batchSize) || batchSize <= 0) {
    throw new Error('chat reconciler batchSize must be a positive integer');
  }

  const generation = nextGeneration(request.contentLayer);
  const plan = createPlan(request);
  const createSlots = plan.slots.filter((slot) => !slot.reuse);
  const yieldToFrame = options.yieldToFrame ?? defaultYieldToFrame;

  for (let index = 0; index < createSlots.length; index += batchSize) {
    if (!isCurrentGeneration(request.contentLayer, generation)) {
      return { status: 'cancelled', generation };
    }

    const batch: HTMLElement[] = [];
    const end = Math.min(index + batchSize, createSlots.length);
    for (let slotIndex = index; slotIndex < end; slotIndex += 1) {
      batch.push(stageSlot(plan, createSlots[slotIndex]));
    }
    options.onStageBatch?.(batch);

    await yieldToFrame();
    if (!isCurrentGeneration(request.contentLayer, generation)) {
      return { status: 'cancelled', generation };
    }
  }

  if (
    !isCurrentGeneration(request.contentLayer, generation) ||
    options.shouldCommit?.() === false
  ) {
    return { status: 'cancelled', generation };
  }
  options.beforeCommit?.();
  const result = commitPlan(plan);
  options.afterCommit?.();
  return { status: 'committed', generation, result };
}
