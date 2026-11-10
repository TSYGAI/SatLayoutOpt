/** 文件说明：优先加载固定包络二进制并在 Worker 解码；资源异常时按机器可用内存有条件回退旧 JSON 网格。 */
import { observe } from '../observability/runtime-log.js';

import { monitoredFetch } from '../observability/runtime-log.js';

import { getFixedLegacyMemoryConfig, getFixedMeshConfig, getPreviewCacheConfig, getRuntimeMemory, resolveApiUrl } from './model-upload-api.js';
import { processMeshWorker, readMeshResponse } from './layout-mesh-loader.js';

const cached = new Map(), pending = new Map();

/** 按最近使用顺序保留有界显示资源；固化记录不可变，重新固化拥有新的 recordId。 */
function remember(id, mesh, budget) {
  cached.delete(id);
  if (mesh.bytes <= budget.maxBytes) cached.set(id, mesh);
  let total = [...cached.values()].reduce((sum, entry) => sum + entry.bytes, 0);
  while (cached.size > budget.modelLimit || total > budget.maxBytes) {
    const first = cached.keys().next().value;
    total -= cached.get(first).bytes; cached.delete(first);
  }
}

/** 订阅共享资源；离页或过期只释放本次订阅，不中止仍由前台使用的预读。 */
function subscribe(entry, signal) {
  signal.throwIfAborted(); entry.users += 1;
  return new Promise((resolve, reject) => {
    let finished = false;
    /** 释放订阅和事件；最后一个调用者离开时取消下载与 Worker。 */
    function finish(error, mesh) {
      if (finished) return;
      finished = true; signal.removeEventListener('abort', abort);
      entry.users -= 1;
      if (!entry.users && !entry.done) entry.controller.abort();
      if (error) reject(error); else resolve(mesh);
    }
    /** 转发调用方的过期或离页取消。 */
    function abort() { finish(signal.reason || new DOMException('加载已取消', 'AbortError')); }
    signal.addEventListener('abort', abort, { once: true });
    entry.promise.then((mesh) => finish(null, mesh), (error) => finish(error));
  });
}

/** 读取一个不可变型号；首个订阅负责下载，重复选择和预读复用同一次准备。 */
async function loadOne(id, signal, limits, budget) {
  signal.throwIfAborted();
  if (cached.has(id)) {
    const mesh = cached.get(id); remember(id, mesh, budget); return mesh;
  }
  let entry = pending.get(id);
  if (!entry || entry.controller.signal.aborted) {
    entry = { users: 0, done: false, controller: new AbortController() };
    const current = entry;
    current.promise = (async () => {
      try {
        const response = await monitoredFetch(await resolveApiUrl(`/api/store/models/${encodeURIComponent(id)}/fixed-display.bin`),
          { signal: current.controller.signal, cache: 'default' });
        const buffer = await readMeshResponse(response, limits.downloadMaxBytes, current.controller.signal);
        const meshes = await processMeshWorker(buffer, [id], limits, current.controller.signal, false, { fixed: true });
        current.controller.signal.throwIfAborted();
        remember(id, meshes[id], budget);
        return meshes[id];
      } finally {
        current.done = true;
        if (pending.get(id) === current) pending.delete(id);
      }
    })();
    pending.set(id, current);
  }
  return subscribe(entry, signal);
}

/** 取浏览器 JavaScript 堆的剩余空间；浏览器不提供该指标时交给后端物理内存快照判断。 */
function browserAvailableMemory() {
  const memory = globalThis.performance?.memory;
  if (!memory || !Number.isFinite(memory.jsHeapSizeLimit) || !Number.isFinite(memory.usedJSHeapSize)) return Infinity;
  return Math.max(0, memory.jsHeapSizeLimit - memory.usedJSHeapSize);
}

/** 旧接口响应包含 JSON 文本、解析对象和 Worker 数组，准入时为其保留额外空间，避免只按文件长度放行。 */
async function legacyMemoryBudget(signal, policy, previousBytes = 0) {
  const runtime = await getRuntimeMemory(signal);
  signal.throwIfAborted();
  if (!Number.isFinite(runtime?.available_memory_bytes) || runtime.available_memory_bytes < 0) {
    throw new Error('无法确认机器可用内存，已跳过旧网格兜底');
  }
  const available = Math.min(runtime.available_memory_bytes, browserAvailableMemory()) - policy.reserveBytes;
  const geometryMaxBytes = Math.floor(available * policy.fraction) - previousBytes;
  const workerMaxBytes = Math.floor(available * policy.workerFraction) - previousBytes;
  const responseMaxBytes = Math.floor(workerMaxBytes / policy.jsonMemoryFactor);
  if (geometryMaxBytes <= 0 || workerMaxBytes <= 0 || responseMaxBytes <= 0) {
    throw new Error('机器可用内存不足，已跳过旧网格兜底');
  }
  return { responseMaxBytes, geometryMaxBytes, workerMaxBytes };
}

