import { appState } from '../../state';
import {
  ChatScrollCoordinator,
  type ChatScrollContentCommit,
  type ChatScrollSessionSnapshot,
} from '../../ui/chat-scroll-coordinator';
import type { ChatScrollMode } from '../../ui/chat-scroll-reducer';
import { conversationInstanceKey } from '../conversations/normalize';

let coordinator: ChatScrollCoordinator | null = null;
let mountEpoch = 0;
let pendingSessionKey: string | null = null;
const sessionMemory = new Map<string, ChatScrollSessionSnapshot>();

export function activeChatScrollSessionKey(): string {
  return conversationInstanceKey(
    appState.activeConversationId || 'pending',
    appState.activeConversationSourcePath,
  );
}

function findElements(): {
  viewport: HTMLElement;
  content: HTMLElement;
  sentinel: HTMLElement;
  button: HTMLElement;
} | null {
  const viewport = document.querySelector<HTMLElement>('#message-list');
  const content = viewport?.querySelector<HTMLElement>(':scope > [data-chat-content]') ?? null;
  const sentinel = content?.querySelector<HTMLElement>(':scope > [data-chat-bottom]') ?? null;
  const button = viewport?.closest<HTMLElement>('.message-list-shell')
    ?.querySelector<HTMLElement>(':scope > .scroll-to-bottom-btn') ?? null;
  return viewport && content && sentinel && button
    ? { viewport, content, sentinel, button }
    : null;
}

function rememberAndDestroyCoordinator(): void {
  if (!coordinator) return;
  sessionMemory.set(coordinator.sessionKey, coordinator.snapshotSession());
  coordinator.destroy();
  coordinator = null;
}

function mountCoordinator(sessionKey: string): ChatScrollCoordinator | null {
  const elements = findElements();
  if (!elements) return null;
  coordinator = new ChatScrollCoordinator({
    viewport: elements.viewport,
    content: elements.content,
    sentinel: elements.sentinel,
    followButton: elements.button,
    sessionKey,
    mountEpoch: ++mountEpoch,
    bottomThresholdPx: 20,
  });
  coordinator.activateSession(coordinator.identity, sessionMemory.get(sessionKey) ?? null);
  pendingSessionKey = null;
  return coordinator;
}

export function ensureMainChatScroll(
  sessionKey = activeChatScrollSessionKey(),
): ChatScrollCoordinator | null {
  const elements = findElements();
  if (!elements) return null;
  if (
    coordinator?.viewport !== elements.viewport ||
    coordinator.content !== elements.content ||
    coordinator.sentinel !== elements.sentinel
  ) {
    rememberAndDestroyCoordinator();
    return mountCoordinator(sessionKey);
  }
  if (coordinator.sessionKey !== sessionKey) {
    rememberAndDestroyCoordinator();
    return mountCoordinator(sessionKey);
  }
  return coordinator;
}

/**
 * Start a live DOM commit. On a session/viewport change the old coordinator is
 * snapshotted and destroyed; target-session restoration is deferred until the
 * new DOM is fully committed, so anchors are never applied to the old list.
 */
export function beginMainChatContentCommit(
  sessionKey = activeChatScrollSessionKey(),
): ChatScrollContentCommit | null {
  const elements = findElements();
  const sameMount = Boolean(
    coordinator &&
    elements &&
    coordinator.viewport === elements.viewport &&
    coordinator.content === elements.content &&
    coordinator.sentinel === elements.sentinel &&
    coordinator.sessionKey === sessionKey,
  );
  if (!sameMount) {
    rememberAndDestroyCoordinator();
    pendingSessionKey = sessionKey;
    return null;
  }
  return coordinator?.beginContentCommit() ?? null;
}

export function endMainChatContentCommit(commit: ChatScrollContentCommit | null): void {
  if (commit && coordinator) coordinator.endContentCommit(commit);
  if (pendingSessionKey) mountCoordinator(pendingSessionKey);
}

export function detachMainChatScroll(): void {
  ensureMainChatScroll()?.detach();
}

export function requestMainChatFollow(): void {
  ensureMainChatScroll()?.requestFollow();
}

export function notifyMainChatIntrinsicLayoutChange(): void {
  ensureMainChatScroll()?.notifyIntrinsicLayoutChange();
}

export function getMainChatScrollMode(): ChatScrollMode | null {
  return coordinator?.mode ?? null;
}

export function destroyMainChatScroll(): void {
  rememberAndDestroyCoordinator();
  pendingSessionKey = null;
}

export function resetMainChatScrollForTests(): void {
  coordinator?.destroy();
  coordinator = null;
  mountEpoch = 0;
  pendingSessionKey = null;
  sessionMemory.clear();
}
