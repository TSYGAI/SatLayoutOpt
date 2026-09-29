/**
 * 文件说明：模型 API 客户端，封装配置、上传、设置、包络生成和浏览资源，以及固化存储与管理请求。
 * 页面层只使用业务化方法，不直接拼接后端地址或解释 TOML 配置。
 */

let configPromise = null;

/** 从 TOML 小节读取数值配置，缺失或无效时使用默认值。 */
function readNumber(section, key, fallback) {
  const match = section.match(new RegExp(`^\\s*${key}\\s*=\\s*([^#\\r\\n]+)`, 'm'));
  const value = Number(match?.[1]?.trim());
  return Number.isFinite(value) ? value : fallback;
}

/** 从统一 TOML 配置读取后端 API 基地址。 */
async function loadConfig() {
  if (!configPromise) {
    const configUrl = new URL('../../../config/sat_layout_opt.toml', import.meta.url);
    configPromise = fetch(configUrl)
      .then((response) => {
        if (!response.ok) throw new Error(`前端配置加载失败（${response.status}）`);
        return response.text();
      })
      .then((content) => {
        const frontendSection = content.match(/\[frontend\]([\s\S]*)/i)?.[1] || '';
        const match = frontendSection.match(/^\s*api_base_url\s*=\s*["']([^"']+)["']\s*$/m);
        if (!match) throw new Error('TOML 配置缺少 frontend.api_base_url');
        return {
          baseUrl: match[1].replace(/\/$/, ''),
          previewQuality: {
            interactionPixelRatio: readNumber(frontendSection, 'preview_interaction_pixel_ratio', 1),
            interactionMinPixelRatio: readNumber(frontendSection, 'preview_interaction_min_pixel_ratio', 0.65),
            idlePixelRatioCap: readNumber(frontendSection, 'preview_idle_pixel_ratio_cap', 1.5),
            idleDelayMs: readNumber(frontendSection, 'preview_idle_delay_ms', 180),
            slowFrameMs: readNumber(frontendSection, 'preview_slow_frame_ms', 20),
            fastFrameMs: readNumber(frontendSection, 'preview_fast_frame_ms', 14),
          },
          envelopePreview: {
            color: readNumber(frontendSection, 'preview_envelope_color', 0x39d0e9),
            opacity: readNumber(frontendSection, 'preview_envelope_opacity', 0.22),
          },
          backgroundTask: {
            runningPollIntervalMs: Math.max(readNumber(frontendSection, 'background_task_running_poll_interval_ms', 1000), 250),
            idlePollIntervalMs: Math.max(readNumber(frontendSection, 'background_task_idle_poll_interval_ms', 5000), 1000),
          },
        };
      });
  }
  return configPromise;
}

/** 返回三维预览的像素比和交互恢复配置。 */
export async function getPreviewQualityConfig() {
  return (await loadConfig()).previewQuality;
}

/** 返回安全包络覆盖层的显示配置。 */
export async function getEnvelopePreviewConfig() {
  return (await loadConfig()).envelopePreview;
}

/** 返回后台任务在运行和空闲状态下的前端轮询间隔。 */
export async function getBackgroundTaskPollingConfig() {
  return (await loadConfig()).backgroundTask;
}

/** 读取已生成且仍有效的安全包络 GLB，失败时返回可展示的后端错误。 */
export async function getModelEnvelopePreview(modelId, signal) {
  const url = await resolveApiUrl(`/api/models/${encodeURIComponent(modelId)}/envelope/preview.glb`);
  const response = await fetch(url, { signal, cache: 'no-store' });
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    throw new Error(body.detail || `包络加载失败（${response.status}）`);
  }
  return response.arrayBuffer();
}

/** 将相对 API 资源地址转换为绝对 URL。 */
export async function resolveApiUrl(path) {
  const { baseUrl } = await loadConfig();
  return `${baseUrl}${path}`;
}

/** 发送 JSON 请求；失败时抛出带 HTTP status 的可展示异常，供页面区分记录缺失与临时故障。 */
export async function requestJson(path, options = {}) {
  const response = await fetch(await resolveApiUrl(path), options);
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(body.detail || `请求失败（${response.status}）`);
    error.status = response.status;
    throw error;
  }
  return body;
}

/** 检查模型 API 是否可用。 */
export async function checkHealth() {
  return requestJson('/api/health');
}

/** 获取全部已上传模型及派生产物状态。 */
export async function listModels() {
  return (await requestJson('/api/models')).models;
}

/** 获取指定模型已保存的设备、变换、质心和安装面设置。 */
export async function getModelSettings(modelId, signal) {
  return (await requestJson(`/api/models/${encodeURIComponent(modelId)}/settings`, { signal })).settings;
}

/** 完整保存指定模型设置，并返回规范化设置与后端判定的包络状态。 */
export async function updateModelSettings(modelId, settings, signal) {
  return requestJson(`/api/models/${encodeURIComponent(modelId)}/settings`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(settings),
    signal,
  });
}

/** 启动不依赖当前页面生命周期的单模型包络后台任务。 */
export async function startModelEnvelopeGeneration(modelId) {
  return (await requestJson(`/api/models/${encodeURIComponent(modelId)}/envelope`, {
    method: 'POST',
    keepalive: true,
  })).task;
}

/** 启动不依赖当前页面生命周期的全部模型包络后台任务。 */
export async function startAllModelEnvelopeGeneration() {
  return (await requestJson('/api/models/envelopes/generate-all', {
    method: 'POST',
    keepalive: true,
  })).task;
}

