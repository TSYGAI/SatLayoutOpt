/**
 * 文件说明：三维预览按真实尺寸显示整流罩、安装筒及下方同轴基座；中轴柱沿筒体展示质心偏移。
 * 场景以 Z 轴为上，与后端约定一致：圆柱中轴与 Z 轴重合，整体抬升到 z ≥ 0 的上半空间，底面贴合 z = 0 水平面。
 * 预览与模型上传、模型设置共享左右键、缩放、方向立方体与边线操作；裁剪范围随相机移动更新，取景忽略辅助坐标轴。
 * 固定卫星按缓存矩阵逐帧更新本体、包络与质心，显示世界六向位置箭头与随当前视角换算方向的安装面旋转按钮；不重建稳定成员。
 * 本模块复用统一网格初始化，旧圆柱主体与安装筒重合时只绘制一次；不请求后端资源、不判定业务可行性或参与固化。
 * 组合整流罩按分段边界显式绘制圆环，避免上下锥段增高后连接边线被面夹角阈值过滤。
 * 圆环按相机实时区分可见实线和遮挡虚线，复用共用边线控制器，不改变半透明罩体与内部布局。
 * 整流罩主题色、边线透明度和安装实体材质向微调视口共享，避免两处预览各自定义外观。
 * 右键投影平移与微调视口共用实现，保持旋转中心和鼠标手势一致。
 */

import * as THREE from 'three';
import { createPreviewViewMemory } from '../../components/preview-view-memory.js';
import { createPreviewPan } from '../../components/preview-pan.js';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';

import { getCurrentTheme } from '../../theme/theme.js';
import { createCoordinateAxes, setCoordinateAxesSize } from '../../components/coordinate-axes.js';
import { disposeOrbitControls } from '../../components/orbit-controls-lifecycle.js';
import { PreviewRenderer } from '../../components/preview-renderer.js';
import { getModulePreviewConfig, getPreviewQualityConfig, getFairingEdgeConfig } from '../../api/model-upload-api.js';
import { createFairingBoundaryEdges } from '../../components/fairing-boundary-edges.js';
import {
  configureEnvelopeRenderer, resolveEnvelopeScenePalette, createEnvelopeLights, applyEnvelopeLightTheme,
} from '../../components/envelope-preview-appearance.js';
import { createOrientationGizmo } from '../../components/orientation-gizmo.js';
import { createLayoutPlacementObjects } from '../../components/layout-placement-objects.js';
import { createLayoutGeometryCache } from '../../components/layout-geometry-cache.js';
import { createFixedPlacementObjects, updateFixedPlacementObjects } from '../../components/fixed-placement-objects.js';
import { createFixedPlacementInteraction } from './fixed-placement-interaction.js';
import { createFixedTranslationGizmo } from '../../components/fixed-translation-gizmo.js';
import { createFixedMountRotationControls } from '../../components/fixed-mount-rotation-controls.js';

/**
 * 圆柱预览的明暗主题调色板。
 * 深色沿用工作台原有青色高亮；亮色改用深青主体与浅灰背景，保证在浅色画布上仍然清晰。
 * 整流罩沿用原内壁边界的浅色半透明配色，安装筒沿用主体配色；质心约束中轴柱使用原有橙色实心材质。
 */
const SCENE_PALETTES = {
  dark: {
    body: 0x39d0e9,
    edge: 0x0a2b36,
    axis: 0xffb45c,
    axisEdge: 0x4a2f0d,
    fairingBoundary: 0x9bd9e6,
    fairingBoundaryEdge: 0xc7f3fa,
    gridMajor: 0x1d3b4a,
    gridMinor: 0x12242e,
    gridOpacity: 0.5,
  },
  light: {
    body: 0x0f7d99,
    edge: 0x2c3f4b,
    axis: 0xc4761a,
    axisEdge: 0x5c3607,
    fairingBoundary: 0x4f8296,
    fairingBoundaryEdge: 0x315b6c,
    gridMajor: 0x9fb2c0,
    gridMinor: 0xcbd8e1,
    gridOpacity: 0.75,
  },
};
const GRID_DIVISIONS = 20;
const MINIMUM_SCENE_SPAN = 1;
/** 包围球适配视图后的目标占比；斜视余量使圆柱实体约占画布短边的三分之二。 */
const VIEWPORT_FILL_RATIO = 0.8;
/** 默认从 +X/+Y/+Z 象限观察，使屏幕中的 X、Y、Z 分别指向左下、右下和正上。 */
const DEFAULT_VIEW_DIRECTION = Object.freeze([0.95, 0.95, 1.35]);
/** 场景以 Z 轴为上，与后端归一化约定（模型最小 Z 为 0）保持一致。 */
const SCENE_UP = Object.freeze([0, 0, 1]);
/** 方向立方体采用固定像素比，避免跟随高分屏比例产生不必要的额外开销。 */
const ORIENTATION_GIZMO_PIXEL_RATIO = 2;

/** 返回前置配置构件与环境外观；微调视口共享整流罩边线色和透明度，未知主题回退深色。 */
export function resolveCylinderScenePalette(theme) {
  return { ...(SCENE_PALETTES[theme] || SCENE_PALETTES.dark),
    fairingBoundaryEdgeOpacity: 0.82, ...resolveEnvelopeScenePalette(theme) };
}

/** 创建原预览与微调共用的半透明安装筒/基座材质；调用方独立持有并负责释放。 */
export function createInstallationSurfaceMaterial(theme) {
  return new THREE.MeshStandardMaterial({ color: resolveCylinderScenePalette(theme).body,
    transparent: true, opacity: 0.42, roughness: 0.42, metalness: 0.08,
    side: THREE.DoubleSide, depthWrite: false });
}

/**
 * 生成圆柱侧壁与上下底面的三角网格顶点和索引。
 * @param {{ radius: number, height: number, radialSegments: number }} geometry 圆柱半径、高度与圆周分段数，单位为毫米。
 * @returns {{ positions: Float32Array, indices: Uint32Array }} 可直接写入 BufferGeometry 的位置与索引数组。
 */
