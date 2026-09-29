/**
 * 文件说明：管理模型上传页与模型设置页各自的 Z 轴朝上视角会话快照。
 * 本模块只负责 sessionStorage 键、结构校验和序列化；视角版本升级时通过新键隔离旧坐标系缓存。
 */

const MODEL_VIEW_STORAGE_KEYS = Object.freeze({
  upload: 'sat-layout-opt:model-upload-view:v2',
  settings: 'sat-layout-opt:model-settings-view:v2',
});
const MODEL_SELECTION_STORAGE_KEYS = Object.freeze({
  upload: 'sat-layout-opt:model-upload-selection:v1',
  settings: 'sat-layout-opt:model-settings-selection:v1',
});

/** 判断一个值是否为指定长度的有限数值数组。 */
function isFiniteNumberArray(value, length) {
  return Array.isArray(value) && value.length === length && value.every(Number.isFinite);
}

/** 返回指定预览页面的会话视角缓存键。 */
function getModelViewStorageKey(pageMode) {
  return MODEL_VIEW_STORAGE_KEYS[pageMode] || MODEL_VIEW_STORAGE_KEYS.upload;
}

/** 返回指定预览页面的模型选择缓存键。 */
function getModelSelectionStorageKey(pageMode) {
  return MODEL_SELECTION_STORAGE_KEYS[pageMode] || MODEL_SELECTION_STORAGE_KEYS.upload;
}

/** 创建两页互不共享的空模型选择状态。 */
export function createModelPageSelections() {
  return { upload: null, settings: null };
}

/** 从 sessionStorage 读取并校验指定页面的模型与相机视角。 */
export function readStoredModelView(pageMode) {
  try {
    const snapshot = JSON.parse(window.sessionStorage.getItem(getModelViewStorageKey(pageMode)) || 'null');
    if (!snapshot || typeof snapshot.modelId !== 'string') return null;
    if (!isFiniteNumberArray(snapshot.cameraPosition, 3)
      || !isFiniteNumberArray(snapshot.cameraUp, 3)
      || !isFiniteNumberArray(snapshot.target, 3)
      || !isFiniteNumberArray(snapshot.panOffset, 2)
      || !Number.isFinite(snapshot.near)
      || !Number.isFinite(snapshot.far)) return null;
    return snapshot;
  } catch {
    return null;
  }
}

/** 从 sessionStorage 读取指定页面最近选择的模型标识。 */
export function readStoredModelSelection(pageMode) {
  try {
    const modelId = window.sessionStorage.getItem(getModelSelectionStorageKey(pageMode));
    return modelId || null;
  } catch {
    return null;
  }
}

/** 将指定页面最近选择的模型标识写入 sessionStorage。 */
export function writeStoredModelSelection(pageMode, modelId) {
  try {
    window.sessionStorage.setItem(getModelSelectionStorageKey(pageMode), modelId);
  } catch {
    // 存储不可用时忽略缓存，不影响当前预览。
  }
}

/** 将指定页面的模型与相机视角写入 sessionStorage。 */
export function writeStoredModelView(pageMode, snapshot) {
  try {
    window.sessionStorage.setItem(getModelViewStorageKey(pageMode), JSON.stringify(snapshot));
  } catch {
    // 隐私模式或存储空间不足时忽略缓存，不影响当前预览。
  }
}

/** 删除指定页面的模型与相机视角会话快照。 */
export function removeStoredModelView(pageMode) {
  try {
    window.sessionStorage.removeItem(getModelViewStorageKey(pageMode));
    window.sessionStorage.removeItem(getModelSelectionStorageKey(pageMode));
  } catch {
    // 存储不可用时无需影响模型管理和预览功能。
  }
}
