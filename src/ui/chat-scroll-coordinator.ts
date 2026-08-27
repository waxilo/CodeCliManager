import {
  chatScrollReducer,
  createChatScrollState,
  type ChatScrollAction,
  type ChatScrollMode,
  type ChatScrollState,
  type UserScrollDirection,
} from './chat-scroll-reducer';

export interface ChatScrollMountIdentity {
  readonly sessionKey: string;
  readonly mountEpoch: number;
}

export interface ChatScrollCoordinatorOptions extends ChatScrollMountIdentity {
  /** The only element whose scrollTop this coordinator writes. */
  readonly viewport: HTMLElement;
  /** Element whose size represents the rendered chat content. */
  readonly content: HTMLElement;
  /** Stable element at the end of content, used for bottom detection. */
  readonly sentinel: HTMLElement;
  /** Existing static button; the coordinator never creates or removes it. */
  readonly followButton: HTMLElement;
  readonly bottomThresholdPx?: number;
  readonly transactionDebounceMs?: number;
  readonly requestFrame?: (callback: FrameRequestCallback) => number;
  readonly cancelFrame?: (handle: number) => void;
  readonly createResizeObserver?: (callback: ResizeObserverCallback) => ResizeObserver;
}

export interface ChatScrollContentCommit extends ChatScrollMountIdentity {
  readonly id: number;
}

export interface ChatScrollSessionSnapshot {
  readonly mode: ChatScrollMode;
  readonly scrollTop: number;
  readonly anchorKey: string | null;
  readonly anchorOffset: number;
}

interface DetachedAnchor {
  readonly node: HTMLElement;
  readonly viewportOffset: number;
}

interface LayoutSnapshot {
  readonly anchor: DetachedAnchor | null;
  readonly scrollTop: number;
}

const USER_SCROLL_KEYS = new Set([
  'ArrowUp',
  'ArrowDown',
  'PageUp',
  'PageDown',
  'Home',
  'End',
  ' ',
  'Spacebar',
]);

/** Owns every scrollTop write for one mounted main chat viewport. */
export class ChatScrollCoordinator {
  readonly viewport: HTMLElement;
  readonly content: HTMLElement;
  readonly sentinel: HTMLElement;
  readonly followButton: HTMLElement;

  private state: ChatScrollState = createChatScrollState();
  private mountIdentity: ChatScrollMountIdentity;
  private readonly bottomThresholdPx: number;
  private readonly transactionDebounceMs: number;
  private readonly requestFrame: (callback: FrameRequestCallback) => number;
  private readonly cancelFrame: (handle: number) => void;
  private readonly createResizeObserver:
    | ((callback: ResizeObserverCallback) => ResizeObserver)
    | undefined;
  private readonly resizeObservers: ResizeObserver[] = [];
  private readonly commits = new Map<number, LayoutSnapshot>();
  private nextCommitId = 1;
  private followFrame: number | null = null;
  private followGeneration = 0;
  private userEndTimer: ReturnType<typeof setTimeout> | null = null;
  private userEndGeneration = 0;
  private detachedAnchor: DetachedAnchor | null = null;
  private detachedScrollTop = 0;
  private lastObservedScrollTop = 0;
  private activePointerType = '';
  private expectedProgrammaticScrollTop: number | null = null;
  private destroyed = false;

