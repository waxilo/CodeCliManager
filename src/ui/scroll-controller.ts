export interface ScrollControllerOptions {
  /** 距离底部多少 px 时判定为"在底部"（触发恢复自动滚动） */
  resumePx: number;
  /** 是否创建浮动"回到底部"按钮 */
  createButton?: boolean;
  /** 按钮挂载宿主；默认挂在滚动容器内 */
  buttonHost?: HTMLElement;
  /** 滚动按钮的 CSS class */
  buttonClass?: string;
  /** 是否阻止 wheel 事件冒泡（嵌套滚动容器使用，避免影响父容器） */
  stopWheelPropagation?: boolean;
  /** 用户明确输入滚动意图时的回调：嵌套容器用它同步关闭父容器的自动跟随 */
  onUserScroll?: () => void;
}

export interface ScrollAnchor {
  id: string;
  offsetTop: number;
}

export interface ScrollSnapshot {
  autoScroll: boolean;
  scrollTop: number;
  anchor: ScrollAnchor | null;
}

export class ScrollController {
  readonly el: HTMLElement;
  autoScroll = true;
  private opts: ScrollControllerOptions & { resumePx: number };
  private rafId: number | null = null;
  private anchorRafId: number | null = null;
  private buttonEl: HTMLElement | null = null;
  private buttonClickHandler: (() => void) | null = null;
  private resizeObserver: ResizeObserver | null = null;
  private mutationObserver: MutationObserver | null = null;
  private anchor: ScrollAnchor | null = null;
  private pendingNewContent = false;
  private pointerScrollActive = false;
  private resumeFromUserInput = false;
  private userIntentRafId: number | null = null;
  private addedTabIndex = false;

  constructor(el: HTMLElement, opts: ScrollControllerOptions) {
    this.el = el;
    this.opts = {
      resumePx: opts.resumePx,
      createButton: opts.createButton ?? false,
      buttonHost: opts.buttonHost,
      buttonClass: opts.buttonClass ?? 'scroll-to-bottom-btn',
      stopWheelPropagation: opts.stopWheelPropagation ?? false,
      onUserScroll: opts.onUserScroll,
    };

    this.lastScrollTop = el.scrollTop;
    // 只有可确认的输入事件能关闭自动跟随；布局变化产生的 scroll 不能冒充用户上滑。
    el.addEventListener('wheel', this._onWheel, { passive: true });
    el.addEventListener('pointerdown', this._onPointerDown, { passive: true });
    el.addEventListener('pointerup', this._onPointerEnd, { passive: true });
    el.addEventListener('pointercancel', this._onPointerEnd, { passive: true });
    el.addEventListener('keydown', this._onKeyDown);
    // scroll 只同步实际位置、阅读锚点和按钮状态。
    el.addEventListener('scroll', this._onScroll, { passive: true });
    if (!el.hasAttribute('tabindex')) {
      el.tabIndex = 0;
      this.addedTabIndex = true;
    }

    // 流式 Markdown、图片缩略图、工具卡展开都会异步改变高度。用户阅读上方时，
    // 以可见消息锚点补偿高度变化，避免视口看起来“跳动”。
    if (typeof ResizeObserver !== 'undefined') {
      this.resizeObserver = new ResizeObserver(this._onObservedLayoutChange);
      this.resizeObserver.observe(el);
    }
    if (typeof MutationObserver !== 'undefined') {
      this.mutationObserver = new MutationObserver(this._onObservedLayoutChange);
      this.mutationObserver.observe(el, { childList: true, subtree: true, characterData: true });
    }

    if (this.opts.createButton) {
      this._createButton();
    }
  }

  /** 新内容到达时调用；RAF 执行前再次检查，用户刚上滑就不会被旧队列拉回底部。 */
  onNewContent(): void {
    if (!this.autoScroll) {
      this.pendingNewContent = true;
      this._updateButton();
      return;
    }
    if (this.rafId !== null) return;
    this.rafId = requestAnimationFrame(() => {
      this.rafId = null;
      if (!this.autoScroll) {
        this.pendingNewContent = true;
        this._updateButton();
        return;
      }
      this._scrollToBottom();
    });
  }

