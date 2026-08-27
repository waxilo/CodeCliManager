import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { appState } from '../../state';
import {
  beginMainChatContentCommit,
  detachMainChatScroll,
  endMainChatContentCommit,
  ensureMainChatScroll,
  getMainChatScrollMode,
  resetMainChatScrollForTests,
} from './chat-scroll';

function setupShell(): HTMLElement {
  document.body.innerHTML = `
    <div class="message-list-shell">
      <div id="message-list">
        <div data-chat-content>
          <div data-chat-reconcile-key="message:a">A</div>
          <div data-chat-bottom></div>
        </div>
      </div>
      <button class="scroll-to-bottom-btn" type="button"></button>
    </div>
  `;
  return document.querySelector<HTMLElement>('#message-list')!;
}

function activate(id: string): void {
  appState.activeConversationId = id;
  appState.activeConversationSourcePath = null;
}

describe('main chat scroll session memory', () => {
  beforeEach(() => {
    resetMainChatScrollForTests();
    document.body.innerHTML = '';
    activate('');
  });

  afterEach(() => {
    resetMainChatScrollForTests();
    document.body.innerHTML = '';
  });

  it('restores A DETACHED state and fallback position after A → B → A', () => {
    const viewport = setupShell();
    activate('A');
    ensureMainChatScroll();
    viewport.scrollTop = 123;
    detachMainChatScroll();
    expect(getMainChatScrollMode()).toBe('DETACHED');

    activate('B');
    const toB = beginMainChatContentCommit();
    expect(toB).toBeNull();
    endMainChatContentCommit(toB);
    expect(getMainChatScrollMode()).toBe('FOLLOWING');

    activate('A');
    const toA = beginMainChatContentCommit();
    expect(toA).toBeNull();
    endMainChatContentCommit(toA);

    expect(getMainChatScrollMode()).toBe('DETACHED');
    expect(viewport.scrollTop).toBe(123);
  });
});