  constructor(options: ChatScrollCoordinatorOptions) {
    this.viewport = options.viewport;
    this.content = options.content;
    this.sentinel = options.sentinel;
    this.followButton = options.followButton;
    this.mountIdentity = {
      sessionKey: options.sessionKey,
      mountEpoch: options.mountEpoch,
    };
    this.bottomThresholdPx = options.bottomThresholdPx ?? 24;
    this.transactionDebounceMs = options.transactionDebounceMs ?? 120;
    this.requestFrame = options.requestFrame
      ?? ((callback) => window.requestAnimationFrame(callback));
    this.cancelFrame = options.cancelFrame
      ?? ((handle) => window.cancelAnimationFrame(handle));
    this.createResizeObserver = options.createResizeObserver
      ?? (typeof ResizeObserver === 'undefined'
        ? undefined
        : (callback: ResizeObserverCallback) => new ResizeObserver(callback));
    this.lastObservedScrollTop = this.viewport.scrollTop;

    this.viewport.addEventListener('wheel', this.onWheel, { passive: true });
    this.viewport.addEventListener('pointerdown', this.onPointerDown, { passive: true });
    window.addEventListener('pointerup', this.onPointerEnd, { passive: true });
    window.addEventListener('pointercancel', this.onPointerCancel, { passive: true });
    this.viewport.addEventListener('keydown', this.onKeyDown);
    this.viewport.addEventListener('scroll', this.onScroll, { passive: true });
    this.viewport.addEventListener('scrollend', this.onScrollEnd);
    this.followButton.addEventListener('click', this.onFollowClick);

    this.observeLayout();
    this.renderButton();
  }

  get mode(): ChatScrollMode {
    return this.state.mode;
  }

  get sessionKey(): string {
    return this.mountIdentity.sessionKey;
  }

  get mountEpoch(): number {
    return this.mountIdentity.mountEpoch;
  }

  get identity(): ChatScrollMountIdentity {
    return { ...this.mountIdentity };
  }

  /** Snapshot a session without retaining DOM nodes across conversation switches. */
  snapshotSession(): ChatScrollSessionSnapshot {
    // 全壳重建时旧 viewport 可能已脱离文档；此时 DOMRect 全为 0，不能覆盖有效阅读几何。
    // 仍保存 scrollTop，待新壳恢复时使用数值 fallback。
    const anchor = this.mode === 'DETACHED' && this.viewport.isConnected
      ? this.captureAnchor()
      : null;
    const anchorNode = anchor?.node ?? null;
    return {
      mode: this.mode,
      scrollTop: this.viewport.scrollTop,
      anchorKey: anchorNode ? this.keyOf(anchorNode) : null,
      anchorOffset: anchor?.viewportOffset ?? 0,
    };
  }

  /** Reuse this stable viewport for another conversation and invalidate old callbacks. */
  activateSession(
    identity: ChatScrollMountIdentity,
    snapshot: ChatScrollSessionSnapshot | null = null,
  ): void {
    if (this.destroyed) return;
    const identityChanged = !this.sameIdentity(identity, this.mountIdentity);
    this.mountIdentity = { ...identity };
    this.cancelPendingFollow();
    this.clearUserEndTimer();
    this.commits.clear();
    this.activePointerType = '';
    this.lastObservedScrollTop = this.viewport.scrollTop;
    this.detachedAnchor = null;
    this.detachedScrollTop = snapshot?.scrollTop ?? 0;
    this.reduce({ type: 'ACTIVATE_SESSION', mode: snapshot?.mode ?? 'FOLLOWING' });
    if (snapshot?.mode === 'DETACHED') {
      const anchorNode = snapshot.anchorKey ? this.findByKey(snapshot.anchorKey) : null;
      if (anchorNode) {
        this.detachedAnchor = { node: anchorNode, viewportOffset: snapshot.anchorOffset };
        if (!this.restoreAnchor(this.detachedAnchor)) this.writeScrollTop(snapshot.scrollTop);
      } else {
        this.writeScrollTop(snapshot.scrollTop);
      }
      this.rememberDetachedPosition();
    } else {
      this.scheduleFollow();
    }
    if (identityChanged) {
      this.disconnectResizeObservers();
      this.observeLayout();
    }
    this.renderButton();
  }
  setMountIdentity(identity: ChatScrollMountIdentity): void {
    if (this.sameIdentity(identity, this.mountIdentity)) return;
    this.activateSession(identity);
  }

  /** Explicit user intent used by thinking/details interactions. */
  detach(identity: ChatScrollMountIdentity = this.identity): void {
    if (!this.isCurrent(identity)) return;
    this.reduce({ type: 'USER_TRANSACTION_BEGIN', direction: 'AWAY' });
    this.reduce({ type: 'USER_TRANSACTION_END', atBottom: false });
    this.cancelPendingFollow();
  }

