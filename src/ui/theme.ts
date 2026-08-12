import type { ThemeMode } from '../types';

const THEME_STORAGE_KEY = 'codemanager-theme';

export function getStoredTheme(): ThemeMode | null {
  const stored = localStorage.getItem(THEME_STORAGE_KEY);
  if (stored === 'light' || stored === 'dark') {
    return stored;
  }
  return null;
}

export function getSystemTheme(): ThemeMode {
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

export function getCurrentTheme(): ThemeMode {
  const theme = document.documentElement.dataset.theme;
  return theme === 'light' ? 'light' : 'dark';
}

export function applyTheme(theme: ThemeMode) {
  document.documentElement.dataset.theme = theme;
  localStorage.setItem(THEME_STORAGE_KEY, theme);
  updateThemeToggleButton();
}

export function getThemeToggleTitle(theme: ThemeMode = getCurrentTheme()): string {
  return theme === 'dark' ? '切换到日间模式' : '切换到夜间模式';
}

export function getThemeToggleIcon(theme: ThemeMode = getCurrentTheme()): string {
  if (theme === 'dark') {
    return `<svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M4.93 19.07l1.41-1.41M17.66 6.34l1.41-1.41"/></svg>`;
  }
  return `<svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/></svg>`;
}

export function updateThemeToggleButton() {
  const themeBtn = document.querySelector('#theme-toggle-btn') as HTMLButtonElement | null;
  if (!themeBtn) return;
  themeBtn.title = getThemeToggleTitle();
  themeBtn.setAttribute('aria-label', getThemeToggleTitle());
  themeBtn.innerHTML = getThemeToggleIcon();
}

export function initTheme() {
  applyTheme(getStoredTheme() || getSystemTheme());
}

export function toggleTheme() {
  applyTheme(getCurrentTheme() === 'dark' ? 'light' : 'dark');
}
