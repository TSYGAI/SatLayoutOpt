/**
 * 文件说明：模型上传页与模型设置页的共享预览控制器，负责模型库、页面选择、Z 轴朝上的三维场景与内存预览。
 * 两页分别保存选中模型与相机状态；独立模块负责 GLB 资源和安全包络显示，精确几何由后端负责。
 */

import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { disposeOrbitControls } from '../../components/orbit-controls-lifecycle.js';
import { createOrientationGizmo } from '../../components/orientation-gizmo.js';
import { showToast } from '../../components/toast.js';
import { restorePagePosition } from '../../app/page-position-cache.js';
import {
  checkHealth,
  deleteModel,
  deleteModels,
  getFaceMapping,
  getInteractionPreviewManifest,
  getPreviewManifest,
  getPreviewQualityConfig,
  getPreviewRuntimeCache,
  listModels,
  resolveApiUrl,
  savePreviewRuntimeCache,
  uploadModel,
} from '../../api/model-upload-api.js';
import {
  deserializePreviewRuntimeCache,
  serializePreviewRuntimeCache,
} from './preview-runtime-cache.js';
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
import { disposeObject, loadGlb, prepareMappingEntries } from './model-preview-resources.js';
import { createCoordinateAxes, setCoordinateAxesSize } from '../../components/coordinate-axes.js';

const VALID_EXTENSIONS = new Set(['stp', 'step']);
const ARTIFACT_LABELS = { failed: '生成失败', pending: '等待生成', processing: '正在转换', ready: '预览就绪' };
const PREVIEW_CACHE_LIMIT = 4;
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
  models: [], selectedModel: null, selectedIds: new Set(), search: '', loadController: null, loadToken: 0,
  scene: null, mappingEntries: [], previewManifest: null, interactionManifest: null, previewCache: new Map(),
  qualityConfig: normalizePreviewQualityConfig(DEFAULT_PREVIEW_QUALITY_CONFIG), interactionQuality: null,
  previewTransition: null,
  isInteracting: false, idleTimer: null, lastRenderAt: 0,
  showTopologyEdges: true, scrollRestoreApplied: false,
  pendingViewSnapshot: null, viewSaveTimer: null,
  pageMode: 'upload',
  pageSelections: createModelPageSelections(),
  selectFirstModel: false,
  modelSettings: null,
  connection: { message: '连接检查中', error: false },
};
let activePageLifecycle = null;
let deferredPreviewDisposeTimer = null;

/** 深拷贝包含嵌套质心和安装点对象的模型设置，避免页面草稿修改模型列表缓存。 */
function cloneModelSettings(settings = {}) {
  return {
    ...settings,
    center_of_mass: settings?.center_of_mass ? { ...settings.center_of_mass } : null,
    installation_point: settings?.installation_point ? { ...settings.installation_point } : null,
  };
}

/** 返回当前页面允许应用到共享预览的设置；上传页固定使用原始 STEP 姿态。 */
function getCurrentPreviewSettings() {
  if (state.pageMode !== 'settings') return {};
  return state.modelSettings || state.selectedModel?.settings || {};
}

