/**
 * 文件说明：模型 API 客户端，封装配置、上传、设置、包络生成和浏览资源，以及单个与全部固化存储请求。
 * 页面层只使用业务化方法；预览预算、整流罩虚线、微调选中色、模型搜索近期容量和体素内存建议统一读取 TOML。
 * JSON 请求错误保留原始 detail 与状态码，供页面展示中文字段提示及日志诊断。
 */
import { observe, monitoredFetch } from '../observability/runtime-log.js';
import { mergeHardwareRuntime } from './hardware-runtime.js';


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
    configPromise = monitoredFetch(configUrl)
      .then((response) => {
        if (!response.ok) throw new Error(`前端配置加载失败（${response.status}）`);
        return response.text();
      })
      .then(mergeHardwareRuntime)
      .then((content) => {
        const frontendSection = content.match(/\[frontend\]([\s\S]*)/i)?.[1] || '';
        const match = frontendSection.match(/^\s*api_base_url\s*=\s*["']([^"']+)["']\s*$/m);
        if (!match) throw new Error('TOML 配置缺少 frontend.api_base_url');
        return {
          baseUrl: match[1].replace(/\/$/, ''),
          previewRenderer: {
            preference: frontendSection.match(/^\s*preview_renderer\s*=\s*["'](auto|webgl)["']/m)?.[1] || 'auto',
            initTimeoutMs: Math.max(readNumber(frontendSection, 'preview_webgpu_init_timeout_ms', 8000), 1),
          },
          fairingEdges: {
            dashPx: readNumber(frontendSection, 'fairing_hidden_dash_px', NaN),
            gapPx: readNumber(frontendSection, 'fairing_hidden_gap_px', NaN),
            rayEpsilonRatio: readNumber(frontendSection, 'fairing_edge_ray_epsilon_ratio', NaN),
          },
          previewQuality: {
            interactionPixelRatio: readNumber(frontendSection, 'preview_interaction_pixel_ratio', 1),
            interactionMinPixelRatio: readNumber(frontendSection, 'preview_interaction_min_pixel_ratio', 0.65),
            idlePixelRatioCap: readNumber(frontendSection, 'preview_idle_pixel_ratio_cap', 1.5),
            idleDelayMs: readNumber(frontendSection, 'preview_idle_delay_ms', 180),
            slowFrameMs: readNumber(frontendSection, 'preview_slow_frame_ms', 20),
            fastFrameMs: readNumber(frontendSection, 'preview_fast_frame_ms', 14),
          },
          previewCache: {
            modelLimit: Math.max(Math.floor(readNumber(frontendSection, 'preview_cache_model_limit', 4)), 1),
            maxBytes: Math.max(Math.floor(readNumber(frontendSection, 'preview_cache_max_bytes', 268435456)), 1),
          },
          modelSearch: { recentLimit: readNumber(frontendSection, 'model_search_recent_limit', NaN) },
          modulePreview: {
            preConfigPixelRatioCap: readNumber(frontendSection, 'pre_config_pixel_ratio_cap', NaN),
            dataManagementPixelRatioCap: readNumber(frontendSection, 'data_management_pixel_ratio_cap', NaN),
            dataManagementCacheMaxBytes: readNumber(frontendSection, 'data_management_cache_max_bytes', NaN),
          },
          envelopePreview: {
            color: readNumber(frontendSection, 'preview_envelope_color', 0x39d0e9),
            opacity: readNumber(frontendSection, 'preview_envelope_opacity', 0.22),
          },
          envelopeMemoryRecommendations: {
            defaultResolution: readNumber(content.match(/\[backend\]([\s\S]*?)(?=\n\[|$)/i)?.[1] || '',
              'model_envelope_refinement_grid_size', NaN),
            table: content.match(/\[frontend\.envelope_memory_recommendations\]([\s\S]*?)(?=\n\[|$)/i)?.[1] || '',
          },
          fixedInteraction: Object.fromEntries([
            ['nudgeStepMm', 'fixed_nudge_step_mm'],
            ['mountRotationStepDeg', 'fixed_mount_rotation_step_deg'],
            ['gizmoSizePx', 'fixed_gizmo_size_px'],
            ['validationDebounceMs', 'fixed_validation_debounce_ms'],
          ].map(([name, key]) => {
            const value = readNumber(frontendSection, key, NaN);
            if (!Number.isFinite(value) || value <= 0) throw new Error(`固定放置交互配置无效：${key}`);
            return [name, value];
          })),
          backgroundTask: {
            runningPollIntervalMs: Math.max(readNumber(frontendSection, 'background_task_running_poll_interval_ms', 1000), 250),
            idlePollIntervalMs: Math.max(readNumber(frontendSection, 'background_task_idle_poll_interval_ms', 5000), 1000),
          },
          layoutMesh: Object.fromEntries([
            ['geometryMaxBytes', 'layout_mesh_geometry_max_bytes'],
            ['downloadMaxBytes', 'layout_mesh_download_max_bytes'],
            ['workerMaxBytes', 'layout_mesh_worker_max_bytes'],
            ['workerTimeoutMs', 'layout_mesh_worker_timeout_ms'],
          ].map(([name, key]) => {
            const value = readNumber(frontendSection, key, NaN);
            if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`布局显示配置无效：${key}`);
            return [name, value];
          })),
          fixedDisplayDownloadMaxBytes: readNumber(frontendSection, 'fixed_display_download_max_bytes', 268435456),
          fixedLegacyMemory: {
            reserveBytes: readNumber(frontendSection, 'fixed_legacy_memory_reserve_bytes', 67108864),
            fraction: readNumber(frontendSection, 'fixed_legacy_memory_fraction', 0.45),
            workerFraction: readNumber(frontendSection, 'fixed_legacy_worker_fraction', 0.7),
            jsonMemoryFactor: readNumber(frontendSection, 'fixed_legacy_json_memory_factor', 12),
          },
          layoutPreview: {
            fixedColor: readNumber(frontendSection, 'layout_fixed_satellite_color', NaN),
            optimizedColor: readNumber(frontendSection, 'layout_optimized_satellite_color', NaN),
            selectedColor: readNumber(frontendSection, 'layout_refinement_selected_color', NaN),
            refinementFillRatio: readNumber(frontendSection, 'layout_refinement_view_fill_ratio', NaN),
            opacity: readNumber(frontendSection, 'layout_satellite_opacity', NaN),
          },
        };
      }).catch((error) => { configPromise = null; throw error; });
  }
  return configPromise;
}

/** 返回三维预览的像素比和交互恢复配置。 */
export async function getPreviewQualityConfig() {
  return (await loadConfig()).previewQuality;
}

/** 返回非当前场景的预览缓存数量和网格数组字节预算，后台加载不能无限累积内存。 */
export async function getPreviewCacheConfig() {
  return (await loadConfig()).previewCache;
}

/** 返回卫星模型搜索的最近使用上限；缺失或非法配置抛错，避免容量散落在业务代码中。 */
export async function getModelSearchConfig() {
  const config = (await loadConfig()).modelSearch;
  if (!Number.isSafeInteger(config.recentLimit) || config.recentLimit < 0) {
    throw new Error('frontend.model_search_recent_limit 必须为非负整数');
  }
  return config;
}

/** 返回当前后端会话的专属画布和缓存预算；缺失配置时明确报错，避免前端另设默认值。 */
export async function getModulePreviewConfig() {
  const values = (await loadConfig()).modulePreview;
  if (Object.values(values).some((value) => !Number.isFinite(value) || value <= 0)) {
    throw new Error('分模块预览预算缺失或无效，请检查统一 TOML 配置');
  }
  return values;
}

/** 返回三维渲染后端偏好及 WebGPU 初始化时限；配置加载失败时由渲染控制器回退 WebGL。 */
export async function getPreviewRendererConfig() {
  return (await loadConfig()).previewRenderer;
}

/** 返回安全包络覆盖层的显示配置。 */
export async function getEnvelopePreviewConfig() {
  return (await loadConfig()).envelopePreview;
}

/** 读取仅供展示的体素分辨率与内存建议，默认档位沿用后端配置；格式错误时抛出可展示异常。 */
export async function getEnvelopeMemoryRecommendations() {
  const { table, defaultResolution } = (await loadConfig()).envelopeMemoryRecommendations;
  const lines = table.split(/\r?\n/).map((line) => line.split('#')[0].trim()).filter(Boolean);
  const rows = lines.map((line) => {
    const match = line.match(/^(\d+)\s*=\s*(\d+)$/);
    if (!match) throw new Error('体素分辨率推荐配置格式无效');
    const resolution = Number(match[1]), memoryGb = Number(match[2]);
    if (![resolution, memoryGb].every((value) => Number.isSafeInteger(value) && value > 0)) {
      throw new Error('体素分辨率推荐配置必须为正整数');
    }
    return { resolution, memoryGb, isDefault: resolution === defaultResolution };
  });
  if (!rows.length || new Set(rows.map((row) => row.resolution)).size !== rows.length) {
    throw new Error('体素分辨率推荐配置缺失或重复');
  }
  return rows.sort((left, right) => left.resolution - right.resolution);
}

/** 返回固定放置微调步长、六向箭头屏幕尺寸及正式校验等待时间；仅用于客户端交互。 */
export async function getFixedInteractionConfig() {
  return (await loadConfig()).fixedInteraction;
}

/** 返回后台任务在运行和空闲状态下的前端轮询间隔。 */
export async function getBackgroundTaskPollingConfig() {
  return (await loadConfig()).backgroundTask;
}

/** 返回当前布局显示的下载、共享几何与 Worker 预算。 */
export async function getLayoutMeshConfig() {
  return (await loadConfig()).layoutMesh;
}

/** 固定页下载与预读共用专属文件限额；共享几何与 Worker 默认预算沿用布局显示配置。 */
export async function getFixedMeshConfig() {
  const config = await loadConfig();
  const downloadMaxBytes = config.fixedDisplayDownloadMaxBytes;
  if (!Number.isSafeInteger(downloadMaxBytes) || downloadMaxBytes <= 0) throw new Error('固定显示下载限额无效');
  return { ...config.layoutMesh, downloadMaxBytes };
}

/** 返回统一的整流罩隐藏线样式；缺项或非法值明确报错，避免视口采用不一致的显示参数。 */
export async function getFairingEdgeConfig() {
  const style = (await loadConfig()).fairingEdges;
  if (!Object.values(style).every((value) => Number.isFinite(value) && value > 0) || style.rayEpsilonRatio >= 1) {
    throw new Error('整流罩隐藏边线配置无效');
  }
  return style;
}

/** 返回布局配色、包络透明度、微调画幅比例及共用罩体边线配置；固定与优化颜色必须不同。 */
export async function getLayoutPreviewConfig() {
  const style = (await loadConfig()).layoutPreview;
  if (![style.fixedColor, style.optimizedColor, style.selectedColor].every((value) => Number.isInteger(value) && value >= 0 && value <= 0xffffff)
      || style.fixedColor === style.optimizedColor || !Number.isFinite(style.opacity) || style.opacity < 0 || style.opacity > 1
      || !Number.isFinite(style.refinementFillRatio) || style.refinementFillRatio <= 0 || style.refinementFillRatio >= 1) {
    throw new Error('布局卫星的配色、透明度或微调画幅比例配置无效');
  }
  return { ...style, fairingEdges: await getFairingEdgeConfig() };
}

/** 读取已生成且仍有效的安全包络 GLB，失败时返回可展示的后端错误。 */
export async function getModelEnvelopePreview(modelId, signal) {
  const url = await resolveApiUrl(`/api/models/${encodeURIComponent(modelId)}/envelope/preview.glb`);
  const response = await monitoredFetch(url, { signal, cache: 'no-store' });
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
  const response = await monitoredFetch(await resolveApiUrl(path), options);
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    const detail = Array.isArray(body.detail) ? body.detail.map((item) => item.msg || String(item)).join('；') : body.detail;
    const error = new Error(detail || `请求失败（${response.status}）`);
    error.status = response.status;
    error.detail = body.detail;
    throw error;
  }
  return body;
}

