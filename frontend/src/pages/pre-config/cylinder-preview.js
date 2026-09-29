/**
 * 文件说明：前置配置页的自定义圆柱三维预览控制器，在独立画布中按真实尺寸显示整流舱段、中轴与整流罩内壁边界。
 * 场景以 Z 轴为上，与后端约定一致：圆柱中轴与 Z 轴重合，整体抬升到 z ≥ 0 的上半空间，底面贴合 z = 0 水平面。
 * 预览与模型上传、模型设置共享左右键、缩放、方向立方体与边线操作；裁剪范围随相机移动更新，取景忽略辅助坐标轴。
 * 本模块只做本地几何渲染，可展示布局服务传入的正式包络快照；不请求后端资源，不参与算法或固化流程。
 */

import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';

import { getCurrentTheme } from '../../theme/theme.js';
import { createCoordinateAxes, setCoordinateAxesSize } from '../../components/coordinate-axes.js';
import { disposeOrbitControls } from '../../components/orbit-controls-lifecycle.js';
import { createOrientationGizmo } from '../../components/orientation-gizmo.js';
import { createLayoutPlacementObjects } from '../../components/layout-placement-objects.js';

/**
 * 圆柱预览的明暗主题调色板。
 * 深色沿用工作台原有青色高亮；亮色改用深青主体与浅灰背景，保证在浅色画布上仍然清晰。
 * `axis` 与 `axisEdge` 是内嵌中轴（中心杆）的独立配色，与外壳明显区分。
 */
