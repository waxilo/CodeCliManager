import { invoke } from '@tauri-apps/api/core';
export function setupExternalLinkInterceptor(): void {
  document.addEventListener('click', async (e) => {
    const target = e.target as HTMLElement;
    const anchor = target.closest('a');
    if (!anchor) return;
    const href = anchor.getAttribute('href');
    if (!href || !/^https?:\/\//i.test(href)) return;
    e.preventDefault();
    try {
      await invoke('plugin:opener|open_url', { url: href });
    } catch (err) {
      console.error('[opener] 打开链接失败:', href, err);
    }
  });
}
export function initPlatformClass() {
  const ua = navigator.userAgent.toLowerCase();
  if (ua.includes('mac')) {
    document.documentElement.classList.add('platform-macos');
  } else if (ua.includes('win')) {
    document.documentElement.classList.add('platform-windows');
  }
}