/** 检查模型 API 是否可用。 */
export async function checkHealth() {
  return requestJson('/api/health');
}

/** 读取后端所在机器的可用物理内存；旧后端或代理不支持时返回空值，由调用方采用保守策略。 */
export async function getRuntimeMemory(signal) {
  try {
    const value = await requestJson('/api/runtime-resources', { signal, cache: 'no-store' });
    return Number.isFinite(value.available_memory_bytes) ? value : null;
  } catch (error) {
    if (error?.name === 'AbortError') throw error;
    return null;
  }
}

/** 返回固定旧网格兜底的内存预留策略；具体可用空间仍由运行时快照提供。 */
export async function getFixedLegacyMemoryConfig() {
  const policy = (await loadConfig()).fixedLegacyMemory;
  if (!Number.isSafeInteger(policy.reserveBytes) || policy.reserveBytes < 0
      || !(policy.fraction > 0 && policy.fraction <= policy.workerFraction && policy.workerFraction < 1)
      || !Number.isFinite(policy.jsonMemoryFactor) || policy.jsonMemoryFactor < 1) {
    throw new Error('固定旧网格内存策略无效');
  }
  return policy;
}

/** 获取全部已上传模型及派生产物状态；绕过 HTTP 缓存，避免删除后复用旧列表。 */
export async function listModels() {
  return (await requestJson('/api/models', { cache: 'no-store' })).models;
}

