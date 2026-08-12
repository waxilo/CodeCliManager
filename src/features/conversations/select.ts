import { appState } from '../../state';
import { shellApi } from '../../app/shell/api';
import { invalidateFileCache } from '../files';
import { isActiveConversationRunning } from '../chat/session-context';
import { showPendingAssistantIndicator } from '../chat/retry';
import { dismissApiConfigViewState } from '../api-config/view-lifecycle';
import { refreshStreamingUI } from '../chat/streaming';
import { refreshConversationFromBackend } from './load';
import { dismissMcpViewState } from '../mcp/mount';
import { dismissSettingsViewState } from '../settings/mount';
import { updateConversationListSpinner } from '../sidebar/render-list';
export function selectConversation(id: string) {
  dismissApiConfigViewState();
  dismissSettingsViewState();
  dismissMcpViewState();
  appState.activeConversationId = id;
  invalidateFileCache();

  void refreshConversationFromBackend(id).then(() => {
    shellApi.render();

    // shellApi.render() 已按 appState.runningSessions 同步按钮；此处再读一次供流式 UI 恢复
    const thisSessionRunning = isActiveConversationRunning();
    updateConversationListSpinner();

    setTimeout(() => {
      // 滚动到底部（ScrollController 会临时禁用 smooth 避免长动画）
      appState.answerScroller?.scrollToBottom();
      // 如果切换到的会话正在流式输出，恢复流式 UI
      if (thisSessionRunning && appState.streamingBySession.has(id)) {
        showPendingAssistantIndicator();
        refreshStreamingUI(id);
      }
    }, 50);
  });
}

