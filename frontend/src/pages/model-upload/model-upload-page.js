/**
 * 文件说明：模型上传页与模型设置页的共享预览控制器，负责模型库、页面选择、Z 轴朝上的三维场景与内存预览。
 * 生成队列、已有资源读取队列和网格缓存属于应用会话；设置页兼容空模型库与重复草稿清理，精确几何由后端负责。
 * 设置页通过独立搜索控制器按设备名称和文件名检索，并接收模型名称摘要用于批量进度；上传页仍按原始文件名管理模型。
 */

import * as THREE from 'three';
import { formatParameterNumber } from '../../utils/number-format.js';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { disposeOrbitControls } from '../../components/orbit-controls-lifecycle.js';
import { PreviewRenderer } from '../../components/preview-renderer.js';
import { createOrientationGizmo } from '../../components/orientation-gizmo.js';
import { showToast } from '../../components/toast.js';
import { restorePagePosition } from '../../app/page-position-cache.js';
import {
  checkHealth,
  getPreviewCacheConfig,
  getModelSearchConfig,
  getPreviewQualityConfig,
  listModels,
} from '../../api/model-upload-api.js';
import {
  createInteractionQualityState,
  createPreviewTransitionState,
  DEFAULT_PREVIEW_QUALITY_CONFIG,
  normalizePreviewQualityConfig,
  recordInteractionFrame,
  transitionPreviewState,
} from './preview-quality.js';
import {
  createModelPageSelections,
  readStoredModelSelection,
  readStoredModelView,
  removeStoredModelView,
  writeStoredModelSelection,
  writeStoredModelView,
} from './model-preview-view-state.js';
import {
  getModelPreviewTransform,
  MODEL_SETTINGS_SELECTION_EVENT,
} from '../model-settings/model-settings-state.js';
import { createModelSettingPreviewTools } from '../model-settings/model-setting-preview-tools.js';
import { createModelEnvelopePreview } from '../model-settings/model-envelope-preview.js';
import { disposeObject } from './model-preview-resources.js';
import { createCoordinateAxes, setCoordinateAxesSize } from '../../components/coordinate-axes.js';
import { createModelDeletionActions } from './model-upload-deletion.js';
import { createModelUploadActions } from './model-upload-actions.js';
import { createPreviewResources, measurePreviewBytes } from './preview-resource-loader.js';
import { createPreviewLoadQueue } from './preview-load-queue.js';
import { applySourceDisplayTransform } from '../model-settings/coordinate-frame.js';
import { createCoordinateFramePreview } from '../model-settings/coordinate-frame-preview.js';
import { createModelSearchSelect } from '../model-settings/model-search-select.js';

const ARTIFACT_LABELS = { failed: '生成失败', pending: '等待生成', processing: '正在转换', ready: '预览就绪' };
const GRID_DIVISIONS = 24;
const GRID_MODEL_RADIUS_FACTOR = 3;
const GRID_BOUNDS_MARGIN = 1.15;
const EMPTY_PREVIEW_GRID_SIZE = 10;
const EMPTY_PREVIEW_CAMERA_POSITION = Object.freeze([8, 10, 9]);
/** 两个模型预览页统一采用 Z 轴朝上的世界坐标系。 */
const SCENE_UP = Object.freeze([0, 0, 1]);
const MODEL_UPLOAD_VIEW_SAVE_DELAY_MS = 120;
const MODEL_PREVIEW_HANDOFF_DELAY_MS = 0;
const ORIENTATION_GIZMO_PIXEL_RATIO = 2;
const TOPOLOGY_EDGE_OPACITY = 0.5;
const DEFAULT_MODEL_QUATERNION = new THREE.Quaternion();
const SCENE_PALETTES = {
  dark: { background: 0x030609, preview: [0x87, 0x94, 0x9f], edge: 0x41535f, gridOpacity: 0.62 },
  light: { background: 0xe8eef3, preview: [0x58, 0x6d, 0x7d], edge: 0x41535f, gridOpacity: 0.62 },
};
const state = {
  models: [], modelsLoaded: false, selectedModel: null, selectedIds: new Set(), search: '', loadToken: 0, pendingUploads: 0,
  modelsRefreshToken: 0, deleting: false, onRequestDelete: null,
  scene: null, mappingEntries: [], previewManifest: null, interactionManifest: null, previewCache: new Map(),
  previewCacheConfig: null,
  qualityConfig: normalizePreviewQualityConfig(DEFAULT_PREVIEW_QUALITY_CONFIG), interactionQuality: null,
  previewTransition: null,
  isInteracting: false, idleTimer: null, lastRenderAt: 0,
  showTopologyEdges: true, scrollRestoreApplied: false,
  pendingViewSnapshot: null, viewSaveTimer: null,
  pageMode: 'upload',
  pageSelections: createModelPageSelections(),
  selectFirstModel: false,
  modelSettings: null,
  settingsNotifiedModelId: undefined,
  coordinateFrameDraft: null,
  connection: { message: '连接检查中', error: false },
};
let activePageLifecycle = null;
let deferredPreviewDisposeTimer = null;
const { requestModelDeletion } = createModelDeletionActions({
  state, getLifecycle: () => activePageLifecycle, renderModelList, refreshModels,
  evictCachedPreviews, clearModelView, clearPreview, clearModelScene, syncPreviewQueue,
});
const { uploadFiles } = createModelUploadActions({
  state, getLifecycle: () => activePageLifecycle, renderModelList, refreshModels, selectModel, syncPreviewQueue,
});

const previewResources = createPreviewResources({ getScenePalette, edgeOpacity: TOPOLOGY_EDGE_OPACITY });
const previewQueue = createPreviewLoadQueue({
  load: previewResources.loadTier,
  onResult: acceptBackgroundPreview,
  onChange: renderPreviewQueueState,
  disposeResult: (result) => disposePreview(result.preview),
  canStartDetail: () => state.pendingUploads === 0,
});
const modelSearchSelect = createModelSearchSelect({
  getModels: getSettingsPreviewModels,
  getExistingModels: () => state.models,
  getSelectedModel: () => state.selectedModel,
  getEmptyLabel: getSettingsModelEmptyLabel,
  onSelect: selectModel,
});

/** 深拷贝包含嵌套质心和安装点对象的模型设置，避免页面草稿修改模型列表缓存。 */
function cloneModelSettings(settings = {}) {
  return {
    ...settings,
    center_of_mass: settings?.center_of_mass ? { ...settings.center_of_mass } : null,
    installation_point: settings?.installation_point ? { ...settings.installation_point } : null,
    coordinate_frame: settings?.coordinate_frame ? structuredClone(settings.coordinate_frame) : undefined,
  };
}

/** 返回当前页面的预览设置；上传页使用当前模型坐标，单位比例及摆放姿态由设置页应用。 */
function getCurrentPreviewSettings() {
  if (state.pageMode !== 'settings') return { coordinate_frame: state.selectedModel?.settings?.coordinate_frame };
  return state.modelSettings || state.selectedModel?.settings || {};
}

/** 比例编辑保持相机位置，让实际尺寸变化可见；只扩展裁剪范围，适配视图由用户主动触发。 */
function updatePreviewClippingForScale(previousScale, nextScale) {
  const { camera, controls } = state.scene || {};
  if (!camera || !controls || !Number.isFinite(previousScale) || previousScale <= 0
    || !Number.isFinite(nextScale) || nextScale <= 0) return;
  const ratio = nextScale / previousScale;
  if (Math.abs(ratio - 1) < 1e-9) return;
  camera.near = Math.max(Math.min(camera.near, camera.near * ratio), 0.0001);
  camera.far = Math.max(camera.far, camera.far * ratio, camera.near + 1);
  camera.updateProjectionMatrix();
  controls.update();
}

/** 从 sessionStorage 读取并校验当前页面的选中项与相机视角。 */
function readModelView(pageMode = state.pageMode) {
  return readStoredModelView(pageMode);
}

/** 清除指定页面已经失效的模型选择和视角缓存。 */
function clearModelView(pageMode = state.pageMode) {
  if (pageMode === state.pageMode) {
    window.clearTimeout(state.viewSaveTimer);
    state.viewSaveTimer = null;
    state.pendingViewSnapshot = null;
  }
  state.pageSelections[pageMode] = null;
  removeStoredModelView(pageMode);
}

/** 将当前页面选中模型及相机参数同步写入其独立会话缓存。 */
function saveModelView() {
  window.clearTimeout(state.viewSaveTimer);
  state.viewSaveTimer = null;
  if (state.coordinateFrameDraft) return;
  const { camera, controls, panOffset, modelRoot } = state.scene || {};
  if (!state.selectedModel || !modelRoot || !camera || !controls || !panOffset) return;
  state.pageSelections[state.pageMode] = state.selectedModel.id;
  const snapshot = {
    modelId: state.selectedModel.id,
    cameraPosition: camera.position.toArray(),
    cameraUp: camera.up.toArray(),
    target: controls.target.toArray(),
    panOffset: panOffset.toArray(),
    near: camera.near,
    far: camera.far,
  };
  writeStoredModelView(state.pageMode, snapshot);
}

