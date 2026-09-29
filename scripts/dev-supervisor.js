/**
 * 文件说明：本地开发进程编排器，并行管理当前 Python 环境的后端和 Node.js 前端。
 * 任一服务退出时会回收另一服务，避免端口与模型处理线程遗留。
 */

const fs = require('node:fs');
const net = require('node:net');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');
const { readRuntimeConfig } = require('./runtime-config.js');

const projectRoot = path.resolve(__dirname, '..');
const pythonExecutable = process.env.SAT_LAYOUT_OPT_PYTHON || 'python';
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

/** 启动受管服务，并在异常退出时停止整组服务。 */
function startChild(label, command, args) {
  const child = spawn(command, args, { cwd: projectRoot, env: process.env, stdio: 'inherit', windowsHide: false });
  children.push(child);
  child.once('error', (error) => { console.error(`[SatLayoutOpt] ${label}启动失败：${error.message}`); shutdown(1); });
  child.once('exit', (code) => { if (!closing) shutdown(code === 0 ? 0 : 1); });
}

/** 使用系统默认浏览器打开模型上传页。 */
function openBrowser(url) {
  if (process.env.SAT_LAYOUT_OPT_NO_BROWSER === '1') return;
  if (process.platform === 'win32') spawn(process.env.ComSpec || 'cmd.exe', ['/d', '/c', 'start', '', url], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
  else spawn(process.platform === 'darwin' ? 'open' : 'xdg-open', [url], { detached: true, stdio: 'ignore' }).unref();
}

/** 等待前后端端口就绪，超时抛出明确错误。 */
async function waitForPort(host, port, timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await checkPort(host, port)) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`服务未在预期时间内监听端口 ${port}`);
}

/** 校验依赖和端口，并启动前后端服务。 */
async function start() {
  const config = readRuntimeConfig(projectRoot);
  const pythonCheck = spawnSync(pythonExecutable, ['--version'], { stdio: 'ignore', windowsHide: true });
  if (pythonCheck.error || pythonCheck.status !== 0) {
    throw new Error('未找到可用的 Python，请激活项目环境或设置 SAT_LAYOUT_OPT_PYTHON');
  }
  if (!fs.existsSync(path.resolve(projectRoot, 'frontend/node_modules/vite'))) throw new Error('React/Vite 前端依赖未安装，请先在指定环境执行 npm install');
  const occupied = await Promise.all([checkPort(config.backend.host, config.backend.port), checkPort(config.frontend.host, config.frontend.port)]);
  if (occupied[0] || occupied[1]) throw new Error(`开发端口已占用：${occupied[0] ? config.backend.port : config.frontend.port}`);
  startChild('后端', pythonExecutable, ['backend/run.py']);
  startChild('前端', process.execPath, ['frontend/scripts/start-server.js']);
  await Promise.all([waitForPort(config.backend.host, config.backend.port), waitForPort(config.frontend.host, config.frontend.port)]);
  const url = `http://${config.frontend.host}:${config.frontend.port}/frontend/model-upload`;
  console.log(`[SatLayoutOpt] 模型上传工作台已就绪：${url}`);
  openBrowser(url);
}

process.once('SIGINT', () => shutdown(0));
process.once('SIGTERM', () => shutdown(0));
process.once('exit', () => children.forEach(stopChild));
start().catch((error) => { console.error(`[SatLayoutOpt] 启动失败：${error.message}`); shutdown(1); });