  /** Coalesced intrinsic layout notification for markdown/highlight/image changes. */
  notifyIntrinsicLayoutChange(identity: ChatScrollMountIdentity = this.identity): void {
    if (!this.isCurrent(identity)) return;
    this.reconcileLayout({
      anchor: this.mode === 'DETACHED' ? this.detachedAnchor : null,
      scrollTop: this.mode === 'DETACHED' ? this.detachedScrollTop : this.viewport.scrollTop,
    });
  }

  /** Capture the reading position immediately before a content DOM mutation. */
  beginContentCommit(identity: ChatScrollMountIdentity = this.identity): ChatScrollContentCommit | null {
    if (!this.isCurrent(identity)) return null;
    const id = this.nextCommitId++;
    this.commits.set(id, {
      anchor: this.mode === 'DETACHED' ? this.captureAnchor() : null,
      scrollTop: this.viewport.scrollTop,
    });
    return { ...identity, id };
  }

  /** Reconcile a completed DOM mutation. Layout reconciliation never changes mode. */
  endContentCommit(commit: ChatScrollContentCommit): void {
    if (!this.isCurrent(commit)) return;
    const snapshot = this.commits.get(commit.id);
    if (!snapshot) return;
    this.commits.delete(commit.id);
    this.reconcileLayout(snapshot);
  }

  /** Enter FOLLOWING explicitly; normally called by the static follow button. */
  requestFollow(identity: ChatScrollMountIdentity = this.identity): void {
    if (!this.isCurrent(identity)) return;
    this.reduce({ type: 'REQUEST_FOLLOW' });
    this.scheduleFollow();
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.viewport.removeEventListener('wheel', this.onWheel);
    this.viewport.removeEventListener('pointerdown', this.onPointerDown);
    window.removeEventListener('pointerup', this.onPointerEnd);
    window.removeEventListener('pointercancel', this.onPointerCancel);
    this.viewport.removeEventListener('keydown', this.onKeyDown);
    this.viewport.removeEventListener('scroll', this.onScroll);
    this.viewport.removeEventListener('scrollend', this.onScrollEnd);
    this.followButton.removeEventListener('click', this.onFollowClick);
    this.disconnectResizeObservers();
    this.commits.clear();
    this.cancelPendingFollow();
    this.clearUserEndTimer();
  }

  private observeLayout(): void {
    if (!this.createResizeObserver) return;
    const identity = this.identity;
    const callback: ResizeObserverCallback = () => {
      if (!this.isCurrent(identity)) return;
      if (this.mode === 'FOLLOWING') {
        this.reduce({ type: 'LAYOUT_CHANGED' });
        this.scheduleFollow();
        return;
      }
      this.reconcileLayout({
        anchor: this.detachedAnchor,
        scrollTop: this.detachedScrollTop,
      });
    };
    const contentObserver = this.createResizeObserver(callback);
    const viewportObserver = this.createResizeObserver(callback);
    contentObserver.observe(this.content);
    viewportObserver.observe(this.viewport);
    this.resizeObservers.push(contentObserver, viewportObserver);
  }

  private disconnectResizeObservers(): void {
    this.resizeObservers.forEach((observer) => observer.disconnect());
    this.resizeObservers.length = 0;
  }

  private readonly onWheel = (event: WheelEvent): void => {
    if (event.deltaY === 0) return;
    this.beginUserTransaction(event.deltaY < 0 ? 'AWAY' : 'TOWARD');
  };

  private readonly onPointerDown = (event: PointerEvent): void => {
    this.activePointerType = event.pointerType;
    this.lastObservedScrollTop = this.viewport.scrollTop;
    this.beginUserTransaction('UNKNOWN', false);
  };

  private readonly onPointerEnd = (): void => {
    const pointerType = this.activePointerType;
    this.activePointerType = '';
    // Touch scrolling can continue with inertia after pointerup. scrollend/debounce
    // owns the transaction end so momentum remains classified as user scroll.
    if (pointerType === 'touch') {
      this.armUserEndTimer();
      return;
    }
    this.finishUserTransaction();
  };

