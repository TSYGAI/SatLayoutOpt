/** 文件说明：仅 Tauri 注入配置时启用的桌面监测；操作、请求与子步骤通过显式对象或 AbortSignal 关联。
 * 状态批量上报 Rust 单写日志；成功只保留终态和耗时，异常区分后端拒绝与前端读取、解码步骤。
 */
let settings = null;
let nativeFetch = null;
let queue = [];
let sending = false;
let timer = null;
let lost = 0;
let lastAction = null;
let transportFailed = false;
const active = new Set();
const signals = new WeakMap();
const reported = new WeakSet();
const detailKeys = new Set(['step', 'model', 'model_id', 'model_name', 'models', 'record', 'record_id',
  'job', 'job_id', 'task', 'task_id', 'file', 'path', 'url', 'page', 'action', 'bytes', 'vertices',
  'quality', 'backend', 'boundary', 'status', 'stack', 'parent', 'failure_kind']);

/** 将必要标量限定为有界字段，禁止直接倾倒模型、TypedArray 或完整请求。 */
function safe(value) {
  const limit = settings?.fieldLimit || 8192;
  return Object.fromEntries(Object.entries(value || {}).filter(([key, v]) => detailKeys.has(key)
    && v !== null && v !== undefined && ['string', 'number', 'boolean'].includes(typeof v))
    .map(([key, v]) => [key, typeof v === 'string' ? v.slice(0, limit) : v]));
}

/** 写入有限队列，开始与阶段立即投递，业务不等待日志网络响应。 */
function enqueue(event, urgent = false) {
  if (!settings) return;
  if (queue.length >= settings.capacity) { lost += 1; return; }
  queue.push(event);
  if (urgent) void flush();
}

/** 串行发送有界批次；失败保留待发送事件并在控制台可见，不递归记录自身请求。 */
export async function flush() {
  if (!settings || sending || !queue.length) return;
  sending = true;
  const batch = [];
  let size = 2;
  while (queue.length && batch.length < settings.batchSize) {
    const bytes = new TextEncoder().encode(JSON.stringify(queue[0])).byteLength + 1;
    if (size + bytes > settings.maxBytes) {
      if (batch.length) break;
      queue.shift(); lost += 1; continue;
    }
    size += bytes; batch.push(queue.shift());
  }
  if (!batch.length) { sending = false; return; }
  let succeeded = false;
  try {
    const response = await nativeFetch(settings.endpoint, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Sat-Telemetry': '1' },
      body: JSON.stringify(batch), keepalive: true });
    if (!response.ok) throw new Error(`桌面日志接收失败 ${response.status}`);
    succeeded = true; transportFailed = false;
  } catch (error) {
    if (!transportFailed) console.warn('桌面日志投递失败，将按配置重试', error);
    transportFailed = true;
    const pending = [...batch, ...queue];
    lost += Math.max(0, pending.length - settings.capacity);
    queue = pending.slice(0, settings.capacity);
  } finally {
    sending = false;
    if (succeeded && queue.length) void flush();
  }
}