/** 获取指定模型已保存的设备、变换、质心和安装面设置。 */
export async function getModelSettings(modelId, signal) {
  return (await requestJson(`/api/models/${encodeURIComponent(modelId)}/settings`, { signal })).settings;
}

/** 完整保存指定模型设置，并返回规范化设置与后端判定的包络状态。 */
export async function updateModelSettings(modelId, settings, signal, expectedSettings) {
  return requestJson(`/api/models/${encodeURIComponent(modelId)}/settings`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...settings, ...(expectedSettings ? { expected_settings: expectedSettings } : {}) }),
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
  return observe('上传模型', { file: file.name, bytes: file.size }, (operation) => uploadModelLogged(file, onProgress, operation), { long: true });
}

/** 执行上传模型；日志边界由同名公开入口管理。 */
async function uploadModelLogged(file, onProgress, uploadLog) {
  uploadLog.step('解析上传地址');
  const uploadUrl = await resolveApiUrl('/api/models');
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', uploadUrl);
    uploadLog.step('上传模型文件');
    if (uploadLog.enabled) xhr.setRequestHeader('X-Sat-Operation', uploadLog.trace);
    xhr.responseType = 'json';
    xhr.upload.onprogress = (event) => {
      uploadLog.progress();
      const progress = event.lengthComputable ? Math.round((event.loaded / event.total) * 100) : 0;
      onProgress?.(progress);
    };
    xhr.upload.onload = () => uploadLog.step('上传完成，等待后端解析入库');
    xhr.onerror = () => { const error = new Error('模型上传网络连接失败'); uploadLog.finish(error); reject(error); };
    xhr.onabort = () => { const error = new DOMException('模型上传已取消','AbortError'); uploadLog.finish(error); reject(error); };
    xhr.onload = () => {
      const body = xhr.response || {};
      uploadLog.finish(xhr.status >= 200 && xhr.status < 300 ? null : Object.assign(new Error(body.detail || `HTTP ${xhr.status}`), {status:xhr.status}));
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
  const response = await monitoredFetch(await resolveApiUrl(`/api/models/${encodeURIComponent(modelId)}/preview-runtime-cache`), { signal });
  if (response.status === 404) { await response.body?.cancel(); return null; }
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    throw new Error(body.detail || `预览缓存读取失败（${response.status}）`);
  }
  return response.arrayBuffer();
}