export function buildCylinderMesh({ radius, height, radialSegments }) {
  const segments = Math.max(Math.round(radialSegments) || 8, 8);
  const halfHeight = height / 2;
  const positions = [];
  const indices = [];

  // 侧壁：每段环向两个顶点，法线方向由 Three.js 依据顶点顺序计算。
  for (let index = 0; index <= segments; index += 1) {
    const angle = (index / segments) * Math.PI * 2;
    const x = Math.cos(angle) * radius;
    const y = Math.sin(angle) * radius;
    positions.push(x, y, -halfHeight, x, y, halfHeight);
  }
  for (let index = 0; index < segments; index += 1) {
    const bottom = index * 2;
    const top = bottom + 1;
    const nextBottom = bottom + 2;
    const nextTop = bottom + 3;
    indices.push(bottom, nextBottom, top, top, nextBottom, nextTop);
  }

  // 上下底面：各用一个中心点加一圈环向顶点构成扇形三角面。
  for (const [z, upward] of [[-halfHeight, false], [halfHeight, true]]) {
    const centerIndex = positions.length / 3;
    positions.push(0, 0, z);
    const ringStart = positions.length / 3;
    for (let index = 0; index <= segments; index += 1) {
      const angle = (index / segments) * Math.PI * 2;
      positions.push(Math.cos(angle) * radius, Math.sin(angle) * radius, z);
    }
    for (let index = 0; index < segments; index += 1) {
      const current = ringStart + index;
      const next = ringStart + index + 1;
      if (upward) indices.push(centerIndex, current, next);
      else indices.push(centerIndex, next, current);
    }
  }

  return { positions: new Float32Array(positions), indices: new Uint32Array(indices) };
}

/** 将网格顶点与索引转换为带法线的 Three.js 几何；返回资源由场景销毁流程统一释放。 */
function createBufferGeometry({ positions, indices }) {
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geometry.setIndex(new THREE.BufferAttribute(indices, 1));
  geometry.computeVertexNormals();
  return geometry;
}

/**
 * 根据下锥段、圆柱段和上锥段生成连续网格及分段圆环；圆环与实体共用顶点坐标。
 * @param {{ profile?: { segments?: Array<object>, total_height_mm?: number }, radialSegments: number }} options 组合段参数与圆周分段数。
 * @returns {{ positions: Float32Array, indices: Uint32Array, edgeIndices: Uint32Array }|null} 组合网格及圆环线段索引；缺少轮廓或总高度非法时返回空。
 */
export function buildFairingProfileMesh({ profile, radialSegments }) {
  const segments = Array.isArray(profile?.segments) && profile.segments.length
    ? profile.segments : [];
  if (!segments.length) return null;
  const count = Math.max(Math.round(radialSegments) || 8, 8);
  const totalHeight = Number(profile?.total_height_mm)
    || segments.reduce((sum, item) => sum + Number(item.height_mm || 0), 0);
  if (!Number.isFinite(totalHeight) || totalHeight <= 0) return null;
  const positions = [];
  const indices = [];
  const edgeIndices = [];
  let z = -totalHeight / 2;
  segments.forEach((item, segmentIndex) => {
    const height = Number(item.height_mm);
    const lower = Number(item.lower_radius_mm ?? item.radius_mm);
    const upper = Number(item.upper_radius_mm ?? item.radius_mm);
    if (![height, lower, upper].every((value) => Number.isFinite(value) && value > 0)) return null;
    const start = positions.length / 3;
    for (let index = 0; index <= count; index += 1) {
      const angle = (index / count) * Math.PI * 2;
      const x = Math.cos(angle);
      const y = Math.sin(angle);
      positions.push(x * lower, y * lower, z, x * upper, y * upper, z + height);
    }
    for (let index = 0; index < count; index += 1) {
      const bottom = start + index * 2;
      const top = bottom + 1;
      const nextBottom = bottom + 2;
      const nextTop = bottom + 3;
      indices.push(bottom, nextBottom, top, top, nextBottom, nextTop);
      // 每段顶环与首段底环各绘制一次，连接环不重复，也不包含侧壁三角剖分线。
      edgeIndices.push(top, nextTop);
      if (segmentIndex === 0) edgeIndices.push(bottom, nextBottom);
    }
    if (segmentIndex === 0) {
      const center = positions.length / 3;
      positions.push(0, 0, z);
      for (let index = 0; index < count; index += 1) {
        const current = start + index * 2;
        const next = current + 2;
        indices.push(center, next, current);
      }
    }
    if (segmentIndex === segments.length - 1) {
      const center = positions.length / 3;
      positions.push(0, 0, z + height);
      for (let index = 0; index < count; index += 1) {
        const current = start + index * 2 + 1;
        const next = current + 2;
        indices.push(center, current, next);
      }
    }
    z += height;
  });
  return { positions: new Float32Array(positions), indices: new Uint32Array(indices),
    edgeIndices: new Uint32Array(edgeIndices) };
}

/** 复用连续段网格生成基座圆台；上底面取当前筒体半径，缺少基座时返回空。 */
export function buildInstallationBaseMesh({ base, radius, radialSegments }) {
  if (!base) return null;
  const lower = Number(base.lower_radius_mm), height = Number(base.height_mm), upper = Number(radius);
  if (![lower, height, upper].every((value) => Number.isFinite(value) && value > 0)) return null;
  return buildFairingProfileMesh({ radialSegments, profile: { total_height_mm: height,
    segments: [{ lower_radius_mm: lower, upper_radius_mm: upper, height_mm: height }] } });
}

/**
 * 生成用于展示同轴整流罩内壁的轻量圆柱侧壁网格，不生成上下端盖。
 * @param {{ radius: number, height: number, fairingRadius: number, radialSegments: number }} geometry
 *   整流舱半径、高度、整流罩半径与圆周分段数，单位为毫米。
 * @returns {{ radius: number, positions: Float32Array, indices: Uint32Array }|null} 内壁半径及网格数据，参数非法时返回空。
 */
export function buildFairingBoundaryMesh({ radius, height, fairingRadius, radialSegments }) {
  const cylinderRadius = Number(radius);
  const innerRadius = Number(fairingRadius);
  const safeHeight = Number(height);
  if (
    !Number.isFinite(cylinderRadius) || cylinderRadius <= 0
    || !Number.isFinite(innerRadius) || innerRadius <= cylinderRadius
    || !Number.isFinite(safeHeight) || safeHeight <= 0
  ) return null;
  const segments = Math.max(Math.round(radialSegments) || 8, 8);
  const halfHeight = safeHeight / 2;
  const positions = [];
  const indices = [];
  for (let index = 0; index <= segments; index += 1) {
    const angle = (index / segments) * Math.PI * 2;
    const x = Math.cos(angle) * innerRadius;
    const y = Math.sin(angle) * innerRadius;
    positions.push(x, y, -halfHeight, x, y, halfHeight);
  }
  for (let index = 0; index < segments; index += 1) {
    const bottom = index * 2;
    const top = bottom + 1;
    const nextBottom = bottom + 2;
    const nextTop = bottom + 3;
    indices.push(bottom, nextBottom, top, top, nextBottom, nextTop);
  }
  return {
    radius: innerRadius,
    positions: new Float32Array(positions),
    indices: new Uint32Array(indices),
  };
}

