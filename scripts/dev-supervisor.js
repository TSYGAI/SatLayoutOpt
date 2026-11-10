/**
 * 文件说明：本地开发进程编排器，并行管理 Rust 业务后端和 Node.js 前端。
 * 等待前端完成资源预热后再打开浏览器；任一服务退出时回收另一服务，避免端口与模型处理线程遗留。
 */

const fs = require('node:fs');
const net = require('node:net');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');
const { readRuntimeConfig } = require('./runtime-config.js');
const { waitForFrontendReady } = require('./dev-readiness.js');

const projectRoot = path.resolve(__dirname, '..');
const rustExecutable = process.env.SAT_LAYOUT_RUST_BACKEND;
const children = [];
let closing = false;

/** 检查本地服务端口是否已被占用。 */
function checkPort(host, port) {
  return new Promise((resolve) => {
    const socket = net.createConnection({ host, port });
    socket.once('connect', () => { socket.destroy(); resolve(true); });
    socket.once('error', () => { socket.destroy(); resolve(false); });
  });
}

/** 跨平台回收单个服务进程及其子进程。 */
function stopChild(child) {
  if (!child?.pid || child.exitCode !== null) return;
  if (process.platform === 'win32') {
    spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
  } else child.kill('SIGTERM');
}

/** 回收全部服务并退出编排器。 */
function shutdown(code = 0) {
  if (closing) return;
  closing = true;
  children.forEach(stopChild);
  setTimeout(() => process.exit(code), 80);
}

/** 启动并返回受管服务；可为 Node 前端启用 IPC，任一服务异常退出时停止整组服务。 */
function startChild(label, command, args, withIpc = false) {
  const child = spawn(command, args, { cwd: projectRoot, env: process.env,
    stdio: withIpc ? ['inherit', 'inherit', 'inherit', 'ipc'] : ['pipe', 'inherit', 'inherit'], windowsHide: true });
  children.push(child);
  child.once('error', (error) => { console.error(`[SatLayoutOpt] ${label}启动失败：${error.message}`); shutdown(1); });
  child.once('exit', (code) => { if (!closing) shutdown(code === 0 ? 0 : 1); });
  return child;
}

/** 使用系统默认浏览器打开模型上传页。 */
function openBrowser(url) {
  if (process.env.SAT_LAYOUT_OPT_NO_BROWSER === '1') return;
  if (process.platform === 'win32') spawn(process.env.ComSpec || 'cmd.exe', ['/d', '/c', 'start', '', url], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
  else spawn(process.platform === 'darwin' ? 'open' : 'xdg-open', [url], { detached: true, stdio: 'ignore' }).unref();
}

/** 等待前后端端口就绪，超时抛出明确错误。 */
async function waitForPort(host, port, timeoutMs, pollIntervalMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await checkPort(host, port)) return;
    await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
  }
  throw new Error(`服务未在预期时间内监听端口 ${port}`);
}

/** 校验依赖和端口，并启动前后端服务。 */
async function start() {
  const config = readRuntimeConfig(projectRoot);
  if (!rustExecutable || !fs.existsSync(rustExecutable)) throw new Error('未找到 Rust 业务后端，请通过 start-dev.bat 在指定环境构建并启动');
  if (!fs.existsSync(path.resolve(projectRoot, 'frontend/node_modules/vite'))) throw new Error('React/Vite 前端依赖未安装，请先在指定环境执行 npm install');
  const occupied = await Promise.all([checkPort(config.backend.host, config.backend.port), checkPort(config.frontend.host, config.frontend.port)]);
  if (occupied[0] || occupied[1]) throw new Error(`开发端口已占用：${occupied[0] ? config.backend.port : config.frontend.port}`);
  startChild('后端', rustExecutable, ['--port', String(config.backend.port), '--managed']);
  const frontend = startChild('前端', process.execPath, ['frontend/scripts/start-server.js'], true);
  await Promise.all([
    waitForPort(config.backend.host, config.backend.port, config.frontend.devStartupTimeoutMs, config.frontend.devPollIntervalMs),
    waitForFrontendReady(frontend, config.frontend.devStartupTimeoutMs),
  ]);
  const url = `http://${config.frontend.host}:${config.frontend.port}/frontend/model-upload`;
  console.log(`[SatLayoutOpt] 模型上传工作台已就绪：${url}`);
  openBrowser(url);
}

process.once('SIGINT', () => shutdown(0));
process.once('SIGTERM', () => shutdown(0));
process.once('exit', () => children.forEach(stopChild));
start().catch((error) => { console.error(`[SatLayoutOpt] 启动失败：${error.message}`); shutdown(1); });
