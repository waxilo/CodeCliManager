export interface ScrollControllerOptions {
  /** 距离底部多少 px 时判定为"在底部"（触发恢复自动滚动） */
  resumePx: number;
  /** 距离底部多少 px 时判定为"用户已离开"（触发停止自动滚动） */
  leavePx: number;
  /** 是否创建浮动"回到底部"按钮 */
  createButton?: boolean;
  /** 滚动按钮的 CSS class */
  buttonClass?: string;
  /** 是否阻止 wheel 事件冒泡（嵌套滚动容器使用，避免影响父容器） */
  stopWheelPropagation?: boolean;
}

export class ScrollController {
  readonly el: HTMLElement;
  autoScroll = true;
  private opts: Required<ScrollControllerOptions>;
  private rafId: number | null = null;
  private buttonEl: HTMLElement | null = null;
  private buttonClickHandler: (() => void) | null = null;

  constructor(el: HTMLElement, opts: ScrollControllerOptions) {
    this.el = el;
    this.opts = {
      resumePx: opts.resumePx,
      leavePx: opts.leavePx,
      createButton: opts.createButton ?? false,
      buttonClass: opts.buttonClass ?? 'scroll-to-bottom-btn',
      stopWheelPropagation: opts.stopWheelPropagation ?? false,
    };

    // wheel 事件：向上滚动 → 关闭自动滚动
    el.addEventListener('wheel', this._onWheel, { passive: true });
    // scroll 事件：回到底部 → 恢复自动滚动（scroll 不冒泡，无需处理）
    el.addEventListener('scroll', this._onScroll, { passive: true });

    if (this.opts.createButton) {
      this._createButton();
    }
  }

  /** 新内容到达时调用：若 autoScroll 则置底（RAF 节流） */
  onNewContent(): void {
    if (!this.autoScroll) return;
    if (this.rafId !== null) return; // 已有待处理的 RAF
    this.rafId = requestAnimationFrame(() => {
      this.rafId = null;
      this._scrollToBottom();
    });
  }

  /** 立即置底并开启自动滚动 */
  scrollToBottom(): void {
    this.autoScroll = true;
    this._scrollToBottom();
    this._updateButton();
  }

  /** 消息列表重建后恢复用户滚动位置：autoScroll=false 表示用户在阅读上方内容，不强制置底 */
  restorePosition(scrollTop: number, autoScroll: boolean): void {
    this.autoScroll = autoScroll;
    this.el.scrollTop = scrollTop;
    this._updateButton();
  }

  /** 销毁：移除监听器和按钮 */
  destroy(): void {
    this.el.removeEventListener('wheel', this._onWheel);
    this.el.removeEventListener('scroll', this._onScroll);
    if (this.rafId !== null) {
      cancelAnimationFrame(this.rafId);
      this.rafId = null;
    }
    if (this.buttonClickHandler) {
      this.buttonEl?.removeEventListener('click', this.buttonClickHandler);
      this.buttonClickHandler = null;
    }
    this.buttonEl?.remove();
    this.buttonEl = null;
  }

  // ── 内部方法 ──────────────────────────────────────────

  private _isNearBottom(): boolean {
    return this.el.scrollHeight - this.el.scrollTop - this.el.clientHeight < this.opts.resumePx;
  }

  private _isFarFromBottom(): boolean {
    return this.el.scrollHeight - this.el.scrollTop - this.el.clientHeight > this.opts.leavePx;
  }

  private _scrollToBottom(): void {
    // 暂时关闭 smooth 滚动避免动画积压
    const prev = this.el.style.scrollBehavior;
    this.el.style.scrollBehavior = 'auto';
    this.el.scrollTop = this.el.scrollHeight;
    this.el.style.scrollBehavior = prev;
  }

  private _onWheel = (e: WheelEvent): void => {
    if (this.opts.stopWheelPropagation) {
      e.stopPropagation();
    }
    if (e.deltaY < 0) {
      // 用户向上滚动 → 停止自动跟随
      this.autoScroll = false;
    } else if (this._isNearBottom()) {
      // 用户向下滚动到底部 → 恢复自动跟随
      this.autoScroll = true;
    }
  };

  private _onScroll = (): void => {
    if (this._isNearBottom()) {
      this.autoScroll = true;
    } else if (this._isFarFromBottom()) {
      // 用户已离开底部区域 → 停止自动跟随
      this.autoScroll = false;
    }
    this._updateButton();
  };

  private _createButton(): void {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = this.opts.buttonClass;
    btn.title = '滚动到底部';
    btn.innerHTML = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9"></polyline></svg>`;
    btn.addEventListener('click', this.buttonClickHandler = () => this.scrollToBottom());
    this.el.appendChild(btn);
    this.buttonEl = btn;
  }

  private _updateButton(): void {
    if (!this.buttonEl) return;
    if (this._isNearBottom()) {
      this.buttonEl.classList.remove('visible');
    } else {
      this.buttonEl.classList.add('visible');
    }
  }
}
