/** 文件说明：按当前方案的型号顺序读取有界二进制资源，在 Worker 派生显示数据；取消、超时均终止 Worker，不保留跨任务缓存。 */
import { observe } from '../observability/runtime-log.js';

import { monitoredFetch } from '../observability/runtime-log.js';

import { getLayoutMeshConfig, requestJson, resolveApiUrl } from './model-upload-api.js';

/** 流式读取有容量上限的响应；错误和中断取消底层流，长度超限不继续下载。 */
export async function readMeshResponse(response, limit, signal) {
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    throw new Error(body.detail || `布局网格加载失败（${response.status}）`);
  }
  const declared = Number(response.headers.get('content-length'));
  if (declared > limit) { await response.body?.cancel(); throw new Error('布局网格超过下载预算'); }
  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  try {
    while (true) {
      signal.throwIfAborted();
      const { value, done } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > limit) throw new Error('布局网格超过下载预算');
      chunks.push(value);
    }
    const result = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) { result.set(chunk, offset); offset += chunk.byteLength; }
    return result.buffer;
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
}

/** 用专用 Worker 处理一次资源；AbortSignal、超时或加载错误均清理事件、终止线程并拒绝 Promise。 */
export function processMeshWorker(buffer, records, limits, signal, legacy = false, options = {}) {
  return observe('网格 Worker 解码和派生', { models: records.join(','), bytes: buffer.byteLength },
    (operation) => processMeshWorkerLogged(buffer, records, limits, signal, legacy, options, operation), { signal, quiet: true });
}

/** 执行网格 Worker 解码和派生；日志边界由同名公开入口管理。 */
function processMeshWorkerLogged(buffer, records, limits, signal, legacy, options, operation) {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL('../components/layout-mesh.worker.js', import.meta.url), { type: 'module' });
    let timer, settled = false;
    /** 完成或失败后立即释放 Worker；转移出的 TypedArray 由调用者管理。 */
    function finish(error, meshes) {
      if (settled) return;
      settled = true;
      clearTimeout(timer); signal.removeEventListener('abort', abort); worker.terminate();
      if (error) reject(error); else resolve(meshes);
    }
    /** 中止过期候选的派生计算。 */
    function abort() { finish(signal.reason || new DOMException('加载已取消', 'AbortError')); }
    worker.onmessage = ({ data }) => {
      if (data.monitor) { operation.step(data.monitor.step, data.monitor); return; }
      finish(data.error ? Object.assign(new Error(data.error), { stack: data.stack }) : null, data.meshes);
    };
    worker.onerror = () => finish(new Error('布局网格 Worker 加载或执行失败'));
    worker.onmessageerror = () => finish(new Error('布局网格 Worker 响应无效'));
    signal.addEventListener('abort', abort, { once: true });
    timer = setTimeout(() => finish(new Error('布局网格处理超时，请降低预览复杂度')), limits.workerTimeoutMs);
    try { worker.postMessage({ buffer, records, limits, legacy, ...options, monitor: operation.enabled }, [buffer]); }
    catch (failure) { finish(failure); }
  });
}

/** 仅加载当前方案缺少的型号，复用同任务的不可变数组；正式 Rust 出错不会退回旧 JSON 路径。 */
export async function loadLayoutMeshSelection(jobId, records, previous, signal) {
  return observe("加载布局方案网格", {job:jobId,models:records.join(",")}, () => loadLayoutMeshSelectionLogged(...arguments), {signal,long:true});
}

/** 执行加载布局方案网格；日志边界由同名公开入口管理。 */
async function loadLayoutMeshSelectionLogged(jobId, records, previous, signal) {
  const limits = await getLayoutMeshConfig();
  signal.throwIfAborted();
  const meshes = Object.fromEntries(records.filter((id) => previous?.[id]).map((id) => [id, previous[id]]));
  const missing = records.filter((id) => !meshes[id]);
  let remaining = limits.geometryMaxBytes - Object.values(meshes).reduce((sum, mesh) => sum + mesh.bytes, 0);
  if (!missing.length) return meshes;
  const base = `/api/layout-optimization/jobs/${encodeURIComponent(jobId)}`;
  let manifest;
  try { manifest = await requestJson(`${base}/mesh-manifest`, { signal, cache: 'no-store' }); }
  catch (failure) {
    if (failure.status !== 404 && failure.status !== 405) throw failure;
    const health = await monitoredFetch(await resolveApiUrl('/api/health'), { signal, cache: 'no-store' });
    await health.body?.cancel();
    if (!health.ok || health.headers.get('x-sat-backend') === 'rust') throw failure;
    const response = await monitoredFetch(await resolveApiUrl(`${base}/meshes`), { signal, cache: 'no-store' });
    const buffer = await readMeshResponse(response, limits.downloadMaxBytes, signal);
    return { ...meshes, ...await processMeshWorker(buffer, missing, { ...limits, geometryMaxBytes: remaining }, signal, true) };
  }
  if (manifest.format !== 'sat-layout-mesh' || manifest.version !== 1 || manifest.job_id !== jobId) throw new Error('不支持的布局网格清单');
  for (const id of missing) {
    signal.throwIfAborted();
    const expected = `${base}/meshes/${encodeURIComponent(id)}/binary`;
    if (manifest.meshes?.[id]?.url !== expected) throw new Error('布局网格资源地址不匹配');
    const response = await monitoredFetch(await resolveApiUrl(expected), { signal, cache: 'no-cache' });
    const buffer = await readMeshResponse(response, limits.downloadMaxBytes, signal);
    const loaded = await processMeshWorker(buffer, [id], { ...limits, geometryMaxBytes: remaining }, signal);
    meshes[id] = loaded[id];
    remaining -= loaded[id].bytes;
  }
  return meshes;
}
