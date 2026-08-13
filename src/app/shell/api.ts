/** 跨模块 UI 动作的晚绑定入口，避免 features ↔ shell 循环依赖。 */
type VoidFn = () => void;
type AsyncVoidFn = () => Promise<void>;

export const shellApi: {
  render: VoidFn;
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
  openMcpView: VoidFn;
  openKiroView: VoidFn;
  closeApiConfigView: VoidFn;
  closeSettingsView: VoidFn;
  closeMcpView: VoidFn;
  closeKiroView: VoidFn;
  dismissApiConfigViewState: VoidFn;
  dismissSettingsViewState: VoidFn;
  dismissMcpViewState: VoidFn;
  dismissKiroViewState: VoidFn;
  mountApiConfigView: AsyncVoidFn;
  mountSettingsView: VoidFn;
  mountMcpView: AsyncVoidFn;
  mountKiroView: AsyncVoidFn;
  newChat: VoidFn;
  renderKiroCard: (status: unknown) => void;
  refreshKiroStatus: AsyncVoidFn;
  refreshSettingsModal: (overlay: HTMLElement, profileId: string | null) => Promise<void>;
  refreshModelInfo: AsyncVoidFn;
} = {
  render: () => {},
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
  openMcpView: () => {},
  openKiroView: () => {},
  closeApiConfigView: () => {},
  closeSettingsView: () => {},
  closeMcpView: () => {},
  closeKiroView: () => {},
  dismissApiConfigViewState: () => {},
  dismissSettingsViewState: () => {},
  dismissMcpViewState: () => {},
  dismissKiroViewState: () => {},
  mountApiConfigView: async () => {},
  mountSettingsView: () => {},
  mountMcpView: async () => {},
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
