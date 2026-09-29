/**
 * 文件说明：React 单页应用路由器，在无刷新导航中选择独立功能页组件。
 * BrowserRouter 使用 /frontend 基路径；独立的加载与异常边界确保页面尚未就绪时菜单仍可操作。
 */

import { lazy } from 'react';
import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom';

import { getRouterPath, PAGE_ROUTES } from '../page-routes.mjs';
import { PageLoadBoundary } from './app/PageLoadBoundary.jsx';
import { DataManagementPage } from './pages/DataManagementPage.jsx';
import { LayoutOptimizationPage } from './pages/LayoutOptimizationPage.jsx';
import { PreConfigPage } from './pages/PreConfigPage.jsx';

/** 按需加载包含 Three.js 的模型上传功能页，避免其他入口下载三维渲染依赖。 */
function loadModelUploadPage() {
  return import('./pages/model-upload/ModelUploadPage.jsx');
}

const ModelUploadPage = lazy(loadModelUploadPage);

/** 按需加载复用 Three.js 预览的模型设置功能页。 */
function loadModelSettingsPage() {
  return import('./pages/ModelSettingsPage.jsx').then((module) => ({ default: module.ModelSettingsPage }));
}

const ModelSettingsPage = lazy(loadModelSettingsPage);

const LAYOUT_OPTIMIZATION_PATH = getRouterPath('layout-optimization');
const PAGE_COMPONENTS = {
  'model-upload': ModelUploadPage,
  'model-settings': ModelSettingsPage,
  'pre-config': PreConfigPage,
  'layout-optimization': LayoutOptimizationPage,
  'data-management': DataManagementPage,
};

/** 声明五个功能页以及根地址和未知地址的回退规则。 */
function AppRoutes() {
  return (
    <Routes>
      {PAGE_ROUTES.map((page) => {
        const Page = PAGE_COMPONENTS[page.id];
        return (
          <Route key={page.id} path={page.routerPath} element={
            <PageLoadBoundary key={page.id} pageTitle={page.label}><Page /></PageLoadBoundary>
          } />
        );
      })}
      <Route path="/" element={<Navigate to={LAYOUT_OPTIMIZATION_PATH} replace />} />
      <Route path="*" element={<Navigate to={LAYOUT_OPTIMIZATION_PATH} replace />} />
    </Routes>
  );
}

/** 创建使用 /frontend 基路径的 React 单页应用。 */
export function App() {
  return (
    <BrowserRouter basename="/frontend">
      <AppRoutes />
    </BrowserRouter>
  );
}