/**
 * 按当前圆柱尺寸生成便于确认原点位置的网格间距。
 * @param {number} span 场景需要覆盖的最大跨度，单位为毫米。
 * @returns {number} 取值为 1、2、5 乘以 10 的整数次幂的网格间距。
 */
export function resolveGridSpacing(span) {
  if (!Number.isFinite(span) || span <= 0) return 1;
  const rawStep = span / GRID_DIVISIONS;
  const magnitude = 10 ** Math.floor(Math.log10(rawStep));
  const normalized = rawStep / magnitude;
  const factor = normalized <= 1 ? 1 : normalized <= 2 ? 2 : normalized <= 5 ? 5 : 10;
  return factor * magnitude;
}

/**
 * 计算把圆柱抬到坐标轴上半空间所需的 Z 向偏移量。
 *
 * 场景以 Z 轴为上，与后端归一化约定（模型最小 Z 为 0）一致；圆柱整体位于 z ≥ 0，底面贴合原点水平面。
 * @param {{ min: { z: number } }} bounds 圆柱的世界包围盒。
 * @returns {number} 需要沿 +Z 平移的距离；包围盒无效或已在上半空间时返回 0。
 */
export function resolveUpperHalfOffset(bounds) {
  const minimumZ = Number(bounds?.min?.z);
  if (!Number.isFinite(minimumZ)) return 0;
  return Math.max(-minimumZ, 0);
}

/**
 * 计算让包围球占据画布短边指定比例所需的相机距离。
 * @param {number} radius 包围球半径。
 * @param {number} verticalFovDegrees 相机垂直视场角，单位为度。
 * @param {number} aspect 画布宽高比。
 * @param {number} [fillRatio] 包围球目标占比，默认保留斜视圆柱所需的边角余量。
 * @returns {number} 相机到包围球中心的距离。
 */
export function resolveFitDistance(radius, verticalFovDegrees, aspect, fillRatio = VIEWPORT_FILL_RATIO) {
  const safeRadius = Number(radius);
  const safeFov = Number(verticalFovDegrees);
  const safeAspect = Number(aspect);
  const safeFill = Number(fillRatio);
  if (
    !Number.isFinite(safeRadius) || safeRadius <= 0
    || !Number.isFinite(safeFov) || safeFov <= 0 || safeFov >= 180
    || !Number.isFinite(safeAspect) || safeAspect <= 0
    || !Number.isFinite(safeFill) || safeFill <= 0 || safeFill >= 1
  ) return MINIMUM_SCENE_SPAN;
  const verticalTangent = Math.tan((safeFov * Math.PI) / 360);
  const limitingTangent = verticalTangent * Math.min(safeAspect, 1);
  return safeRadius / (limitingTangent * safeFill);
}

/**
 * 根据相机到内容中心的当前距离更新裁剪范围，避免滚轮放大后仍使用适配时的近裁剪面。
 * @param {number} radius 实体内容包围球半径，单位为毫米。
 * @param {number} distance 当前相机到包围球中心的距离，单位为毫米。
 * @returns {{ near: number, far: number }} 覆盖完整包围球并保留网格余量的裁剪范围。
 */
export function resolveCameraClipping(radius, distance) {
  const safeRadius = Math.max(radius, MINIMUM_SCENE_SPAN);
  return {
    near: Math.max(distance - safeRadius * 2, distance / 1000, 1e-3),
    far: distance + safeRadius * 3,
  };
}

/**
 * 只合并实体网格的世界包围盒，模型坐标轴和边线不影响居中与适配距离。
 * @param {THREE.Object3D|null} object 当前舱体及卫星根组，不改变其位姿。
 * @returns {THREE.Box3} 完整实体范围；没有实体时返回空包围盒。
 */
export function resolveContentBounds(object) {
  const bounds = new THREE.Box3();
  object?.updateWorldMatrix(true, true);
  object?.traverse((child) => {
    if (!child.isMesh || !child.geometry) return;
    if (!child.geometry.boundingBox) child.geometry.computeBoundingBox();
    if (child.geometry.boundingBox) bounds.union(child.geometry.boundingBox.clone().applyMatrix4(child.matrixWorld));
  });
  return bounds;
}

/**
 * 创建自定义圆柱预览控制器。
 * @param {{ container: HTMLElement, orientationGizmoContainer?: HTMLElement|null, sessionKey?: string|null, edgesVisible?: boolean }} options
 *   主画布、可选方向立方体容器、会话视角标识和初始边线开关；省略会话标识时不保存视角。
 * @returns {{
 *   show: (geometry: { radius: number, height: number, radialSegments: number, axisRadius?: number, fairingRadius?: number }) => void,
 *   toggleTopologyEdges: () => boolean,
 *   clear: () => void,
 *   fitView: () => void,
 *   applySceneTheme: () => void,
 *   dispose: () => void,
 * }} 预览控制接口，`show` 会用新尺寸整体替换当前圆柱。
 */
