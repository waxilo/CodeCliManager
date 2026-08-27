import { describe, expect, it } from 'vitest';
import {
  chatScrollReducer,
  createChatScrollState,
  type ChatScrollAction,
  type ChatScrollState,
} from './chat-scroll-reducer';

function reduce(
  actions: readonly ChatScrollAction[],
  initial: ChatScrollState = createChatScrollState(),
): ChatScrollState {
  return actions.reduce(chatScrollReducer, initial);
}

describe('chatScrollReducer', () => {
  it('starts FOLLOWING with no user transaction', () => {
    expect(createChatScrollState()).toEqual({
      mode: 'FOLLOWING',
      userTransactionActive: false,
      userScrollObserved: false,
      userDirection: 'UNKNOWN',
    });
  });

  it('standalone scroll, layout and programmatic actions never change intent', () => {
    for (const mode of ['FOLLOWING', 'DETACHED'] as const) {
      const state = createChatScrollState(mode);
      expect(chatScrollReducer(state, {
        type: 'USER_SCROLL_POSITION',
        direction: 'AWAY',
      })).toBe(state);
      expect(chatScrollReducer(state, { type: 'LAYOUT_CHANGED' })).toBe(state);
      expect(chatScrollReducer(state, { type: 'PROGRAMMATIC_SCROLL' })).toBe(state);
    }
  });

  it('an away user transaction detaches immediately and stays detached at settle', () => {
    const active = chatScrollReducer(createChatScrollState(), {
      type: 'USER_TRANSACTION_BEGIN',
      direction: 'AWAY',
    });
    expect(active.mode).toBe('DETACHED');

    const detached = reduce([
      { type: 'USER_SCROLL_POSITION', direction: 'AWAY' },
      { type: 'USER_TRANSACTION_END', atBottom: false },
    ], active);
    expect(detached).toEqual(createChatScrollState('DETACHED'));
  });

  it('a toward-bottom transaction follows only when it settles at the bottom', () => {
    const detached = createChatScrollState('DETACHED');
    const active = reduce([
      { type: 'USER_TRANSACTION_BEGIN', direction: 'TOWARD' },
      { type: 'USER_SCROLL_POSITION', direction: 'TOWARD' },
    ], detached);
    expect(active.mode).toBe('DETACHED');

    expect(chatScrollReducer(active, {
      type: 'USER_TRANSACTION_END',
      atBottom: false,
    })).toEqual(createChatScrollState('DETACHED'));
    expect(chatScrollReducer(active, {
      type: 'USER_TRANSACTION_END',
      atBottom: true,
    })).toEqual(createChatScrollState('FOLLOWING'));
  });

  it('a pointer transaction with no actual scroll preserves the previous mode', () => {
    for (const mode of ['FOLLOWING', 'DETACHED'] as const) {
      const initial = createChatScrollState(mode);
      const active = chatScrollReducer(initial, {
        type: 'USER_TRANSACTION_BEGIN',
        direction: 'UNKNOWN',
      });
      expect(chatScrollReducer(active, {
        type: 'USER_TRANSACTION_END',
        atBottom: mode === 'FOLLOWING',
      })).toEqual(initial);
    }
  });

  it('explicit follow and session activation are the only non-user transitions', () => {
    const detached = createChatScrollState('DETACHED');
    expect(chatScrollReducer(detached, { type: 'REQUEST_FOLLOW' }))
      .toEqual(createChatScrollState('FOLLOWING'));
    expect(chatScrollReducer(detached, {
      type: 'ACTIVATE_SESSION',
      mode: 'DETACHED',
    })).toEqual(createChatScrollState('DETACHED'));
    expect(chatScrollReducer(detached, {
      type: 'ACTIVATE_SESSION',
      mode: 'FOLLOWING',
    })).toEqual(createChatScrollState('FOLLOWING'));
  });
});
