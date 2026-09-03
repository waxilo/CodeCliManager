import { appState } from '../../state';
import { getActiveSessionKey } from '../chat/session-context';
export function formatPermissionInput(input: unknown): string {
  try {
    return JSON.stringify(input ?? {}, null, 2);
  } catch {
    return String(input ?? '');
  }
}


export function getInteractionHost(): HTMLElement | null {
  return document.querySelector('#interaction-host');
}

export function clearInteractionHostUi(): void {
  const host = getInteractionHost();
  if (!host) return;
  host.replaceChildren();
  host.hidden = true;
}

/**
 * 将交互面板挂到输入框上方；shellApi.render() 重建 DOM 后可 remount
 */
export function mountInteractionPanel(
  element: HTMLElement,
  conversationId: string,
  cleanup: (result: 'allow' | 'deny') => void,
): void {
  appState.interactionPanelsBySession.set(conversationId, { conversationId, element, cleanup });
  if (getActiveSessionKey() !== conversationId) return;
  const host = getInteractionHost();
  if (!host) return;
  host.replaceChildren(element);
  host.hidden = false;
}

/** shellApi.render() 后把当前会话仍待处理的面板重新挂回新 host */
export function remountActiveInteractionPanel(conversationId = getActiveSessionKey()): void {
  const panel = appState.interactionPanelsBySession.get(conversationId);
  const host = getInteractionHost();
  if (!host) return;
  if (!panel) {
    clearInteractionHostUi();
    return;
  }
  if (host.contains(panel.element)) {
    host.hidden = false;
    return;
  }
  host.replaceChildren(panel.element);
  host.hidden = false;
}

export function transferInteractionPanel(from: string, to: string): void {
  const panel = appState.interactionPanelsBySession.get(from);
  if (!panel) return;
  appState.interactionPanelsBySession.delete(from);
  panel.conversationId = to;
  panel.element.dataset.conversationId = to;
  appState.interactionPanelsBySession.set(to, panel);
}

export function unmountActiveInteractionPanel(element?: HTMLElement): void {
  if (element) {
    for (const [sessionId, panel] of appState.interactionPanelsBySession) {
      if (panel.element === element) {
        appState.interactionPanelsBySession.delete(sessionId);
        break;
      }
    }
  } else {
    const activeSessionKey = getActiveSessionKey();
    if (activeSessionKey) appState.interactionPanelsBySession.delete(activeSessionKey);
  }
  const host = getInteractionHost();
  if (!host) return;
  if (element) {
    if (host.contains(element)) element.remove();
  } else {
    host.replaceChildren();
  }
  if (host.childElementCount === 0) host.hidden = true;
}

/** 展示工具权限确认（输入框上方内联卡片） */
