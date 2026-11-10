/**
 * 文件说明：卫星配载工作台桌面入口，管理隔离的前后端进程、原生窗口与用户数据。
 * Electron 仅提供窗口和前端资源服务；业务计算由 Nuitka 编译的独立后端执行。
 */
const { app, BrowserWindow, dialog, Menu, screen } = require('electron');
const { spawn, spawnSync } = require('node:child_process');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { startFrontend } = require('./server.cjs');

// Chromium 的 User-Agent 必须使用 ASCII 产品名，中文名称仅用于窗口与安装界面。
app.setName('SatLayoutOpt');
const root = path.dirname(process.execPath);
const backendRoot = path.join(root, 'backend');
const backendExecutable = path.join(backendRoot, 'SatLayoutOptServer.exe');
let window = null;
let backend = null;
let frontend = null;
let exiting = false;
let settings = null;
let log = null;

/** 清除宿主 Python 注入，独立编译后端仅使用自身原生运行库与系统目录。 */
function backendEnvironment(dataRoot) {
  const env = { ...process.env };
  for (const name of Object.keys(env)) {
    if (/^(PYTHON|CONDA)/i.test(name)) delete env[name];
  }
  return { ...env, SAT_LAYOUT_OPT_DATA_ROOT: dataRoot,
    PATH: [backendRoot,
      path.join(process.env.SystemRoot, 'System32'), process.env.SystemRoot].join(path.delimiter) };
}

/** 查询指定后端的健康状态；连接失败或非本应用响应均返回 false。 */
function healthy(port) {
  return new Promise((resolve) => {
    const request = http.get(`http://127.0.0.1:${port}/api/health`, { timeout: 1000 }, (response) => {
      let text = '';
      response.on('data', (chunk) => { text += chunk; if (text.length > 4096) request.destroy(); });
      response.on('end', () => {
        try { const body = JSON.parse(text); resolve(body.status === 'ok' && body.service === 'sat-layout-api'); }
        catch { resolve(false); }
      });
    });
    request.on('timeout', () => request.destroy());
    request.on('error', () => resolve(false));
  });
}

/** 启动后端并等待健康检查成功；超时、启动异常或提前退出时抛出可诊断错误。 */
async function startBackend(frontendPort, dataRoot, onPort) {
  backend = spawn(backendExecutable, ['--frontend-port', String(frontendPort)], {
    cwd: root, windowsHide: true, env: backendEnvironment(dataRoot), stdio: ['pipe', 'pipe', 'pipe'],
  });
  let startError = null;
  let port = null;
  let pending = '';
  backend.on('error', (error) => { startError = error; });
  backend.stdin.on('error', () => {});
  backend.stdout.on('data', (chunk) => {
    log.write(chunk);
    pending += chunk.toString('utf8');
    const lines = pending.split(/\r?\n/);
    pending = lines.pop();
    for (const line of lines) {
      if (line.startsWith('SAT_LAYOUT_READY=')) {
        port = JSON.parse(line.slice('SAT_LAYOUT_READY='.length)).port;
        onPort(port);
      }
    }
  });
  backend.stderr.on('data', (chunk) => log.write(chunk));
  const deadline = Date.now() + settings.startup_timeout_ms;
  while (Date.now() < deadline) {
    if (startError) throw startError;
    if (backend.exitCode !== null) throw new Error(`后台服务已退出，退出码 ${backend.exitCode}`);
    if (port && await healthy(port)) return;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error('后台服务启动超时');
}

/** 正常关闭 API 和静态服务，超出宽限期终止后端；Windows Job 同时回收 CAD 子进程。 */
async function stopServices() {
  frontend?.close();
  frontend?.closeAllConnections();
  if (backend && backend.exitCode === null) {
    await new Promise((resolve) => {
      const timer = setTimeout(() => { backend.kill(); resolve(); }, settings.shutdown_timeout_ms);
      backend.once('exit', () => { clearTimeout(timer); resolve(); });
      backend.stdin.end('stop\n');
    });
  }
  log?.end();
}

/** 从 TOML 加载桌面参数，创建日志和独立服务，随后打开带安全隔离的原生窗口。 */
async function launch() {
  const configResult = spawnSync(backendExecutable, ['--config'], {
    cwd: root, windowsHide: true, encoding: 'utf8', env: backendEnvironment(''),
  });
  if (configResult.error || configResult.status !== 0) {
    throw new Error(configResult.error?.message || configResult.stderr || '无法读取桌面配置');
  }
  settings = JSON.parse(configResult.stdout);
  const dataRoot = process.env.SAT_LAYOUT_OPT_DESKTOP_DATA_ROOT
    || path.join(process.env.LOCALAPPDATA, settings.user_data_dir);
  fs.mkdirSync(path.join(dataRoot, 'logs'), { recursive: true });
  app.setPath('userData', path.join(dataRoot, 'desktop'));
  const logPath = path.join(dataRoot, 'logs/desktop.log');
  if (fs.existsSync(logPath)) fs.renameSync(logPath, logPath + '.previous');
  log = fs.createWriteStream(logPath, { flags: 'a' });
  let backendPort = null;
  const { PAGE_ROUTES } = await import(pathToFileURL(path.join(__dirname, 'page-routes.mjs')).href);
  const service = await startFrontend(path.join(root, 'frontend/dist'), () => backendPort, PAGE_ROUTES);
  frontend = service.server;
  await startBackend(service.port, dataRoot, (port) => { backendPort = port; });
  const origin = `http://127.0.0.1:${service.port}`;
  const workArea = screen.getPrimaryDisplay().workAreaSize;
  window = new BrowserWindow({ title: settings.title, icon: path.join(root, 'app.ico'),
    width: Math.min(settings.width, workArea.width), height: Math.min(settings.height, workArea.height),
    minWidth: Math.min(settings.min_width, workArea.width), minHeight: Math.min(settings.min_height, workArea.height),
    show: false, backgroundColor: '#f5f7f9',
    webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: true, webSecurity: true },
  });
  window.once('ready-to-show', () => window.show());
  window.webContents.on('will-navigate', (event, url) => { if (new URL(url).origin !== origin) event.preventDefault(); });
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.session.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  backend.once('exit', () => {
    if (!exiting) { dialog.showErrorBox(settings.title, `后台服务意外退出，请查看日志：\n${logPath}`); app.quit(); }
  });
  await window.loadURL(origin + settings.entry_path);
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.setAppUserModelId('SatLayoutOpt.Desktop');
  app.on('second-instance', () => { if (window) { if (window.isMinimized()) window.restore(); window.focus(); } });
  app.on('window-all-closed', () => app.quit());
  app.on('before-quit', (event) => {
    if (exiting) return;
    event.preventDefault();
    exiting = true;
    stopServices().finally(() => app.quit());
  });
  app.whenReady().then(async () => {
    Menu.setApplicationMenu(null);
    try { await launch(); }
    catch (error) {
      exiting = true;
      await stopServices();
      dialog.showErrorBox('卫星配载工作台启动失败', `${error.message}\n日志位于用户数据目录的 logs 文件夹。`);
      app.quit();
    }
  });
}