/** 延迟合并当前页面的连续相机变化，避免交互期间高频写入会话缓存。 */
function scheduleModelViewSave() {
  if (!state.selectedModel || state.viewSaveTimer !== null) return;
  state.viewSaveTimer = window.setTimeout(saveModelView, MODEL_UPLOAD_VIEW_SAVE_DELAY_MS);
}

/** 在模型首次适配完成后应用待恢复的相机视角。 */
function restorePendingModelView() {
  const snapshot = state.pendingViewSnapshot;
  const { camera, controls, panOffset } = state.scene || {};
  if (!snapshot || snapshot.modelId !== state.selectedModel?.id || !camera || !controls || !panOffset) return false;
  state.pendingViewSnapshot = null;
  camera.position.fromArray(snapshot.cameraPosition);
  camera.up.fromArray(snapshot.cameraUp);
  camera.near = Math.max(snapshot.near, 0.0001);
  camera.far = Math.max(snapshot.far, camera.near + 1);
  controls.target.fromArray(snapshot.target);
  panOffset.fromArray(snapshot.panOffset);
  camera.updateProjectionMatrix();
  controls.update();
  applyPreviewPan();
  setCoordinateAxesSize(state.scene);
  requestSceneRender();
  saveModelView();
  return true;
}

/** 返回至少成功加载过简易或高清预览的模型；内存淘汰后的资源可重载，后端就绪标记不作为加载成功证据。 */
function getSettingsPreviewModels() {
  return state.models.filter((model) => previewQueue.get(model.id)?.hasLoadedPreview
    || (state.selectedModel?.id === model.id && Boolean(state.scene?.modelRoot)));
}

/** 根据页面选择和会话快照解析模型；设置页仅恢复可用预览，暂未加载的历史选择保留至有可用候选。 */
function resolveCurrentPageModel(cachedView) {
  const pageMode = state.pageMode;
  const preferredModelId = state.pageSelections[pageMode]
    || readStoredModelSelection(pageMode)
    || cachedView?.modelId;
  const candidates = pageMode === 'settings' ? getSettingsPreviewModels() : state.models;
  const preferredModel = preferredModelId
    ? candidates.find((model) => model.id === preferredModelId)
    : null;
  if (preferredModelId && !state.models.some((model) => model.id === preferredModelId)) clearModelView(pageMode);
  const model = preferredModel || (state.selectFirstModel ? candidates[0] : null);
  if (model || pageMode !== 'settings') state.pageSelections[pageMode] = model?.id || null;
  if (model) writeStoredModelSelection(pageMode, model.id);
  return model;
}

/** 在开发环境将已挂载控制器的相机快照入口提供给端到端测试。 */
function exposePreviewTestApi() {
  if (!import.meta.env.DEV) return;
  window.__satLayoutPreviewTestApi = { getInteractionSnapshot: getPreviewInteractionSnapshot };
}

/** 返回当前页面主题对应的三维场景配色。 */
function getScenePalette() {
  return SCENE_PALETTES[document.documentElement.dataset.theme] || SCENE_PALETTES.dark;
}

/** 在下一帧校正主题切换后的预览画布尺寸，避免容器重排造成视口拉伸。 */
function resizeSceneAfterThemeChange() {
  window.requestAnimationFrame(() => window.requestAnimationFrame(resizeScene));
}