/** 将首次处理完成的双 LOD 网格与面映射保存为可跨刷新恢复的二进制缓存。 */
export async function savePreviewRuntimeCache(modelId, cache, signal) {
  const response = await monitoredFetch(await resolveApiUrl(`/api/models/${encodeURIComponent(modelId)}/preview-runtime-cache`), {
    method: 'PUT',
    headers: { 'Content-Type': cache.type },
    body: cache,
    signal,
  });
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    throw new Error(body.detail || `预览缓存保存失败（${response.status}）`);
  }
  await response.body?.cancel();
}

/** 删除指定模型及其全部派生产物；保留错误状态码，供页面清理已经不存在的模型行。 */
export async function deleteModel(modelId) {
  await requestJson(`/api/models/${encodeURIComponent(modelId)}`, { method: 'DELETE' });
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

/** 固化全部已上传模型各自的已保存设置，返回成功记录及逐模型失败；不在客户端复制存储准入规则。 */
export async function saveAllModelSnapshots() {
  return requestJson('/api/store/models/save-all', { method: 'POST' });
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
  const response = await monitoredFetch(await resolveApiUrl(`/api/store/models/${encodeURIComponent(recordId)}/envelope/preview.glb`), { signal, cache: 'no-store' });
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    throw new Error(body.detail || `固化包络加载失败（${response.status}）`);
  }
  return response.arrayBuffer();
}

/** 删除一条固化存储记录及其固化资源。 */
export async function deleteStoredModel(recordId) {
  const response = await monitoredFetch(await resolveApiUrl(`/api/store/models/${encodeURIComponent(recordId)}`), { method: 'DELETE' });
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