/** 按模型统一缩放比例调整相机距离和裁剪面，保持当前观察方向与固定 STEP 原点。 */
function preservePreviewFramingForScale(previousScale, nextScale) {
  const { camera, controls } = state.scene || {};
  if (!camera || !controls || !Number.isFinite(previousScale) || previousScale <= 0
    || !Number.isFinite(nextScale) || nextScale <= 0) return;
  const ratio = nextScale / previousScale;
  if (Math.abs(ratio - 1) < 1e-9) return;
  camera.position.sub(controls.target).multiplyScalar(ratio).add(controls.target);
  camera.near = Math.max(camera.near * ratio, 0.0001);
  camera.far = Math.max(camera.far * ratio, camera.near + 1);
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

/** 根据当前页面的内存选择和会话快照解析应显示的模型。 */
function resolveCurrentPageModel(cachedView) {
  const pageMode = state.pageMode;
  const preferredModelId = state.pageSelections[pageMode]
    || readStoredModelSelection(pageMode)
    || cachedView?.modelId;
  const preferredModel = preferredModelId
    ? state.models.find((model) => model.id === preferredModelId)
    : null;
  if (preferredModelId && !preferredModel) clearModelView(pageMode);
  const model = preferredModel || (state.selectFirstModel ? state.models[0] : null);
  state.pageSelections[pageMode] = model?.id || null;
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
  return `${value.toFixed(value >= 100 ? 0 : value >= 10 ? 1 : 2)} ${units[index]}`;
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
  status.title = model.derivatives?.message || status.textContent;
  row.append(checkbox, main, status);
  return row;
}

/** 打开或关闭模型设置页的模型列表，并按需把焦点移入列表或返回触发按钮。 */
function setModelSettingsModelSelectOpen(open, focusTarget = null) {
  const selector = document.getElementById('model-settings-model-select');
  const control = selector?.closest('.model-settings-select-control');
  const options = document.getElementById('model-settings-model-options');
  if (!selector || !control || !options) return;
  const shouldOpen = Boolean(open && !selector.disabled && state.models.length);
  selector.setAttribute('aria-expanded', String(shouldOpen));
  control.classList.toggle('open', shouldOpen);
  options.hidden = !shouldOpen;
  if (focusTarget === 'trigger') selector.focus();
  if (shouldOpen && focusTarget === 'option') {
    (options.querySelector('[aria-selected="true"]') || options.querySelector('[role="option"]'))?.focus();
  }
}

/** 将键盘焦点在模型选项间循环移动。 */
function moveModelSettingsOptionFocus(options, offset) {
  const items = [...options.querySelectorAll('[role="option"]')];
  if (!items.length) return;
  const currentIndex = items.indexOf(document.activeElement);
  const nextIndex = currentIndex < 0 ? 0 : (currentIndex + offset + items.length) % items.length;
  items[nextIndex].focus();
}

/** 更新模型设置页的已上传模型选择菜单，并同步当前选中的预览对象。 */
function renderModelSettingsModelSelect() {
  const selector = document.getElementById('model-settings-model-select');
  const value = document.getElementById('model-settings-model-select-value');
  const options = document.getElementById('model-settings-model-options');
  if (!selector || !value || !options) return;
  options.replaceChildren();
  setModelSettingsModelSelectOpen(false);
  if (!state.models.length) {
    value.textContent = '暂无已上传模型';
    selector.dataset.value = '';
    selector.disabled = true;
    return;
  }
  const currentModel = state.models.find((model) => model.id === state.selectedModel?.id) || state.models[0];
  state.models.forEach((model) => {
    const option = document.createElement('button');
    option.className = 'model-settings-model-option';
    option.type = 'button';
    option.role = 'option';
    option.tabIndex = -1;
    option.dataset.modelId = model.id;
    option.setAttribute('aria-selected', String(model.id === currentModel.id));
    const label = document.createElement('span');
    label.className = 'model-settings-model-option-label';
    label.textContent = model.filename;
    option.append(label);
    options.append(option);
  });
  selector.disabled = false;
  selector.dataset.value = currentModel.id;
  value.textContent = currentModel.filename;
}

/** 按搜索关键字渲染模型列表，并同步选择数量和删除按钮。 */
function renderModelList() {
  const list = document.getElementById('model-list');
  const selectAll = document.getElementById('select-all-models');
  renderModelSettingsModelSelect();
  if (!list || !selectAll) return;
  const keyword = state.search.trim().toLocaleLowerCase('zh-CN');
  const visibleModels = state.models.filter((model) => model.filename.toLocaleLowerCase('zh-CN').includes(keyword));
  list.replaceChildren();
  document.getElementById('model-count').textContent = `${state.models.length} 个模型`;
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
  deleteButton.disabled = state.selectedIds.size === 0;
  deleteButton.title = state.selectedIds.size ? `删除选中的 ${state.selectedIds.size} 个模型` : '删除选中模型';
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

/** 从预览场景卸载当前模型，并保留完整双 LOD、拓扑映射及渲染资源供缓存复用。 */
function detachCurrentPreview() {
  state.scene?.envelopePreview?.clear();
  if (!state.scene?.interactionRoot && !state.scene?.detailRoot) return null;
  state.scene.settingsTools?.clearPreview();
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

/** 保存近期模型预览，优先保留两个页面当前选择并释放最久未使用的其他 GPU 资源。 */
function cachePreview(modelId, preview) {
  const existing = state.previewCache.get(modelId);
  if (existing && existing !== preview) disposePreview(existing);
  state.previewCache.delete(modelId);
  state.previewCache.set(modelId, preview);
  while (state.previewCache.size > PREVIEW_CACHE_LIMIT) {
    const pinnedModelIds = new Set(Object.values(state.pageSelections).filter(Boolean));
    const evictedEntry = [...state.previewCache.entries()].find(([cachedModelId]) => !pinnedModelIds.has(cachedModelId));
    if (!evictedEntry) break;
    const [evictedId, evictedPreview] = evictedEntry;
    state.previewCache.delete(evictedId);
    disposePreview(evictedPreview);
  }
}

/** 通知模型设置页当前选择已经变化，并提供后端返回的完整设置。 */
function notifyModelSettingsSelection() {
  if (state.pageMode !== 'settings') return;
  window.dispatchEvent(new CustomEvent(MODEL_SETTINGS_SELECTION_EVENT, {
    detail: {
      model: state.selectedModel
        ? { ...state.selectedModel, settings: cloneModelSettings(state.selectedModel.settings) }
        : null,
    },
  }));
}

/** 把设置变换同步到当前双 LOD 与拓扑边线；可选择提交到控制器内存模型列表。 */
export function applyCurrentModelPreviewSettings(settings, options = {}) {
  const transform = getModelPreviewTransform(settings);
  if (!transform) return false;
  const previousTransform = getModelPreviewTransform(getCurrentPreviewSettings());
  state.modelSettings = state.pageMode === 'settings' ? cloneModelSettings(settings) : null;
  if (options.commit && state.selectedModel) {
    state.selectedModel.settings = cloneModelSettings(settings);
    const storedModel = state.models.find((model) => model.id === state.selectedModel.id);
    if (storedModel) storedModel.settings = cloneModelSettings(settings);
  }
  const roots = [state.scene?.interactionRoot, state.scene?.detailRoot, state.scene?.edgeOverlay].filter(Boolean);
  roots.forEach((root) => {
    root.scale.setScalar(transform.scale);
    root.rotation.set(...transform.rotation, 'XYZ');
    root.updateMatrixWorld(true);
  });
  if (state.scene?.modelRoot) preservePreviewFramingForScale(previousTransform?.scale, transform.scale);
  if (state.scene?.modelRoot) {
    fitGridToBounds(new THREE.Box3().setFromObject(state.scene.modelRoot));
    if (state.previewManifest || state.interactionManifest) renderModelStats(state.previewManifest || state.interactionManifest);
  }
  state.scene?.settingsTools?.setContext({
    enabled: state.pageMode === 'settings' && Boolean(state.selectedModel),
    modelId: state.selectedModel?.id || null,
    detailRoot: state.scene?.detailRoot || null,
    mappingEntries: state.mappingEntries,
    settings: state.pageMode === 'settings' ? settings : {},
    transform,
  });
  requestSceneRender();
  return true;
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
  new Set([preview?.interactionRoot, preview?.detailRoot, preview?.edgeOverlay].filter(Boolean))
    .forEach((object) => disposeObject(object));
}

/** 将最终合并网格转换为可持久化的紧凑属性数据，并拒绝不完整的渲染对象。 */
function serializePreviewGeometry(geometry, includeNormals, label) {
  const position = geometry?.getAttribute('position');
  const normal = geometry?.getAttribute('normal');
  const index = geometry?.getIndex();
  if (!position || position.itemSize !== 3
    || (index && index.itemSize !== 1)
    || (includeNormals && (!normal || normal.itemSize !== 3))) {
    throw new Error(`${label}网格数据不完整`);
  }
  const indices = index
    ? Uint32Array.from(index.array)
    : Uint32Array.from({ length: position.count }, (_, vertexIndex) => vertexIndex);
  return {
    positions: Float32Array.from(position.array),
    ...(includeNormals ? { normals: Float32Array.from(normal.array) } : {}),
    indices,
  };
}

/** 校验缓存中的索引均引用指定顶点数量范围内的数据。 */
function hasValidGeometryIndices(indices, vertexCount) {
  for (let index = 0; index < indices.length; index += 1) {
    if (indices[index] >= vertexCount) return false;
  }
  return true;
}

/** 判断缓存属性数组中的全部数值是否有限，避免异常数据破坏相机与渲染计算。 */
function hasFiniteGeometryValues(values) {
  for (let index = 0; index < values.length; index += 1) {
    if (!Number.isFinite(values[index])) return false;
  }
  return true;
}

/** 从持久化属性数据恢复 Three.js BufferGeometry，并完成基础结构校验。 */
function createPreviewGeometryFromCache(data, includeNormals, label) {
  if (!data || typeof data !== 'object'
    || !(data.positions instanceof Float32Array)
    || !(data.indices instanceof Uint32Array)
    || data.positions.length === 0
    || data.positions.length % 3 !== 0
    || data.indices.length === 0
    || data.indices.length % (includeNormals ? 3 : 2) !== 0
    || !hasFiniteGeometryValues(data.positions)
    || !hasValidGeometryIndices(data.indices, data.positions.length / 3)
    || (includeNormals && (!(data.normals instanceof Float32Array)
      || data.normals.length !== data.positions.length
      || !hasFiniteGeometryValues(data.normals)))) {
    throw new Error(`${label}缓存结构无效`);
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(data.positions, 3));
  if (includeNormals) geometry.setAttribute('normal', new THREE.BufferAttribute(data.normals, 3));
  geometry.setIndex(new THREE.BufferAttribute(data.indices, 1));
  geometry.computeBoundingSphere();
  return geometry;
}

/** 从缓存中一次性创建表面和可选边线网格，任一数据段异常时释放已分配资源。 */
function createPreparedPreviewFromCache(surfaceData, edgeData, label) {
  let surfaceGeometry = null;
  let edgeGeometry = null;
  try {
    surfaceGeometry = createPreviewGeometryFromCache(surfaceData, true, label);
    edgeGeometry = edgeData ? createPreviewGeometryFromCache(edgeData, false, '拓扑边线') : null;
    return createPreparedPreviewFromGeometries(surfaceGeometry, edgeGeometry);
  } catch (error) {
    surfaceGeometry?.dispose();
    edgeGeometry?.dispose();
    throw error;
  }
}

/** 创建当前主题下已合并表面网格与可选拓扑边线覆盖层。 */
function createPreparedPreviewFromGeometries(surfaceGeometry, edgeGeometry = null) {
  let edgeOverlay = null;
  try {
    if (!surfaceGeometry) throw new Error('GLB 预览不包含可渲染网格');
    surfaceGeometry.computeBoundingSphere();
    const [red, green, blue] = getScenePalette().preview.map((value) => value / 255);
    const baseMaterial = new THREE.MeshStandardMaterial({
      color: new THREE.Color(red, green, blue),
      emissive: new THREE.Color(red * 0.1, green * 0.1, blue * 0.1),
      emissiveIntensity: 1,
      metalness: 0.08,
      roughness: 0.64,
      side: THREE.DoubleSide,
      wireframe: false,
      polygonOffset: true,
      polygonOffsetFactor: 1,
      polygonOffsetUnits: 1,
    });
    const modelRoot = new THREE.Mesh(surfaceGeometry, baseMaterial);
    modelRoot.name = 'STEP_PREVIEW_MERGED';
    if (edgeGeometry) {
      edgeGeometry.computeBoundingSphere();
      const edgeMaterial = createTopologyEdgeMaterial();
      edgeOverlay = new THREE.LineSegments(edgeGeometry, edgeMaterial);
      edgeOverlay.name = 'STEP_TOPOLOGY_EDGES';
      edgeOverlay.renderOrder = 1;
    }
    return { modelRoot, edgeOverlay };
  } catch (error) {
    surfaceGeometry?.dispose();
    edgeGeometry?.dispose();
    edgeOverlay?.material.dispose();
    throw error;
  }
}

/** 创建参考色拓扑边线材质，通过降低覆盖强度获得略细的视觉效果。 */
function createTopologyEdgeMaterial() {
  return new THREE.LineBasicMaterial({
    color: getScenePalette().edge,
    transparent: true,
    opacity: TOPOLOGY_EDGE_OPACITY,
    depthTest: true,
    depthWrite: false,
    toneMapped: false,
  });
}

/** 将当前双 LOD、拓扑边线、清单和面映射提取为跨刷新缓存负载。 */
function getPreviewRuntimeCachePayload() {
  const sceneState = state.scene;
  if (!sceneState?.interactionRoot || !sceneState.detailRoot || !state.interactionManifest
    || !state.previewManifest || !state.mappingEntries.length) return null;
  return {
    interaction: serializePreviewGeometry(sceneState.interactionRoot.geometry, true, '交互预览'),
    detail: serializePreviewGeometry(sceneState.detailRoot.geometry, true, '高清预览'),
    edge: sceneState.edgeOverlay ? serializePreviewGeometry(sceneState.edgeOverlay.geometry, false, '拓扑边线') : null,
    interactionManifest: state.interactionManifest,
    previewManifest: state.previewManifest,
    mappingEntries: state.mappingEntries,
  };
}

/** 验证缓存恢复所需的清单基础字段，避免异常缓存破坏预览状态。 */
function hasValidPreviewManifest(manifest) {
  return manifest && typeof manifest === 'object'
    && manifest.stats && typeof manifest.stats === 'object'
    && Number.isFinite(manifest.stats.body_count)
    && Number.isFinite(manifest.stats.face_count)
    && Number.isFinite(manifest.stats.triangle_count)
    && Array.isArray(manifest.bounds?.min)
    && Array.isArray(manifest.bounds?.max)
    && manifest.bounds.min.length === 3
    && manifest.bounds.max.length === 3
    && manifest.bounds.min.concat(manifest.bounds.max).every(Number.isFinite);
}

/** 将磁盘缓存负载还原为可直接接入当前 Three.js 场景的双 LOD 预览对象。 */
function createPreviewFromRuntimeCache(payload) {
  if (!payload || typeof payload !== 'object'
    || !hasValidPreviewManifest(payload.interactionManifest)
    || !hasValidPreviewManifest(payload.previewManifest)
    || !Array.isArray(payload.mappingEntries)) {
    throw new Error('预览缓存结构无效');
  }
  let interactionPreview = null;
  let detailPreview = null;
  try {
    interactionPreview = createPreparedPreviewFromCache(payload.interaction, null, '交互预览');
    detailPreview = createPreparedPreviewFromCache(payload.detail, payload.edge, '高清预览');
    const triangleCount = detailPreview.modelRoot.geometry.getIndex().count / 3;
    const mappingEntries = prepareMappingEntries(payload.mappingEntries, triangleCount);
    return {
      interactionRoot: interactionPreview.modelRoot,
      detailRoot: detailPreview.modelRoot,
      edgeOverlay: detailPreview.edgeOverlay,
      interactionManifest: payload.interactionManifest,
      previewManifest: payload.previewManifest,
      mappingEntries,
    };
  } catch (error) {
    if (interactionPreview?.modelRoot) disposeObject(interactionPreview.modelRoot);
    if (interactionPreview?.edgeOverlay) disposeObject(interactionPreview.edgeOverlay);
    if (detailPreview?.modelRoot) disposeObject(detailPreview.modelRoot);
    if (detailPreview?.edgeOverlay) disposeObject(detailPreview.edgeOverlay);
    throw error;
  }
}

/** 读取并验证磁盘持久化预览缓存；缓存不可用时返回空以回退到 GLB 加载。 */
async function loadPersistedPreview(modelId, signal) {
  try {
    const buffer = await getPreviewRuntimeCache(modelId, signal);
    return buffer ? createPreviewFromRuntimeCache(deserializePreviewRuntimeCache(buffer, modelId)) : null;
  } catch (error) {
    if (error.name === 'AbortError') throw error;
    console.warn(`预览持久缓存不可用，已回退 GLB 加载：${error.message}`);
    return null;
  }
}

/** 将已完成的当前模型预览异步写入后端磁盘缓存，失败不影响正在显示的模型。 */
async function persistPreview(modelId) {
  try {
    const payload = getPreviewRuntimeCachePayload();
    if (!payload) return;
    await savePreviewRuntimeCache(modelId, serializePreviewRuntimeCache(modelId, payload));
  } catch (error) {
    console.warn(`预览持久缓存保存失败：${error.message}`);
  }
}

/** 从预览场景移除当前模型并释放其 GPU 资源。 */
function clearModelScene() {
  const preview = detachCurrentPreview();
  if (preview) disposePreview(preview);
}

/** 恢复预览面板为空状态。 */
function clearPreview() {
  state.loadController?.abort();
  window.clearTimeout(state.idleTimer);
  state.loadController = null;
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
  const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
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
  state.scene = {
    container, scene, camera, renderer, controls, grid, axes, orientationGizmoContainer,
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
  document.getElementById('stat-bounds').textContent = size.map((value) => Number(value).toFixed(2)).join(' × ');
}

/** 把 GLB 中的逐面网格和拓扑线段分别合并为两个轻量渲染对象。 */
function prepareLoadedModel(root) {
  const surfaceGeometries = [];
  const edgeGeometries = [];
  let mergedGeometry = null;
  let mergedEdgeGeometry = null;
  let edgeOverlay = null;
  root.updateMatrixWorld(true);
  root.traverse((child) => {
    if (!child.isMesh && !child.isLineSegments) return;
    const geometry = child.geometry.clone();
    geometry.applyMatrix4(child.matrixWorld);
    if (child.isMesh) {
      if (!geometry.getAttribute('normal')) geometry.computeVertexNormals();
      surfaceGeometries.push(geometry);
    } else edgeGeometries.push(geometry);
  });
  try {
    if (!surfaceGeometries.length) throw new Error('GLB 预览不包含可渲染网格');
    mergedGeometry = mergeGeometries(surfaceGeometries, false);
    if (!mergedGeometry) throw new Error('GLB 逐面网格无法合并');
    mergedGeometry.computeBoundingSphere();
    const [red, green, blue] = getScenePalette().preview.map((value) => value / 255);
    const baseMaterial = new THREE.MeshStandardMaterial({
      color: new THREE.Color(red, green, blue),
      emissive: new THREE.Color(red * 0.1, green * 0.1, blue * 0.1),
      emissiveIntensity: 1,
      metalness: 0.08,
      roughness: 0.64,
      side: THREE.DoubleSide,
      wireframe: false,
      polygonOffset: true,
      polygonOffsetFactor: 1,
      polygonOffsetUnits: 1,
    });
    const model = new THREE.Mesh(mergedGeometry, baseMaterial);
    model.name = 'STEP_PREVIEW_MERGED';
    if (edgeGeometries.length) {
      mergedEdgeGeometry = mergeGeometries(edgeGeometries, false);
      if (mergedEdgeGeometry) {
        mergedEdgeGeometry.computeBoundingSphere();
        const edgeMaterial = createTopologyEdgeMaterial();
        edgeOverlay = new THREE.LineSegments(mergedEdgeGeometry, edgeMaterial);
        edgeOverlay.name = 'STEP_TOPOLOGY_EDGES';
        edgeOverlay.renderOrder = 1;
      }
    }
    return { modelRoot: model, edgeOverlay };
  } catch (error) {
    mergedGeometry?.dispose();
    mergedEdgeGeometry?.dispose();
    edgeOverlay?.material.dispose();
    throw error;
  } finally {
    surfaceGeometries.forEach((geometry) => geometry.dispose());
    edgeGeometries.forEach((geometry) => geometry.dispose());
    disposeObject(root);
  }
}

/** 把已准备的交互 LOD 接入场景，并首次适配相机。 */
function attachInteractionPreview(preparedPreview, manifest) {
  state.scene.interactionRoot = preparedPreview.modelRoot;
  state.interactionManifest = manifest;
  state.previewManifest = manifest;
  state.scene.scene.add(preparedPreview.modelRoot);
  applyCurrentModelPreviewSettings(getCurrentPreviewSettings());
  applyModelMaterialState(preparedPreview.modelRoot);
  applyPreviewTransition({ type: 'interaction-ready' });
  renderModelStats(manifest);
  fitModelView();
  setLoading(false);
  setPreviewStatus('快速预览就绪，高清生成中', 'busy');
  document.getElementById('fit-model-view').disabled = false;
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
    setPreviewStatus(`快速预览已从${cacheLabel}恢复，高清生成中`, 'busy');
  }
  requestSceneRender();
}

/** 后台加载细节 LOD 和外壳面映射，完成后在空闲状态无跳动切换。 */
async function loadDetailPreview(model, controller, token, hasInteractionPreview) {
  try {
    const manifest = await getPreviewManifest(model.id, controller.signal);
    if (token !== state.loadToken || controller.signal.aborted) return false;
    const [modelResult, mappingResult] = await Promise.allSettled([
      loadGlb(await resolveApiUrl(manifest.browser_asset.url), controller.signal),
      getFaceMapping(manifest.face_mapping.url, controller.signal),
    ]);
    if (modelResult.status === 'rejected' || mappingResult.status === 'rejected') {
      if (modelResult.status === 'fulfilled') disposeObject(modelResult.value);
      throw modelResult.status === 'rejected' ? modelResult.reason : mappingResult.reason;
    }
    const modelRoot = modelResult.value;
    const mapping = mappingResult.value;
    if (token !== state.loadToken || controller.signal.aborted) {
      disposeObject(modelRoot);
      return false;
    }
    const preparedPreview = prepareLoadedModel(modelRoot);
    const triangleCount = preparedPreview.modelRoot.geometry.getIndex().count / 3;
    try {
      state.mappingEntries = prepareMappingEntries(mapping.entries, triangleCount);
    } catch (error) {
      disposeObject(preparedPreview.modelRoot);
      if (preparedPreview.edgeOverlay) disposeObject(preparedPreview.edgeOverlay);
      throw error;
    }
    state.scene.detailRoot = preparedPreview.modelRoot;
    state.scene.edgeOverlay = preparedPreview.edgeOverlay;
    state.previewManifest = manifest;
    preparedPreview.modelRoot.visible = false;
    state.scene.scene.add(preparedPreview.modelRoot);
    if (preparedPreview.edgeOverlay) state.scene.scene.add(preparedPreview.edgeOverlay);
    applyCurrentModelPreviewSettings(getCurrentPreviewSettings());
    applyModelMaterialState(preparedPreview.modelRoot);
    renderModelStats(manifest);
    setTopologyEdgeControlAvailable(Boolean(preparedPreview.edgeOverlay));
    applyPreviewTransition({ type: 'detail-ready' });
    setLoading(false);
    document.getElementById('preview-format').textContent = 'STEP → GLB · 高清';
    setPreviewStatus('高清预览与映射就绪', 'ready');
    void persistPreview(model.id);
    await refreshModels({ quiet: true });
    return true;
  } catch (error) {
    if (error.name === 'AbortError' || token !== state.loadToken) return false;
    applyPreviewTransition({ type: 'detail-failed' });
    if (!hasInteractionPreview) throw error;
    setLoading(false);
    setPreviewStatus('快速预览可用', 'ready');
    showToast(`高清预览生成失败：${error.message}`, true);
    return false;
  }
}

/** 选中模型后优先加载交互 LOD，并在后台补充细节 LOD 与面映射。 */
async function selectModel(model, force = false) {
  if (!force && state.selectedModel?.id === model.id && state.scene?.modelRoot) return;
  if (state.pendingViewSnapshot?.modelId !== model.id) state.pendingViewSnapshot = null;
  state.loadController?.abort();
  window.clearTimeout(state.idleTimer);
  state.idleTimer = null;
  state.lastRenderAt = 0;
  const token = state.loadToken + 1;
  state.loadToken = token;
  const cachedPreview = takeCachedPreview(model.id);
  saveModelView();
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
  document.getElementById('preview-format').textContent = 'STEP → GLB · 快速';
  document.getElementById('fit-model-view').disabled = true;
  setTopologyEdgeControlAvailable(false);
  if (cachedPreview) {
    attachCachedPreview(cachedPreview);
    if (cachedPreview.detailRoot) {
      state.loadController = null;
      return;
    }
    const controller = new AbortController();
    state.loadController = controller;
    void loadDetailPreview(model, controller, token, true).finally(() => {
      if (state.loadController === controller) state.loadController = null;
    });
    return;
  }
  const controller = new AbortController();
  state.loadController = controller;
  try {
    setLoading(true, '正在恢复预览缓存', '读取已合并网格与 STEP 面映射');
    setPreviewStatus('正在恢复预览缓存', 'busy');
    const persistedPreview = await loadPersistedPreview(model.id, controller.signal);
    if (token !== state.loadToken || controller.signal.aborted) {
      if (persistedPreview) disposePreview(persistedPreview);
      return;
    }
    if (persistedPreview) {
      attachCachedPreview(persistedPreview, 'persistent');
      state.loadController = null;
      return;
    }
    setLoading(true, '正在生成快速预览', '提取外壳并生成交互网格');
    setPreviewStatus('正在准备快速预览', 'busy');
    const manifest = await getInteractionPreviewManifest(model.id, controller.signal);
    if (token !== state.loadToken || controller.signal.aborted) return;
    const modelRoot = await loadGlb(await resolveApiUrl(manifest.browser_asset.url), controller.signal);
    if (token !== state.loadToken || controller.signal.aborted) {
      disposeObject(modelRoot);
      return;
    }
    attachInteractionPreview(prepareLoadedModel(modelRoot), manifest);
    void loadDetailPreview(model, controller, token, true).finally(() => {
      if (state.loadController === controller) state.loadController = null;
    });
  } catch (interactionError) {
    if (interactionError.name === 'AbortError' || token !== state.loadToken) return;
    applyPreviewTransition({ type: 'interaction-failed' });
    setLoading(true, '快速预览不可用', '正在回退到细节预览');
    setPreviewStatus('正在加载细节预览', 'busy');
    try {
      const loaded = await loadDetailPreview(model, controller, token, false);
      if (loaded) {
        fitModelView();
        document.getElementById('fit-model-view').disabled = false;
      }
    } catch (detailError) {
      if (detailError.name === 'AbortError' || token !== state.loadToken) return;
      setLoading(false);
      document.getElementById('preview-empty').hidden = false;
      document.getElementById('fit-model-view').disabled = true;
      setTopologyEdgeControlAvailable(false);
      setPreviewStatus('模型处理失败', 'error');
      showToast(detailError.message, true);
    } finally {
      if (state.loadController === controller) state.loadController = null;
    }
  }
}

/** 从后端刷新模型库，保留当前仍存在的选择和预览。 */
async function refreshModels(options = {}) {
  const button = document.getElementById('refresh-models');
  if (!options.quiet) button?.classList.add('spinning');
  try {
    state.models = await listModels();
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
    setConnection('模型服务已连接');
  } catch (error) {
    setConnection('模型服务未连接', true);
    if (!options.quiet) showToast(error.message, true);
  } finally { button?.classList.remove('spinning'); }
}

/** 创建单个上传队列项并返回可更新的状态节点。 */
function createUploadItem(file) {
  const item = document.createElement('div');
  item.className = 'upload-item';
  const name = document.createElement('strong');
  name.textContent = file.name;
  const status = document.createElement('span');
  status.textContent = '等待上传';
  const track = document.createElement('div');
  track.className = 'progress-track';
  const bar = document.createElement('b');
  track.append(bar);
  item.append(name, status, track);
  document.getElementById('upload-queue').append(item);
  return { bar, status };
}

/** 校验并并行上传用户选择的 STEP/STP 文件。 */
async function uploadFiles(files) {
  const validFiles = [];
  const invalidFiles = [];
  files.forEach((file) => {
    const extension = file.name.split('.').pop()?.toLowerCase();
    if (VALID_EXTENSIONS.has(extension)) validFiles.push(file); else invalidFiles.push(file);
  });
  if (invalidFiles.length) showToast(`已拒绝 ${invalidFiles.length} 个文件：仅允许 .stp 或 .step`, true);
  if (!validFiles.length) return;
  const results = await Promise.all(validFiles.map(async (file) => {
    const queueItem = createUploadItem(file);
    try {
      const model = await uploadModel(file, (progress) => {
        queueItem.bar.style.width = `${progress}%`;
        queueItem.status.textContent = `上传中 ${progress}%`;
      });
      queueItem.status.className = 'success';
      queueItem.status.textContent = '源文件已保存';
      return model;
    } catch (error) {
      queueItem.status.className = 'error';
      queueItem.status.textContent = '上传失败';
      queueItem.status.title = error.message;
      return null;
    }
  }));
  const uploaded = results.filter(Boolean);
  await refreshModels({ quiet: true });
  if (uploaded.length) {
    const latest = state.models.find((model) => model.id === uploaded[uploaded.length - 1].id);
    if (latest) await selectModel(latest, true);
    showToast(`${uploaded.length} 个 STEP 模型已保存，正在生成浏览网格`);
  }
}

/** 删除指定模型集合，并在必要时清空当前预览。 */
async function removeModels(modelIds) {
  if (!modelIds.length) return;
  if (!window.confirm(`确定删除选中的 ${modelIds.length} 个模型及其派生产物吗？`)) return;
  try {
    const removesCurrent = Boolean(state.selectedModel && modelIds.includes(state.selectedModel.id));
    if (modelIds.length === 1) await deleteModel(modelIds[0]); else await deleteModels(modelIds);
    evictCachedPreviews(modelIds);
    Object.keys(state.pageSelections).forEach((pageMode) => {
      if (!state.pageSelections[pageMode] || !modelIds.includes(state.pageSelections[pageMode])) return;
      clearModelView(pageMode);
    });
    state.selectedIds.clear();
    if (removesCurrent) { state.selectedModel = null; clearModelView(); clearPreview(); }
    await refreshModels({ quiet: true });
    showToast(`已删除 ${modelIds.length} 个模型`);
  } catch (error) { showToast(error.message, true); }
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
    document.getElementById('delete-selected').addEventListener('click', () => removeModels([...state.selectedIds]), { signal: lifecycleSignal });
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
  const modelSettingsSelector = document.getElementById('model-settings-model-select');
  if (modelSettingsSelector) {
    const modelSettingsOptions = document.getElementById('model-settings-model-options');
    modelSettingsSelector.addEventListener('click', () => {
      const shouldOpen = modelSettingsSelector.getAttribute('aria-expanded') !== 'true';
      setModelSettingsModelSelectOpen(shouldOpen, shouldOpen ? 'option' : 'trigger');
    }, { signal: lifecycleSignal });
    modelSettingsSelector.addEventListener('keydown', (event) => {
      if (!['ArrowDown', 'ArrowUp'].includes(event.key)) return;
      event.preventDefault();
      setModelSettingsModelSelectOpen(true, 'option');
    }, { signal: lifecycleSignal });
    modelSettingsOptions?.addEventListener('click', async (event) => {
      const option = event.target.closest('[role="option"]');
      const model = state.models.find((item) => item.id === option?.dataset.modelId);
      if (!model) return;
      setModelSettingsModelSelectOpen(false, 'trigger');
      await selectModel(model);
    }, { signal: lifecycleSignal });
    modelSettingsOptions?.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        setModelSettingsModelSelectOpen(false, 'trigger');
      } else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault();
        moveModelSettingsOptionFocus(modelSettingsOptions, event.key === 'ArrowDown' ? 1 : -1);
      } else if (event.key === 'Home' || event.key === 'End') {
        event.preventDefault();
        const items = modelSettingsOptions.querySelectorAll('[role="option"]');
        items[event.key === 'Home' ? 0 : items.length - 1]?.focus();
      } else if (event.key === 'Tab') setModelSettingsModelSelectOpen(false);
    }, { signal: lifecycleSignal });
    document.addEventListener('pointerdown', (event) => {
      if (!event.target.closest('.model-settings-select-control')) setModelSettingsModelSelectOpen(false);
    }, { signal: lifecycleSignal });
  }
  document.getElementById('fit-model-view').addEventListener('click', fitModelView, { signal: lifecycleSignal });
  document.getElementById('toggle-topology-edges').addEventListener('click', toggleTopologyEdges, { signal: lifecycleSignal });
  window.addEventListener('sat-layout-theme-change', () => {
    applySceneTheme();
    resizeSceneAfterThemeChange();
  }, { signal: lifecycleSignal });
  window.addEventListener('resize', resizeScene, { signal: lifecycleSignal });
  window.addEventListener('beforeunload', disposeModelUploadPage, { signal: lifecycleSignal });
}

