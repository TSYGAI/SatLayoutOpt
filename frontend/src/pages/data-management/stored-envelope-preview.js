/**
 * 文件说明：数据管理页的固化包络三维预览，在独立画布中显示已存储记录的安全包络外壳。
 * 控制器只读取固化记录的浏览 GLB，不参与包络生成、模型设置或上传页的渲染状态。
 * 画布配色跟随全局主题，相机按画布宽高比适配包络，提供独立的视图复位入口。
 */

import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';

import { getStoredEnvelopePreview } from '../../api/model-upload-api.js';
import { disposeOrbitControls } from '../../components/orbit-controls-lifecycle.js';
import { getCurrentTheme } from '../../theme/theme.js';

/**
 * 按主题定义的画布配色。
 * 深色保持青色外壳与暗底；浅色改为浅灰底，并把边线压深以保证半透明外壳上的对比度。
 */
const SCENE_PALETTES = Object.freeze({
  dark: {
    background: 0x0a1219,
    edge: 0x0a2b36,
    edgeOpacity: 0.55,
    hemisphereSky: 0xbfe8ff,
    hemisphereGround: 0x0d1720,
    keyIntensity: 1.35,
    rimIntensity: 0.55,
  },
  light: {
    background: 0xeef3f7,
    edge: 0x1d5b6e,
    edgeOpacity: 0.85,
    hemisphereSky: 0xffffff,
    hemisphereGround: 0x9db4c4,
    keyIntensity: 1.05,
    rimIntensity: 0.35,
  },
});

/** 安全包络半透明外壳的填充色，深色与浅色主题共用。 */
const ENVELOPE_COLOR = 0x39d0e9;

/**
 * 返回指定主题对应的画布配色，未知主题按深色处理。
 * @param {string} [theme] 主题名，缺省读取当前生效主题。
 * @returns {typeof SCENE_PALETTES.dark} 背景、边线与灯光参数。
 */
export function resolveScenePalette(theme = getCurrentTheme()) {
  return SCENE_PALETTES[theme] || SCENE_PALETTES.dark;
}

/** 返回当前主题对应的画布配色。 */
function currentPalette() {
  return resolveScenePalette();
}

/**
 * 根据包围盒八个角点在观察方向上的投影计算相机距离，避免窄画布裁切或宽画布留白过多。
 * @param {THREE.Vector3} size 模型包围盒尺寸。
 * @param {THREE.Vector3} direction 从目标指向相机的方向，不要求单位化。
 * @param {number} verticalFov 相机垂直视场角，单位为度。
 * @param {number} aspect 画布宽高比。
 * @returns {number} 含边缘留白的观察距离。
 */
export function calculatePreviewDistance(size, direction, verticalFov, aspect) {
  const backward = direction.clone().normalize();
  const right = new THREE.Vector3().crossVectors(new THREE.Vector3(0, 1, 0), backward).normalize();
  const up = new THREE.Vector3().crossVectors(backward, right);
  const verticalTangent = Math.tan(THREE.MathUtils.degToRad(verticalFov / 2));
  const horizontalTangent = verticalTangent * aspect;
  let distance = 0;
  for (const x of [-size.x / 2, size.x / 2]) {
    for (const y of [-size.y / 2, size.y / 2]) {
      for (const z of [-size.z / 2, size.z / 2]) {
        const corner = new THREE.Vector3(x, y, z);
        const depth = corner.dot(backward);
        distance = Math.max(distance,
          depth + Math.abs(corner.dot(right)) / horizontalTangent,
          depth + Math.abs(corner.dot(up)) / verticalTangent);
      }
    }
  }
  return distance > 0 ? distance * 1.15 : 1;
}

/**
 * 创建固化包络预览控制器。
 * @param {{ container: HTMLElement }} options 画布容器。
 * @returns {{ container: HTMLElement, show: (recordId: string, signal?: AbortSignal) => Promise<void>, clear: () => void, fitView: () => void, dispose: () => void }} 预览控制接口。
 */
