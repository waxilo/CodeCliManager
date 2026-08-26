import { ScrollController } from '../../ui';
import { appState } from '../../state';
export function getThinkingScroller(el: HTMLElement, id: string): ScrollController {
  let sc = appState.thinkingScrollers.get(id);
  if (!sc || sc.el !== el) {
    sc?.destroy();
    sc = new ScrollController(el, {
      resumePx: 20,
      stopWheelPropagation: true,
      // 思考块滚动被拦截（不冒泡到父容器），父容器感知不到用户在看思考块、
      // 自动跟随一直保持 → 每 tick 置底把思考块拉走。用户滚动思考块时
      // 同步关闭父消息列表的自动跟随，避免「自动跳来跳去」。
      onUserScroll: () => {
        appState.answerScroller?.pauseFollow();
      },
    });
    appState.thinkingScrollers.set(id, sc);
  }
  return sc;
}