const SCENE_PALETTES = {
  dark: {
    background: 0x030609,
    body: 0x39d0e9,
    edge: 0x0a2b36,
    axis: 0xffb45c,
    axisEdge: 0x4a2f0d,
    fairingBoundary: 0x9bd9e6,
    fairingBoundaryEdge: 0xc7f3fa,
    gridMajor: 0x1d3b4a,
    gridMinor: 0x12242e,
    gridOpacity: 0.5,
    hemisphere: { sky: 0xbfe8ff, ground: 0x0d1720, intensity: 1.5 },
    rim: { color: 0x4fb6d8, intensity: 0.5 },
  },
  light: {
    background: 0xe8eef3,
    body: 0x0f7d99,
    edge: 0x2c3f4b,
    axis: 0xc4761a,
    axisEdge: 0x5c3607,
    fairingBoundary: 0x4f8296,
    fairingBoundaryEdge: 0x315b6c,
    gridMajor: 0x9fb2c0,
    gridMinor: 0xcbd8e1,
    gridOpacity: 0.75,
    hemisphere: { sky: 0xffffff, ground: 0xd7e2ea, intensity: 1.6 },
    rim: { color: 0x4f7f96, intensity: 0.45 },
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
 * @param {{ container: HTMLElement, orientationGizmoContainer?: HTMLElement|null }} options 主画布与可选方向立方体容器。
 * @returns {{
 *   show: (geometry: { radius: number, height: number, radialSegments: number, axisRadius?: number, fairingRadius?: number }) => void,
 *   toggleTopologyEdges: () => boolean,
 *   clear: () => void,
 *   fitView: () => void,
 *   applySceneTheme: () => void,
 *   dispose: () => void,
 * }} 预览控制接口，`show` 会用新尺寸整体替换当前圆柱。
 */
export function createCylinderPreview({ container, orientationGizmoContainer = null }) {
  const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false, powerPreference: 'high-performance' });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.5));
  renderer.setSize(container.clientWidth || 1, container.clientHeight || 1, false);
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.05;
  renderer.domElement.setAttribute('aria-label', '自定义圆柱三维预览画布');
  container.appendChild(renderer.domElement);

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x030609);
  const camera = new THREE.PerspectiveCamera(42, 1, 0.1, 1e7);
  camera.up.set(...SCENE_UP);
  camera.position.set(1.4, -1.4, 1.6);

  const controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = false;
  controls.enablePan = false;
  controls.minDistance = 0.01;
  controls.maxDistance = 10000000;

  const hemisphereLight = new THREE.HemisphereLight(0xbfe8ff, 0x0d1720, 1.5);
  scene.add(hemisphereLight);
  const keyLight = new THREE.DirectionalLight(0xffffff, 1.3);
  keyLight.position.set(1.4, 2.0, 1.2);
  scene.add(keyLight);
  const rimLight = new THREE.DirectionalLight(0x4fb6d8, 0.5);
  rimLight.position.set(-1.6, -0.6, -1.4);
  scene.add(rimLight);

  // 地面网格按圆柱尺寸缩放；坐标系固定在原点并使用与模型上传页一致的世界坐标系实现。
  const gridGroup = new THREE.Group();
  scene.add(gridGroup);
  const axes = createCoordinateAxes({ name: 'CYLINDER_ORIGIN_AXES' });
  scene.add(axes);
  const cylinderGroup = new THREE.Group();
  scene.add(cylinderGroup);

  let currentObject = null;
  let currentFairingInnerRadius = null;
  let currentSpan = MINIMUM_SCENE_SPAN;
  let contentBounds = new THREE.Box3();
  const contentSphere = new THREE.Sphere(new THREE.Vector3(), MINIMUM_SCENE_SPAN);
  let activeTheme = getCurrentTheme();
  let topologyEdgesVisible = true;
  let disposed = false;
  let renderQueued = false;
  let animationFrame = null;
  let orientationGizmo = null;
  const identityQuaternion = new THREE.Quaternion();
  const panOffset = new THREE.Vector2();
  const panLastPosition = new THREE.Vector2();
  let panPointerId = null;
  const resizeObserver = new ResizeObserver(() => resize());

  /** 返回当前主题对应的调色板，未知主题回退到深色。 */
  function getPalette() {
    return SCENE_PALETTES[activeTheme] || SCENE_PALETTES.dark;
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

  /** 将右键拖动产生的像素偏移应用到相机投影，不改变世界原点旋转中心。 */
  function applyPreviewPan() {
    const width = Math.max(renderer.domElement.clientWidth, 1);
    const height = Math.max(renderer.domElement.clientHeight, 1);
    if (panOffset.lengthSq() < 1e-8) {
      camera.clearViewOffset();
      return;
    }
    camera.setViewOffset(width, height, panOffset.x, panOffset.y, width, height);
  }

  /** 清除投影平移，使构件画面重新居中。 */
  function resetPreviewPan() {
    panOffset.set(0, 0);
    camera.clearViewOffset();
  }

  /** 开始右键投影平移，并阻止 OrbitControls 改写旋转中心。 */
  function startPreviewPan(event) {
    if (event.button !== 2 || panPointerId !== null) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    panPointerId = event.pointerId;
    panLastPosition.set(event.clientX, event.clientY);
    renderer.domElement.setPointerCapture(event.pointerId);
  }

  /** 按右键拖动距离更新画面投影偏移。 */
  function movePreviewPan(event) {
    if (event.pointerId !== panPointerId) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    const deltaX = event.clientX - panLastPosition.x;
    const deltaY = event.clientY - panLastPosition.y;
    panLastPosition.set(event.clientX, event.clientY);
    panOffset.x -= deltaX;
    panOffset.y -= deltaY;
    applyPreviewPan();
    requestRender();
  }

  /** 结束右键投影平移并释放指针捕获。 */
  function finishPreviewPan(event) {
    if (event.pointerId !== panPointerId) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    panPointerId = null;
    if (renderer.domElement.hasPointerCapture(event.pointerId)) {
      renderer.domElement.releasePointerCapture(event.pointerId);
    }
  }

  /** 屏蔽预览画布右键菜单，保留右键拖动平移。 */
  function preventPreviewContextMenu(event) {
    event.preventDefault();
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
      child.geometry?.dispose?.();
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
    hemisphereLight.color.setHex(palette.hemisphere.sky);
    hemisphereLight.groundColor.setHex(palette.hemisphere.ground);
    hemisphereLight.intensity = palette.hemisphere.intensity;
    rimLight.color.setHex(palette.rim.color);
    rimLight.intensity = palette.rim.intensity;
    currentObject?.traverse((child) => {
      if (!child.material?.color) return;
      const role = child.userData?.surfaceRole;
      if (role === 'payload') return;
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

  /** 设置构件外壳和中轴边线是否显示，并返回最终状态。 */
  function setTopologyEdgesVisible(visible) {
    topologyEdgesVisible = Boolean(visible);
    currentObject?.traverse((child) => {
      if (child.isLineSegments && child.userData?.surfaceRole) child.visible = topologyEdgesVisible;
    });
    requestRender();
    return topologyEdgesVisible;
  }

  /** 切换构件表面边线，并返回切换后的显示状态。 */
  function toggleTopologyEdges() {
    return setTopologyEdgesVisible(!topologyEdgesVisible);
  }

  /**
   * 用给定尺寸、中轴半径与整流罩半径重建构件网格并适配视图。
   * 整流舱段半透明、中轴实心，整流罩内壁使用更轻的半透明侧壁和边线显示。
   * @param {{ radius: number, height: number, radialSegments: number, axisRadius?: number, fairingRadius?: number }} geometry
   *   圆柱尺寸、中轴半径与整流罩半径，长度单位为毫米。
   */
  function show(geometry) {
    if (disposed) return;
    const { positions, indices } = buildCylinderMesh(geometry);
    const bufferGeometry = new THREE.BufferGeometry();
    bufferGeometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    bufferGeometry.setIndex(new THREE.BufferAttribute(indices, 1));
    bufferGeometry.computeVertexNormals();

    const palette = getPalette();
    const group = new THREE.Group();
    // 外壳半透明且不写深度，使内嵌的中轴可见；同时写入正反两面，避免壳体出现缺口。
    const shellMesh = new THREE.Mesh(bufferGeometry, new THREE.MeshStandardMaterial({
      color: palette.body,
      transparent: true,
      opacity: 0.28,
      roughness: 0.42,
      metalness: 0.08,
      side: THREE.DoubleSide,
      depthWrite: false,
      flatShading: false,
    }));
    shellMesh.userData.surfaceRole = 'shell';
    group.add(shellMesh);
    const shellEdges = new THREE.LineSegments(
      new THREE.EdgesGeometry(bufferGeometry, 30),
      new THREE.LineBasicMaterial({ color: palette.edge, transparent: true, opacity: 0.7 }),
    );
    shellEdges.userData.surfaceRole = 'shell';
    group.add(shellEdges);

    const fairingHeight = geometry.fairingHeight ?? geometry.height;
    const fairingBoundary = buildFairingBoundaryMesh({ ...geometry, height: fairingHeight });
    if (fairingBoundary && fairingBoundary.radius > Number(geometry.radius)) {
      const boundaryGeometry = new THREE.BufferGeometry();
      boundaryGeometry.setAttribute('position', new THREE.BufferAttribute(fairingBoundary.positions, 3));
      boundaryGeometry.setIndex(new THREE.BufferAttribute(fairingBoundary.indices, 1));
      boundaryGeometry.computeVertexNormals();
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
      const boundaryEdges = new THREE.LineSegments(
        new THREE.EdgesGeometry(boundaryGeometry, 30),
        new THREE.LineBasicMaterial({
          color: palette.fairingBoundaryEdge,
          transparent: true,
          opacity: 0.82,
        }),
      );
      boundaryEdges.userData.surfaceRole = 'fairing-boundary';
      boundaryEdges.renderOrder = 2;
      group.add(boundaryEdges);
    }

    // 中轴（中心杆）：与外壳等长同轴，用独立的实心配色，必须先于外壳绘制，
    // 这样半透明外壳叠加在其上时仍能看清中轴本身。
    const axisRadius = Number(geometry.axisRadius);
    if (Number.isFinite(axisRadius) && axisRadius > 0 && axisRadius < geometry.radius) {
      const rod = buildCylinderMesh({
        radius: axisRadius,
        height: geometry.height,
        radialSegments: geometry.radialSegments,
      });
      const rodGeometry = new THREE.BufferGeometry();
      rodGeometry.setAttribute('position', new THREE.BufferAttribute(rod.positions, 3));
      rodGeometry.setIndex(new THREE.BufferAttribute(rod.indices, 1));
      rodGeometry.computeVertexNormals();
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

    clearCylinder();
    currentObject = group;
    currentFairingInnerRadius = fairingBoundary?.radius ?? null;
    cylinderGroup.add(group);
    group.updateMatrixWorld(true);
    const bounds = new THREE.Box3().setFromObject(group);
    group.position.z = resolveUpperHalfOffset(bounds);
    group.updateMatrixWorld(true);
    setTopologyEdgesVisible(topologyEdgesVisible);
    const span = Math.max((currentFairingInnerRadius ?? geometry.radius) * 2, geometry.height, MINIMUM_SCENE_SPAN);
    rebuildHelpers(span);
    fitView();
  }

  /** 显示后端布局的正式包络、罩体可用高度和整体质心；位姿使用底面 Z=0，不复制约束规则。 */
  function showLayout(candidate, meshes, radialSegments) {
    const payload = createLayoutPlacementObjects(candidate, meshes);
    show({ radius: candidate.radius_mm, height: candidate.height_mm, axisRadius: candidate.axis_radius_mm,
      fairingRadius: candidate.fairing_radius_mm, radialSegments });
    payload.userData.layoutCandidate = candidate;
    payload.position.z = -currentObject.position.z;
    currentObject.add(payload);
    setTopologyEdgesVisible(topologyEdgesVisible);
    fitView();
  }

  /** 清空圆柱网格但保留坐标系与渲染器。 */
  function clear() {
    clearCylinder();
    currentFairingInnerRadius = null;
    clearHelpers();
    requestRender();
  }

  /** 释放渲染器、WebGL 上下文、控制器与全部几何资源。 */
  function dispose() {
    if (disposed) return;
    disposed = true;
    resizeObserver.disconnect();
    window.removeEventListener('sat-layout-theme-change', applySceneTheme);
    if (animationFrame !== null) window.cancelAnimationFrame(animationFrame);
    renderer.domElement.removeEventListener('pointerdown', startPreviewPan, true);
    renderer.domElement.removeEventListener('pointermove', movePreviewPan, true);
    renderer.domElement.removeEventListener('pointerup', finishPreviewPan, true);
    renderer.domElement.removeEventListener('pointercancel', finishPreviewPan, true);
    renderer.domElement.removeEventListener('contextmenu', preventPreviewContextMenu);
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
  renderer.domElement.addEventListener('pointerdown', startPreviewPan, true);
  renderer.domElement.addEventListener('pointermove', movePreviewPan, true);
  renderer.domElement.addEventListener('pointerup', finishPreviewPan, true);
  renderer.domElement.addEventListener('pointercancel', finishPreviewPan, true);
  renderer.domElement.addEventListener('contextmenu', preventPreviewContextMenu);
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
    toggleTopologyEdges,
    clear,
    fitView,
    applySceneTheme,
    dispose,
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
    /** 返回相机、投影平移与边线状态的只读快照，供浏览器回归测试验证统一交互。 */
    getInteractionSnapshot() {
      camera.updateMatrixWorld();
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
        layoutCandidateId: currentObject?.children.find((child) => child.userData.layoutCandidate)
          ?.userData.layoutCandidate.candidate_id ?? null,
        layoutPayloadCount: currentObject?.children.find((child) => child.userData.layoutCandidate)
          ?.children.filter((child) => child.userData.instanceId).length ?? 0,
      };
    },
  };
}