/** 初始化图标、三维场景、交互事件和模型库连接。 */
async function initialize(lifecycleSignal) {
  const cachedView = readModelView();
  window.lucide?.createIcons();
  try {
    state.qualityConfig = normalizePreviewQualityConfig(await getPreviewQualityConfig());
  } catch (error) {
    if (lifecycleSignal.aborted) return;
    showToast(`预览质量配置读取失败，已使用默认值：${error.message}`, true);
  }
  if (lifecycleSignal.aborted) return;
  state.previewTransition = createPreviewTransitionState(state.qualityConfig, window.devicePixelRatio || 1);
  initializeScene(lifecycleSignal);
  bindEvents(lifecycleSignal);
  clearPreview();
  try {
    await checkHealth();
    if (lifecycleSignal.aborted) return;
    await refreshModels({ quiet: true });
    if (lifecycleSignal.aborted) return;
    const initialModel = resolveCurrentPageModel(cachedView);
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
  setPreviewStatus(hasDetailPreview ? '高清预览已从内存恢复' : '快速预览已从内存恢复，高清生成中', hasDetailPreview ? 'ready' : 'busy');
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
  if (state.scene.interactionRoot && !state.scene.detailRoot && !state.loadController) {
    const token = state.loadToken;
    const controller = new AbortController();
    state.loadController = controller;
    void loadDetailPreview(pageModel, controller, token, true).finally(() => {
      if (state.loadController === controller) state.loadController = null;
    });
  }
  return true;
}

/** 暂停页面专属事件和在途加载，但保留可立即复用的场景、模型和 GPU 缓存。 */
function suspendModelPreviewPage() {
  saveModelView();
  state.loadController?.abort();
  state.loadController = null;
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

/** 在没有新预览页面接管时，于当前路由切换结束后完整释放 GPU 资源。 */
function scheduleDeferredPreviewDisposal() {
  cancelDeferredPreviewDisposal();
  deferredPreviewDisposeTimer = window.setTimeout(() => {
    deferredPreviewDisposeTimer = null;
    if (!activePageLifecycle) disposeModelUploadPage();
  }, MODEL_PREVIEW_HANDOFF_DELAY_MS);
}

/** 释放模型上传页的请求、事件、定时器、Three.js GPU 资源及 WebGL 上下文。 */
function disposeModelUploadPage() {
  cancelDeferredPreviewDisposal();
  saveModelView();
  state.loadController?.abort();
  state.loadToken += 1;
  window.clearTimeout(state.idleTimer);
  window.clearTimeout(state.viewSaveTimer);
  state.previewCache.forEach(disposePreview);
  state.previewCache.clear();
  const sceneState = state.scene;
  if (sceneState) {
    sceneState.envelopePreview?.dispose();
    sceneState.settingsTools?.dispose();
    sceneState.orientationGizmo?.dispose();
    disposeOrbitControls(sceneState.controls);
    disposeObject(sceneState.scene);
    sceneState.renderer?.dispose();
    sceneState.renderer?.forceContextLoss();
    sceneState.renderer?.domElement.remove();
  }
  state.scene = null;
  state.loadController = null;
  state.idleTimer = null;
  state.viewSaveTimer = null;
  state.previewTransition = null;
  state.interactionQuality = null;
  state.isInteracting = false;
  state.lastRenderAt = 0;
  state.showTopologyEdges = true;
  state.scrollRestoreApplied = false;
  state.models = [];
  state.selectedModel = null;
  state.modelSettings = null;
  state.selectedIds.clear();
  state.mappingEntries = [];
  state.previewManifest = null;
  state.interactionManifest = null;
  state.pendingViewSnapshot = null;
  state.pageMode = 'upload';
  state.pageSelections = createModelPageSelections();
  state.selectFirstModel = false;
  state.connection = { message: '连接检查中', error: false };
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
    gridRotation: grid?.rotation.toArray().slice(0, 3) || null,
    envelope: state.scene?.envelopePreview?.getSnapshot() || null,
  };
}

/** 按页面模式挂载共享模型预览控制器，并返回卸载函数。 */
function mountModelPreviewPage(options = {}) {
  cancelDeferredPreviewDisposal();
  activePageLifecycle?.abort();
  state.pageMode = options.pageMode || 'upload';
  state.selectFirstModel = Boolean(options.selectFirstModel);
  const lifecycle = new AbortController();
  activePageLifecycle = lifecycle;
  if (state.scene) resumeModelPreviewPage(lifecycle.signal);
  else void initialize(lifecycle.signal);
  return () => {
    if (activePageLifecycle !== lifecycle) return;
    lifecycle.abort();
    activePageLifecycle = null;
    suspendModelPreviewPage();
    scheduleDeferredPreviewDisposal();
  };
}

/** 将模型上传控制器挂载到 React 已渲染的 DOM，并返回卸载函数。 */
export function mountModelUploadPage() {
  return mountModelPreviewPage({ pageMode: 'upload' });
}

/** 将只读模型预览挂载到模型设置页，并在没有历史选择时展示首个模型。 */
export function mountModelSettingsPage() {
  return mountModelPreviewPage({ pageMode: 'settings', selectFirstModel: true });
}
