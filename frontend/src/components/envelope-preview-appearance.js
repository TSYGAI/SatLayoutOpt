/**
 * 文件说明：统一优化页与固化包络预览的表面材质、轮廓材质、主题灯光及色彩输出。
 * 颜色和不透明度由调用方读取集中 TOML 配置；本模块仅创建 Three.js 显示资源，释放由宿主负责。
 */

import * as THREE from 'three';

/** 布局优化既有的主题环境；包络预览共享背景与灯光，避免浅色主题下出现不同的青色。 */
const SCENE_PALETTES = Object.freeze({
  dark: {
    background: 0x030609,
    hemisphere: { sky: 0xbfe8ff, ground: 0x0d1720, intensity: 1.5 },
    rim: { color: 0x4fb6d8, intensity: 0.5 },
  },
  light: {
    background: 0xe8eef3,
    hemisphere: { sky: 0xffffff, ground: 0xd7e2ea, intensity: 1.6 },
    rim: { color: 0x4f7f96, intensity: 0.45 },
  },
});

/** 返回布局包络的主题环境参数；未知主题沿用深色，调用方负责提供当前主题。 */
export function resolveEnvelopeScenePalette(theme) {
  return SCENE_PALETTES[theme] || SCENE_PALETTES.dark;
}

/** 创建共享的半球光、主光和轮廓光；返回灯光集合，由调用方加入和移除场景。 */
export function createEnvelopeLights(theme) {
  const palette = resolveEnvelopeScenePalette(theme);
  const hemisphere = new THREE.HemisphereLight(palette.hemisphere.sky, palette.hemisphere.ground, palette.hemisphere.intensity);
  const key = new THREE.DirectionalLight(0xffffff, 1.3);
  key.position.set(1.4, 2.0, 1.2);
  const rim = new THREE.DirectionalLight(palette.rim.color, palette.rim.intensity);
  rim.position.set(-1.6, -0.6, -1.4);
  return { hemisphere, key, rim };
}

/** 同步已有灯光的主题参数，保留场景对象和位置；不创建新资源。 */
export function applyEnvelopeLightTheme(lights, theme) {
  const palette = resolveEnvelopeScenePalette(theme);
  lights.hemisphere.color.setHex(palette.hemisphere.sky);
  lights.hemisphere.groundColor.setHex(palette.hemisphere.ground);
  lights.hemisphere.intensity = palette.hemisphere.intensity;
  lights.rim.color.setHex(palette.rim.color);
  lights.rim.intensity = palette.rim.intensity;
}

/** 根据配置的颜色和不透明度创建包络外表面；写入深度以避免背后面片透叠冲淡结构。 */
export function createEnvelopeSurfaceMaterial(color, opacity) {
  return new THREE.MeshStandardMaterial({
    color,
    roughness: 0.55,
    metalness: 0.05,
    transparent: true,
    opacity,
    side: THREE.FrontSide,
    depthWrite: true,
  });
}

/** 从包络填充色派生深色轮廓材质；返回独立材质，避免不同预览互相修改颜色。 */
export function createEnvelopeEdgeMaterial(color) {
  return new THREE.LineBasicMaterial({ color: new THREE.Color(color).multiplyScalar(0.45) });
}

/** 设置与布局优化一致的色彩空间及色调映射；应在渲染器异步初始化完成前调用。 */
export function configureEnvelopeRenderer(renderer) {
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.05;
}
