export function renderKiroViewHtml(): string {
  return `
    <div class="kiro-view" id="kiro-view">
      <div class="settings-header">
        <div>
          <h3 class="settings-title">Kiro 代理</h3>
          <p class="settings-subtitle">将本地 Kiro 额度暴露为 Anthropic API，供 Claude Code 使用</p>
        </div>
        <button type="button" class="settings-close-btn" aria-label="返回聊天">✕</button>
      </div>

      <div class="kiro-layout" id="kiro-card">
        <section class="kiro-status-panel" data-kiro-panel="status">
          <div class="kiro-status-main">
            <div class="kiro-status-indicator" data-kiro-indicator="unknown" aria-hidden="true"></div>
            <div class="kiro-status-copy">
              <div class="kiro-status-title-row">
                <span class="kiro-status-name">本地代理</span>
                <span class="kiro-card-status" data-kiro-status="unknown">检测中…</span>
              </div>
              <p class="kiro-status-desc" data-kiro-status-desc>正在读取代理状态…</p>
            </div>
          </div>
          <button type="button" class="settings-btn-primary kiro-toggle-btn" data-kiro-running="false" disabled>启动</button>

        </section>

        <section class="kiro-metrics" aria-label="代理概览">
          <div class="kiro-metric">
            <span class="kiro-metric-label">代理地址</span>
            <code class="kiro-metric-value" data-kiro-port>未运行</code>
          </div>
          <div class="kiro-metric">
            <div class="kiro-metric-head">
              <span class="kiro-metric-label">Token</span>
              <button type="button" class="kiro-link-btn kiro-token-refresh" title="刷新共享 SSO 凭据">刷新</button>
            </div>
            <span class="kiro-metric-value" data-kiro-expires>—</span>
          </div>
          <div class="kiro-metric">
            <div class="kiro-metric-head">
              <span class="kiro-metric-label">账户额度</span>
              <button type="button" class="kiro-link-btn kiro-usage-refresh" title="刷新额度">刷新</button>
            </div>
            <span class="kiro-metric-value kiro-metric-value-usage" data-kiro-usage>—</span>
          </div>
        </section>

        <section class="kiro-meta" aria-label="凭据信息">
          <div class="kiro-meta-row">
            <span class="kiro-meta-label">凭据</span>
            <span class="kiro-meta-value" data-kiro-auth title="">—</span>
          </div>
          <div class="kiro-meta-row" data-kiro-arn-row hidden>
            <span class="kiro-meta-label">Profile</span>
            <span class="kiro-meta-value kiro-meta-value-mono" data-kiro-arn title="">—</span>
          </div>
        </section>

        <section class="kiro-models" data-kiro-models>
          <button type="button" class="kiro-model-entry" data-kiro-model-summary-btn>
            <div class="kiro-model-entry-copy">
              <span class="kiro-model-entry-title">模型配置</span>
              <span class="kiro-model-entry-summary" data-kiro-model-summary>点击配置展示与自定义模型</span>
            </div>
            <span class="kiro-model-entry-chevron" aria-hidden="true">›</span>
          </button>
          <p class="kiro-models-hint" data-kiro-models-hint>同步后可在聊天输入框快捷选择模型。</p>
        </section>

        <p class="kiro-footnote">
          开启后自动接入 Claude Code；关闭后恢复原 API 配置。凭据与 Kiro IDE / <code>kiro-cli</code> 共用，首次请先登录。
        </p>
      </div>

      <div class="settings-footer">
        <div class="settings-footer-actions">
          <button type="button" class="settings-btn-secondary settings-close-footer">返回</button>
        </div>
      </div>
    </div>
  `;
}