  private readonly onPointerCancel = (): void => {
    this.activePointerType = '';
    this.finishUserTransaction();
  };

  private readonly onKeyDown = (event: KeyboardEvent): void => {
    if (event.target !== this.viewport || !USER_SCROLL_KEYS.has(event.key)) return;
    if (event.key === 'End') {
      this.requestFollow();
      return;
    }
    const away =
      event.key === 'ArrowUp' ||
      event.key === 'PageUp' ||
      event.key === 'Home' ||
      ((event.key === ' ' || event.key === 'Spacebar') && event.shiftKey);
    this.beginUserTransaction(away ? 'AWAY' : 'TOWARD');
  };

  private readonly onScroll = (): void => {
    const scrollTop = this.viewport.scrollTop;
    if (
      this.expectedProgrammaticScrollTop !== null &&
      Math.abs(scrollTop - this.expectedProgrammaticScrollTop) <= 0.5
    ) {
      this.expectedProgrammaticScrollTop = null;
      this.lastObservedScrollTop = scrollTop;
      this.reduce({ type: 'PROGRAMMATIC_SCROLL' });
      return;
    }
    this.expectedProgrammaticScrollTop = null;
    if (!this.state.userTransactionActive) {
      this.lastObservedScrollTop = scrollTop;
      return;
    }
    const direction: UserScrollDirection = scrollTop < this.lastObservedScrollTop
      ? 'AWAY'
      : scrollTop > this.lastObservedScrollTop
        ? 'TOWARD'
        : 'UNKNOWN';
    this.lastObservedScrollTop = scrollTop;
    this.reduce({ type: 'USER_SCROLL_POSITION', direction });
    if (this.mode === 'DETACHED') this.rememberDetachedPosition();
    if (!this.activePointerType) this.armUserEndTimer();
  };

  private readonly onScrollEnd = (): void => {
    this.finishUserTransaction();
  };

  private readonly onFollowClick = (): void => {
    this.requestFollow();
  };

  private beginUserTransaction(
    direction: UserScrollDirection,
    armEndTimer = true,
  ): void {
    this.lastObservedScrollTop = this.viewport.scrollTop;
    this.reduce({ type: 'USER_TRANSACTION_BEGIN', direction });
    if (direction === 'AWAY') this.cancelPendingFollow();
    if (armEndTimer) this.armUserEndTimer();
  }

  private finishUserTransaction(): void {
    if (!this.state.userTransactionActive) return;
    this.clearUserEndTimer();
    this.reduce({ type: 'USER_TRANSACTION_END', atBottom: this.isAtBottom() });
    if (this.mode === 'DETACHED') this.rememberDetachedPosition();
  }

  private armUserEndTimer(): void {
    this.clearUserEndTimer();
    const identity = this.identity;
    const generation = ++this.userEndGeneration;
    this.userEndTimer = setTimeout(() => {
      if (generation !== this.userEndGeneration || !this.isCurrent(identity)) return;
      this.userEndTimer = null;
      this.finishUserTransaction();
    }, this.transactionDebounceMs);
  }

  private clearUserEndTimer(): void {
    this.userEndGeneration += 1;
    if (this.userEndTimer === null) return;
    clearTimeout(this.userEndTimer);
    this.userEndTimer = null;
  }

  private reconcileLayout(snapshot: LayoutSnapshot): void {
    this.reduce({ type: 'LAYOUT_CHANGED' });
    // 用户手势拥有最高优先级：commit/图片/字体/高亮变化不得与手指或滚动条争抢位置。
    // 手势 settle 后会按真实位置重新捕获 detached anchor。
    if (this.state.userTransactionActive) {
      if (this.mode === 'DETACHED') this.rememberDetachedPosition();
      return;
    }
    if (this.mode === 'FOLLOWING') {
      this.scheduleFollow();
      return;
    }
    const anchored = snapshot.anchor ? this.restoreAnchor(snapshot.anchor) : false;
    if (!anchored) this.writeScrollTop(snapshot.scrollTop);
    this.rememberDetachedPosition();
  }

