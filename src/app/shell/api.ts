/** 跨模块 UI 动作的晚绑定入口，避免 features ↔ shell 循环依赖。 */
type VoidFn = () => void;
type AsyncVoidFn = () => Promise<void>;

export const shellApi: {
  render: VoidFn;
  /** 仅重建标题栏 actions 并重新绑定，供 Kiro 运行状态点等轻量刷新 */
  syncTitlebarActions: VoidFn;
  refreshChatContent: VoidFn;
  refreshConversationListDom: VoidFn;
  loadData: AsyncVoidFn;
  selectConversation: (id: string) => void;
  startMainBalanceBarAutoRefresh: VoidFn;
  scheduleMainBalanceBar: VoidFn;
  remountActiveInteractionPanel: VoidFn;
  updateSendButtonState: VoidFn;
  updateConversationListSpinner: VoidFn;
  loadChatModelOptions: AsyncVoidFn;
  updateChatModelPicker: VoidFn;
  syncStatusBarSections: VoidFn;
  clearMainBalanceBarCache: VoidFn;
  clearGitBranchCache: VoidFn;
  refreshGitBranch: AsyncVoidFn;
  invalidateFileCache: VoidFn;
  bindDragDropFileRefs: AsyncVoidFn;
  clearPasteAttachments: VoidFn;
  clearImportedFileRefs: VoidFn;
  closePermissionDialogs: (conversationId?: string) => void;
  hideSendingState: VoidFn;
  setAbortingUi: (aborting: boolean) => void;
  setSendButtonLoading: (loading: boolean) => void;
  ensureChatViewVisible: VoidFn;
  openApiConfigView: VoidFn;
  openSettingsView: VoidFn;
  openSkillsView: VoidFn;
  openKiroView: VoidFn;
  closeApiConfigView: VoidFn;
  closeSettingsView: VoidFn;
  closeSkillsView: VoidFn;
  closeKiroView: VoidFn;
  /** 增量进入管理页（摘取保存主视图 DOM，不整页重绘） */
  enterManagementView: (kind: 'api-config' | 'settings' | 'skills') => void;
  /** 增量退出管理页；返回是否走增量恢复（false = 已回退全量 render） */
  exitManagementView: () => boolean;
  dismissApiConfigViewState: VoidFn;
  dismissSettingsViewState: VoidFn;
  dismissSkillsViewState: VoidFn;
  dismissKiroViewState: VoidFn;
  mountApiConfigView: AsyncVoidFn;
  mountSettingsView: VoidFn;
  mountSkillsView: VoidFn;
  mountKiroView: AsyncVoidFn;
  newChat: VoidFn;
  renderKiroCard: (status: unknown) => void;
  refreshKiroStatus: AsyncVoidFn;
  refreshSettingsModal: (overlay: HTMLElement, profileId: string | null) => Promise<void>;
  refreshModelInfo: AsyncVoidFn;
} = {
  render: () => {},
  syncTitlebarActions: () => {},
  refreshChatContent: () => {},
  refreshConversationListDom: () => {},
  loadData: async () => {},
  selectConversation: () => {},
  startMainBalanceBarAutoRefresh: () => {},
  scheduleMainBalanceBar: () => {},
  remountActiveInteractionPanel: () => {},
  updateSendButtonState: () => {},
  updateConversationListSpinner: () => {},
  loadChatModelOptions: async () => {},
  updateChatModelPicker: () => {},
  syncStatusBarSections: () => {},
  clearMainBalanceBarCache: () => {},
  clearGitBranchCache: () => {},
  refreshGitBranch: async () => {},
  invalidateFileCache: () => {},
  bindDragDropFileRefs: async () => {},
  clearPasteAttachments: () => {},
  clearImportedFileRefs: () => {},
  closePermissionDialogs: () => {},
  hideSendingState: () => {},
  setAbortingUi: () => {},
  setSendButtonLoading: () => {},
  ensureChatViewVisible: () => {},
  openApiConfigView: () => {},
  openSettingsView: () => {},
  openSkillsView: () => {},
  openKiroView: () => {},
  closeApiConfigView: () => {},
  closeSettingsView: () => {},
  closeSkillsView: () => {},
  closeKiroView: () => {},
  enterManagementView: () => {},
  exitManagementView: () => false,
  dismissApiConfigViewState: () => {},
  dismissSettingsViewState: () => {},
  dismissSkillsViewState: () => {},
  dismissKiroViewState: () => {},
  mountApiConfigView: async () => {},
  mountSettingsView: () => {},
  mountSkillsView: () => {},
  mountKiroView: async () => {},
  newChat: () => {},
  renderKiroCard: () => {},
  refreshKiroStatus: async () => {},
  refreshSettingsModal: async () => {},
  refreshModelInfo: async () => {},
};

export function render(): void {
  shellApi.render();
}
export function refreshChatContent(): void {
  shellApi.refreshChatContent();
}
