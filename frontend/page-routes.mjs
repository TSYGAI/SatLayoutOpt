/**
 * 文件说明：集中定义前端功能页的公开地址、React Router 路径和旧 HTML 地址。
 * React 导航、Vite 回退与端到端测试共同依赖本文件，避免路由配置分散。
 */

export const PAGE_ROUTES = Object.freeze([
  Object.freeze({ id: 'model-upload', label: '模型上传', path: '/frontend/model-upload', routerPath: '/model-upload', htmlFile: 'model-upload.html' }),
  Object.freeze({ id: 'model-settings', label: '卫星设置', path: '/frontend/model-settings', routerPath: '/model-settings', htmlFile: 'model-settings.html' }),
  Object.freeze({ id: 'pre-config', label: '前置配置', path: '/frontend/pre-config', routerPath: '/pre-config', htmlFile: 'pre-config.html' }),
  Object.freeze({ id: 'layout-optimization', label: '布局优化', path: '/frontend/index', routerPath: '/index', htmlFile: 'index.html' }),
  Object.freeze({ id: 'data-management', label: '数据管理', path: '/frontend/data-management', routerPath: '/data-management', htmlFile: 'data-management.html' }),
]);

/** 根据页面标识返回 React Router 路径，未知页面回退到布局优化页。 */
export function getRouterPath(pageId) {
  return PAGE_ROUTES.find((route) => route.id === pageId)?.routerPath || '/index';
}

/** 返回旧 HTML 地址到无后缀公开地址的映射。 */
export function createLegacyRouteRedirects() {
  return new Map(PAGE_ROUTES.map((route) => [`/frontend/${route.htmlFile}`, route.path]));
}