/** 使用原有固定预览 JSON 取得网格；仅在二进制失败且运行时资源准入通过时调用，不改变正式验收结果。 */
async function loadLegacyMeshes(recordIds, request, previous, signal, limits, policy) {
  if (!request?.groups || !request.fingerprint) throw new Error('固定显示二进制不可用，且缺少旧网格兜底参数');
  const previousBytes = Object.values(previous).reduce((sum, mesh) => sum + mesh.bytes, 0);
  const budget = await legacyMemoryBudget(signal, policy, previousBytes);
  const url = await resolveApiUrl('/api/pre-config/fixed-constraints/preview');
  const response = await monitoredFetch(url, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, signal,
    body: JSON.stringify({ groups: request.groups, config_fingerprint: request.fingerprint, include_meshes: true }),
  });
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    throw new Error(body.detail || `旧网格兜底失败（${response.status}）`);
  }
  const declared = Number(response.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > budget.responseMaxBytes) {
    await response.body?.cancel();
    throw new Error('机器可用内存不足，已跳过旧网格兜底');
  }
  const buffer = await readMeshResponse(response, budget.responseMaxBytes, signal);
  const legacyLimits = {
    ...limits,
    downloadMaxBytes: budget.responseMaxBytes,
    geometryMaxBytes: budget.geometryMaxBytes,
    workerMaxBytes: budget.workerMaxBytes,
    jsonMemoryFactor: policy.jsonMemoryFactor,
  };
  const meshes = await processMeshWorker(buffer, recordIds, legacyLimits, signal, true, { fixedLegacy: true });
  return { ...previous, ...meshes };
}

/** 只补齐本次组缺少的型号，成员不变时保持对象身份；当前场景总内存也必须符合统一预算。 */
export async function loadFixedMeshes(recordIds, previous, signal, legacyRequest = null) {
  return observe("加载固定组网格", {models:recordIds.join(",")}, () => loadFixedMeshesLogged(...arguments), {signal,long:true});
}

/** 执行加载固定组网格；日志边界由同名公开入口管理。 */
async function loadFixedMeshesLogged(recordIds, previous, signal, legacyRequest = null) {
  signal.throwIfAborted();
  const ids = [...new Set(recordIds)];
  if (!ids.length) return {};
  if (previous && ids.length === Object.keys(previous).length && ids.every((id) => previous[id])) return previous;
  const [limits, budget, policy] = await Promise.all([getFixedMeshConfig(), getPreviewCacheConfig(), getFixedLegacyMemoryConfig()]);
  const meshes = Object.fromEntries(ids.filter((id) => previous?.[id]).map((id) => [id, previous[id]]));
  const missing = ids.filter((id) => !meshes[id]);
  for (const id of missing) {
    signal.throwIfAborted();
    try {
      meshes[id] = await loadOne(id, signal, limits, budget);
    } catch (error) {
      signal.throwIfAborted();
      if (error?.name === 'AbortError' || !legacyRequest) throw error;
      return loadLegacyMeshes(ids.filter((record) => !meshes[record]), legacyRequest, meshes, signal, limits, policy);
    }
  }
  const bytes = Object.values(meshes).reduce((sum, mesh) => sum + mesh.bytes, 0);
  if (bytes > limits.geometryMaxBytes) {
    // 已解码的数组不重复下载或派生；仅扩展本次场景预算，缓存淘汰策略保持独立。
    const available = await legacyMemoryBudget(signal, policy);
    if (bytes > available.geometryMaxBytes) throw new Error('机器可用内存不足以显示当前固定组');
  }
  return meshes;
}

/** 前置配置确定型号后串行预读预算范围内的资源；失败留给用户实际选择时报告，不阻塞页面。 */
export async function warmFixedMeshes(recordIds, signal) {
  const [limits, budget] = await Promise.all([getFixedMeshConfig(), getPreviewCacheConfig()]);
  let bytes = 0;
  for (const id of [...new Set(recordIds)].slice(0, budget.modelLimit)) {
    if (signal.aborted || bytes >= budget.maxBytes) return;
    try { bytes += (await loadOne(id, signal, limits, budget)).bytes; }
    catch { if (signal.aborted) return; }
  }
}
