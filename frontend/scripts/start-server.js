/**
 * 文件说明：前端 Vite 开发服务器入口，从统一 TOML 读取地址并加载 React 单页配置。
 * 本文件管理开发服务生命周期与首页预热，并通过 IPC 向编排器报告就绪，不包含页面业务逻辑。
 */

import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { prepareDevServer } from './prepare-dev-server.js';

const require = createRequire(import.meta.url);
const { readRuntimeConfig } = require('../../scripts/runtime-config.js');
const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(scriptDirectory, '../..');
const frontendRoot = path.resolve(projectRoot, 'frontend');
let viteServer = null;
let closing = false;

/** 关闭 Vite 服务并使用指定退出码结束进程。 */
async function shutdown(code = 0) {
  if (closing) return;
  closing = true;
  if (viteServer) await viteServer.close();
  process.exit(code);
}

/** 使用统一配置启动 Vite 开发服务器。 */
async function start() {
  const runtimeConfig = readRuntimeConfig(projectRoot);
  const { createServer } = await import('vite');
  viteServer = await createServer({
    configFile: path.resolve(frontendRoot, 'vite.config.mjs'),
    server: {
      host: runtimeConfig.frontend.host,
      port: runtimeConfig.frontend.port,
      strictPort: true,
    },
  });
  await viteServer.listen();
  console.log('[SatLayoutOpt] 正在准备首页资源，首次启动可能需要几秒……');
  await prepareDevServer(viteServer, runtimeConfig.frontend.devWarmupPaths);
  viteServer.printUrls();
  process.send?.({ type: 'frontend-ready' });
  console.log(`[SatLayoutOpt] React 前端已启动：http://${runtimeConfig.frontend.host}:${runtimeConfig.frontend.port}/frontend/model-upload`);
}

process.once('SIGINT', () => { void shutdown(0); });
process.once('SIGTERM', () => { void shutdown(0); });
start().catch((error) => {
  console.error(`[SatLayoutOpt] React 前端启动失败：${error.message}`);
  void shutdown(1);
});
