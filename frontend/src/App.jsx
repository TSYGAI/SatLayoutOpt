/**
 * 文件说明：React 单页路由器，包含独立人工微调子页；子页不加入顶部功能导航。
 * 数据路由使用 /frontend 基路径并支持未保存编辑阻断；加载与异常边界保留独立功能页。
 */

import { lazy } from 'react';
import { createBrowserRouter, Navigate, RouterProvider } from 'react-router-dom';

import { getRouterPath, PAGE_ROUTES } from '../page-routes.mjs';
import { PageLoadBoundary } from './app/PageLoadBoundary.jsx';

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

/** 按需加载前置配置页，返回 React.lazy 所需的默认组件导出。 */
function loadPreConfigPage() {
  return import('./pages/PreConfigPage.jsx').then((module) => ({ default: module.PreConfigPage }));
}

/** 按需加载布局优化页，避免首页提前处理任务与历史记录组件。 */
function loadLayoutOptimizationPage() {
  return import('./pages/LayoutOptimizationPage.jsx').then((module) => ({ default: module.LayoutOptimizationPage }));
}

/** 按需加载数据管理页，避免首页提前加载固化记录预览。 */
function loadDataManagementPage() {
  return import('./pages/DataManagementPage.jsx').then((module) => ({ default: module.DataManagementPage }));
}

/** 按需加载硬件设置页，返回 React.lazy 所需的默认组件导出。 */
function loadHardwareConfigPage() {
  return import('./pages/HardwareConfigPage.jsx').then((module) => ({ default: module.HardwareConfigPage }));
}

const PreConfigPage = lazy(loadPreConfigPage);
const LayoutOptimizationPage = lazy(loadLayoutOptimizationPage);
/** 按需加载人工微调子页，保持入口属于布局优化。 */
const LayoutRefinementPage = lazy(() => import('./pages/LayoutRefinementPage.jsx').then((module) => ({ default: module.LayoutRefinementPage })));
const DataManagementPage = lazy(loadDataManagementPage);
const HardwareConfigPage = lazy(loadHardwareConfigPage);

const LAYOUT_OPTIMIZATION_PATH = getRouterPath('layout-optimization');
const PAGE_COMPONENTS = {
  'model-upload': ModelUploadPage,
  'model-settings': ModelSettingsPage,
  'pre-config': PreConfigPage,
  'layout-optimization': LayoutOptimizationPage,
  'data-management': DataManagementPage,
  'hardware-config': HardwareConfigPage,
};

/** 声明各功能页以及根地址和未知地址的回退规则。 */
function createAppRouter() {
  return createBrowserRouter([
    { path: '/layout-refinement/:jobId/:candidateId', element: <PageLoadBoundary pageTitle="人工微调"><LayoutRefinementPage /></PageLoadBoundary> },
    ...PAGE_ROUTES.map((page) => {
      const Page = PAGE_COMPONENTS[page.id];
      return { path: page.routerPath, element: <PageLoadBoundary key={page.id} pageTitle={page.label}><Page /></PageLoadBoundary> };
    }),
    { path: '/', element: <Navigate to={LAYOUT_OPTIMIZATION_PATH} replace /> },
    { path: '*', element: <Navigate to={LAYOUT_OPTIMIZATION_PATH} replace /> },
  ], { basename: '/frontend' });
}

const router = createAppRouter();

/** 创建使用 /frontend 基路径的 React 单页应用。 */
export function App() {
  return <RouterProvider router={router} />;
}