/** 格式化模型文件大小。 */
function formatSize(bytes) {
  if (!Number.isFinite(bytes) || bytes < 1024) return `${bytes || 0} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let value = bytes;
  let index = -1;
  while (value >= 1024 && index < units.length - 1) { value /= 1024; index += 1; }
  return `${formatParameterNumber(value)} ${units[index]}`;
}

/** 把后端 UTC 时间格式化为紧凑的本地时间。 */
function formatDate(value) {
  const date = new Date(value);
  if (Number.isNaN(date.valueOf())) return '--';
  return date.toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false });
}

/** 更新顶部后端连接状态。 */
function setConnection(message, error = false) {
  state.connection = { message, error };
  const badge = document.getElementById('model-connection');
  if (!badge) return;
  badge.innerHTML = `<b class="${error ? 'error' : ''}"></b>${message}`;
}

/** 更新预览区操作状态。 */
function setPreviewStatus(message, kind = '') {
  const badge = document.getElementById('preview-status');
  if (!badge) return;
  badge.className = `status-badge${kind ? ` ${kind}` : ''}`;
  badge.innerHTML = `<b></b>${message}`;
}

/** 控制 GLB 生成或下载时的遮罩及详细提示。 */
function setLoading(visible, title = '正在生成浏览网格', detail = 'STEP 面正在离散为 GLB 并建立映射') {
  const loading = document.getElementById('model-loading');
  if (!loading) return;
  loading.hidden = !visible;
  loading.querySelector('strong').textContent = title;
  loading.querySelector('small').textContent = detail;
}

/** 创建不包含 HTML 注入风险的模型列表行。 */
function createModelRow(model) {
  const row = document.createElement('div');
  row.className = `model-row${state.selectedModel?.id === model.id ? ' selected' : ''}`;
  row.dataset.modelId = model.id;
  const checkbox = document.createElement('input');
  checkbox.type = 'checkbox';
  checkbox.checked = state.selectedIds.has(model.id);
  checkbox.dataset.role = 'select';
  checkbox.setAttribute('aria-label', `选择 ${model.filename}`);
  const main = document.createElement('div');
  main.className = 'model-row-main';
  const name = document.createElement('span');
  name.className = 'model-row-name';
  name.textContent = model.filename;
  const meta = document.createElement('span');
  meta.className = 'model-row-meta';
  meta.textContent = `${formatSize(model.size)} · ${formatDate(model.uploaded_at)}`;
  main.append(name, meta);
  const status = document.createElement('span');
  const hasInteractionPreview = model.derivatives?.interaction_state === 'ready';
  const artifactState = model.derivatives?.state || 'pending';
  status.className = `artifact-state ${artifactState}`;
  status.textContent = artifactState === 'pending' && hasInteractionPreview
    ? '快速预览就绪'
    : ARTIFACT_LABELS[artifactState] || '等待生成';
  const queued = previewQueueLabel(model);
  if (queued) { status.className = `artifact-state ${queued.kind}`; status.textContent = queued.text; }
  status.title = queued?.error || model.derivatives?.message || status.textContent;
  row.append(checkbox, main, status);
  return row;
}

/** 返回设置页没有可用预览时的原因，候选资格仍由现有预览队列决定。 */
function getSettingsModelEmptyLabel() {
  if (!state.models.length) return '暂无已上传模型';
  const waiting = state.models.some((model) => {
    const entry = previewQueue.get(model.id);
    return !entry || [entry.interaction, entry.detail].some((status) => ['pending', 'loading'].includes(status));
  });
  return waiting ? '等待简易预览就绪' : '暂无可用预览，请先重试';
}

/** 将模型变更同步到独立搜索选择器，保留其本会话关键词、最近记录与输入焦点。 */
function renderModelSettingsModelSelect() { modelSearchSelect.render(); }

/** 按搜索关键字渲染模型列表，并同步选择数量和删除按钮。 */
function renderModelList() {
  const list = document.getElementById('model-list');
  const selectAll = document.getElementById('select-all-models');
  renderModelSettingsModelSelect();
  if (!list || !selectAll) return;
  const keyword = state.search.trim().toLocaleLowerCase('zh-CN');
  const visibleModels = state.models.filter((model) => model.filename.toLocaleLowerCase('zh-CN').includes(keyword));
  list.replaceChildren();
  document.getElementById('model-count').textContent = state.deleting ? '正在删除…' : `${state.models.length} 个模型`;
  if (!visibleModels.length) {
    const empty = document.createElement('div');
    empty.className = 'list-empty';
    const icon = document.createElement('i');
    icon.dataset.lucide = keyword ? 'search-x' : 'archive';
    const label = document.createElement('span');
    label.textContent = keyword ? '未找到匹配模型' : '暂无模型，请先上传';
    empty.append(icon, label);
    list.append(empty);
    window.lucide?.createIcons({ nodes: [empty] });
  } else visibleModels.forEach((model) => list.append(createModelRow(model)));
  const deleteButton = document.getElementById('delete-selected');
  deleteButton.disabled = state.deleting || state.selectedIds.size === 0;
  deleteButton.setAttribute('aria-busy', String(state.deleting));
  deleteButton.title = state.deleting ? '正在删除所选模型，请稍候'
    : state.selectedIds.size ? `删除选中的 ${state.selectedIds.size} 个模型` : '删除选中模型';
  selectAll.disabled = state.models.length === 0;
  selectAll.checked = state.models.length > 0 && state.selectedIds.size === state.models.length;
  selectAll.indeterminate = state.selectedIds.size > 0 && state.selectedIds.size < state.models.length;
}

/** 在下一帧渲染场景，同一帧内的重复请求会合并为一次 GPU 绘制。 */
function requestSceneRender() {
  const sceneState = state.scene;
  if (!sceneState || sceneState.renderQueued) return;
  sceneState.renderQueued = true;
  window.requestAnimationFrame(() => {
    sceneState.renderQueued = false;
    if (state.scene !== sceneState) return;
    const now = window.performance.now();
    if (state.isInteracting && state.lastRenderAt > 0) {
      const changed = recordInteractionFrame(state.interactionQuality, now - state.lastRenderAt, state.qualityConfig);
      if (changed) {
        state.previewTransition = {
          ...state.previewTransition,
          pixelRatio: state.interactionQuality.pixelRatio,
        };
        setRendererPixelRatio(state.interactionQuality.pixelRatio);
      }
    }
    state.lastRenderAt = now;
    sceneState.settingsTools?.updateScreenScale();
    sceneState.coordinateFramePreview?.resize();
    sceneState.renderer.render(sceneState.scene, sceneState.camera);
    renderOrientationGizmo(sceneState);
    if (state.isInteracting) requestSceneRender();
  });
}

/** 更新主预览渲染器像素比。 */
function setRendererPixelRatio(pixelRatio) {
  const { renderer } = state.scene || {};
  if (!renderer || Math.abs(renderer.getPixelRatio() - pixelRatio) < 1e-6) return;
  renderer.setPixelRatio(pixelRatio);
}

/** 使用主相机位置和 Z 轴朝上的世界坐标系更新方向立方体。 */
function renderOrientationGizmo(sceneState) {
  const { orientationGizmo, camera, controls } = sceneState;
  if (!orientationGizmo) return;
  const viewDirection = camera.position.clone().sub(controls.target);
  orientationGizmo.render(viewDirection, DEFAULT_MODEL_QUATERNION, camera.up);
}

/** 把方向立方体点击的世界轴向转换为 Z 轴朝上的正交观察方向。 */
function orientPreviewCamera(localNormal) {
  const { camera, controls } = state.scene || {};
  if (!camera || !controls || localNormal.lengthSq() < 1e-8) return;
  controls.target.set(0, 0, 0);
  const worldDirection = localNormal.clone().normalize();
  const distance = Math.max(camera.position.distanceTo(controls.target), camera.near * 2);
  const worldUp = new THREE.Vector3(...SCENE_UP);
  camera.up.copy(
    Math.abs(worldDirection.dot(worldUp)) > 0.98
      ? new THREE.Vector3(0, worldDirection.z >= 0 ? -1 : 1, 0)
      : worldUp,
  );
  camera.position.copy(controls.target).addScaledVector(worldDirection, distance);
  camera.lookAt(controls.target);
  controls.update();
  requestSceneRender();
}

/** 同步方向立方体画布尺寸及其宽线描边分辨率。 */
function resizeOrientationGizmo() {
  const { orientationGizmo, orientationGizmoContainer } = state.scene || {};
  if (!orientationGizmo || !orientationGizmoContainer) return;
  orientationGizmo.resize(orientationGizmoContainer.clientWidth, orientationGizmoContainer.clientHeight);
}

/** 将模型材质同步为当前主题的预览色，不显示三角剖分线框。 */
function applyModelMaterialState(modelRoot = null) {
  const [red, green, blue] = getScenePalette().preview.map((value) => value / 255);
  const roots = modelRoot
    ? [modelRoot]
    : [state.scene?.interactionRoot, state.scene?.detailRoot].filter(Boolean);
  roots.forEach((root) => {
    root.traverse((child) => {
      if (!child.isMesh) return;
      const materials = Array.isArray(child.material) ? child.material : [child.material];
      materials.forEach((material) => {
        material.color?.setRGB(red, green, blue);
        material.emissive?.setRGB(red * 0.1, green * 0.1, blue * 0.1);
        material.wireframe = false;
        material.needsUpdate = true;
      });
    });
  });
}

/** 将单一的 STEP 拓扑边线覆盖层同步为当前主题颜色与开关状态。 */
function applyTopologyEdgeState(edgeOverlay = state.scene?.edgeOverlay) {
  if (!edgeOverlay) return;
  edgeOverlay.visible = state.showTopologyEdges && !state.isInteracting && state.scene?.activeQuality === 'detail';
  edgeOverlay.traverse((child) => {
    if (!child.isLineSegments) return;
    const materials = Array.isArray(child.material) ? child.material : [child.material];
    materials.forEach((material) => {
      material.color?.setHex(getScenePalette().edge);
      material.opacity = TOPOLOGY_EDGE_OPACITY;
      material.needsUpdate = true;
    });
  });
}

/** 同步表面边线按钮的可用状态和当前可见状态。 */
function setTopologyEdgeControlAvailable(enabled) {
  const button = document.getElementById('toggle-topology-edges');
  button.disabled = !enabled;
  button.classList.toggle('active', state.showTopologyEdges);
}

/** 同步三维画布背景、网格透明度和模型基础色到当前全局主题。 */
function applySceneTheme() {
  if (!state.scene) return;
  const palette = getScenePalette();
  state.scene.scene.background.setHex(palette.background);
  state.scene.grid.material.opacity = palette.gridOpacity;
  applyModelMaterialState();
  applyTopologyEdgeState();
  requestSceneRender();
}

/** 卸载模型并移交预览资源；同一模型升级质量时保留包络与设置覆盖层上下文。 */
function detachCurrentPreview({ preserveOverlays = false } = {}) {
  if (!preserveOverlays) state.scene?.envelopePreview?.clear();
  if (!state.scene?.interactionRoot && !state.scene?.detailRoot) return null;
  if (!preserveOverlays) state.scene.settingsTools?.clearPreview();
  const preview = {
    interactionRoot: state.scene.interactionRoot,
    detailRoot: state.scene.detailRoot,
    edgeOverlay: state.scene.edgeOverlay,
    interactionManifest: state.interactionManifest,
    previewManifest: state.previewManifest,
    mappingEntries: state.mappingEntries,
  };
  if (state.scene.interactionRoot) state.scene.scene.remove(state.scene.interactionRoot);
  if (state.scene.detailRoot) state.scene.scene.remove(state.scene.detailRoot);
  if (state.scene.edgeOverlay) state.scene.scene.remove(state.scene.edgeOverlay);
  state.scene.modelRoot = null;
  state.scene.interactionRoot = null;
  state.scene.detailRoot = null;
  state.scene.edgeOverlay = null;
  state.scene.activeQuality = '';
  state.mappingEntries = [];
  state.previewManifest = null;
  state.interactionManifest = null;
  requestSceneRender();
  return preview;
}

/** 在数量和数组字节预算内保存近期预览；优先保留页面选择，超预算仍释放以免大模型耗尽内存。 */
function cachePreview(modelId, preview) {
  const existing = state.previewCache.get(modelId);
  if (existing && existing !== preview) disposePreview(existing);
  state.previewCache.delete(modelId);
  state.previewCache.set(modelId, preview);
  const budget = state.previewCacheConfig;
  while (state.previewCache.size && (!budget || state.previewCache.size > budget.modelLimit
    || [...state.previewCache.values()].reduce((total, item) => total + measurePreviewBytes(item), 0) > budget.maxBytes)) {
    const pinnedModelIds = new Set(Object.values(state.pageSelections).filter(Boolean));
    const evictedEntry = [...state.previewCache.entries()].find(([cachedModelId]) => !pinnedModelIds.has(cachedModelId))
      || state.previewCache.entries().next().value;
    const [evictedId, evictedPreview] = evictedEntry;
    state.previewCache.delete(evictedId);
    disposePreview(evictedPreview);
  }
}

/** 预览挂载后通知设置页当前模型和全库名称摘要；质量升级不重复通知，避免覆盖草稿或取消保存。 */
function notifyModelSettingsSelection() {
  if (state.pageMode !== 'settings') return;
  const model = state.scene?.modelRoot ? state.selectedModel : null;
  const modelId = model?.id || null;
  if (state.settingsNotifiedModelId === modelId) return;
  state.settingsNotifiedModelId = modelId;
  window.dispatchEvent(new CustomEvent(MODEL_SETTINGS_SELECTION_EVENT, {
    detail: {
      models: state.models.map(({ id, filename }) => ({ id, filename })),
      model: model
        ? { ...model, settings: cloneModelSettings(model.settings) }
        : null,
    },
  }));
}

/** 把设置变换同步到当前双 LOD 与拓扑边线；提交时更新内存模型设置和模型选择名称。 */
export function applyCurrentModelPreviewSettings(settings, options = {}) {
  const transform = getModelPreviewTransform(settings);
  if (!transform) return false;
  const previousTransform = getModelPreviewTransform(getCurrentPreviewSettings());
  state.modelSettings = state.pageMode === 'settings' ? cloneModelSettings(settings) : null;
  if (options.commit && state.selectedModel) {
    state.selectedModel.settings = cloneModelSettings(settings);
    const storedModel = state.models.find((model) => model.id === state.selectedModel.id);
    if (storedModel) storedModel.settings = cloneModelSettings(settings);
    renderModelSettingsModelSelect();
  }
  const roots = [state.scene?.interactionRoot, state.scene?.detailRoot, state.scene?.edgeOverlay].filter(Boolean);
  roots.forEach((root) => {
    applySourceDisplayTransform(root, transform, settings.coordinate_frame);
  });
  if (state.scene?.modelRoot) updatePreviewClippingForScale(previousTransform?.scale, transform.scale);
  if (state.scene?.modelRoot) {
    fitGridToBounds(new THREE.Box3().setFromObject(state.scene.modelRoot));
    if (state.previewManifest || state.interactionManifest) renderModelStats(state.previewManifest || state.interactionManifest);
  }
  state.scene?.settingsTools?.setContext({
    enabled: state.pageMode === 'settings' && Boolean(state.selectedModel),
    modelId: state.selectedModel?.id || null,
    detailRoot: state.scene?.detailRoot || (state.mappingEntries.length ? state.scene?.interactionRoot : null),
    mappingEntries: state.mappingEntries,
    settings: state.pageMode === 'settings' ? settings : {},
    transform,
  });
  if (state.coordinateFrameDraft?.modelId === state.selectedModel?.id) applyCoordinateFrameDraft();
  else { state.coordinateFrameDraft = null; state.scene?.coordinateFramePreview?.update(null); }
  requestSceneRender();
  return true;
}

/** 在初始参考下预览坐标草稿，保留当前比例、单位和姿态，避免编辑时退回原始尺寸。 */
function applyCoordinateFrameDraft() {
  const draft = state.coordinateFrameDraft;
  if (!draft || !state.scene) return;
  const settings = getCurrentPreviewSettings();
  const transform = getModelPreviewTransform(settings);
  if (!transform) return;
  [state.scene.interactionRoot, state.scene.detailRoot, state.scene.edgeOverlay].filter(Boolean)
    .forEach((root) => applySourceDisplayTransform(root, transform, undefined));
  state.scene.settingsTools?.clearPreview();
  state.scene.coordinateFramePreview?.update(draft.frame, settings.center_of_mass, transform);
}

/** 进入或退出坐标系草稿预览；null 清理可重复调用，仅为仍选中的原模型恢复旧草稿视角。 */
export function setCoordinateFrameDraft(frame) {
  if (!state.scene || state.pageMode !== 'settings') return;
  const entering = frame && !state.coordinateFrameDraft;
  const previous = state.coordinateFrameDraft;
  let view = previous?.view;
  if (entering) {
    saveModelView();
    view = readModelView();
  }
  const savedFrame = previous?.savedFrame ?? JSON.stringify(getCurrentPreviewSettings().coordinate_frame);
  state.coordinateFrameDraft = frame ? { modelId: state.selectedModel?.id, frame, view, savedFrame } : null;
  if (frame) { applyCoordinateFrameDraft(); if (entering) fitModelView(); }
  else {
    state.scene.coordinateFramePreview?.update(null);
    applyCurrentModelPreviewSettings(getCurrentPreviewSettings());
    if (previous && state.selectedModel && previous.modelId === state.selectedModel.id) {
      if (previous.savedFrame === JSON.stringify(getCurrentPreviewSettings().coordinate_frame)) {
        state.pendingViewSnapshot = previous.view;
        restorePendingModelView();
      } else fitModelView();
    }
  }
  requestSceneRender();
}

/** 开启或关闭当前设置页的安装面拾取模式。 */
export async function setInstallationFacePicking(enabled) {
  if (state.pageMode !== 'settings') return false;
  return state.scene?.settingsTools?.setPickingEnabled(Boolean(enabled)) || false;
}

/** 将 React 页面的包络显示上下文交给独立渲染器；上传页不会挂载包络。 */
export function setCurrentModelEnvelopePreview(context) {
  if (!context) { state.scene?.envelopePreview?.clear(); return; }
  if (state.pageMode !== 'settings' || context.modelId !== state.selectedModel?.id) return;
  state.scene?.envelopePreview?.setContext(context);
}

/** 将当前模型从场景移入近期预览缓存，以便切回时立即展示。 */
function cacheCurrentPreview() {
  const modelId = state.selectedModel?.id;
  const preview = detachCurrentPreview();
  if (!preview) return;
  if (modelId) cachePreview(modelId, preview);
  else disposePreview(preview);
}

/** 取出指定模型的缓存预览，并将其标记为最近使用。 */
function takeCachedPreview(modelId) {
  const preview = state.previewCache.get(modelId);
  if (!preview) return null;
  state.previewCache.delete(modelId);
  return preview;
}

/** 释放已删除或失效模型对应的缓存预览资源。 */
function evictCachedPreviews(modelIds) {
  modelIds.forEach((modelId) => {
    const preview = state.previewCache.get(modelId);
    if (!preview) return;
    state.previewCache.delete(modelId);
    disposePreview(preview);
  });
}

/** 释放缓存预览的双 LOD 网格和其独立的 STEP 拓扑边线 GPU 资源。 */
function disposePreview(preview) {
  state.scene?.settingsTools?.releasePreview(preview?.detailRoot);
  state.scene?.settingsTools?.releasePreview(preview?.interactionRoot);
  new Set([preview?.interactionRoot, preview?.detailRoot, preview?.edgeOverlay].filter(Boolean))
    .forEach((object) => disposeObject(object));
}

/** 从预览场景移除当前模型并释放其 GPU 资源。 */
function clearModelScene() {
  const preview = detachCurrentPreview();
  if (preview) disposePreview(preview);
}

/** 恢复预览面板为空状态。 */
function clearPreview() {
  window.clearTimeout(state.idleTimer);
  state.idleTimer = null;
  state.lastRenderAt = 0;
  state.loadToken += 1;
  clearModelScene();
  resetEmptyPreviewView();
  applyPreviewTransition({ type: 'select-model', modelId: null });
  setLoading(false);
  document.getElementById('preview-empty').hidden = false;
  document.getElementById('preview-title').textContent = '尚未选择模型';
  document.getElementById('preview-format').textContent = 'GLB';
  document.getElementById('fit-model-view').disabled = true;
  setTopologyEdgeControlAvailable(false);
  ['stat-bodies', 'stat-faces', 'stat-triangles', 'stat-bounds'].forEach((id) => { document.getElementById(id).textContent = '--'; });
  setPreviewStatus('等待选择');
  notifyModelSettingsSelection();
}


/** 创建常亮的主光、环境光和上下补光，不启用模型投射阴影。 */
function createPreviewLighting() {
  const lights = new THREE.Group();
  const ambientLight = new THREE.AmbientLight(0xffffff, 0.65);
  const hemisphereLight = new THREE.HemisphereLight(0xd8edf8, 0xc7dfce, 0.9);
  const keyLight = new THREE.DirectionalLight(0xffffff, 1.6);
  const lowerFillLight = new THREE.DirectionalLight(0xd6ecff, 1.15);
  keyLight.position.set(6, 10, 8);
  lowerFillLight.position.set(-5, -7, -6);
  lights.add(ambientLight, hemisphereLight, keyLight, lowerFillLight);
  return lights;
}


/** 创建与参考预览一致的 24 分段地面网格，模型加载后会按精确包围盒自适应。 */
function createPreviewGrid() {
  const grid = new THREE.GridHelper(EMPTY_PREVIEW_GRID_SIZE, GRID_DIVISIONS, '#7b8792', '#c4cbd1');
  grid.name = 'PREVIEW_GRID';
  // GridHelper 默认位于 XZ 平面；旋转到 XY 平面后，网格法向与世界 +Z 一致。
  grid.rotation.x = Math.PI / 2;
  grid.renderOrder = 0;
  grid.material.transparent = true;
  grid.material.opacity = getScenePalette().gridOpacity;
  grid.material.depthTest = true;
  grid.material.depthWrite = false;
  grid.material.toneMapped = false;
  return grid;
}

/** 依据 STEP 精确包围盒在 XY 平面的投影范围调整固定原点网格。 */
function fitGridToBounds(bounds) {
  const { grid } = state.scene || {};
  if (!grid || bounds.isEmpty()) return;
  const sphere = bounds.getBoundingSphere(new THREE.Sphere());
  const projectedOffsets = [bounds.min.x, bounds.max.x, bounds.min.y, bounds.max.y];
  const requiredHalfSize = projectedOffsets.every(Number.isFinite)
    ? Math.max(...projectedOffsets.map(Math.abs))
    : 0;
  const gridSize = Math.max(
    sphere.radius * GRID_MODEL_RADIUS_FACTOR,
    requiredHalfSize * 2 * GRID_BOUNDS_MARGIN,
    1e-3,
  );
  grid.scale.setScalar(gridSize / EMPTY_PREVIEW_GRID_SIZE);
  grid.position.set(0, 0, 0);
}

/** 恢复未选择模型时的原点视角与完整网格，不沿用上一模型的相机和网格尺度。 */
function resetEmptyPreviewView() {
  const { camera, controls, grid, axes } = state.scene || {};
  if (!camera || !controls || !grid || !axes) return;
  camera.position.set(...EMPTY_PREVIEW_CAMERA_POSITION);
  camera.up.set(...SCENE_UP);
  camera.near = 0.01;
  camera.far = 1000000;
  camera.updateProjectionMatrix();
  controls.target.set(0, 0, 0);
  resetPreviewPan();
  grid.position.set(0, 0, 0);
  grid.scale.setScalar(1);
  axes.position.set(0, 0, 0);
  controls.update();
  setCoordinateAxesSize(state.scene);
  requestSceneRender();
}

/** 将投影平移量应用到相机，使画面平移但观察目标仍保持在世界原点。 */
function applyPreviewPan() {
  const { camera, renderer, panOffset } = state.scene || {};
  if (!camera || !renderer || !panOffset) return;
  const width = Math.max(renderer.domElement.clientWidth, 1);
  const height = Math.max(renderer.domElement.clientHeight, 1);
  if (panOffset.lengthSq() < 1e-8) {
    camera.clearViewOffset();
    return;
  }
  camera.setViewOffset(width, height, panOffset.x, panOffset.y, width, height);
}

/** 清除投影平移量，恢复围绕坐标原点的居中视图。 */
function resetPreviewPan() {
  const { panOffset, camera } = state.scene || {};
  if (!panOffset || !camera) return;
  panOffset.set(0, 0);
  camera.clearViewOffset();
}

/** 开始右键拖动的投影平移，阻止 OrbitControls 修改旋转目标。 */
function startPreviewPan(event) {
  const sceneState = state.scene;
  if (!sceneState || event.button !== 2 || sceneState.panPointerId !== null) return;
  event.preventDefault();
  event.stopImmediatePropagation();
  sceneState.panPointerId = event.pointerId;
  sceneState.panLastPosition.set(event.clientX, event.clientY);
  sceneState.renderer.domElement.setPointerCapture(event.pointerId);
  beginPreviewInteraction();
}

/** 按鼠标移动量更新相机投影偏移，不改变 OrbitControls 的原点目标。 */
function movePreviewPan(event) {
  const sceneState = state.scene;
  if (!sceneState || event.pointerId !== sceneState.panPointerId) return;
  event.preventDefault();
  event.stopImmediatePropagation();
  const deltaX = event.clientX - sceneState.panLastPosition.x;
  const deltaY = event.clientY - sceneState.panLastPosition.y;
  sceneState.panLastPosition.set(event.clientX, event.clientY);
  sceneState.panOffset.x -= deltaX;
  sceneState.panOffset.y -= deltaY;
  applyPreviewPan();
  scheduleModelViewSave();
  requestSceneRender();
}

/** 结束右键投影平移并恢复空闲渲染质量。 */
function finishPreviewPan(event) {
  const sceneState = state.scene;
  if (!sceneState || event.pointerId !== sceneState.panPointerId) return;
  event.preventDefault();
  event.stopImmediatePropagation();
  sceneState.panPointerId = null;
  if (sceneState.renderer.domElement.hasPointerCapture(event.pointerId)) {
    sceneState.renderer.domElement.releasePointerCapture(event.pointerId);
  }
  finishPreviewInteraction();
}

/** 屏蔽预览画布右键菜单，保留右键拖动平移操作。 */
function preventPreviewContextMenu(event) {
  event.preventDefault();
}

/** 在不改变相机的情况下切换交互或细节模型，并同步拓扑边线。 */
function setActivePreviewQuality(quality) {
  const sceneState = state.scene;
  if (!sceneState) return;
  const preferredRoot = quality === 'detail' ? sceneState.detailRoot : sceneState.interactionRoot;
  const fallbackRoot = quality === 'detail' ? sceneState.interactionRoot : sceneState.detailRoot;
  const targetRoot = preferredRoot || fallbackRoot;
  if (!targetRoot) return;
  if (sceneState.interactionRoot) sceneState.interactionRoot.visible = targetRoot === sceneState.interactionRoot;
  if (sceneState.detailRoot) sceneState.detailRoot.visible = targetRoot === sceneState.detailRoot;
  sceneState.modelRoot = targetRoot;
  sceneState.activeQuality = targetRoot === sceneState.detailRoot ? 'detail' : 'interaction';
  applyTopologyEdgeState();
  requestSceneRender();
}

/** 应用纯质量状态机的结果，并把 LOD 与像素比变化同步到 Three.js。 */
function applyPreviewTransition(event) {
  state.previewTransition = transitionPreviewState(
    state.previewTransition,
    { ...event, devicePixelRatio: window.devicePixelRatio || 1 },
    state.qualityConfig,
  );
  state.isInteracting = state.previewTransition.isInteracting;
  setRendererPixelRatio(state.previewTransition.pixelRatio);
  if (state.previewTransition.activeQuality) {
    setActivePreviewQuality(state.previewTransition.activeQuality);
  } else {
    applyTopologyEdgeState();
  }
}

/** 进入旋转、缩放或平移状态，切换轻量模型并开始帧耗时自适应。 */
function beginPreviewInteraction() {
  if (!state.scene?.modelRoot) return;
  window.clearTimeout(state.idleTimer);
  state.idleTimer = null;
  state.lastRenderAt = 0;
  state.interactionQuality = createInteractionQualityState(state.qualityConfig);
  applyPreviewTransition({ type: 'interaction-start' });
}

/** 在交互结束并稳定一段时间后恢复高像素比和细节模型。 */
function finishPreviewInteraction() {
  window.clearTimeout(state.idleTimer);
  applyPreviewTransition({ type: 'interaction-end' });
  state.idleTimer = window.setTimeout(() => {
    state.idleTimer = null;
    state.lastRenderAt = 0;
    applyPreviewTransition({ type: 'idle' });
  }, state.qualityConfig.idleDelayMs);
}

/** 创建 Three.js 场景、固定坐标轴、常亮照明和视角控制器。 */
function initializeScene(lifecycleSignal) {
  const container = document.getElementById('model-viewport');
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(getScenePalette().background);
  const camera = new THREE.PerspectiveCamera(42, 1, 0.01, 1000000);
  camera.up.set(...SCENE_UP);
  camera.position.set(...EMPTY_PREVIEW_CAMERA_POSITION);
  const renderer = new PreviewRenderer({ antialias: true, powerPreference: 'high-performance' });
  renderer.setPixelRatio(state.previewTransition.pixelRatio);
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.05;
  container.append(renderer.domElement);
  const orientationGizmoContainer = document.getElementById('orientation-gizmo');
  const controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = false;
  controls.enablePan = false;
  controls.minDistance = 0.01;
  controls.maxDistance = 100000;
  const grid = createPreviewGrid();
  const axes = createCoordinateAxes();
  const lighting = createPreviewLighting();
  grid.material.transparent = true;
  grid.material.opacity = getScenePalette().gridOpacity;
  scene.add(grid, axes, lighting);
  const coordinateFramePreview = createCoordinateFramePreview({ scene, camera, renderer, requestRender: requestSceneRender });
  state.scene = {
    container, scene, camera, renderer, controls, grid, axes, orientationGizmoContainer, coordinateFramePreview,
    modelRoot: null, interactionRoot: null, detailRoot: null, edgeOverlay: null,
    activeQuality: '', renderQueued: false,
    panOffset: new THREE.Vector2(), panPointerId: null, panLastPosition: new THREE.Vector2(),
  };
  state.scene.settingsTools = createModelSettingPreviewTools({
    scene,
    camera,
    renderer,
    requestRender: requestSceneRender,
    onStatus: setPreviewStatus,
    onError: (message) => showToast(message, true),
  });
  state.scene.envelopePreview = createModelEnvelopePreview({ scene, requestRender: requestSceneRender });
  exposePreviewTestApi();
  state.scene.orientationGizmo = createOrientationGizmo(orientationGizmoContainer, {
    pixelRatio: ORIENTATION_GIZMO_PIXEL_RATIO,
    onFaceClick: orientPreviewCamera,
  });
  resizeScene();
  controls.addEventListener('start', beginPreviewInteraction);
  controls.addEventListener('change', () => {
    setCoordinateAxesSize(state.scene);
    state.scene?.coordinateFramePreview?.resize();
    state.scene?.settingsTools?.updateScreenScale();
    scheduleModelViewSave();
    requestSceneRender();
  });
  controls.addEventListener('end', finishPreviewInteraction);
  bindPreviewCanvasEvents(lifecycleSignal);
  requestSceneRender();
}

/** 为主预览画布绑定当前 React 页面生命周期内的平移交互事件。 */
function bindPreviewCanvasEvents(lifecycleSignal) {
  const canvas = state.scene?.renderer?.domElement;
  if (!canvas) return;
  canvas.addEventListener('pointerdown', startPreviewPan, { capture: true, signal: lifecycleSignal });
  canvas.addEventListener('pointermove', movePreviewPan, { capture: true, signal: lifecycleSignal });
  canvas.addEventListener('pointerup', finishPreviewPan, { capture: true, signal: lifecycleSignal });
  canvas.addEventListener('pointercancel', finishPreviewPan, { capture: true, signal: lifecycleSignal });
  canvas.addEventListener('contextmenu', preventPreviewContextMenu, { signal: lifecycleSignal });
  state.scene.settingsTools?.bindEvents(lifecycleSignal);
}

/** 让画布像素尺寸与预览容器保持一致。 */
function resizeScene() {
  if (!state.scene) return;
  const { container, renderer, camera } = state.scene;
  const width = Math.max(1, container.clientWidth);
  const height = Math.max(1, container.clientHeight);
  renderer.setSize(width, height, false);
  camera.aspect = width / height;
  camera.updateProjectionMatrix();
  applyPreviewPan();
  resizeOrientationGizmo();
  setCoordinateAxesSize(state.scene);
  state.scene.settingsTools?.updateScreenScale();
  requestSceneRender();
}

/** 使相机和网格适配当前模型包围盒，并保持坐标轴在 STEP 原点。 */
function fitModelView() {
  const { modelRoot, camera, controls, axes } = state.scene || {};
  if (!modelRoot) return;
  const bounds = new THREE.Box3().setFromObject(modelRoot);
  const size = bounds.getSize(new THREE.Vector3());
  const boundingSphere = bounds.getBoundingSphere(new THREE.Sphere());
  const originRadius = boundingSphere.center.length() + boundingSphere.radius;
  const dimension = Math.max(size.x, size.y, size.z, originRadius * 2, 1e-3);
  const distance = dimension * 1.1;
  camera.up.set(...SCENE_UP);
  camera.position.set(distance, distance * 0.72, distance);
  camera.near = Math.max(dimension / 10000, 0.001);
  camera.far = Math.max(dimension * 100, 1000);
  camera.updateProjectionMatrix();
  controls.target.set(0, 0, 0);
  controls.update();
  resetPreviewPan();
  fitGridToBounds(bounds);
  setCoordinateAxesSize(state.scene);
  state.scene.settingsTools?.updateScreenScale();
  if (!restorePendingModelView()) saveModelView();
  requestSceneRender();
}

/** 更新右侧统计卡和包围尺寸。 */
function renderModelStats(manifest) {
  const stats = manifest.stats;
  const bounds = state.scene?.modelRoot
    ? new THREE.Box3().setFromObject(state.scene.modelRoot)
    : new THREE.Box3(new THREE.Vector3(...manifest.bounds.min), new THREE.Vector3(...manifest.bounds.max));
  const size = bounds.getSize(new THREE.Vector3()).toArray();
  document.getElementById('stat-bodies').textContent = String(stats.body_count);
  document.getElementById('stat-faces').textContent = stats.face_count.toLocaleString('zh-CN');
  document.getElementById('stat-triangles').textContent = stats.triangle_count.toLocaleString('zh-CN');
  document.getElementById('stat-bounds').textContent = size.map((value) => formatParameterNumber(value)).join(' × ');
}

/** 将命中的完整预览缓存接回场景，避免重新请求 GLB、清单和面映射。 */
function attachCachedPreview(preview, source = 'memory') {
  const sceneState = state.scene;
  if (!sceneState) {
    disposePreview(preview);
    return;
  }
  sceneState.interactionRoot = preview.interactionRoot || null;
  sceneState.detailRoot = preview.detailRoot || null;
  sceneState.edgeOverlay = preview.edgeOverlay || null;
  state.interactionManifest = preview.interactionManifest || null;
  state.previewManifest = preview.previewManifest || state.interactionManifest;
  state.mappingEntries = preview.mappingEntries || [];
  [sceneState.interactionRoot, sceneState.detailRoot, sceneState.edgeOverlay]
    .filter(Boolean)
    .forEach((object) => sceneState.scene.add(object));
  applyCurrentModelPreviewSettings(getCurrentPreviewSettings());
  applyModelMaterialState();
  if (sceneState.interactionRoot) applyPreviewTransition({ type: 'interaction-ready' });
  if (sceneState.detailRoot) applyPreviewTransition({ type: 'detail-ready' });
  const manifest = state.previewManifest || state.interactionManifest;
  if (manifest) renderModelStats(manifest);
  fitModelView();
  setLoading(false);
  document.getElementById('fit-model-view').disabled = false;
  setTopologyEdgeControlAvailable(Boolean(sceneState.edgeOverlay));
  const cacheLabel = source === 'persistent' ? '磁盘缓存' : '缓存';
  if (sceneState.detailRoot) {
    document.getElementById('preview-format').textContent = 'STEP → GLB · 高清';
    setPreviewStatus(`高清预览已从${cacheLabel}恢复`, 'ready');
  } else {
    setPreviewStatus(`简易预览已从${cacheLabel}恢复`, 'ready');
  }
  notifyModelSettingsSelection();
  requestSceneRender();
}

/** 合并队列完成的资源；只把当前选择接入场景，其余模型交给有限内存缓存。 */
function acceptBackgroundPreview(model, quality, { preview, complete }) {
  const visible = Boolean(activePageLifecycle && state.scene && state.selectedModel?.id === model.id);
  if (visible && state.scene.modelRoot) {
    saveModelView();
    state.pendingViewSnapshot = readModelView();
  }
  const previous = visible ? detachCurrentPreview({ preserveOverlays: true }) : takeCachedPreview(model.id);
  const merged = { ...previous, ...preview };
  if (previous?.detailRoot && !preview.detailRoot) {
    merged.previewManifest = previous.previewManifest;
    merged.mappingEntries = previous.mappingEntries;
  }
  for (const key of ['interactionRoot', 'detailRoot', 'edgeOverlay']) {
    if (previous?.[key] && preview[key] && previous[key] !== preview[key]) {
      state.scene?.settingsTools?.releasePreview(previous[key]);
      disposeObject(previous[key]);
    }
  }
  state.models = state.models.map((item) => item.id === model.id ? { ...item, derivatives: {
    ...item.derivatives,
    ...(preview.interactionRoot ? { interaction_state: 'ready' } : {}),
    ...(preview.detailRoot ? { state: 'ready' } : {}),
  } } : item);
  // 序列化在首次 await 前完成；缓存后续淘汰不会使正在保存的字节失效。
  if (!complete) void previewResources.persistPreview(model.id, merged);
  if (visible) attachCachedPreview(merged);
  else cachePreview(model.id, merged);
}

/** 根据实际解码结果与后端产物分别显示读取、生成和失败状态，已有高清不能被标成等待生成。 */
function previewQueueLabel(model) {
  const entry = previewQueue.get(model.id);
  if (!entry) return null;
  if (entry.restoring) return { text: entry.restoringQuality === 'detail' ? '高清预览读取中' : '简易预览读取中', kind: 'processing' };
  if (entry.detail === 'ready') return { text: '高清预览就绪', kind: 'ready' };
  if (entry.detail === 'failed') return { text: entry.interaction === 'ready' ? '简易可用 · 高清失败' : '预览加载失败', kind: 'failed', error: entry.errors.detail };
  if (entry.available.detail) return { text: '高清已生成 · 待读取', kind: 'ready' };
  if (entry.interaction === 'loading') return { text: '简易预览生成中', kind: 'processing' };
  if (entry.detail === 'loading') return { text: '高清预览生成中', kind: 'processing' };
  if (entry.interaction === 'ready') return { text: '简易就绪 · 高清排队', kind: 'ready' };
  if (entry.interaction === 'failed') return { text: '简易失败 · 高清排队', kind: 'failed', error: entry.errors.interaction };
  if (entry.available.interaction) return { text: '简易已生成 · 待读取', kind: 'ready' };
  return { text: '简易预览排队中', kind: 'pending' };
}

/** 刷新可见页面的队列状态；页面卸载时完全不访问场景或页面节点。 */
function renderPreviewQueueState() {
  if (!activePageLifecycle || !state.scene) return;
  if (state.pageMode === 'settings') {
    const models = getSettingsPreviewModels();
    if (!models.some((model) => model.id === state.selectedModel?.id)) {
      const cachedView = readModelView();
      const model = resolveCurrentPageModel(cachedView);
      if (model) {
        state.pendingViewSnapshot = cachedView?.modelId === model.id ? cachedView : null;
        void selectModel(model);
        return;
      }
      if (state.selectedModel) { state.selectedModel = null; clearPreview(); }
    }
    renderModelSettingsModelSelect();
  }
  document.querySelectorAll('.model-row').forEach((row) => {
    const label = previewQueueLabel({ id: row.dataset.modelId });
    const status = row.querySelector('.artifact-state');
    if (!label || !status) return;
    status.textContent = label.text;
    status.className = `artifact-state ${label.kind}`;
    status.title = label.error || label.text;
  });
  const model = state.selectedModel;
  if (!model) return;
  const entry = previewQueue.get(model.id);
  if (!entry) return;
  if (state.scene.detailRoot) {
    setLoading(false);
    setPreviewStatus('高清预览与映射就绪', 'ready');
  } else if (state.scene.interactionRoot) {
    setLoading(false);
    setPreviewStatus(entry.detail === 'failed' ? '简易预览可用，高清加载失败'
      : entry.detail === 'loading' ? entry.available.detail ? '简易预览可用，正在读取高清' : '简易预览可用，正在生成高清'
        : entry.available.detail ? '简易预览可用，高清已生成，等待读取' : '简易预览可用，高清排队中', 'ready');
  } else {
    const failed = entry.interaction === 'failed' && entry.detail === 'failed';
    const label = previewQueueLabel(model);
    setLoading(!failed, label.text, entry.restoring
      ? '正在读取已生成的预览资源，无需等待后台高清任务'
      : '已有预览独立读取；新预览先生成简易再生成高清，切换页面不会中断任务');
    setPreviewStatus(label.text, failed ? 'error' : 'busy');
    if (failed) document.getElementById('preview-empty').hidden = false;
  }
}

/** 将已确认列表交给后台队列，已知结果及当前任务保持不变。 */
function syncPreviewQueue(options) {
  previewQueue.sync(state.models, options);
}

/** 切换展示对象并请求后续优先准备；不取消旧模型的后台生成、下载或解析。 */
async function selectModel(model, force = false) {
  if (state.pageMode === 'settings' && !getSettingsPreviewModels().some((item) => item.id === model.id)) return;
  if (!force && state.selectedModel?.id === model.id && state.scene?.modelRoot) return;
  if (state.pendingViewSnapshot?.modelId !== model.id) state.pendingViewSnapshot = null;
  window.clearTimeout(state.idleTimer);
  state.idleTimer = null;
  state.lastRenderAt = 0;
  state.loadToken += 1;
  saveModelView();
  const cachedPreview = takeCachedPreview(model.id);
  cacheCurrentPreview();
  applyPreviewTransition({ type: 'select-model', modelId: model.id });
  state.selectedModel = model;
  state.modelSettings = state.pageMode === 'settings' ? cloneModelSettings(model.settings) : null;
  state.pageSelections[state.pageMode] = model.id;
  writeStoredModelSelection(state.pageMode, model.id);
  notifyModelSettingsSelection();
  renderModelList();
  document.getElementById('preview-empty').hidden = true;
  document.getElementById('preview-title').textContent = model.filename;
  document.getElementById('preview-format').textContent = 'STEP → GLB · 简易';
  document.getElementById('fit-model-view').disabled = true;
  setTopologyEdgeControlAvailable(false);
  if (cachedPreview) attachCachedPreview(cachedPreview);
  syncPreviewQueue();
  previewQueue.request(model.id, { reload: !cachedPreview, retry: true });
  renderPreviewQueueState();
}

/** 从后端刷新模型库并返回是否成功；过期请求及已卸载页面不能覆盖删除后的列表。 */
async function refreshModels(options = {}) {
  const button = document.getElementById('refresh-models');
  const token = ++state.modelsRefreshToken;
  const lifecycle = activePageLifecycle;
  if (!options.quiet) button?.classList.add('spinning');
  try {
    const models = await listModels();
    if (token !== state.modelsRefreshToken || lifecycle?.signal.aborted) return false;
    state.models = models;
    state.modelsLoaded = true;
    state.selectedIds = new Set([...state.selectedIds].filter((id) => state.models.some((model) => model.id === id)));
    const validModelIds = new Set(state.models.map((model) => model.id));
    evictCachedPreviews([...state.previewCache.keys()].filter((id) => !validModelIds.has(id)));
    Object.keys(state.pageSelections).forEach((pageMode) => {
      if (state.pageSelections[pageMode] && !validModelIds.has(state.pageSelections[pageMode])) {
        state.pageSelections[pageMode] = null;
        removeStoredModelView(pageMode);
      }
    });
    if (state.selectedModel) {
      const current = state.models.find((model) => model.id === state.selectedModel.id);
      if (current) state.selectedModel = current;
      else { state.selectedModel = null; clearModelView(); clearPreview(); }
    }
    renderModelList();
    syncPreviewQueue({ retryFailed: !options.quiet });
    renderPreviewQueueState();
    setConnection('模型服务已连接');
    return true;
  } catch (error) {
    if (token !== state.modelsRefreshToken || lifecycle?.signal.aborted) return false;
    console.warn('模型列表刷新失败，保留已有列表：', error);
    setConnection(state.modelsLoaded ? '列表刷新失败，已保留现有模型' : '模型服务未连接', true);
    if (!options.quiet) showToast(error.message, true);
    return false;
  } finally {
    if (token === state.modelsRefreshToken) button?.classList.remove('spinning');
  }
}

/** 切换已合并的 STEP 拓扑边线覆盖层，不显示三角剖分边。 */
function toggleTopologyEdges() {
  if (!state.scene?.edgeOverlay) return;
  state.showTopologyEdges = !state.showTopologyEdges;
  applyTopologyEdgeState();
  document.getElementById('toggle-topology-edges').classList.toggle('active', state.showTopologyEdges);
  requestSceneRender();
}

/** 绑定上传、拖放、搜索、列表、视图和窗口事件，并随 React 页面卸载统一解绑。 */
function bindEvents(lifecycleSignal) {
  const input = document.getElementById('model-file-input');
  const dropzone = document.getElementById('model-dropzone');
  if (input && dropzone) {
    input.addEventListener('change', async (event) => {
      const files = Array.from(event.target.files || []);
      event.target.value = '';
      await uploadFiles(files);
    }, { signal: lifecycleSignal });
    ['dragenter', 'dragover'].forEach((type) => dropzone.addEventListener(type, (event) => { event.preventDefault(); dropzone.classList.add('dragging'); }, { signal: lifecycleSignal }));
    ['dragleave', 'drop'].forEach((type) => dropzone.addEventListener(type, (event) => { event.preventDefault(); dropzone.classList.remove('dragging'); }, { signal: lifecycleSignal }));
    dropzone.addEventListener('drop', async (event) => uploadFiles(Array.from(event.dataTransfer?.files || [])), { signal: lifecycleSignal });
    document.getElementById('model-search').addEventListener('input', (event) => { state.search = event.target.value; renderModelList(); }, { signal: lifecycleSignal });
    document.getElementById('refresh-models').addEventListener('click', () => refreshModels(), { signal: lifecycleSignal });
    document.getElementById('delete-selected').addEventListener('click', () => requestModelDeletion([...state.selectedIds]), { signal: lifecycleSignal });
    document.getElementById('select-all-models').addEventListener('change', (event) => {
      state.selectedIds = event.target.checked ? new Set(state.models.map((model) => model.id)) : new Set();
      renderModelList();
    }, { signal: lifecycleSignal });
    document.getElementById('model-list').addEventListener('click', async (event) => {
      const row = event.target.closest('.model-row');
      if (!row) return;
      const model = state.models.find((item) => item.id === row.dataset.modelId);
      if (!model) return;
      if (event.target.dataset.role === 'select') {
        if (event.target.checked) state.selectedIds.add(model.id); else state.selectedIds.delete(model.id);
        renderModelList();
        return;
      }
      await selectModel(model);
    }, { signal: lifecycleSignal });
  }
  modelSearchSelect.bind(lifecycleSignal);
  document.getElementById('fit-model-view').addEventListener('click', fitModelView, { signal: lifecycleSignal });
  document.getElementById('toggle-topology-edges').addEventListener('click', toggleTopologyEdges, { signal: lifecycleSignal });
  window.addEventListener('sat-layout-theme-change', () => {
    applySceneTheme();
    resizeSceneAfterThemeChange();
  }, { signal: lifecycleSignal });
  window.addEventListener('resize', resizeScene, { signal: lifecycleSignal });
  window.addEventListener('beforeunload', disposeModelUploadPage, { signal: lifecycleSignal });
}

/** 初始化页面场景并先恢复会话预览；后台校验模型列表不阻塞已有数据展示。 */
async function initialize(lifecycleSignal) {
  const cachedView = readModelView();
  window.lucide?.createIcons();
  try {
    const [quality, cache, modelSearch] = await Promise.all([
      getPreviewQualityConfig(), getPreviewCacheConfig(), getModelSearchConfig(),
    ]);
    state.qualityConfig = normalizePreviewQualityConfig(quality);
    state.previewCacheConfig = cache;
    modelSearchSelect.configure(modelSearch);
  } catch (error) {
    if (lifecycleSignal.aborted) return;
    showToast(`预览质量配置读取失败，已使用默认值：${error.message}`, true);
  }
  if (lifecycleSignal.aborted) return;
  state.previewTransition = createPreviewTransitionState(state.qualityConfig, window.devicePixelRatio || 1);
  initializeScene(lifecycleSignal);
  bindEvents(lifecycleSignal);
  clearPreview();
  const sessionModel = state.modelsLoaded ? resolveCurrentPageModel(cachedView) : null;
  if (sessionModel) {
    state.pendingViewSnapshot = cachedView?.modelId === sessionModel.id ? cachedView : null;
    void selectModel(sessionModel, true);
  }
  const selectionToken = state.loadToken;
  try {
    if (!state.modelsLoaded) await checkHealth();
    if (lifecycleSignal.aborted) return;
    const refreshed = await refreshModels({ quiet: true });
    if (lifecycleSignal.aborted || !refreshed) return;
    const initialModel = !sessionModel && state.loadToken === selectionToken ? resolveCurrentPageModel(cachedView) : null;
    const initialView = cachedView?.modelId === initialModel?.id ? cachedView : null;
    if (initialModel) {
      state.pendingViewSnapshot = initialView;
      await selectModel(initialModel, true);
    }
    if (!state.scrollRestoreApplied) {
      state.scrollRestoreApplied = true;
      restorePagePosition(window.location.pathname, window.location.search, {
        restoreWindow: false,
        restoreElements: true,
      });
    }
  } catch (error) {
    if (lifecycleSignal.aborted) return;
    setConnection('模型服务未连接', true);
    showToast(`无法连接模型服务：${error.message}`, true);
  }
}

/** 将保留的主预览与方向立方体画布挂载到新页面的对应容器。 */
function attachRetainedPreviewCanvases() {
  const sceneState = state.scene;
  const container = document.getElementById('model-viewport');
  const orientationGizmoContainer = document.getElementById('orientation-gizmo');
  if (!sceneState || !container || !orientationGizmoContainer) return false;
  container.append(sceneState.renderer.domElement);
  sceneState.orientationGizmo?.attach(orientationGizmoContainer);
  sceneState.container = container;
  sceneState.orientationGizmoContainer = orientationGizmoContainer;
  return true;
}

/** 根据保留的预览状态恢复新页面的标题、统计、按钮和提示文案。 */
function restoreRetainedPreviewPanel() {
  const sceneState = state.scene;
  const empty = document.getElementById('preview-empty');
  if (!sceneState || !empty) return;
  renderModelList();
  setConnection(state.connection.message, state.connection.error);
  if (!state.selectedModel) {
    empty.hidden = false;
    document.getElementById('preview-title').textContent = '尚未选择模型';
    document.getElementById('preview-format').textContent = 'GLB';
    document.getElementById('fit-model-view').disabled = true;
    setTopologyEdgeControlAvailable(false);
    setLoading(false);
    setPreviewStatus('等待选择');
    return;
  }
  const hasPreview = Boolean(sceneState.modelRoot);
  const hasDetailPreview = Boolean(sceneState.detailRoot);
  empty.hidden = true;
  document.getElementById('preview-title').textContent = state.selectedModel.filename;
  document.getElementById('preview-format').textContent = hasDetailPreview ? 'STEP → GLB · 高清' : 'STEP → GLB · 快速';
  document.getElementById('fit-model-view').disabled = !hasPreview;
  setTopologyEdgeControlAvailable(Boolean(sceneState.edgeOverlay));
  const manifest = state.previewManifest || state.interactionManifest;
  if (manifest) renderModelStats(manifest);
  if (!hasPreview) {
    setLoading(true, '正在恢复预览', '菜单切换期间的加载将在此继续');
    setPreviewStatus('正在恢复预览', 'busy');
    return;
  }
  setLoading(false);
  setPreviewStatus(hasDetailPreview ? '高清预览已从内存恢复' : '简易预览已从内存恢复', 'ready');
}

/** 在模型预览菜单之间接管既有场景，避免重新请求预览资源或重建 WebGL 上下文。 */
function resumeModelPreviewPage(lifecycleSignal) {
  if (!attachRetainedPreviewCanvases()) return false;
  window.lucide?.createIcons();
  bindPreviewCanvasEvents(lifecycleSignal);
  bindEvents(lifecycleSignal);
  state.isInteracting = false;
  state.interactionQuality = null;
  state.lastRenderAt = 0;
  if (state.previewTransition) applyPreviewTransition({ type: 'idle' });
  resizeScene();
  const cachedView = readModelView();
  const pageModel = resolveCurrentPageModel(cachedView);
  const pageView = cachedView?.modelId === pageModel?.id ? cachedView : null;
  setConnection(state.connection.message, state.connection.error);
  if (!pageModel) {
    cacheCurrentPreview();
    state.selectedModel = null;
    clearPreview();
    renderModelList();
    return true;
  }
  state.pendingViewSnapshot = pageView;
  if (state.selectedModel?.id !== pageModel.id || !state.scene.modelRoot) {
    void selectModel(pageModel, true);
    return true;
  }
  state.selectedModel = pageModel;
  state.modelSettings = state.pageMode === 'settings' ? cloneModelSettings(pageModel.settings) : null;
  applyCurrentModelPreviewSettings(getCurrentPreviewSettings());
  notifyModelSettingsSelection();
  restoreRetainedPreviewPanel();
  fitModelView();
  renderPreviewQueueState();
  return true;
}

/** 暂停页面专属事件并缓存当前预览；会话后台队列继续运行，不依赖场景存活。 */
function suspendModelPreviewPage() {
  saveModelView();
  state.loadToken += 1;
  window.clearTimeout(state.idleTimer);
  window.clearTimeout(state.viewSaveTimer);
  state.idleTimer = null;
  state.viewSaveTimer = null;
  state.isInteracting = false;
  state.interactionQuality = null;
  state.lastRenderAt = 0;
  if (state.scene) state.scene.panPointerId = null;
  if (state.previewTransition) applyPreviewTransition({ type: 'idle' });
  cacheCurrentPreview();
}

/** 取消等待中的完整释放，使同一轮路由切换可以接管预览场景。 */
function cancelDeferredPreviewDisposal() {
  if (deferredPreviewDisposeTimer === null) return;
  window.clearTimeout(deferredPreviewDisposeTimer);
  deferredPreviewDisposeTimer = null;
}

/** 没有新预览页面接管时释放画布及 GPU 上下文，列表与有限网格缓存继续属于应用会话。 */
function scheduleDeferredPreviewDisposal() {
  cancelDeferredPreviewDisposal();
  deferredPreviewDisposeTimer = window.setTimeout(() => {
    deferredPreviewDisposeTimer = null;
    if (!activePageLifecycle) disposeModelUploadPage({ preserveSession: true });
  }, MODEL_PREVIEW_HANDOFF_DELAY_MS);
}

/** 释放页面渲染资源；切页保留列表、选择和已解码网格，窗口卸载时同时清理会话缓存。 */
function disposeModelUploadPage({ preserveSession = false } = {}) {
  cancelDeferredPreviewDisposal();
  saveModelView();
  state.loadToken += 1;
  window.clearTimeout(state.idleTimer);
  window.clearTimeout(state.viewSaveTimer);
  if (!preserveSession) {
    modelSearchSelect.reset();
    previewQueue.dispose();
    state.previewCache.forEach(disposePreview);
    state.previewCache.clear();
  }
  const sceneState = state.scene;
  if (sceneState) {
    sceneState.envelopePreview?.dispose();
    sceneState.settingsTools?.dispose();
    sceneState.coordinateFramePreview?.dispose();
    sceneState.orientationGizmo?.dispose();
    disposeOrbitControls(sceneState.controls);
    disposeObject(sceneState.scene);
    sceneState.renderer?.dispose();
    sceneState.renderer?.forceContextLoss();
    sceneState.renderer?.domElement.remove();
  }
  state.scene = null;
  state.idleTimer = null;
  state.viewSaveTimer = null;
  state.previewTransition = null;
  state.interactionQuality = null;
  state.isInteracting = false;
  state.lastRenderAt = 0;
  state.scrollRestoreApplied = false;
  state.modelsRefreshToken += 1;
  state.onRequestDelete = null;
  state.modelSettings = null;
  state.coordinateFrameDraft = null;
  state.mappingEntries = [];
  state.previewManifest = null;
  state.interactionManifest = null;
  state.pendingViewSnapshot = null;
  state.pageMode = 'upload';
  state.selectFirstModel = false;
  if (!preserveSession) {
    state.showTopologyEdges = true;
    state.models = [];
    state.modelsLoaded = false;
    state.selectedModel = null;
    state.selectedIds.clear();
    state.pageSelections = createModelPageSelections();
    state.connection = { message: '连接检查中', error: false };
  }
  if (import.meta.env.DEV) delete window.__satLayoutPreviewTestApi;
}

/** 返回相机与模型变换的只读数值快照，供浏览器回归测试验证交互约束。 */
export function getPreviewInteractionSnapshot() {
  const { camera, controls, panOffset, modelRoot, grid } = state.scene || {};
  if (!camera || !controls || !panOffset) return null;
  return {
    cameraPosition: camera.position.toArray(),
    cameraUp: camera.up.toArray(),
    target: controls.target.toArray(),
    panOffset: panOffset.toArray(),
    viewOffsetEnabled: Boolean(camera.view?.enabled),
    modelScale: modelRoot?.scale.toArray() || null,
    modelRotation: modelRoot?.rotation.toArray().slice(0, 3) || null,
    modelMatrix: modelRoot?.matrixWorld.toArray() || null,
    coordinateDraft: state.scene?.coordinateFramePreview?.getSnapshot() || null,
    gridRotation: grid?.rotation.toArray().slice(0, 3) || null,
    envelope: state.scene?.envelopePreview?.getSnapshot() || null,
  };
}

/** 按页面模式挂载共享模型预览控制器，并返回卸载函数。 */
function mountModelPreviewPage(options = {}) {
  cancelDeferredPreviewDisposal();
  activePageLifecycle?.abort();
  state.pageMode = options.pageMode || 'upload';
  state.settingsNotifiedModelId = undefined;
  state.selectFirstModel = Boolean(options.selectFirstModel);
  state.onRequestDelete = options.onRequestDelete || null;
  const lifecycle = new AbortController();
  activePageLifecycle = lifecycle;
  if (state.modelsLoaded) {
    const searchInput = document.getElementById('model-search');
    if (searchInput) searchInput.value = state.search;
    renderModelList();
    setConnection(state.connection.message, state.connection.error);
  }
  if (state.scene) {
    resumeModelPreviewPage(lifecycle.signal);
    void refreshModels({ quiet: true });
  } else void initialize(lifecycle.signal);
  return () => {
    if (activePageLifecycle !== lifecycle) return;
    lifecycle.abort();
    activePageLifecycle = null;
    suspendModelPreviewPage();
    scheduleDeferredPreviewDisposal();
  };
}

/** 将模型上传控制器挂载到 React 已渲染的 DOM，并返回卸载函数。 */
export function mountModelUploadPage(options = {}) {
  return mountModelPreviewPage({ ...options, pageMode: 'upload' });
}

/** 挂载模型设置页，仅在简易或高清预览加载成功后自动选择首个可设置模型。 */
export function mountModelSettingsPage() {
  return mountModelPreviewPage({ pageMode: 'settings', selectFirstModel: true });
}
