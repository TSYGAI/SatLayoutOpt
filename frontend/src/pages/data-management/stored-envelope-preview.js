/**
 * 文件说明：数据管理页的固化包络三维预览，在独立画布中显示已存储记录的安全包络外壳。
 * 保留最近固化记录的 GLB 字节和视角；控制器不参与包络生成、模型设置或上传页的渲染状态。
 * 包络材质和色彩输出复用布局优化样式，拓扑边线默认关闭；画布跟随全局主题，可在面板与大窗之间移动。
 */

import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';

import { getLayoutPreviewConfig, getModulePreviewConfig, getStoredEnvelopePreview } from '../../api/model-upload-api.js';
import {
  configureEnvelopeRenderer, createEnvelopeSurfaceMaterial, createEnvelopeEdgeMaterial,
  resolveEnvelopeScenePalette, createEnvelopeLights, applyEnvelopeLightTheme,
} from '../../components/envelope-preview-appearance.js';
import { disposeOrbitControls } from '../../components/orbit-controls-lifecycle.js';
import { PreviewRenderer } from '../../components/preview-renderer.js';
import { getCurrentTheme } from '../../theme/theme.js';
import { readPageSession, writePageSession } from '../../app/page-session-state.js';
import { createPreviewViewMemory } from '../../components/preview-view-memory.js';

/**
 * 返回指定主题对应的画布配色，未知主题按深色处理。
 * @param {string} [theme] 主题名，缺省读取当前生效主题。
 * @returns {object} 与布局优化共用的背景与灯光参数。
 */
