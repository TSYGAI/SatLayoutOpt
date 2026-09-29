/**
 * 文件说明：Vite React 单页入口，初始化主题、兼容动态 Lucide 图标并挂载路由应用。
 * 功能页选择由 React Router 负责，本文件不访问后端业务数据。
 */

import { Archive, createIcons, SearchX } from 'lucide';
import { createRoot } from 'react-dom/client';

import { App } from './App.jsx';
import { applyTheme, getInitialTheme } from './theme/theme.js';
import '../styles/layout.css';

const DYNAMIC_ICONS = Object.freeze({ Archive, SearchX });

/** 为现有模型列表控制器提供动态 Lucide 图标替换接口。 */
function installLucideAdapter() {
  window.lucide = {
    /** 替换控制器动态插入的 data-lucide 占位节点。 */
    createIcons(options = {}) {
      createIcons({
        icons: DYNAMIC_ICONS,
        root: options.root || options.nodes?.[0] || document,
      });
    },
  };
}

applyTheme(getInitialTheme());
installLucideAdapter();

const rootElement = document.getElementById('root');
if (!rootElement) throw new Error('React 挂载节点不存在');
createRoot(rootElement).render(<App />);