  pauseFollow(): void {
    this._clearResumeIntent();
    this.autoScroll = false;
    // 用户可在上方继续滚动；每次都刷新锚点，后续高度变化才会保持其当前阅读位置。
    this.anchor = this.captureAnchor();
    this._updateButton();
  }

  /** 立即置底并开启自动滚动 */
  scrollToBottom(): void {
    this._clearResumeIntent();
    this.autoScroll = true;
    this.anchor = null;
    this.pendingNewContent = false;
    this._scrollToBottom();
    this._updateButton();
  }

  isNearBottom(): boolean {
    return this._isNearBottom();
  }

  captureAnchor(): ScrollAnchor | null {
    const containerTop = this.el.getBoundingClientRect().top;
    const nodes = this.el.querySelectorAll<HTMLElement>('.message[data-message-id], .message[data-stream-id]');
    for (const node of nodes) {
      const rect = node.getBoundingClientRect();
      if (rect.bottom > containerTop) {
        const id = node.dataset.messageId || node.dataset.streamId;
        if (id) return { id, offsetTop: rect.top - containerTop };
      }
    }
    return null;
  }

  snapshot(): ScrollSnapshot {
    return {
      autoScroll: this.autoScroll,
      scrollTop: this.el.scrollTop,
      anchor: this.autoScroll ? null : this.captureAnchor(),
    };
  }

  /** 重建后恢复用户阅读锚点；找不到锚点时才退化到数值 scrollTop。 */
  restoreSnapshot(snapshot: ScrollSnapshot | null): void {
    if (!snapshot || snapshot.autoScroll) {
      this.scrollToBottom();
      return;
    }
    this._clearResumeIntent();
    this.autoScroll = false;
    this.anchor = snapshot.anchor;
    if (!this.restoreAnchor(snapshot.anchor)) {
      this._setScrollTop(snapshot.scrollTop);
    }
    this._updateButton();
  }

  /** 兼容旧调用方；后续统一改用 snapshot/restoreSnapshot。 */
  restorePosition(scrollTop: number, autoScroll: boolean): void {
    this.restoreSnapshot({ autoScroll, scrollTop, anchor: autoScroll ? null : this.captureAnchor() });
  }

  /** 销毁：移除监听器和按钮 */
  destroy(): void {
    this.el.removeEventListener('wheel', this._onWheel);
    this.el.removeEventListener('pointerdown', this._onPointerDown);
    this.el.removeEventListener('pointerup', this._onPointerEnd);
    this.el.removeEventListener('pointercancel', this._onPointerEnd);
    this._onPointerEnd();
    this.el.removeEventListener('keydown', this._onKeyDown);
    this.el.removeEventListener('scroll', this._onScroll);
    if (this.addedTabIndex) {
      this.el.removeAttribute('tabindex');
      this.addedTabIndex = false;
    }
    if (this.rafId !== null) {
      cancelAnimationFrame(this.rafId);
      this.rafId = null;
    }
    if (this.anchorRafId !== null) {
      cancelAnimationFrame(this.anchorRafId);
      this.anchorRafId = null;
    }
    this._clearResumeIntent();
    this.resizeObserver?.disconnect();
    this.resizeObserver = null;
    this.mutationObserver?.disconnect();
    this.mutationObserver = null;
    if (this.buttonClickHandler) {
      this.buttonEl?.removeEventListener('click', this.buttonClickHandler);
      this.buttonClickHandler = null;
    }
    this.buttonEl?.remove();
    this.buttonEl = null;
  }

  // ── 内部方法 ──────────────────────────────────────────

  private _onObservedLayoutChange = (): void => {
    if (this.autoScroll) {
      this.onNewContent();
    } else {
      this._scheduleAnchorRestore();
    }
    this._updateButton();
  };

  private _scheduleAnchorRestore(): void {
    if (this.autoScroll || !this.anchor || this.anchorRafId !== null) return;
    this.anchorRafId = requestAnimationFrame(() => {
      this.anchorRafId = null;
      if (!this.autoScroll) this.restoreAnchor(this.anchor);
      this._updateButton();
    });
  }