export function resolveScenePalette(theme = getCurrentTheme()) {
  return resolveEnvelopeScenePalette(theme);
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
 * @param {THREE.Vector3} [center] 包围盒中心在旋转目标坐标系中的位置，缺省为原点。
 * @returns {number} 含边缘留白的观察距离。
 */
export function calculatePreviewDistance(size, direction, verticalFov, aspect, center = new THREE.Vector3()) {
  const backward = direction.clone().normalize();
  const right = new THREE.Vector3().crossVectors(new THREE.Vector3(0, 1, 0), backward).normalize();
  const up = new THREE.Vector3().crossVectors(backward, right);
  const verticalTangent = Math.tan(THREE.MathUtils.degToRad(verticalFov / 2));
  const horizontalTangent = verticalTangent * aspect;
  let distance = 0;
  for (const x of [-size.x / 2, size.x / 2]) {
    for (const y of [-size.y / 2, size.y / 2]) {
      for (const z of [-size.z / 2, size.z / 2]) {
        const corner = new THREE.Vector3(center.x + x, center.y + y, center.z + z);
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
 * @returns {{ readonly container: HTMLElement, show: (recordId: string, signal?: AbortSignal) => Promise<void>, clear: () => void, fitView: () => void, setTopologyEdgesVisible: (visible: boolean) => boolean, toggleTopologyEdges: () => boolean, setContainer: (target: HTMLElement) => void, dispose: () => void }} 预览控制接口。
 */
export function createStoredEnvelopePreview({ container }) {
  const renderer = new PreviewRenderer({ antialias: true, alpha: false });
  configureEnvelopeRenderer(renderer);
  renderer.setPixelRatio(1);
  renderer.setSize(container.clientWidth || 1, container.clientHeight || 1, false);
  renderer.domElement.setAttribute('aria-label', '固化包络三维预览画布');
  container.appendChild(renderer.domElement);

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(currentPalette().background);
  const camera = new THREE.PerspectiveCamera(42, 1, 0.1, 100000);
  camera.position.set(1.6, 1.2, 1.9);
  const controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = false;
  controls.enablePan = false;
  controls.minDistance = 0.01;
  controls.maxDistance = 100000;

  const lights = createEnvelopeLights(getCurrentTheme());
  scene.add(...Object.values(lights));

  const root = new THREE.Group();
  scene.add(root);

  let currentObject = null;
  let currentRecordId = null;
  let showVersion = 0;
  const panOffset = new THREE.Vector2();
  const panLastPosition = new THREE.Vector2();
  let panPointerId = null;
  const currentBounds = new THREE.Box3();
  const viewMemory = createPreviewViewMemory('stored-envelope', { camera, controls, panOffset, version: 4 });
  let currentEdgeObjects = [];
  let topologyEdgesVisible = false;
  let disposed = false;
  let animationFrame = null;
  let renderQueued = false;
  const resizeObserver = new ResizeObserver(() => resize());

  /** 将右键拖动产生的投影平移应用到相机，不改写 OrbitControls 的旋转目标。 */
  function applyPreviewPan() {
    const width = Math.max(container.clientWidth, 1);
    const height = Math.max(container.clientHeight, 1);
    if (panOffset.lengthSq() < 1e-8) {
      camera.clearViewOffset();
      return;
    }
    camera.setViewOffset(width, height, panOffset.x, panOffset.y, width, height);
  }

  /** 清除投影平移，恢复当前旋转目标下的初始构图。 */
  function resetPreviewPan() {
    panOffset.set(0, 0);
    camera.clearViewOffset();
  }

  /** 开始右键平移并阻止 OrbitControls 把平移误处理为旋转中心变化。 */
  function startPreviewPan(event) {
    if (event.button !== 2 || panPointerId !== null) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    panPointerId = event.pointerId;
    panLastPosition.set(event.clientX, event.clientY);
    renderer.domElement.setPointerCapture(event.pointerId);
  }

  /** 按右键拖动距离更新投影偏移，保持旋转中心和前几个页面一致。 */
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

  /** 结束右键平移并释放指针捕获。 */
  function finishPreviewPan(event) {
    if (event.pointerId !== panPointerId) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    panPointerId = null;
    if (renderer.domElement.hasPointerCapture(event.pointerId)) {
      renderer.domElement.releasePointerCapture(event.pointerId);
    }
  }

  /** 屏蔽右键菜单，保留右键拖动平移操作。 */
  function preventPreviewContextMenu(event) {
    event.preventDefault();
  }

  /** 根据当前包络和画布比例计算适配视图距离，用于窗口尺寸变化时保留缩放倍率。 */
  function getFitDistance(aspect) {
    if (currentBounds.isEmpty()) return null;
    return calculatePreviewDistance(
      currentBounds.getSize(new THREE.Vector3()),
      new THREE.Vector3(0.85, 0.6, 0.95).normalize(),
      camera.fov,
      aspect,
    );
  }

  /** 按容器尺寸同步投影但保留用户视角；首次加载和显式复位由 fitView 负责取景。 */
  function resize() {
    const width = container.clientWidth || 1;
    const height = container.clientHeight || 1;
    const previousFitDistance = getFitDistance(camera.aspect);
    renderer.setSize(width, height, false);
    camera.aspect = width / height;
    if (currentObject && previousFitDistance) {
      const nextFitDistance = getFitDistance(camera.aspect);
      if (nextFitDistance) {
        camera.position.sub(controls.target).multiplyScalar(nextFitDistance / previousFitDistance).add(controls.target);
      }
    }
    camera.updateProjectionMatrix();
    applyPreviewPan();
    requestRender();
  }

  /** 切换画布容器并同步尺寸；保留模型、相机和控件事件，调用方须先显示目标容器。 */
  function setContainer(target) {
    if (disposed || target === container) return;
    resizeObserver.unobserve(container);
    container = target;
    container.appendChild(renderer.domElement);
    resizeObserver.observe(container);
    resize();
  }

  /** 渲染一帧；交互和视图变化合并到浏览器帧，静止后停止占用 GPU。 */
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

  /** 释放加载器临时场景或显示对象的几何与材质，不持有任何资源引用。 */
  function releaseObject(object) {
    object.traverse((child) => {
      child.geometry?.dispose?.();
      if (Array.isArray(child.material)) child.material.forEach((material) => material.dispose?.());
      else child.material?.dispose?.();
    });
  }

  /** 释放当前包络的拓扑边线对象与材质，恢复为仅表面显示。 */
  function clearTopologyEdgeObjects() {
    currentEdgeObjects.forEach((edge) => {
      edge.removeFromParent();
      releaseObject(edge);
    });
    currentEdgeObjects = [];
  }

  /** 按优化页相同的折角规则生成轮廓，并挂到所属网格以保持位姿和深度一致。 */
  function createTopologyEdgeObjects() {
    if (!currentObject) return;
    const meshes = [];
    currentObject.traverse((child) => {
      if (child.isMesh) meshes.push(child);
    });
    for (const mesh of meshes) {
      const edgeGeometry = new THREE.EdgesGeometry(mesh.geometry);
      const edge = new THREE.LineSegments(edgeGeometry, createEnvelopeEdgeMaterial(mesh.material.color));
      mesh.add(edge);
      currentEdgeObjects.push(edge);
    }
  }

  /** 设置包络拓扑边线显示状态；返回最终状态，关闭时立即释放边线几何。 */
  function setTopologyEdgesVisible(visible) {
    if (!currentObject) {
      topologyEdgesVisible = false;
      return false;
    }
    const next = Boolean(visible);
    if (next === topologyEdgesVisible && (!next || currentEdgeObjects.length)) return next;
    if (next) createTopologyEdgeObjects();
    else clearTopologyEdgeObjects();
    topologyEdgesVisible = next;
    requestRender();
    return topologyEdgesVisible;
  }

  /** 切换包络拓扑边线显示状态；只影响当前固化预览。 */
  function toggleTopologyEdges() {
    return setTopologyEdgesVisible(!topologyEdgesVisible);
  }

  /** 释放当前显示的几何与材质，避免切换记录时泄漏 GPU 资源。 */
  function disposeCurrent() {
    if (!currentObject) return;
    root.remove(currentObject);
    releaseObject(currentObject);
    currentObject = null;
    currentBounds.makeEmpty();
    resetPreviewPan();
    currentEdgeObjects = [];
    topologyEdgesVisible = false;
  }

  /**
   * 把当前主题应用到画布背景和灯光；包络与轮廓继续使用共享的布局配色。
   * 已经加载的包络网格与相机位置保持不变，切换主题不需要重新请求资源。
   */
  function applyTheme() {
    const palette = currentPalette();
    scene.background.setHex(palette.background);
    applyEnvelopeLightTheme(lights, getCurrentTheme());
    requestRender();
  }

  /** 按包络包围盒中心适配相机；模型保持原坐标，旋转目标固定为包络中心。 */
  function fitView() {
    if (!currentObject) return;
    root.position.set(0, 0, 0);
    root.updateMatrixWorld(true);
    const box = new THREE.Box3().setFromObject(currentObject);
    if (box.isEmpty()) return;
    currentBounds.copy(box);
    const size = box.getSize(new THREE.Vector3());
    const center = box.getCenter(new THREE.Vector3());
    const direction = new THREE.Vector3(0.85, 0.6, 0.95).normalize();
    const distance = calculatePreviewDistance(size, direction, camera.fov, camera.aspect);
    controls.target.copy(center);
    camera.position.copy(center).addScaledVector(direction, distance);
    resetPreviewPan();
    camera.near = Math.max(distance / 500, 0.01);
    camera.far = distance * 60;
    camera.updateProjectionMatrix();
    controls.update();
    requestRender();
  }

  /** 解析固化包络 GLB，按优化页配置显示外壳并保持边线关闭；加载取消或过期时丢弃结果。 */
  async function show(recordId, signal) {
    const version = ++showVersion;
    setTopologyEdgesVisible(false);
    const cached = readPageSession('data-management', 'previewBytes');
    const [buffer, style, budgets] = await Promise.all([
      cached?.recordId === recordId ? cached.buffer : getStoredEnvelopePreview(recordId, signal),
      getLayoutPreviewConfig(),
      getModulePreviewConfig(),
    ]);
    if (disposed || signal?.aborted || version !== showVersion) return;
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, budgets.dataManagementPixelRatioCap));
    writePageSession('data-management', 'previewBytes', buffer.byteLength <= budgets.dataManagementCacheMaxBytes ? { recordId, buffer } : null);
    const { GLTFLoader } = await import('three/addons/loaders/GLTFLoader.js');
    const gltf = await new GLTFLoader().parseAsync(buffer, '');
    if (disposed || signal?.aborted || version !== showVersion) {
      releaseObject(gltf.scene);
      return;
    }
    const group = new THREE.Group();
    gltf.scene.traverse((child) => {
      if (!child.isMesh || !child.geometry) return;
      const geometry = child.geometry.clone();
      geometry.computeVertexNormals();
      group.add(new THREE.Mesh(geometry, createEnvelopeSurfaceMaterial(style.optimizedColor, style.opacity)));
    });
    releaseObject(gltf.scene);
    if (currentObject) viewMemory.save(currentRecordId);
    disposeCurrent();
    currentObject = group;
    currentRecordId = recordId;
    root.add(group);
    fitView();
    viewMemory.restore(currentRecordId);
  }

  /** 清空当前显示内容并保留渲染器。 */
  function clear() {
    showVersion += 1;
    disposeCurrent();
    topologyEdgesVisible = false;
    requestRender();
  }

  /** 释放渲染器、WebGL 上下文、控制器与全部几何资源。 */
  function dispose() {
    if (disposed) return;
    if (currentObject) viewMemory.save(currentRecordId);
    disposed = true;
    window.removeEventListener('sat-layout-theme-change', handleThemeChange);
    resizeObserver.disconnect();
    if (animationFrame !== null) window.cancelAnimationFrame(animationFrame);
    renderQueued = false;
    clear();
    renderer.domElement.removeEventListener('pointerdown', startPreviewPan, true);
    renderer.domElement.removeEventListener('pointermove', movePreviewPan, true);
    renderer.domElement.removeEventListener('pointerup', finishPreviewPan, true);
    renderer.domElement.removeEventListener('pointercancel', finishPreviewPan, true);
    renderer.domElement.removeEventListener('contextmenu', preventPreviewContextMenu);
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
  renderer.domElement.addEventListener('pointerdown', startPreviewPan, true);
  renderer.domElement.addEventListener('pointermove', movePreviewPan, true);
  renderer.domElement.addEventListener('pointerup', finishPreviewPan, true);
  renderer.domElement.addEventListener('pointercancel', finishPreviewPan, true);
  renderer.domElement.addEventListener('contextmenu', preventPreviewContextMenu);
  resizeObserver.observe(container);
  resize();
  requestRender();
  return {
    /** 返回当前承载画布的容器，供调用方检查挂载状态。 */
    get container() { return container; },
    show, clear, fitView, setTopologyEdgesVisible, toggleTopologyEdges, setContainer, dispose,
  };
}