  private scheduleFollow(): void {
    if (this.followFrame !== null) return;
    const identity = this.identity;
    const generation = ++this.followGeneration;
    this.followFrame = this.requestFrame(() => {
      if (generation !== this.followGeneration || !this.isCurrent(identity)) return;
      this.followFrame = null;
      if (this.mode !== 'FOLLOWING') return;
      this.reduce({ type: 'PROGRAMMATIC_SCROLL' });
      this.writeScrollTop(this.bottomScrollTop());
    });
  }

  private cancelPendingFollow(): void {
    this.followGeneration += 1;
    if (this.followFrame === null) return;
    this.cancelFrame(this.followFrame);
    this.followFrame = null;
  }

  private rememberDetachedPosition(): void {
    this.detachedAnchor = this.captureAnchor();
    this.detachedScrollTop = this.viewport.scrollTop;
  }

  private captureAnchor(): DetachedAnchor | null {
    const viewportTop = this.viewport.getBoundingClientRect().top;
    for (const child of Array.from(this.content.children)) {
      if (!(child instanceof HTMLElement)) continue;
      const rect = child.getBoundingClientRect();
      if (rect.bottom > viewportTop) {
        return { node: child, viewportOffset: rect.top - viewportTop };
      }
    }
    return null;
  }

  private restoreAnchor(anchor: DetachedAnchor): boolean {
    if (!anchor.node.isConnected || !this.content.contains(anchor.node)) return false;
    const viewportTop = this.viewport.getBoundingClientRect().top;
    const currentOffset = anchor.node.getBoundingClientRect().top - viewportTop;
    const delta = currentOffset - anchor.viewportOffset;
    if (delta !== 0) this.writeScrollTop(this.viewport.scrollTop + delta);
    return true;
  }

  private isAtBottom(): boolean {
    const viewportRect = this.viewport.getBoundingClientRect();
    const sentinelRect = this.sentinel.getBoundingClientRect();
    if (sentinelRect.bottom !== 0 || viewportRect.bottom !== 0) {
      return sentinelRect.bottom <= viewportRect.bottom + this.bottomThresholdPx;
    }
    return this.bottomScrollTop() - this.viewport.scrollTop <= this.bottomThresholdPx;
  }

  private bottomScrollTop(): number {
    return Math.max(0, this.viewport.scrollHeight - this.viewport.clientHeight);
  }

  private writeScrollTop(value: number): void {
    const next = Math.max(0, value);
    this.expectedProgrammaticScrollTop = next;
    this.viewport.scrollTop = next;
    this.lastObservedScrollTop = this.viewport.scrollTop;
  }

  private reduce(action: ChatScrollAction): void {
    const next = chatScrollReducer(this.state, action);
    if (next === this.state) return;
    const previousMode = this.state.mode;
    this.state = next;
    if (next.mode === previousMode) return;
    if (next.mode === 'DETACHED') {
      this.rememberDetachedPosition();
    } else {
      this.detachedAnchor = null;
    }
    this.renderButton();
  }

  private keyOf(node: HTMLElement): string | null {
    return node.dataset.chatReconcileKey
      ?? (node.dataset.streamId ? `message:${node.dataset.streamId}` : null)
      ?? (node.dataset.messageId ? `message:${node.dataset.messageId}` : null);
  }

  private findByKey(key: string): HTMLElement | null {
    for (const child of Array.from(this.content.children)) {
      if (child instanceof HTMLElement && this.keyOf(child) === key) return child;
    }
    return null;
  }

  private renderButton(): void {
    const visible = this.mode === 'DETACHED';
    this.followButton.hidden = !visible;
    this.followButton.classList.toggle('visible', visible);
    this.followButton.setAttribute('aria-hidden', String(!visible));
  }

  private isCurrent(identity: ChatScrollMountIdentity): boolean {
    return !this.destroyed && this.sameIdentity(identity, this.mountIdentity);
  }

  private sameIdentity(left: ChatScrollMountIdentity, right: ChatScrollMountIdentity): boolean {
    return left.sessionKey === right.sessionKey && left.mountEpoch === right.mountEpoch;
  }
}