  private restoreAnchor(anchor: ScrollAnchor | null): boolean {
    if (!anchor) return false;
    const node = [...this.el.querySelectorAll<HTMLElement>('.message[data-message-id], .message[data-stream-id]')]
      .find((el) => (el.dataset.messageId || el.dataset.streamId) === anchor.id);
    if (!node) return false;
    const delta = node.getBoundingClientRect().top - this.el.getBoundingClientRect().top - anchor.offsetTop;
    if (Math.abs(delta) > 0.5) this._setScrollTop(this.el.scrollTop + delta);
    return true;
  }

  private _setScrollTop(top: number): void {
    const prev = this.el.style.scrollBehavior;
    this.el.style.scrollBehavior = 'auto';
    this.el.scrollTop = top;
    this.el.style.scrollBehavior = prev;
    this.lastScrollTop = this.el.scrollTop;
  }

  private _isNearBottom(): boolean {
    return this.el.scrollHeight - this.el.scrollTop - this.el.clientHeight < this.opts.resumePx;
  }

  private _scrollToBottom(): void {
    // 暂时关闭 smooth 滚动避免动画积压
    const prev = this.el.style.scrollBehavior;
    this.el.style.scrollBehavior = 'auto';
    this.el.scrollTop = this.el.scrollHeight;
    this.el.style.scrollBehavior = prev;
    // 同步方向检测基准（见 restorePosition）
    this.lastScrollTop = this.el.scrollTop;
  }

  private _pauseForUserInput(): void {
    this.pauseFollow();
    this.opts.onUserScroll?.();
  }

  private _grantResumeIntent(): void {
    this._clearResumeIntent();
    this.resumeFromUserInput = true;
    this.userIntentRafId = requestAnimationFrame(() => {
      this.userIntentRafId = null;
      this.resumeFromUserInput = false;
    });
  }

  private _clearResumeIntent(): void {
    this.resumeFromUserInput = false;
    if (this.userIntentRafId === null) return;
    cancelAnimationFrame(this.userIntentRafId);
    this.userIntentRafId = null;
  }

  private _resumeFollowAtCurrentPosition(): void {
    this._clearResumeIntent();
    this.autoScroll = true;
    this.anchor = null;
    this.pendingNewContent = false;
    this._updateButton();
  }

  private _onWheel = (e: WheelEvent): void => {
    // 横向滚轮（deltaY===0）不参与纵向跟随状态
    if (e.deltaY === 0) return;
    // 嵌套容器（思考块）：仅当内容确实可滚动时才拦截 wheel（阻止冒泡），
    // 内容不滚动（短思考块）时让事件冒泡到父容器，父容器照常滚动并更新跟随状态。
    // 滚动链条：块内滚到底/顶后继续滚 → 不拦截，父容器接管滚动。
    if (
      this.opts.stopWheelPropagation &&
      this.el.scrollHeight > this.el.clientHeight
    ) {
      const atBottom = this.el.scrollTop + this.el.clientHeight >= this.el.scrollHeight - 1;
      const atTop = this.el.scrollTop <= 0;
      const chainToParent = (e.deltaY > 0 && atBottom) || (e.deltaY < 0 && atTop);
      if (!chainToParent) {
        e.stopPropagation();
      }
    }
    if (e.deltaY < 0) {
      // 用户向上滚动 → 停止自动跟随
      this._pauseForUserInput();
    } else if (this._isNearBottom()) {
      // 用户明确向下且已在底部 → 立即恢复自动跟随。
      this._resumeFollowAtCurrentPosition();
    } else {
      // 用户向下滚动但尚未到底：保持暂停；若同一帧的真实滚动抵达底部，
      // _onScroll 可凭短生命周期许可恢复。纯布局 scroll 没有该许可。
      this._pauseForUserInput();
      this._grantResumeIntent();
    }
  };

  private lastScrollTop = 0;

  private _onPointerDown = (e: PointerEvent): void => {
    // 鼠标只有按在滚动容器本身（含滚动条）才可能是拖动；触摸可从内容节点开始。
    if (e.pointerType !== 'touch' && e.target !== this.el) return;
    this._clearResumeIntent();
    this.pointerScrollActive = true;
    this.lastScrollTop = this.el.scrollTop;
    try {
      this.el.setPointerCapture?.(e.pointerId);
    } catch {
      // 部分 WebView 不允许捕获滚动条产生的 pointer；容器内释放仍由 pointerup 兜底。
    }
  };

