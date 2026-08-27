export type ChatScrollMode = 'FOLLOWING' | 'DETACHED';
export type UserScrollDirection = 'AWAY' | 'TOWARD' | 'UNKNOWN';

export interface ChatScrollState {
  readonly mode: ChatScrollMode;
  readonly userTransactionActive: boolean;
  readonly userScrollObserved: boolean;
  readonly userDirection: UserScrollDirection;
}

export type ChatScrollAction =
  | { readonly type: 'USER_TRANSACTION_BEGIN'; readonly direction: UserScrollDirection }
  | { readonly type: 'USER_SCROLL_POSITION'; readonly direction: UserScrollDirection }
  | { readonly type: 'USER_TRANSACTION_END'; readonly atBottom: boolean }
  | { readonly type: 'REQUEST_FOLLOW' }
  | { readonly type: 'ACTIVATE_SESSION'; readonly mode: ChatScrollMode }
  | { readonly type: 'LAYOUT_CHANGED' }
  | { readonly type: 'PROGRAMMATIC_SCROLL' };

export function createChatScrollState(mode: ChatScrollMode = 'FOLLOWING'): ChatScrollState {
  return {
    mode,
    userTransactionActive: false,
    userScrollObserved: false,
    userDirection: 'UNKNOWN',
  };
}

/**
 * Pure user-intent reducer. Geometry and programmatic scroll events are identity
 * transitions. DETACHED can only recover through an explicit follow request or
 * a toward-bottom user transaction which settles at the bottom.
 */
export function chatScrollReducer(
  state: ChatScrollState,
  action: ChatScrollAction,
): ChatScrollState {
  switch (action.type) {
    case 'USER_TRANSACTION_BEGIN': {
      const mode = action.direction === 'AWAY' ? 'DETACHED' : state.mode;
      return {
        mode,
        userTransactionActive: true,
        userScrollObserved: state.userTransactionActive ? state.userScrollObserved : false,
        userDirection: action.direction === 'UNKNOWN' ? state.userDirection : action.direction,
      };
    }
    case 'USER_SCROLL_POSITION': {
      if (!state.userTransactionActive || action.direction === 'UNKNOWN') return state;
      return {
        ...state,
        mode: action.direction === 'AWAY' ? 'DETACHED' : state.mode,
        userScrollObserved: true,
        userDirection: action.direction,
      };
    }
    case 'USER_TRANSACTION_END': {
      if (!state.userTransactionActive) return state;
      const followed = state.userDirection === 'TOWARD' && action.atBottom;
      return createChatScrollState(followed ? 'FOLLOWING' : state.mode);
    }
    case 'REQUEST_FOLLOW':
      return createChatScrollState('FOLLOWING');
    case 'ACTIVATE_SESSION':
      return createChatScrollState(action.mode);
    case 'LAYOUT_CHANGED':
    case 'PROGRAMMATIC_SCROLL':
      return state;
  }
}