export function createCylinderPreview({ container, orientationGizmoContainer = null, sessionKey = null, edgesVisible = true }) {
  const renderer = new PreviewRenderer({ antialias: true, alpha: false, powerPreference: 'high-performance' });
  renderer.setPixelRatio(1);
  renderer.setSize(container.clientWidth || 1, container.clientHeight || 1, false);
  configureEnvelopeRenderer(renderer);
  renderer.domElement.setAttribute('aria-label', '自定义圆柱三维预览画布');
  container.appendChild(renderer.domElement);

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(resolveEnvelopeScenePalette(getCurrentTheme()).background);
  const camera = new THREE.PerspectiveCamera(42, 1, 0.1, 1e7);
  camera.up.set(...SCENE_UP);
  camera.position.set(1.4, -1.4, 1.6);

  const controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = false;
  controls.enablePan = false;
  controls.minDistance = 0.01;
  controls.maxDistance = 10000000;

  const lights = createEnvelopeLights(getCurrentTheme());
  scene.add(...Object.values(lights));

  // 地面网格按圆柱尺寸缩放；坐标系固定在原点并使用与模型上传页一致的世界坐标系实现。
  const gridGroup = new THREE.Group();
  scene.add(gridGroup);
  const axes = createCoordinateAxes({ name: 'CYLINDER_ORIGIN_AXES' });
  scene.add(axes);
  const cylinderGroup = new THREE.Group();
  scene.add(cylinderGroup);

  let currentObject = null;
  let currentFairingEdges = null, fairingEdgeStyle = null;
  const layoutGeometryCache = createLayoutGeometryCache();
  let currentFairingInnerRadius = null;
  let currentSpan = MINIMUM_SCENE_SPAN;
  let contentBounds = new THREE.Box3();
  const contentSphere = new THREE.Sphere(new THREE.Vector3(), MINIMUM_SCENE_SPAN);
  let activeTheme = getCurrentTheme();
  let topologyEdgesVisible = edgesVisible;
  let disposed = false;
  let renderQueued = false;
  let animationFrame = null;
  let orientationGizmo = null;
  const identityQuaternion = new THREE.Quaternion();
  const panOffset = new THREE.Vector2();
  const previewPan = createPreviewPan({ camera, element: renderer.domElement, panOffset, onChange: requestRender });
  const { apply: applyPreviewPan, reset: resetPreviewPan } = previewPan;
  const viewMemory = createPreviewViewMemory(sessionKey, { camera, controls, panOffset });
  let currentViewKey = null;
  const resizeObserver = new ResizeObserver(() => resize());
  // 读取当前会话预算后再提高画布分辨率；异步完成前已离页的场景不再操作 GPU。
  Promise.all([getModulePreviewConfig(), getPreviewQualityConfig(), getFairingEdgeConfig()]).then(([budget, quality, edgeStyle]) => {
    if (disposed) return;
    fairingEdgeStyle = edgeStyle;
    currentFairingEdges?.configure(edgeStyle);
    const cap = sessionKey === 'pre-config' ? budget.preConfigPixelRatioCap : quality.idlePixelRatioCap;
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, cap));
    resize();
    requestRender();
  }).catch((error) => console.error('预览资源配置加载失败', error));

  /** 返回当前主题对应的调色板，未知主题回退到深色。 */
  function getPalette() {
    return resolveCylinderScenePalette(activeTheme);
  }

  /** 按容器尺寸同步投影，并保留相对于适配视图的缩放倍率和用户观察方向。 */
  function resize() {
    const width = container.clientWidth || 1;
    const height = container.clientHeight || 1;
    const previousFitDistance = resolveFitDistance(contentSphere.radius, camera.fov, camera.aspect);
    renderer.setSize(width, height, false);
    camera.aspect = width / height;
    if (currentObject) {
      const nextFitDistance = resolveFitDistance(contentSphere.radius, camera.fov, camera.aspect);
      camera.position.sub(controls.target).multiplyScalar(nextFitDistance / previousFitDistance).add(controls.target);
      controls.update();
    }
    updateCameraClipping();
    camera.updateProjectionMatrix();
    applyPreviewPan();
    orientationGizmo?.resize(
      orientationGizmoContainer?.clientWidth || 1,
      orientationGizmoContainer?.clientHeight || 1,
    );
    requestRender();
  }

  /** 渲染一帧，并按相机距离同步坐标系与方向立方体。 */
  function renderFrame() {
    animationFrame = null;
    renderQueued = false;
    if (disposed) return;
    controls.update();
    updateCameraClipping();
    setCoordinateAxesSize({ axes, camera, renderer });
    fixedGizmo.update(camera, container.clientHeight);
    fixedRotationControls.update(camera, container.clientWidth, container.clientHeight);
    currentFairingEdges?.update(camera, container.clientHeight);
    renderer.render(scene, camera);
    const viewDirection = camera.position.clone().sub(controls.target);
    orientationGizmo?.render(viewDirection, identityQuaternion, camera.up);
  }

  /** 合并同一浏览器帧内的场景更新，静止时不持续占用 GPU。 */
  function requestRender() {
    if (disposed || renderQueued) return;
    renderQueued = true;
    animationFrame = window.requestAnimationFrame(renderFrame);
  }

  /** 在旋转、缩放或容器变化后同步裁剪面，不改变布局位姿和用户投影平移。 */
  function updateCameraClipping() {
    const { near, far } = resolveCameraClipping(contentSphere.radius, camera.position.distanceTo(contentSphere.center));
    if (camera.near === near && camera.far === far) return;
    camera.near = near;
    camera.far = far;
    camera.updateProjectionMatrix();
  }

  /** 把方向立方体的局部面法线转换为世界坐标系中的正交观察方向。 */
  function orientPreviewCamera(localNormal) {
    if (!localNormal || localNormal.lengthSq() < 1e-8) return;
    const worldDirection = localNormal.clone().normalize();
    const distance = Math.max(camera.position.distanceTo(controls.target), camera.near * 2);
    const sceneUp = new THREE.Vector3(...SCENE_UP);
    camera.up.copy(
      Math.abs(worldDirection.dot(sceneUp)) > 0.98
        ? new THREE.Vector3(0, worldDirection.z >= 0 ? -1 : 1, 0)
        : sceneUp,
    );
    camera.position.copy(controls.target).addScaledVector(worldDirection, distance);
    camera.lookAt(controls.target);
    controls.update();
    requestRender();
  }

  /** 释放一个对象的全部几何与材质资源。 */
  function disposeObject(object) {
    object.traverse((child) => {
      if (!child.userData.sharedLayoutGeometry) child.geometry?.dispose?.();
      const materials = Array.isArray(child.material) ? child.material : [child.material];
      materials.forEach((material) => {
        material?.map?.dispose?.();
        material?.dispose?.();
      });
    });
  }

  /** 清空地面网格，避免切换尺寸时叠加多套网格。 */
  function clearHelpers() {
    gridGroup.children.slice().forEach((child) => {
      gridGroup.remove(child);
      disposeObject(child);
    });
  }

  /** 清空当前圆柱网格。 */
  function clearCylinder() {
    if (!currentObject) return;
    cylinderGroup.remove(currentObject);
    disposeObject(currentObject);
    currentObject = null;
    currentFairingEdges = null;
  }

  /**
   * 在 z = 0 平面重建水平地面网格，并按相机距离同步世界坐标系的像素高度。
   * 网格把下半空间与上半空间分开，圆柱始终整体位于网格之上。
   * @param {number} span 场景需要覆盖的最大跨度，单位为毫米。
   */
  function rebuildHelpers(span) {
    clearHelpers();
    currentSpan = span;
    const palette = getPalette();
    const spacing = resolveGridSpacing(span);
    const halfSize = spacing * (GRID_DIVISIONS / 2);
    const grid = new THREE.GridHelper(halfSize * 2, GRID_DIVISIONS, palette.gridMajor, palette.gridMinor);
    grid.material.transparent = true;
    grid.material.opacity = palette.gridOpacity;
    grid.material.depthTest = true;
    grid.material.depthWrite = false;
    grid.renderOrder = 0;
    // GridHelper 默认躺在 XZ 平面；绕 X 轴转 90° 后水平躺在 XY 平面，与 Z 向上的场景一致。
    grid.rotation.x = Math.PI / 2;
    gridGroup.add(grid);
    setCoordinateAxesSize({ axes, camera, renderer });
  }

  /** 把当前主题应用到背景、灯光、圆柱材质与原点参考系。 */
  function applySceneTheme() {
    activeTheme = getCurrentTheme();
    const palette = getPalette();
    scene.background.setHex(palette.background);
    applyEnvelopeLightTheme(lights, activeTheme);
    currentObject?.traverse((child) => {
      if (!child.material?.color) return;
      const role = child.userData?.appearanceRole || child.userData?.surfaceRole;
      if (role === 'payload' || role === 'fixed-body' || role === 'fixed-envelope') return;
      if (role === 'axis') {
        child.material.color.setHex(child.isLineSegments ? palette.axisEdge : palette.axis);
        return;
      }
      if (role === 'fairing-boundary') {
        child.material.color.setHex(
          child.isLineSegments ? palette.fairingBoundaryEdge : palette.fairingBoundary,
        );
        return;
      }
      child.material.color.setHex(child.isLineSegments ? palette.edge : palette.body);
    });
    rebuildHelpers(currentSpan);
    requestRender();
  }

  /**
   * 把相机调整到构件约占画布短边三分之二的位置。
   * 场景以 Z 轴为上，相机从斜上方看向构件包围球中心，使各种尺寸具有稳定占比。
   * 仅以实体取景；后续裁剪面随相机更新，缩放下限阻止相机进入实体包围球。
   */
  function fitView() {
    contentBounds = resolveContentBounds(currentObject);
    const sphere = !contentBounds.isEmpty()
      ? contentBounds.getBoundingSphere(new THREE.Sphere())
      : new THREE.Sphere(new THREE.Vector3(), MINIMUM_SCENE_SPAN);
    // 以完整构件包围球控制画面占比并看向构件中心，避免高整流罩顶部被画布裁切。
    const fitRadius = Math.max(sphere.radius, MINIMUM_SCENE_SPAN);
    contentSphere.copy(sphere);
    contentSphere.radius = fitRadius;
    const distance = resolveFitDistance(fitRadius, camera.fov, camera.aspect);
    const viewDirection = new THREE.Vector3(...DEFAULT_VIEW_DIRECTION).normalize();
    camera.position.copy(sphere.center).addScaledVector(viewDirection, distance);
    controls.target.copy(sphere.center);
    controls.minDistance = fitRadius;
    controls.update();
    updateCameraClipping();
    resetPreviewPan();
    setCoordinateAxesSize({ axes, camera, renderer });
    requestRender();
  }

  /** 设置构件边线；固定放置包络轮廓始终可见，保持视觉与判定一致。 */
  function setTopologyEdgesVisible(visible) {
    topologyEdgesVisible = Boolean(visible);
    currentObject?.traverse((child) => {
      if (child.isLineSegments && child.userData?.surfaceRole) child.visible = child.userData.surfaceRole === 'fixed-envelope' || topologyEdgesVisible;
    });
    requestRender();
    return topologyEdgesVisible;
  }

  /** 切换构件表面边线，并返回切换后的显示状态。 */
  function toggleTopologyEdges() {
    return setTopologyEdgesVisible(!topologyEdgesVisible);
  }

  /**
   * 用独立的整流罩外形与安装筒尺寸重建构件网格并适配视图。
   * 质心最大偏移以同轴柱显示，高度跟随安装筒；旧记录缺少组合轮廓时沿用圆柱边界预览。
   * @param {{ radius: number, height: number, radialSegments: number, installationRadius?: number,
   *   installationHeight?: number, installationBase?: object, axisRadius?: number, fairingRadius?: number, profile?: object, fairing_profile?: object }} geometry
   *   内部安装筒尺寸、质心约束柱半径、外部整流罩轮廓及旧记录兼容边界，长度单位为毫米。
   * @param {boolean} retainLayoutGeometry 是否保留布局派生几何缓存。
   * @param {string} viewKey 当前几何或候选的稳定内容标识，仅恢复同一内容的视角。
   */
  function show(geometry, retainLayoutGeometry = false, viewKey = JSON.stringify(geometry)) {
    if (currentObject) viewMemory.save(currentViewKey);
    currentViewKey = viewKey;
    if (disposed) return;
    const profile = geometry.profile || geometry.fairing_profile;
    const profileMesh = buildFairingProfileMesh({ profile, radialSegments: geometry.radialSegments });
    const bufferGeometry = createBufferGeometry(profileMesh || buildCylinderMesh(geometry));

    // 罩体与基座从地面起算，筒体再按基座高度抬升，不能将不同高度的实体直接居中叠放。
    const fairingHeight = geometry.fairingHeight ?? profile?.total_height_mm ?? geometry.height;
    if (profileMesh) bufferGeometry.translate(0, 0, (fairingHeight - geometry.height) / 2);

    const palette = getPalette();
    const group = new THREE.Group();
    let nextFairingEdges = null;
    // 组合轮廓只改变几何，仍使用原整流罩浅色半透明材质；旧记录的圆柱主体保持原有外观。
    const shellMaterial = profileMesh ? new THREE.MeshBasicMaterial({
      color: palette.fairingBoundary,
      transparent: true,
      opacity: 0.1,
      side: THREE.DoubleSide,
      depthWrite: false,
    }) : new THREE.MeshStandardMaterial({
      color: palette.body,
      transparent: true,
      opacity: 0.28,
      roughness: 0.42,
      metalness: 0.08,
      side: THREE.DoubleSide,
      depthWrite: false,
      flatShading: false,
    });
    const shellMesh = new THREE.Mesh(bufferGeometry, shellMaterial);
    shellMesh.userData.surfaceRole = 'shell';
    shellMesh.userData.appearanceRole = profileMesh ? 'fairing-boundary' : 'shell';
    group.add(shellMesh);
    // 复制已平移的实体顶点，确保圆环贴合罩体，且几何资源仍可独立释放。
    const shellEdgeGeometry = profileMesh ? new THREE.BufferGeometry()
      .setAttribute('position', bufferGeometry.getAttribute('position').clone())
      .setIndex(new THREE.BufferAttribute(profileMesh.edgeIndices, 1))
      : new THREE.EdgesGeometry(bufferGeometry, 30);
    if (profileMesh) {
      nextFairingEdges = createFairingBoundaryEdges({ surface: shellMesh, edgeGeometry: shellEdgeGeometry,
        color: palette.fairingBoundaryEdge, opacity: palette.fairingBoundaryEdgeOpacity, style: fairingEdgeStyle });
      for (const line of nextFairingEdges.object.children) line.userData.surfaceRole = 'shell';
      group.add(nextFairingEdges.object);
    } else {
      const shellEdges = new THREE.LineSegments(shellEdgeGeometry,
        new THREE.LineBasicMaterial({ color: palette.edge, transparent: true, opacity: 0.7 }));
      shellEdges.userData.surfaceRole = 'shell'; shellEdges.userData.appearanceRole = 'shell';
      group.add(shellEdges);
    }

    const installationRadius = Number(geometry.installationRadius ?? geometry.radius);
    const installationHeight = Number(geometry.installationHeight ?? geometry.height);
    const baseMesh = buildInstallationBaseMesh({ base: geometry.installationBase,
      radius: installationRadius, radialSegments: geometry.radialSegments });
    const baseHeight = baseMesh ? Number(geometry.installationBase.height_mm) : 0;
    const validInstallation = Number.isFinite(installationRadius) && installationRadius > 0
      && Number.isFinite(installationHeight) && installationHeight > 0;
    // 无组合轮廓的旧圆柱已代表安装筒，仅在外形或尺寸不同的情况下额外绘制独立筒体。
    if (validInstallation && (profileMesh || baseMesh || installationRadius !== Number(geometry.radius)
      || installationHeight !== Number(geometry.height))) {
      const tubeGeometry = createBufferGeometry(buildCylinderMesh({
        radius: installationRadius, height: installationHeight, radialSegments: geometry.radialSegments,
      }));
      tubeGeometry.translate(0, 0, baseHeight + (installationHeight - geometry.height) / 2);
      const tubeMesh = new THREE.Mesh(tubeGeometry, createInstallationSurfaceMaterial(activeTheme));
      tubeMesh.userData.surfaceRole = 'installation-tube';
      tubeMesh.renderOrder = 1;
      group.add(tubeMesh);
    }

    if (baseMesh) {
      const baseGeometry = createBufferGeometry(baseMesh);
      baseGeometry.translate(0, 0, (baseHeight - geometry.height) / 2);
      const base = new THREE.Mesh(baseGeometry, createInstallationSurfaceMaterial(activeTheme));
      base.userData.surfaceRole = 'installation-base';
      base.renderOrder = 1;
      group.add(base);
    }

    // 中轴柱表示质心允许的径向偏移，底面和高度与安装筒一致；先绘制实心柱，再叠加半透明筒体和罩体。
    const axisRadius = Number(geometry.axisRadius);
    if (validInstallation && Number.isFinite(axisRadius) && axisRadius > 0 && axisRadius < installationRadius) {
      const rodGeometry = createBufferGeometry(buildCylinderMesh({
        radius: axisRadius, height: installationHeight, radialSegments: geometry.radialSegments,
      }));
      rodGeometry.translate(0, 0, baseHeight + (installationHeight - geometry.height) / 2);
      const rodMesh = new THREE.Mesh(rodGeometry, new THREE.MeshStandardMaterial({
        color: palette.axis,
        transparent: false,
        opacity: 1,
        roughness: 0.35,
        metalness: 0.1,
        side: THREE.FrontSide,
        depthWrite: true,
      }));
      rodMesh.userData.surfaceRole = 'axis';
      rodMesh.renderOrder = -1;
      group.add(rodMesh);
      const rodEdges = new THREE.LineSegments(
        new THREE.EdgesGeometry(rodGeometry, 30),
        new THREE.LineBasicMaterial({ color: palette.axisEdge, transparent: true, opacity: 0.8 }),
      );
      rodEdges.userData.surfaceRole = 'axis';
      group.add(rodEdges);
    }

    const fairingBoundary = profileMesh ? null : buildFairingBoundaryMesh({ ...geometry, height: fairingHeight });
    if (fairingBoundary) {
      const boundaryGeometry = createBufferGeometry(fairingBoundary);
      boundaryGeometry.translate(0, 0, (fairingHeight - geometry.height) / 2);
      const boundaryMesh = new THREE.Mesh(boundaryGeometry, new THREE.MeshBasicMaterial({
        color: palette.fairingBoundary,
        transparent: true,
        opacity: 0.1,
        side: THREE.DoubleSide,
        depthWrite: false,
      }));
      boundaryMesh.userData.surfaceRole = 'fairing-boundary';
      boundaryMesh.renderOrder = 1;
      group.add(boundaryMesh);
      nextFairingEdges = createFairingBoundaryEdges({ surface: boundaryMesh,
        edgeGeometry: new THREE.EdgesGeometry(boundaryGeometry, 30), color: palette.fairingBoundaryEdge,
        opacity: palette.fairingBoundaryEdgeOpacity, style: fairingEdgeStyle });
      for (const line of nextFairingEdges.object.children) line.userData.surfaceRole = 'fairing-boundary';
      group.add(nextFairingEdges.object);
    }
    clearCylinder();
    if (!retainLayoutGeometry) layoutGeometryCache.dispose();
    currentObject = group;
    currentFairingEdges = nextFairingEdges;
    currentFairingInnerRadius = profileMesh ? profile.max_radius_mm : fairingBoundary?.radius ?? null;
    cylinderGroup.add(group);
    group.updateMatrixWorld(true);
    const bounds = new THREE.Box3().setFromObject(group);
    group.position.z = resolveUpperHalfOffset(bounds);
    group.updateMatrixWorld(true);
    setTopologyEdgesVisible(topologyEdgesVisible);
    const span = Math.max((currentFairingInnerRadius ?? geometry.radius) * 2, fairingHeight, MINIMUM_SCENE_SPAN);
    rebuildHelpers(span);
    fitView();
    if (viewMemory.restore(currentViewKey)) applyPreviewPan();
  }

  /** 显示后端布局的正式包络、罩体可用高度和整体质心；位姿使用底面 Z=0，不复制约束规则。 */
  function showLayout(candidate, meshes, radialSegments, style) {
    show({ radius: candidate.radius_mm, height: candidate.height_mm, axisRadius: candidate.axis_radius_mm,
      fairingRadius: candidate.fairing_radius_mm, installationBase: candidate.installation_base,
      profile: candidate.fairing_profile, radialSegments }, true, JSON.stringify(candidate));
    layoutGeometryCache.sync(meshes);
    const payload = createLayoutPlacementObjects(candidate, meshes, layoutGeometryCache, style);
    payload.userData.layoutCandidate = candidate;
    payload.position.z = -currentObject.position.z;
    currentObject.add(payload);
    setTopologyEdgesVisible(topologyEdgesVisible);
    fitView();
    if (viewMemory.restore(currentViewKey)) applyPreviewPan();
  }

  let fixedHandler = null, fixedOptions = null, fixedPayloadBuilds = 0, fixedPoseUpdates = 0;
  const fixedGizmo = createFixedTranslationGizmo(); scene.add(fixedGizmo.object);
  const fixedRotationControls = createFixedMountRotationControls(container,
    (action) => fixedHandler?.('mount-rotate', action));
  const fixedInteraction = createFixedPlacementInteraction(renderer.domElement, camera, controls,
    () => currentObject, (phase, patch) => fixedHandler?.(phase, patch), () => fixedGizmo.pickObject());

  /** 将六向控件放在选中包络的全局显示中心；局部模型旋转不改变箭头的世界轴方向。 */
  function refreshFixedGizmo() {
    const payload = currentObject?.children.find((child) => child.userData.fixedCandidate);
    const instances = payload?.userData.fixedInstances;
    const candidate = payload?.userData.fixedCandidate;
    const placement = candidate?.placements.find((item) => item.instance_id === fixedOptions?.instanceId && item.fixed_group_id === fixedOptions?.groupId)
      || candidate?.placements.find((item) => item.fixed_group_id === fixedOptions?.groupId);
    const body = instances?.get(placement?.instance_id)?.find((mesh) => mesh.userData.surfaceRole === 'fixed-envelope');
    if (!fixedOptions || !body) { fixedGizmo.show(null); fixedRotationControls.show(null); return; }
    body.updateWorldMatrix(true, false);
    const center = body.geometry.boundingBox.getCenter(new THREE.Vector3()).applyMatrix4(body.matrixWorld);
    fixedGizmo.show({ instanceId: placement.instance_id, groupId: placement.fixed_group_id, mount: placement.mount,
      kind: 'translate' }, center, fixedOptions.gizmoSizePx);
    fixedRotationControls.show({ instanceId: placement.instance_id, groupId: placement.fixed_group_id,
      installationFaceNormal: placement.installation_face_normal, installationPoint: placement.installation_point_mm },
      body.geometry.boundingBox.clone().applyMatrix4(body.matrixWorld), fixedOptions.rotationStepDeg,
      fixedOptions.rotationEnabled, fixedOptions.gizmoSizePx);
    fixedGizmo.update(camera, container.clientHeight);
    fixedRotationControls.update(camera, container.clientWidth, container.clientHeight);
  }

  /** 同时更新本体、包络和质心；成员不变时复用全部实例、材质与几何，不在拖动帧销毁重建。 */
  function showFixed(candidate, meshes, radialSegments, opacity) {
    const current = currentObject?.children.find((child) => child.userData.fixedCandidate);
    const sameGeometry = current && current.userData.fixedCandidate.radius_mm === candidate.radius_mm
      && current.userData.fixedCandidate.height_mm === candidate.height_mm
      && current.userData.fixedCandidate.fairing_radius_mm === candidate.fairing_radius_mm
      && JSON.stringify(current.userData.fixedCandidate.installation_base) === JSON.stringify(candidate.installation_base)
      && JSON.stringify(current.userData.fixedCandidate.fairing_profile) === JSON.stringify(candidate.fairing_profile)
      && current.userData.fixedCandidate.axis_radius_mm === candidate.axis_radius_mm;
    const reused = sameGeometry && current.userData.fixedMeshes === meshes && updateFixedPlacementObjects(current, candidate);
    if (!reused) {
      if (!sameGeometry) show({ radius: candidate.radius_mm, height: candidate.height_mm,
        axisRadius: candidate.axis_radius_mm, fairingRadius: candidate.fairing_radius_mm,
        installationBase: candidate.installation_base, profile: candidate.fairing_profile, radialSegments }, true, 'fixed-constraints');
      else { currentObject.remove(current); disposeObject(current); }
      layoutGeometryCache.sync(meshes);
      const payload = createFixedPlacementObjects(candidate, meshes, layoutGeometryCache, opacity);
      payload.userData.fixedCandidate = candidate; payload.userData.fixedMeshes = meshes;
      payload.position.z = -currentObject.position.z;
      currentObject.add(payload); fixedPayloadBuilds += 1;
    } else fixedPoseUpdates += 1;
    currentObject.updateMatrixWorld(true);
    contentBounds.copy(resolveContentBounds(currentObject));
    contentBounds.getBoundingSphere(contentSphere);
    refreshFixedGizmo();
    setTopologyEdgesVisible(topologyEdgesVisible);
    requestRender();
  }

  /** 更新任意本体选择、侧挂拖动与六向微调参数；约束校验交给页面API。 */
  function setFixedInteraction(options, handler) {
    fixedHandler = handler; fixedOptions = options;
    fixedInteraction.setOptions(options);
    refreshFixedGizmo(); requestRender();
  }

  /** 清空圆柱网格但保留坐标系与渲染器。 */
  function clear() {
    clearCylinder();
    layoutGeometryCache.dispose();
    currentFairingInnerRadius = null;
    clearHelpers();
    requestRender();
  }

  /** 释放渲染器、WebGL 上下文、控制器与全部几何资源。 */
  function dispose() {
    if (disposed) return;
    if (currentObject) viewMemory.save(currentViewKey);
    disposed = true;
    fixedInteraction.dispose();
    fixedGizmo.dispose();
    fixedRotationControls.dispose();
    resizeObserver.disconnect();
    window.removeEventListener('sat-layout-theme-change', applySceneTheme);
    if (animationFrame !== null) window.cancelAnimationFrame(animationFrame);
    previewPan.dispose();
    clear();
    disposeObject(axes);
    orientationGizmo?.dispose();
    controls.removeEventListener('change', requestRender);
    disposeOrbitControls(controls);
    renderer.dispose();
    renderer.forceContextLoss();
    renderer.domElement.remove();
  }

  resizeObserver.observe(container);
  window.addEventListener('sat-layout-theme-change', applySceneTheme);
  controls.addEventListener('change', requestRender);
  if (orientationGizmoContainer) {
    orientationGizmo = createOrientationGizmo(orientationGizmoContainer, {
      pixelRatio: ORIENTATION_GIZMO_PIXEL_RATIO,
      onFaceClick: orientPreviewCamera,
    });
  }
  applySceneTheme();
  resize();
  requestRender();
  return {
    container,
    show,
    showLayout,
    showFixed,
    setFixedInteraction,
    toggleTopologyEdges,
    clear,
    fitView,
    applySceneTheme,
    dispose,
    /** 将毫米世界点投影至当前画布，供浏览器验收真实筒面点选与本体拖动。 */
    projectWorldPoint(point) {
      const position = new THREE.Vector3().fromArray(point).project(camera);
      const rect = renderer.domElement.getBoundingClientRect();
      return { x: rect.left + (position.x + 1) / 2 * rect.width,
        y: rect.top + (1 - position.y) / 2 * rect.height };
    },
    /**
     * 返回当前圆柱的世界包围盒，供浏览器验收断言其位于 z ≥ 0 的上半空间。
     * @returns {{ min: number[], max: number[] }|null} 包围盒，无圆柱时为 null。
     */
    getCylinderWorldBounds() {
      if (!currentObject) return null;
      const box = new THREE.Box3().setFromObject(currentObject);
      if (box.isEmpty()) return null;
      return { min: box.min.toArray(), max: box.max.toArray() };
    },
    /** 返回当前同轴整流罩内壁半径，供浏览器验收核对直接半径配置。 */
    getFairingInnerRadius() {
      return currentFairingInnerRadius;
    },
    /** 返回可见实体的角色及世界包围盒，用于验收外部罩体和独立安装筒。 */
    getGeometrySnapshot() {
      return (currentObject?.children || []).filter((child) => child.isMesh).map((child) => {
        const bounds = new THREE.Box3().setFromObject(child);
        return { role: child.userData.surfaceRole, min: bounds.min.toArray(), max: bounds.max.toArray() };
      });
    },
    /** 返回相机、投影平移与边线状态的只读快照，供浏览器回归测试验证统一交互。 */
    getInteractionSnapshot() {
      camera.updateMatrixWorld();
      let fixedEnvelopeCount = 0, fixedEnvelopeOutlineCount = 0;
      const invalidFixedInstances = [];
      currentObject?.traverse((child) => {
        if (child.isMesh && child.userData.surfaceRole === 'fixed-envelope' && child.userData.constraintInvalid) invalidFixedInstances.push({
          instance_id: child.userData.instanceId, color: child.material.color.getHex() });
        if (child.userData.surfaceRole !== 'fixed-envelope' || !child.visible) return;
        if (child.isMesh && child.material.transparent) fixedEnvelopeCount += 1;
        if (child.isLineSegments) fixedEnvelopeOutlineCount += 1;
      });
      const depthBounds = contentBounds.clone().applyMatrix4(camera.matrixWorldInverse);
      const projectedBounds = new THREE.Box3();
      if (!contentBounds.isEmpty()) {
        for (const x of [contentBounds.min.x, contentBounds.max.x]) {
          for (const y of [contentBounds.min.y, contentBounds.max.y]) {
            for (const z of [contentBounds.min.z, contentBounds.max.z]) {
              projectedBounds.expandByPoint(new THREE.Vector3(x, y, z).project(camera));
            }
          }
        }
      }
      return {
        cameraPosition: camera.position.toArray(),
        cameraUp: camera.up.toArray(),
        target: controls.target.toArray(),
        cameraNear: camera.near,
        cameraFar: camera.far,
        contentDepthRange: contentBounds.isEmpty() ? null : [-depthBounds.max.z, -depthBounds.min.z],
        contentProjectedBounds: projectedBounds.isEmpty() ? null : { min: projectedBounds.min.toArray(), max: projectedBounds.max.toArray() },
        panOffset: panOffset.toArray(),
        viewOffsetEnabled: Boolean(camera.view?.enabled),
        topologyEdgesVisible,
        fairingEdges: currentFairingEdges?.snapshot() ?? null,
        layoutGeometry: layoutGeometryCache.snapshot(),
        rendererBackend: renderer.backendName,
        rendererGeometryCount: renderer.renderer?.info?.memory?.geometries ?? null,
        layoutCandidateId: currentObject?.children.find((child) => child.userData.layoutCandidate)
          ?.userData.layoutCandidate.candidate_id ?? null,
        layoutPlacements: currentObject?.children.find((child) => child.userData.layoutCandidate)?.children
          .filter((child) => child.userData.instanceId).map((child) => ({
            instanceId: child.userData.instanceId, fixed: child.userData.fixed, color: child.material.color.getHex(),
            matrix: child.matrix.elements.slice(),
          })) ?? [],
        fixedCandidate: currentObject?.children.find((child) => child.userData.fixedCandidate)?.userData.fixedCandidate ?? null,
        fixedEnvelopeCount, fixedEnvelopeOutlineCount,
        invalidFixedInstances,
        fixedPayloadBuilds, fixedPoseUpdates, fixedGizmo: fixedGizmo.snapshot(),
        layoutPayloadCount: currentObject?.children.find((child) => child.userData.layoutCandidate)
          ?.children.filter((child) => child.userData.instanceId).length ?? 0,
      };
    },
  };
}