/** 创建独立操作；通过 signal 继承编号但不使用全局 current，允许并发模型处理。 */
export function beginOperation(name, details = {}, { signal, quiet = false, long = false, parent: explicitParent } = {}) {
  const parent = explicitParent || (signal && signals.get(signal));
  const id = `op-${globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(36).slice(2)}`}`;
  const trace = parent?.trace || id;
  const started = performance.now();
  let finished = false;
  let lastProgress = 0;
  const operation = {
    id,
    trace,
    enabled: Boolean(settings),
    /** 有实际字节或工作单元完成才报告进展；限频后由宿主保持当前步骤计时。 */
    progress() {
      parent?.progress();
      const now = performance.now();
      if (!finished && now - lastProgress >= settings?.flushMs) {
        lastProgress = now;
        enqueue({ kind: 'progress', id });
      }
    },
    /** 更新小步骤；宿主按操作保存有限轨迹，不重复发送完整步骤 JSON。 */
    step(step, data = {}) {
      if (finished) return;
      parent?.progress();
      const value = safe({ step, ...details, ...data });
      enqueue({ kind: 'step', id, details: value, progress: true }, true);
    },
    /** 结束真实操作；取消为 INFO，输入拒绝为 WARN，其余异常为 ERROR。 */
    finish(error = null, data = {}) {
      if (finished) return;
      finished = true; active.delete(operation);
      if (signal && signals.get(signal) === operation) signals.delete(signal);
      const cancelled = error?.name === 'AbortError' || signal?.aborted;
      const level = error && !cancelled ? (error.status >= 400 && error.status < 500 ? 'WARN' : 'ERROR') : 'INFO';
      const elapsed = Math.round(performance.now() - started);
      const diagnostic = error || elapsed >= (settings?.slowMs || Infinity);
      enqueue({ kind: 'finish', id, level, elapsed_ms: elapsed, result: cancelled ? '已取消' : error ? '失败' : '完成',
        reason: error ? String(error.message || error) : undefined,
        details: safe({ ...details, ...data, ...(diagnostic ? { stack: error?.stack,
          failure_kind: error ? (error.status >= 400 && error.status < 500 ? 'business' : 'program') : undefined } : {}) }) }, true);
    },
  };
  if (settings) {
    active.add(operation);
    if (signal && !parent) signals.set(signal, operation);
    enqueue({ kind: 'start', id, trace, name, quiet: quiet || Boolean(parent), long: long && !parent,
      details: safe({ step: name, ...details, action: lastAction, parent: parent?.id }) }, true);
  }
  return operation;
}

/** 为明确功能边界记录总耗时和异常，保留原返回值与异常。 */
export async function observe(name, details, action, options = {}) {
  const operation = beginOperation(name, details, options);
  try { const value = await action(operation); operation.finish(); return value; }
  catch (error) { operation.finish(error); throw error; }
}

/** 同步解码也提前发送阶段，阻塞期间由宿主识别无进展；正常仅写结果。 */
export function observeSync(name, details, action) {
  const operation = beginOperation(name, details, { quiet: true });
  operation.step(name);
  try { const value = action(operation); operation.finish(); return value; }
  catch (error) { operation.finish(error); throw error; }
}

/** 测量请求、下载和解码；不克隆或提前消费响应体，不缓存额外模型字节。 */
export async function monitoredFetch(input, options = {}) {
  if (!settings) return globalThis.fetch(input, options);
  const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url, globalThis.location.href);
  if (url.origin !== globalThis.location.origin || !url.pathname.startsWith('/api/')) return nativeFetch(input, options);
  const method = options.method || input?.method || 'GET';
  const operation = beginOperation(`${method} ${url.pathname}`, { path: url.pathname }, { signal: options.signal, quiet: method === 'GET' });
  const headers = new Headers(options.headers || input?.headers);
  headers.set('X-Sat-Operation', operation.trace);
  operation.step('等待 API 响应');
  try {
    const response = await nativeFetch(input, { ...options, headers });
    const cacheMiss = method === 'GET' && /^\/api\/models\/[^/]+\/preview-runtime-cache$/.test(url.pathname)
      && response.status === 404 && response.headers.get('X-Sat-Cache-Miss') === '1';
    const failure = response.ok || cacheMiss ? null : Object.assign(new Error(`HTTP ${response.status}`), { status: response.status });
    /** 正文已正常读完时，将 HTTP 拒绝归到后端处理步骤；读取或解码异常仍由各自 catch 记录。 */
    function finishResponse() {
      if (failure) operation.step('后端处理请求', { status: response.status });
      operation.finish(failure);
    }
    if (!response.body || response.status === 204 || response.status === 304) { finishResponse(); return response; }
    operation.step('读取响应体', { status: response.status });
    return new Proxy(response, {
      /** 仅在调用方消费正文时计时，不把 HTTP 头到达当作操作成功。 */
      get(target, property) {
        if (['json', 'text', 'arrayBuffer', 'blob'].includes(property)) return async () => {
          operation.step(`下载及解码 ${property}`);
          try {
            const value = await target[property]();
            if (failure && typeof value?.detail === 'string') failure.message = value.detail;
            finishResponse(); return value;
          } catch (error) { operation.finish(error); throw error; }
        };
        if (property === 'body') return new Proxy(target.body, {
          /** 保留流式背压，只包装 reader/cancel 的结束边界。 */
          get(body, key) {
            if (key === 'getReader') return (...args) => {
              const reader = body.getReader(...args);
              return new Proxy(reader, {
                /** 不在每个 chunk 刷日志；只记录流结束、错误或主动取消。 */
                get(source, member) {
                  if (member === 'read') return async () => { try { const value = await source.read(); if (value.done) finishResponse(); else operation.progress(); return value; } catch (error) { operation.finish(error); throw error; } };
                  if (member === 'cancel') return async (...args) => { operation.finish(new DOMException('流已取消', 'AbortError')); return source.cancel(...args); };
                  const value = Reflect.get(source, member, source); return typeof value === 'function' ? value.bind(source) : value;
                },
              });
            };
            if (key === 'cancel') return async (...args) => { if (failure) finishResponse(); else operation.finish(cacheMiss ? null : new DOMException('流已取消', 'AbortError')); return body.cancel(...args); };
            const value = Reflect.get(body, key, body); return typeof value === 'function' ? value.bind(body) : value;
          },
        });
        const value = Reflect.get(target, property, target); return typeof value === 'function' ? value.bind(target) : value;
      },
    });
  } catch (error) { operation.finish(error); throw error; }
}

/** 捕获未被业务处理的错误或明确回退，堆栈对象只上报一次。 */
export function reportError(error, level = 'ERROR') {
  if (!settings) return;
  if (error && typeof error === 'object') { if (reported.has(error)) return; reported.add(error); }
  enqueue({ kind: 'message', id: `error-${crypto.randomUUID()}`, level, reason: String(error?.message || error),
    details: safe({ stack: error?.stack, action: lastAction, page: globalThis.location.pathname }) }, true);
}

/** 仅显式注入的桌面实例启用；浏览器版不发送任何遥测请求。 */
export function installDesktopLogging(config = globalThis.__SAT_DESKTOP_LOGGING__) {
  if (!config || settings) return;
  settings = config; nativeFetch = globalThis.fetch.bind(globalThis);
  enqueue({ kind: 'reset', id: `page-${crypto.randomUUID()}` }, true);
  timer = setInterval(() => { if (lost) { const count = lost; lost = 0; reportError(`前端日志队列已满，丢弃 ${count} 条`, 'WARN'); } void flush(); }, settings.flushMs);
  globalThis.addEventListener?.('error', (event) => reportError(event.error || event.message));
  globalThis.addEventListener?.('unhandledrejection', (event) => reportError(event.reason));
  globalThis.document?.addEventListener('click', (event) => {
    const target = event.target.closest?.('button,[role="button"],a,input[type="checkbox"]');
    if (target) lastAction = String(target.getAttribute('aria-label') || target.id || target.textContent || target.tagName).trim().slice(0, 120);
  }, true);
  globalThis.addEventListener?.('pagehide', () => { for (const operation of [...active]) operation.finish(new DOMException('页面退出', 'AbortError')); void flush(); clearInterval(timer); });
}