export function createStoredEnvelopePreview({ container }) {
  const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.5));
  renderer.setSize(container.clientWidth || 1, container.clientHeight || 1, false);
  renderer.domElement.setAttribute('aria-label', '固化包络三维预览画布');
  container.appendChild(renderer.domElement);

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(currentPalette().background);
  const camera = new THREE.PerspectiveCamera(42, 1, 0.1, 100000);
  camera.position.set(1.6, 1.2, 1.9);
  const controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;
  controls.dampingFactor = 0.08;

  const initialPalette = currentPalette();
  const hemisphereLight = new THREE.HemisphereLight(
    initialPalette.hemisphereSky, initialPalette.hemisphereGround, 1.5,
  );
  const keyLight = new THREE.DirectionalLight(0xffffff, initialPalette.keyIntensity);
  keyLight.position.set(1.4, 2.0, 1.2);
  const rimLight = new THREE.DirectionalLight(0x4fb6d8, initialPalette.rimIntensity);
  rimLight.position.set(-1.6, -0.6, -1.4);
  scene.add(hemisphereLight, keyLight, rimLight);

  const root = new THREE.Group();
  scene.add(root);

  let currentObject = null;
  let currentEdgeMaterials = [];
  let disposed = false;
  let animationFrame = null;
  let renderQueued = false;
  const resizeObserver = new ResizeObserver(() => resize());

  /** 按容器尺寸同步渲染器与相机比例。 */
  function resize() {
    const width = container.clientWidth || 1;
    const height = container.clientHeight || 1;
    renderer.setSize(width, height, false);
    camera.aspect = width / height;
    camera.updateProjectionMatrix();
    fitView();
  }

  /** 渲染一帧；阻尼仍在改变相机时继续调度，静止后停止占用 GPU。 */
  function renderFrame() {
    animationFrame = null;
    renderQueued = false;
    if (disposed) return;
    const cameraChanged = controls.update();
    renderer.render(scene, camera);
    if (cameraChanged) requestRender();
  }

  /** 合并同一浏览器帧中的重复绘制请求。 */
  function requestRender() {
    if (disposed || renderQueued) return;
    renderQueued = true;
    animationFrame = window.requestAnimationFrame(renderFrame);
  }

  /** 释放当前显示的几何与材质，避免切换记录时泄漏 GPU 资源。 */
  function disposeCurrent() {
    if (!currentObject) return;
    root.remove(currentObject);
    currentObject.traverse((child) => {
      child.geometry?.dispose?.();
      if (Array.isArray(child.material)) child.material.forEach((material) => material.dispose?.());
      else child.material?.dispose?.();
    });
    currentObject = null;
    currentEdgeMaterials = [];
  }

  /**
   * 把当前主题应用到画布背景、灯光和已有边线材质。
   * 已经加载的包络网格与相机位置保持不变，切换主题不需要重新请求资源。
   */
  function applyTheme() {
    const palette = currentPalette();
    scene.background.setHex(palette.background);
    hemisphereLight.color.setHex(palette.hemisphereSky);
    hemisphereLight.groundColor.setHex(palette.hemisphereGround);
    keyLight.intensity = palette.keyIntensity;
    rimLight.intensity = palette.rimIntensity;
    currentEdgeMaterials.forEach((material) => {
      material.color.setHex(palette.edge);
      material.opacity = palette.edgeOpacity;
    });
    requestRender();
  }

  /** 重置模型居中位置并按画布比例适配相机，多次调用保持同一视图且不累积平移。 */
  function fitView() {
    if (!currentObject) return;
    root.position.set(0, 0, 0);
    root.updateMatrixWorld(true);
    const box = new THREE.Box3().setFromObject(currentObject);
    if (box.isEmpty()) return;
    const size = box.getSize(new THREE.Vector3());
    const center = box.getCenter(new THREE.Vector3());
    const direction = new THREE.Vector3(0.85, 0.6, 0.95).normalize();
    const distance = calculatePreviewDistance(size, direction, camera.fov, camera.aspect);
    root.position.set(-center.x, -center.y, -center.z);
    controls.target.set(0, 0, 0);
    camera.position.copy(direction.multiplyScalar(distance));
    camera.near = Math.max(distance / 500, 0.01);
    camera.far = distance * 60;
    camera.updateProjectionMatrix();
    controls.update();
    requestRender();
  }

  /** 解析固化包络 GLB 并显示为半透明外壳与边线。 */
  async function show(recordId, signal) {
    const buffer = await getStoredEnvelopePreview(recordId, signal);
    const { GLTFLoader } = await import('three/addons/loaders/GLTFLoader.js');
    const gltf = await new GLTFLoader().parseAsync(buffer, '');
    const palette = currentPalette();
    const group = new THREE.Group();
    const edgeMaterials = [];
    gltf.scene.traverse((child) => {
      if (!child.isMesh || !child.geometry) return;
      const geometry = child.geometry.clone();
      geometry.computeVertexNormals();
      group.add(new THREE.Mesh(geometry, new THREE.MeshStandardMaterial({
        color: ENVELOPE_COLOR,
        transparent: true,
        opacity: 0.24,
        roughness: 0.42,
        metalness: 0.05,
        // 固化包络只显示外侧面，避免半透明背面形成内部交叉面片。
        side: THREE.FrontSide,
        depthWrite: false,
      })));
      const edgeMaterial = new THREE.LineBasicMaterial({
        color: palette.edge,
        transparent: true,
        opacity: palette.edgeOpacity,
      });
      group.add(new THREE.LineSegments(new THREE.EdgesGeometry(geometry, 32), edgeMaterial));
      edgeMaterials.push(edgeMaterial);
    });
    if (disposed) return;
    disposeCurrent();
    currentObject = group;
    currentEdgeMaterials = edgeMaterials;
    root.add(group);
    fitView();
  }

  /** 清空当前显示内容并保留渲染器。 */
  function clear() {
    disposeCurrent();
    requestRender();
  }

  /** 释放渲染器、WebGL 上下文、控制器与全部几何资源。 */
  function dispose() {
    if (disposed) return;
    disposed = true;
    window.removeEventListener('sat-layout-theme-change', handleThemeChange);
    resizeObserver.disconnect();
    if (animationFrame !== null) window.cancelAnimationFrame(animationFrame);
    renderQueued = false;
    clear();
    controls.removeEventListener('change', requestRender);
    disposeOrbitControls(controls);
    renderer.dispose();
    renderer.forceContextLoss();
    renderer.domElement.remove();
  }

  /** 在主题切换事件中同步画布配色；控制器释放后不再响应。 */
  function handleThemeChange() {
    if (!disposed) applyTheme();
  }

  window.addEventListener('sat-layout-theme-change', handleThemeChange);
  controls.addEventListener('change', requestRender);
  resizeObserver.observe(container);
  resize();
  requestRender();
  return { container, show, clear, fitView, dispose };
}