  private _onPointerEnd = (e?: PointerEvent): void => {
    this.pointerScrollActive = false;
    if (e == null) return;
    try {
      if (this.el.hasPointerCapture?.(e.pointerId)) this.el.releasePointerCapture(e.pointerId);
    } catch {
      // 控制器销毁或 pointer 已自动释放时无需额外处理。
    }
  };

  private _onKeyDown = (e: KeyboardEvent): void => {
    // 子元素里的按钮/链接/输入控件自行处理按键；这里只识别滚动容器本身的导航意图。
    if (e.target !== this.el) return;
    const scrollsUp = e.key === 'ArrowUp' || e.key === 'PageUp' || e.key === 'Home' || (e.key === ' ' && e.shiftKey);
    const scrollsDown = e.key === 'ArrowDown' || e.key === 'PageDown' || e.key === 'End' || (e.key === ' ' && !e.shiftKey);
    if (scrollsUp) {
      this._pauseForUserInput();
    } else if (scrollsDown && this._isNearBottom()) {
      this._resumeFollowAtCurrentPosition();
    } else if (scrollsDown) {
      this._pauseForUserInput();
      this._grantResumeIntent();
    }
  };

  private _onScroll = (): void => {
    const st = this.el.scrollTop;
    const movedUp = st < this.lastScrollTop;
    const movedDown = st > this.lastScrollTop;
    if (this.pointerScrollActive && movedUp) {
      // pointer 明确向上：即使仍处于底部阈值内，也必须保留暂停意图。
      this._pauseForUserInput();
    } else if (
      this._isNearBottom() &&
      (this.autoScroll || this.resumeFromUserInput || (this.pointerScrollActive && movedDown))
    ) {
      // 跟随态保持跟随；暂停态仅允许明确的向下输入或 pointer 拖动恢复。
      this._resumeFollowAtCurrentPosition();
    } else if (this.pointerScrollActive && movedDown) {
      // 向下拖动但尚未到底，仍处于阅读上方状态。
      this._pauseForUserInput();
    } else if (!this.autoScroll) {
      // 用户阅读上方时持续更新锚点，后续异步高度变化保持当前阅读位置。
      this.anchor = this.captureAnchor();
    }
    this.lastScrollTop = st;
    this._updateButton();
  };

  private _createButton(): void {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = this.opts.buttonClass ?? 'scroll-to-bottom-btn';
    btn.title = '滚动到底部';
    btn.setAttribute('aria-label', '滚动到底部');
    btn.innerHTML = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="6 9 12 15 18 9"></polyline></svg>`;
    // 按钮点击：显式平滑滚动（日常 scrollTop 赋值保持 auto 即时，仅此处平滑）
    btn.addEventListener('click', this.buttonClickHandler = () => {
      this.autoScroll = true;
      this.anchor = null;
      this.pendingNewContent = false;
      if (typeof this.el.scrollTo === 'function') {
        this.el.scrollTo({ top: this.el.scrollHeight, behavior: 'smooth' });
      } else {
        this.el.scrollTop = this.el.scrollHeight;
      }
      // 方向检测基准设为当前值：平滑动画期间 scrollTop 单调递增，
      // 不会触发「用户上移」误判；动画中途用户手动滚动由 wheel 事件接管
      this.lastScrollTop = this.el.scrollTop;
      this._updateButton();
    });
    (this.opts.buttonHost ?? this.el).appendChild(btn);
    this.buttonEl = btn;
    this._updateButton();
  }

  private _updateButton(): void {
    if (!this.buttonEl) return;
    const visible = !this.autoScroll || !this._isNearBottom();
    const label = this.pendingNewContent ? '有新内容，回到底部' : '滚动到底部';
    this.buttonEl.classList.toggle('visible', visible);
    this.buttonEl.classList.toggle('has-new-content', visible && this.pendingNewContent);
    this.buttonEl.title = label;
    this.buttonEl.setAttribute('aria-label', label);
  }
}
