export function renderApiConfigViewHtml(): string {
  return `
    <div class="api-config-view" id="api-config-view" data-profile-id="">
      <div class="settings-header">
        <div>
          <h3 class="settings-title">Claude Code API 配置</h3>
          <p class="settings-subtitle">保存多套 API 配置，一键切换并写入 Claude Code</p>
        </div>
        <button type="button" class="settings-close-btn" aria-label="返回聊天">✕</button>
      </div>
      <form class="settings-form" id="settings-form">
        <label class="settings-field">
          <span>配置名称</span>
          <input type="text" name="profileName" placeholder="例如：DeepSeek / 官方 Anthropic" />
        </label>
        <label class="settings-field">
          <span>API Base URL</span>
          <input type="url" name="baseUrl" placeholder="https://api.anthropic.com" />
        </label>
        <div class="settings-field">
          <span>API Key</span>
          <div class="settings-apikey-box" data-mode="empty">
            <span class="settings-apikey-display">
              <span class="settings-apikey-display-label">当前：</span>
              <code class="settings-apikey-display-value"></code>
            </span>
            <input type="password" name="apiKey" class="settings-apikey-input" placeholder="sk-..." autocomplete="off" />
            <div class="settings-apikey-actions">
              <button type="button" class="settings-apikey-btn" data-action="edit" title="编辑密钥">编辑</button>
              <button type="button" class="settings-apikey-btn" data-action="copy" title="复制完整密钥">复制</button>
              <button type="button" class="settings-apikey-btn" data-action="cancel" title="取消编辑" hidden>取消</button>
            </div>
          </div>
        </div>
        <div class="settings-field provider-balance-field" data-provider-balance-wrap hidden>
          <span>账户余额</span>
          <div class="provider-balance-box">
            <span class="provider-balance-value" data-provider-balance>—</span>
            <button type="button" class="settings-apikey-btn provider-balance-refresh" title="刷新余额">刷新</button>
          </div>
        </div>
        <label class="settings-field">
          <span>模型配置</span>
          <input
            type="text"
            class="settings-model-input settings-model-config-summary"
            placeholder="点击配置模型"
            readonly
          />
        </label>
        <p class="settings-model-config-hint">配置展示模型与自定义模型列表，点击输入框管理</p>
        <p class="settings-path settings-live-path"></p>
      </form>
      <div class="settings-footer">
        <div class="settings-footer-actions">
          <button type="button" class="settings-btn-secondary settings-apply-profile">应用</button>
          <button type="button" class="settings-btn-secondary settings-close-footer">返回</button>
          <button type="button" class="settings-btn-primary save-only">保存</button>
        </div>
      </div>
    </div>
  `;
}

