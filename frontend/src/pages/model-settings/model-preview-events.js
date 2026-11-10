/**
 * 文件说明：定义设置页与三维预览之间的浏览器事件名称，避免仅订阅事件就提前加载 Three.js。
 * 本模块不创建场景、不访问 DOM，也不管理模型或包络缓存。
 */

export const INSTALLATION_FACE_SELECTED_EVENT = 'sat-layout-installation-face-selected';
export const INSTALLATION_PICKER_STATE_EVENT = 'sat-layout-installation-picker-state';
export const ENVELOPE_PREVIEW_STATE_EVENT = 'sat-layout-envelope-preview-state';
