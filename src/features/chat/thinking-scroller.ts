import { ScrollController } from '../../ui';
import { appState } from '../../state';
export function getThinkingScroller(el: HTMLElement, id: string): ScrollController {
  let sc = appState.thinkingScrollers.get(id);
  if (!sc || sc.el !== el) {
    sc?.destroy();
    sc = new ScrollController(el, { resumePx: 20, leavePx: 80, stopWheelPropagation: true });
    appState.thinkingScrollers.set(id, sc);
  }
  return sc;
}
