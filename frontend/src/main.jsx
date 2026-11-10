/**
 * 文件说明：Vite React 单页入口，初始化主题、兼容动态 Lucide 图标并挂载路由应用。
 * 功能页选择由 React Router 负责，本文件不访问后端业务数据。
 */

import Archive from 'lucide/dist/esm/icons/archive.js';
import Box from 'lucide/dist/esm/icons/box.js';
import SearchX from 'lucide/dist/esm/icons/search-x.js';
import replaceElement from 'lucide/dist/esm/replaceElement.js';
import { createRoot } from 'react-dom/client';

import { App } from './App.jsx';
import { applyTheme, getInitialTheme } from './theme/theme.js';
import { installDesktopLogging } from './observability/runtime-log.js';
import '../styles/layout.css';

const DYNAMIC_ICONS = Object.freeze({ Archive, Box, SearchX });

/** 为现有模型列表控制器提供动态 Lucide 图标替换接口。 */
function installLucideAdapter() {
  window.lucide = {
    /** 替换控制器动态插入的 data-lucide 占位节点。 */
    createIcons(options = {}) {
      const root = options.root || options.nodes?.[0] || document;
      root.querySelectorAll('[data-lucide]').forEach((element) => {
        replaceElement(element, { nameAttr: 'data-lucide', icons: DYNAMIC_ICONS, attrs: {} });
      });
    },
  };
}

installDesktopLogging();
applyTheme(getInitialTheme());
installLucideAdapter();

const rootElement = document.getElementById('root');
if (!rootElement) throw new Error('React 挂载节点不存在');
createRoot(rootElement).render(<App />);
