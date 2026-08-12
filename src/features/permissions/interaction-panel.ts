import { appState } from '../../state';
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
  appState.activeInteractionPanel = { conversationId, element, cleanup };
  const host = getInteractionHost();
  if (!host) return;
  host.replaceChildren(element);
  host.hidden = false;
}

/** shellApi.render() 后把仍待处理的面板重新挂回新 host */
export function remountActiveInteractionPanel(): void {
  if (!appState.activeInteractionPanel) return;
  const host = getInteractionHost();
  if (!host) return;
  if (host.contains(appState.activeInteractionPanel.element)) {
    host.hidden = false;
    return;
  }
  host.replaceChildren(appState.activeInteractionPanel.element);
  host.hidden = false;
}

export function unmountActiveInteractionPanel(element?: HTMLElement): void {
  if (appState.activeInteractionPanel && (!element || appState.activeInteractionPanel.element === element)) {
    appState.activeInteractionPanel = null;
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
