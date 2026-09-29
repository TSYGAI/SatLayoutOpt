/**
 * 文件说明：React 公共应用外壳，负责品牌栏、跨页面导航、运行状态和主题切换。
 * 页面业务通过 children 注入，本组件不读取模型数据或调用后端接口。
 */

import { useEffect, useLayoutEffect, useState } from 'react';
import { NavLink, useLocation } from 'react-router-dom';

import { PAGE_ROUTES } from '../../page-routes.mjs';
import { restorePagePosition, savePagePosition } from './page-position-cache.js';
import { applyTheme, getInitialTheme } from '../theme/theme.js';

/** 根据 React Router 匹配结果生成当前菜单样式。 */
function getNavigationClassName({ isActive }) {
  return isActive ? 'active' : undefined;
}

/** 渲染单个不刷新文档的功能页导航链接。 */
function NavigationItem({ item }) {
  return (
    <NavLink className={getNavigationClassName} to={item.routerPath} end>
      {item.label}
    </NavLink>
  );
}

/** 渲染主题切换按钮，并响应其他标签页写入的主题。 */
function ThemeToggle() {
  const [theme, setTheme] = useState(getInitialTheme);

  useEffect(() => {
    /** 将外部主题变化同步到当前 React 状态。 */
    function handleThemeChange(event) {
      setTheme(event.detail?.theme || getInitialTheme());
    }

    /** 将其他标签页的持久化主题同步到当前页面。 */
    function handleStorage(event) {
      if (event.key === 'sat-layout-opt-theme') setTheme(applyTheme(event.newValue || 'dark'));
    }

    window.addEventListener('sat-layout-theme-change', handleThemeChange);
    window.addEventListener('storage', handleStorage);
    return () => {
      window.removeEventListener('sat-layout-theme-change', handleThemeChange);
      window.removeEventListener('storage', handleStorage);
    };
  }, []);

  /** 切换当前主题并保存用户选择。 */
  function handleToggle() {
    applyTheme(theme === 'dark' ? 'light' : 'dark', true);
  }

  const nextTheme = theme === 'dark' ? 'light' : 'dark';
  const label = nextTheme === 'light' ? '亮色' : '暗色';
  return (
    <button
      className="theme-toggle"
      type="button"
      aria-label={`切换到${label}主题`}
      aria-pressed={theme === 'light'}
      onClick={handleToggle}
    >
      <span className={`theme-toggle-icon${nextTheme === 'dark' ? ' is-moon' : ''}`} aria-hidden="true">
        {nextTheme === 'light' ? '☼' : ''}
      </span>
      <span>{label}</span>
    </button>
  );
}

/** 渲染所有功能页共享的顶栏和页面内容区域，并同步浏览器标题与可选的位置缓存。 */
export function AppShell({
  children,
  className = '',
  pageTitle,
  status = '系统就绪',
  statusId,
  preservePagePosition = true,
}) {
  const shellClassName = `app-shell${className ? ` ${className}` : ''}`;
  const location = useLocation();
  useEffect(() => {
    document.title = `${pageTitle} · 卫星配载工作台`;
  }, [pageTitle]);
  useLayoutEffect(() => {
    if (!preservePagePosition) return undefined;
    // React Router 会从 location 中剥离 basename；位置缓存统一使用浏览器公开地址。
    const { pathname, search } = window.location;
    let saveFrame = null;
    /** 合并连续滚动事件，避免高频写入会话存储。 */
    function scheduleSave() {
      if (saveFrame !== null) return;
      saveFrame = window.requestAnimationFrame(() => {
        saveFrame = null;
        savePagePosition(pathname, search);
      });
    }
    /** 在离开页面或刷新前同步保存最后一个位置。 */
    function saveImmediately() {
      savePagePosition(pathname, search);
    }

    restorePagePosition(pathname, search);
    const restoreFrame = window.requestAnimationFrame(() => restorePagePosition(pathname, search));
    window.addEventListener('scroll', scheduleSave, { capture: true, passive: true });
    window.addEventListener('pagehide', saveImmediately);
    return () => {
      if (saveFrame !== null) window.cancelAnimationFrame(saveFrame);
      window.cancelAnimationFrame(restoreFrame);
      window.removeEventListener('scroll', scheduleSave, true);
      window.removeEventListener('pagehide', saveImmediately);
      saveImmediately();
    };
  }, [location.pathname, location.search, preservePagePosition]);
  return (
    <div className={shellClassName} data-scroll-position-key="app-shell">
      <header className="topbar">
        <div className="brand" aria-label="卫星配载工作台">
          <div className="brand-mark"><i /><i /><i /></div>
          <div><strong>卫星配载工作台</strong></div>
        </div>
        <nav className="page-nav" aria-label="页面导航">
          {PAGE_ROUTES.map((item) => <NavigationItem key={item.id} item={item} />)}
        </nav>
        <div className="top-meta">
          <span id={statusId}><b />{status}</span>
          <ThemeToggle />
        </div>
      </header>
      {children}
    </div>
  );
}
