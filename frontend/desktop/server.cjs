/**
 * 文件说明：桌面版独立前端静态服务器，流式转发 API 并处理 SPA 页面回退。
 * 仅开放构建后的前端资源，不允许访问安装目录中的后端、数据或任意磁盘文件。
 */
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');

const MIME_TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.toml': 'text/plain; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.wasm': 'application/wasm',
  '.woff2': 'font/woff2' };

/** 启动仅监听本机的动态端口服务；返回服务器与实际端口，绑定失败时拒绝 Promise。 */
async function startFrontend(distRoot, backendPort, routes) {
  const root = path.resolve(distRoot);
  const redirects = new Map(routes.map((route) => [`/frontend/${route.htmlFile}`, route.path]));
  const server = http.createServer(async (request, response) => {
    try {
      const origin = `http://127.0.0.1:${server.address().port}`;
      if (request.headers.host !== new URL(origin).host
        || (request.headers.origin && request.headers.origin !== origin)) {
        response.writeHead(403).end();
        return;
      }
      const url = new URL(request.url, origin);
      if (/^\/api(?:\/|$)/.test(url.pathname)) {
        const port = backendPort();
        if (!port) { response.writeHead(503).end(); return; }
        const upstream = http.request({ hostname: '127.0.0.1', port, method: request.method,
          path: url.pathname + url.search, headers: { ...request.headers, host: `127.0.0.1:${port}` } }, (incoming) => {
          response.writeHead(incoming.statusCode, incoming.headers);
          incoming.pipe(response);
          incoming.on('error', () => response.destroy());
        });
        upstream.on('error', () => { if (!response.headersSent) response.writeHead(502); response.end(); });
        request.on('aborted', () => upstream.destroy());
        response.on('close', () => upstream.destroy());
        request.pipe(upstream);
        return;
      }
      if (!['GET', 'HEAD'].includes(request.method)) { response.writeHead(405).end(); return; }
      if (url.pathname === '/' || redirects.has(url.pathname)) {
        response.writeHead(302, { Location: (redirects.get(url.pathname) || routes[0].path) + url.search }).end();
        return;
      }
      const decoded = decodeURIComponent(url.pathname);
      const relative = decoded.replace(/^\/+/, '');
      let file = path.resolve(root, relative);
      if (!file.startsWith(root + path.sep) || relative.includes('\\') || relative.includes('\0')) {
        response.writeHead(403).end(); return;
      }
      if (decoded === '/frontend' || decoded === '/frontend/'
        || (decoded.startsWith('/frontend/') && !path.posix.extname(decoded))) {
        file = path.join(root, 'frontend/index.html');
      }
      const stats = await fs.promises.stat(file).catch(() => null);
      if (!stats?.isFile()) { response.writeHead(404).end(); return; }
      response.writeHead(200, { 'Content-Type': MIME_TYPES[path.extname(file)] || 'application/octet-stream',
        'Content-Length': stats.size, 'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'no-cache' });
      if (request.method === 'HEAD') { response.end(); return; }
      const stream = fs.createReadStream(file);
      stream.on('error', () => response.destroy());
      stream.pipe(response);
    } catch {
      if (!response.headersSent) response.writeHead(400);
      response.end();
    }
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  return { server, port: server.address().port };
}

module.exports = { startFrontend };