/** 查询后端当前保留的最新包络任务，用于刷新和切页后的状态恢复。 */
export async function getLatestEnvelopeGenerationTask(signal) {
  return (await requestJson('/api/models/envelopes/task', { signal, cache: 'no-store' })).task;
}

/** 使用 XMLHttpRequest 上传单个 STEP/STP 文件，并持续报告传输进度。 */
export async function uploadModel(file, onProgress) {
  const uploadUrl = await resolveApiUrl('/api/models');
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', uploadUrl);
    xhr.responseType = 'json';
    xhr.upload.onprogress = (event) => {
      const progress = event.lengthComputable ? Math.round((event.loaded / event.total) * 100) : 0;
      onProgress?.(progress);
    };
    xhr.onerror = () => reject(new Error('模型上传网络连接失败'));
    xhr.onabort = () => reject(new Error('模型上传已取消'));
    xhr.onload = () => {
      const body = xhr.response || {};
      if (xhr.status < 200 || xhr.status >= 300) {
        reject(new Error(body.detail || `上传失败（${xhr.status}）`));
        return;
      }
      onProgress?.(100);
      resolve(body.model);
    };
    const formData = new FormData();
    formData.append('file', file, file.name);
    xhr.send(formData);
  });
}

/** 获取模型 GLB 与面映射清单，支持取消过期选择。 */
export async function getPreviewManifest(modelId, signal) {
  return requestJson(`/api/models/${encodeURIComponent(modelId)}/preview-manifest`, { signal });
}

/** 获取可优先显示的交互 LOD 清单，支持取消过期选择。 */
export async function getInteractionPreviewManifest(modelId, signal) {
  return requestJson(`/api/models/${encodeURIComponent(modelId)}/preview-interaction-manifest`, { signal });
}

/** 读取模型的三角网格到 STEP 面映射表。 */
export async function getFaceMapping(path, signal) {
  return requestJson(path, { signal });
}

/** 读取模型刷新后可复用的已合并预览二进制缓存；缓存缺失时返回空。 */
export async function getPreviewRuntimeCache(modelId, signal) {
  const response = await fetch(await resolveApiUrl(`/api/models/${encodeURIComponent(modelId)}/preview-runtime-cache`), { signal });
  if (response.status === 404) return null;
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    throw new Error(body.detail || `预览缓存读取失败（${response.status}）`);
  }
  return response.arrayBuffer();
}

/** 将首次处理完成的双 LOD 网格与面映射保存为可跨刷新恢复的二进制缓存。 */
export async function savePreviewRuntimeCache(modelId, cache, signal) {
  const response = await fetch(await resolveApiUrl(`/api/models/${encodeURIComponent(modelId)}/preview-runtime-cache`), {
    method: 'PUT',
    headers: { 'Content-Type': cache.type },
    body: cache,
    signal,
  });
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    throw new Error(body.detail || `预览缓存保存失败（${response.status}）`);
  }
}

/** 删除指定模型及其全部派生产物。 */
export async function deleteModel(modelId) {
  const response = await fetch(await resolveApiUrl(`/api/models/${encodeURIComponent(modelId)}`), { method: 'DELETE' });
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    throw new Error(body.detail || `删除失败（${response.status}）`);
  }
}

/** 批量删除指定模型并返回实际删除数量。 */
export async function deleteModels(modelIds) {
  return requestJson('/api/models/batch-delete', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ids: modelIds }),
  });
}

/** 把已上传模型及其包络固化为一条存储记录，可选记录名称。 */
export async function saveModelSnapshot(modelId, recordName, signal) {
  return (await requestJson('/api/store/models', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model_id: modelId, record_name: recordName ?? null }),
    signal,
  })).record;
}

/** 分页读取固化存储记录，支持关键字匹配设备名称或来源文件名。 */
export async function listStoredModels({ limit = 100, offset = 0, keyword = '', signal } = {}) {
  const query = new URLSearchParams({ limit: String(limit), offset: String(offset) });
  if (keyword) query.set('keyword', keyword);
  return requestJson(`/api/store/models?${query.toString()}`, { signal, cache: 'no-store' });
}

/** 读取一条存储记录的完整信息，包含设置、包络元数据与基础包络文件。 */
export async function getStoredModel(recordId, signal) {
  return (await requestJson(`/api/store/models/${encodeURIComponent(recordId)}`, { signal, cache: 'no-store' })).record;
}

/** 读取指定已上传模型的固化状态，返回是否已存储、次数与最近一条摘要。 */
export async function getModelStorageState(modelId, signal) {
  return requestJson(`/api/store/sources/${encodeURIComponent(modelId)}`, { signal, cache: 'no-store' });
}

/** 读取固化记录中包络浏览网格的字节，用于数据管理页三维预览。 */
export async function getStoredEnvelopePreview(recordId, signal) {
  const response = await fetch(await resolveApiUrl(`/api/store/models/${encodeURIComponent(recordId)}/envelope/preview.glb`), { signal, cache: 'no-store' });
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    throw new Error(body.detail || `固化包络加载失败（${response.status}）`);
  }
  return response.arrayBuffer();
}

/** 删除一条固化存储记录及其固化资源。 */
export async function deleteStoredModel(recordId) {
  const response = await fetch(await resolveApiUrl(`/api/store/models/${encodeURIComponent(recordId)}`), { method: 'DELETE' });
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    throw new Error(body.detail || `删除固化记录失败（${response.status}）`);
  }
}

/** 批量删除勾选的固化存储记录，返回后端实际删除数量。 */
export async function deleteStoredModels(recordIds) {
  return requestJson('/api/store/models/batch-delete', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ids: recordIds }),
  });
}
