/**
 * 文件说明：SatLayoutOpt 前端 Vite 配置，为 React 单页路由提供入口回退和旧地址跳转。
 * 监听地址、域名白名单及 API 代理目标读取根目录统一 TOML；业务处理仍由独立后端负责。
 * 生产构建产物统一写入 frontend/dist，开发和预览服务均提供同源 /api 转发。
 */

import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { defineConfig } from 'vite';

import runtimeConfigReader from '../scripts/runtime-config.js';
import { createLegacyRouteRedirects, PAGE_ROUTES } from './page-routes.mjs';

const { readRuntimeConfig } = runtimeConfigReader;
const frontendRoot = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(frontendRoot, '..');
const runtimeConfig = readRuntimeConfig(projectRoot);
const legacyRouteRedirects = createLegacyRouteRedirects();
const spaEntryPath = '/frontend/index.html';
const apiProxy = {
  '^/api(?:/|$)': {
    target: `http://${runtimeConfig.backend.host}:${runtimeConfig.backend.port}`,
    changeOrigin: true,
  },
};

/** 将旧 HTML 页面跳转到公开地址，并把直接访问的功能页回退到 SPA 入口。 */
function handlePageRouteRequest(request, response, next) {
  const requestUrl = new URL(request.url || '/', 'http://sat-layout-opt.local');
  const destination = requestUrl.pathname === '/'
    ? PAGE_ROUTES.find((page) => page.id === 'model-upload').path
    : legacyRouteRedirects.get(requestUrl.pathname);
  if (destination) {
    response.statusCode = 308;
    response.setHeader('Location', `${destination}${requestUrl.search}`);
    response.end();
    return;
  }
  if (
    requestUrl.pathname === '/frontend'
    || requestUrl.pathname === '/frontend/'
    || (
      requestUrl.pathname.startsWith('/frontend/')
      && path.posix.extname(requestUrl.pathname) === ''
    )
  ) {
    request.url = `${spaEntryPath}${requestUrl.search}`;
  }
  next();
}

/** 创建供开发服务器和 Vite 预览服务器共用的 SPA 路由插件。 */
function createSpaPageRoutesPlugin() {
  return {
    name: 'sat-layout-spa-page-routes',
    /** 在 Vite 开发服务器处理 HTML 前安装路由回退。 */
    configureServer(server) {
      server.middlewares.use(handlePageRouteRequest);
    },
    /** 在 Vite 生产预览服务器处理 HTML 前安装路由回退。 */
    configurePreviewServer(server) {
      server.middlewares.use(handlePageRouteRequest);
    },
  };
}

export default defineConfig({
  root: projectRoot,
  cacheDir: path.resolve(frontendRoot, 'node_modules/.vite'),
  publicDir: false,
  appType: 'spa',
  plugins: [createSpaPageRoutesPlugin()],
  server: {
    host: runtimeConfig.frontend.host,
    port: runtimeConfig.frontend.port,
    strictPort: true,
    allowedHosts: runtimeConfig.frontend.allowedHosts,
    proxy: apiProxy,
    fs: { allow: [projectRoot] },
  },
  preview: {
    host: runtimeConfig.frontend.host,
    port: runtimeConfig.frontend.port,
    strictPort: true,
    allowedHosts: runtimeConfig.frontend.allowedHosts,
    proxy: apiProxy,
  },
  build: {
    outDir: path.resolve(frontendRoot, 'dist'),
    emptyOutDir: true,
    target: 'es2022',
    rollupOptions: {
      input: path.resolve(frontendRoot, 'index.html'),
    },
  },
});
