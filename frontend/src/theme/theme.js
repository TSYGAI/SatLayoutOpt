/**
 * 文件说明：提供 React 前端共享的主题读取、应用、持久化和跨页面通知能力。
 * 本模块只管理 document 根节点与本地存储，不依赖具体业务页面。
 */

const THEME_STORAGE_KEY = 'sat-layout-opt-theme';
const THEMES = new Set(['dark', 'light']);

/** 返回当前生效的主题名，未设置、非法或无 DOM 环境时按深色处理。 */
export function getCurrentTheme() {
  const value = typeof document === 'undefined' ? undefined : document.documentElement.dataset.theme;
  return THEMES.has(value) ? value : 'dark';
}

/** 读取浏览器保存的合法主题，存储不可用时返回深色主题。 */
export function getInitialTheme() {
  try {
    const value = window.localStorage.getItem(THEME_STORAGE_KEY);
    return THEMES.has(value) ? value : 'dark';
  } catch (error) {
    return 'dark';
  }
}

/** 将主题应用到页面并按需持久化，同时通知 Three.js 等命令式组件。 */
export function applyTheme(theme, persist = false) {
  const nextTheme = THEMES.has(theme) ? theme : 'dark';
  document.documentElement.dataset.theme = nextTheme;
  if (persist) {
    try {
      window.localStorage.setItem(THEME_STORAGE_KEY, nextTheme);
    } catch (error) {
      // 浏览器禁用本地存储时仍允许当前页面切换主题。
    }
  }
  window.dispatchEvent(new CustomEvent('sat-layout-theme-change', { detail: { theme: nextTheme } }));
  return nextTheme;
}
