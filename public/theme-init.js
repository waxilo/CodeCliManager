// 首屏主题初始化：在 CSS 加载前根据本地偏好设置 <html data-theme>，避免闪烁（FOUC）。
// 独立为外部文件以兼容 CSP `script-src 'self'`（内联脚本会被 CSP 阻止）。
(function () {
  var key = 'codemanager-theme';
  var stored = localStorage.getItem(key);
  var theme =
    stored === 'light' || stored === 'dark'
      ? stored
      : window.matchMedia('(prefers-color-scheme: dark)').matches
        ? 'dark'
        : 'light';
  document.documentElement.dataset.theme = theme;
})();
