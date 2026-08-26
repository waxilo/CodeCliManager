export interface ScrollControllerOptions {
  /** 距离底部多少 px 时判定为"在底部"（触发恢复自动滚动） */
  resumePx: number;
  /** 是否创建浮动"回到底部"按钮 */
  createButton?: boolean;
  /** 滚动按钮的 CSS class */
  buttonClass?: string;
  /** 是否阻止 wheel 事件冒泡（嵌套滚动容器使用，避免影响父容器） */
  stopWheelPropagation?: boolean;
  /** 用户主动滚动（wheel / scroll）时的回调：嵌套容器用它同步关闭父容器的自动跟随 */
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

  constructor(el: HTMLElement, opts: ScrollControllerOptions) {
    this.el = el;
    this.opts = {
      resumePx: opts.resumePx,
      createButton: opts.createButton ?? false,
      buttonClass: opts.buttonClass ?? 'scroll-to-bottom-btn',
      stopWheelPropagation: opts.stopWheelPropagation ?? false,
      onUserScroll: opts.onUserScroll,
    };

    // wheel 事件：向上滚动 → 关闭自动滚动
    el.addEventListener('wheel', this._onWheel, { passive: true });
    // scroll 事件：回到底部 → 恢复自动滚动（scroll 不冒泡，无需处理）
    el.addEventListener('scroll', this._onScroll, { passive: true });

    // 流式 Markdown、图片缩略图、工具卡展开都会异步改变高度。用户阅读上方时，
    // 以可见消息锚点补偿高度变化，避免视口看起来“跳动”。
    if (typeof ResizeObserver !== 'undefined') {
      this.resizeObserver = new ResizeObserver(() => this._scheduleAnchorRestore());
      this.resizeObserver.observe(el);
    }
    if (typeof MutationObserver !== 'undefined') {
      this.mutationObserver = new MutationObserver(() => this._scheduleAnchorRestore());
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
    this.autoScroll = false;
    // 用户可在上方继续滚动；每次都刷新锚点，后续高度变化才会保持其当前阅读位置。
    this.anchor = this.captureAnchor();
    this._updateButton();
  }

  /** 立即置底并开启自动滚动 */
  scrollToBottom(): void {
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
    this.el.removeEventListener('scroll', this._onScroll);
    if (this.rafId !== null) {
      cancelAnimationFrame(this.rafId);
      this.rafId = null;
    }
    if (this.anchorRafId !== null) {
      cancelAnimationFrame(this.anchorRafId);
      this.anchorRafId = null;
    }
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

  private _scheduleAnchorRestore(): void {
    if (this.autoScroll || !this.anchor || this.anchorRafId !== null) return;
    this.anchorRafId = requestAnimationFrame(() => {
      this.anchorRafId = null;
      if (!this.autoScroll) this.restoreAnchor(this.anchor);
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
      this.pauseFollow();
      this.opts.onUserScroll?.();
    } else if (this._isNearBottom()) {
      // 用户向下滚动到底部 → 恢复自动跟随；当前位置已由浏览器滚动到位，
      // 不再重复写 scrollTop，避免与惯性/测试环境的只读滚动 mock 互相干扰。
      this.autoScroll = true;
      this.anchor = null;
      this.pendingNewContent = false;
      this._updateButton();
    } else {
      // 用户向下滚动但不在底部：仍在查看上方内容，
      // 同样通知外部（嵌套容器需关闭父容器自动跟随，避免被置底拉走）
      this.pauseFollow();
      this.opts.onUserScroll?.();
    }
  };

  /** 上次滚动位置：scrollTop 变小即视为用户上移（拖动滚动条 / PageUp / 键盘 / 惯性收尾），
   *  无 20-80px 死区——避免「滚了却不关跟随、下一 tick 被拉回」 */
  private lastScrollTop = 0;

  private _onScroll = (): void => {
    const st = this.el.scrollTop;
    if (st < this.lastScrollTop) {
      // 用户向上移动 → 立即停止自动跟随（任何幅度）
      this.pauseFollow();
      this.opts.onUserScroll?.();
    } else if (this._isNearBottom()) {
      // 回到底部 → 恢复自动跟随
      this.autoScroll = true;
      this.anchor = null;
      this.pendingNewContent = false;
    }
    this.lastScrollTop = st;
    this._updateButton();
  };

  private _createButton(): void {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = this.opts.buttonClass ?? 'scroll-to-bottom-btn';
    btn.title = '滚动到底部';
    btn.innerHTML = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9"></polyline></svg>`;
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
    this.el.appendChild(btn);
    this.buttonEl = btn;
  }

  private _updateButton(): void {
    if (!this.buttonEl) return;
    const hidden = this._isNearBottom();
    this.buttonEl.classList.toggle('visible', !hidden);
    this.buttonEl.classList.toggle('has-new-content', !hidden && this.pendingNewContent);
    this.buttonEl.title = this.pendingNewContent ? '有新内容，回到底部' : '滚动到底部';
  }
}
