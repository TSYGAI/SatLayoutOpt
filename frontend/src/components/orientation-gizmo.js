/**
 * 文件说明：Three.js 方向立方体组件，独立渲染可点击的统一亮度方向立方体、三轴箭头和悬停面高亮。
 * 本组件不管理业务模型或主相机，仅接收主视图方向并通过回调通知宿主需要切换的局部朝向。
 */

import * as THREE from 'three';
import { ConvexGeometry } from 'three/addons/geometries/ConvexGeometry.js';
import { LineMaterial } from 'three/addons/lines/LineMaterial.js';
import { LineSegments2 } from 'three/addons/lines/LineSegments2.js';
import { LineSegmentsGeometry } from 'three/addons/lines/LineSegmentsGeometry.js';
import { COORDINATE_AXIS_COLORS } from './coordinate-axes.js';

const GIZMO_CAMERA_BOUND = 1.82;
const GIZMO_CAMERA_DISTANCE = 4;
const GIZMO_CUBE_RADIUS = 0.98;
const GIZMO_CUBE_BEVEL = 0.24;
const GIZMO_DEFAULT_PIXEL_RATIO = 2;

/** 创建方向立方体，并返回其渲染、尺寸同步和资源释放接口。 */
export function createOrientationGizmo(container, options) {
  const scene = new THREE.Scene();
  const camera = new THREE.OrthographicCamera(
    -GIZMO_CAMERA_BOUND,
    GIZMO_CAMERA_BOUND,
    GIZMO_CAMERA_BOUND,
    -GIZMO_CAMERA_BOUND,
    0.1,
    10,
  );
  const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, powerPreference: 'high-performance' });
  const pixelRatio = options.pixelRatio ?? GIZMO_DEFAULT_PIXEL_RATIO;
  renderer.setPixelRatio(pixelRatio);
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.3;
  renderer.domElement.setAttribute('aria-label', '模型预览方向立方体');
  container.append(renderer.domElement);

  const cubeGeometry = createBeveledCubeGeometry(GIZMO_CUBE_RADIUS, GIZMO_CUBE_BEVEL);
  // 方向立方体只表达方向，不承载真实材质信息；使用不受场景光照影响的基础材质，
  // 让六个主面保持同一亮度，避免朝向不同导致某些面变暗。
  const cube = new THREE.Mesh(cubeGeometry, new THREE.MeshBasicMaterial({
    color: '#e9e9e9',
    side: THREE.DoubleSide,
    toneMapped: false,
    polygonOffset: true,
    polygonOffsetFactor: 1,
    polygonOffsetUnits: 1,
  }));
  cube.name = 'ORIENTATION_CUBE';
  cube.add(createCubeEdges(cubeGeometry));
  scene.add(cube);

  const faceHighlight = new THREE.Mesh(new THREE.BufferGeometry(), new THREE.MeshBasicMaterial({
    color: '#5ab9ae',
    transparent: true,
    opacity: 0.42,
    depthTest: false,
    depthWrite: false,
    side: THREE.DoubleSide,
  }));
  faceHighlight.renderOrder = 2;
  faceHighlight.visible = false;
  scene.add(faceHighlight);

  addAxes(scene);
  scene.add(new THREE.HemisphereLight('#ffffff', '#68747a', 2.4));
  const keyLight = new THREE.DirectionalLight('#ffffff', 2.4);
  keyLight.position.set(2.6, 3.4, 4.2);
  const fillLight = new THREE.DirectionalLight('#b8cad2', 0.8);
  fillLight.position.set(-3, -1, 2);
  scene.add(keyLight, fillLight);

  const lastViewDirection = new THREE.Vector3(1, 1, 1);
  const lastContentQuaternion = new THREE.Quaternion();
  const lastCameraUp = new THREE.Vector3(0, 1, 0);
  const raycaster = new THREE.Raycaster();
  const pointer = new THREE.Vector2();
  let highlightedFaceKey = null;
  let disposed = false;

  /** 使用主相机状态更新方向立方体的朝向。 */
  function render(viewDirection, contentQuaternion, cameraUp) {
    if (disposed || viewDirection.lengthSq() < 1e-8) return;
    lastViewDirection.copy(viewDirection);
    lastContentQuaternion.copy(contentQuaternion);
    lastCameraUp.copy(cameraUp);
    scene.quaternion.copy(lastContentQuaternion);
    camera.position.copy(lastViewDirection).normalize().multiplyScalar(GIZMO_CAMERA_DISTANCE);
    camera.up.copy(lastCameraUp);
    camera.lookAt(0, 0, 0);
    renderer.render(scene, camera);
  }

  /** 以最近一次主视图状态重绘本控件。 */
  function renderLatestState() {
    render(lastViewDirection, lastContentQuaternion, lastCameraUp);
  }

  /** 根据鼠标位置拾取方向立方体表面。 */
  function getGizmoHit(event) {
    const bounds = renderer.domElement.getBoundingClientRect();
    pointer.set(
      ((event.clientX - bounds.left) / bounds.width) * 2 - 1,
      -((event.clientY - bounds.top) / bounds.height) * 2 + 1,
    );
    raycaster.setFromCamera(pointer, camera);
    return raycaster.intersectObject(cube, false)[0] ?? null;
  }

  /** 更新被悬停立方体面的半透明高亮层。 */
  function updateFaceHighlight(normal) {
    if (!normal) {
      if (highlightedFaceKey === null && !faceHighlight.visible) return;
      highlightedFaceKey = null;
      faceHighlight.visible = false;
      renderLatestState();
      return;
    }
    const targetNormal = normal.clone().normalize();
    const faceKey = targetNormal.toArray().map((value) => value.toFixed(3)).join(',');
    if (faceKey === highlightedFaceKey) return;
    highlightedFaceKey = faceKey;
    const positions = cubeGeometry.getAttribute('position');
    const normals = cubeGeometry.getAttribute('normal');
    const highlightedPositions = [];
    for (let vertex = 0; vertex < positions.count; vertex += 3) {
      const normalX = normals.getX(vertex);
      const normalY = normals.getY(vertex);
      const normalZ = normals.getZ(vertex);
      if (normalX * targetNormal.x + normalY * targetNormal.y + normalZ * targetNormal.z < 0.999) continue;
      for (let offset = 0; offset < 3; offset += 1) {
        highlightedPositions.push(
          positions.getX(vertex + offset),
          positions.getY(vertex + offset),
          positions.getZ(vertex + offset),
        );
      }
    }
    faceHighlight.geometry.dispose();
    faceHighlight.geometry = new THREE.BufferGeometry().setAttribute('position', new THREE.Float32BufferAttribute(highlightedPositions, 3));
    faceHighlight.visible = highlightedPositions.length > 0;
    renderLatestState();
  }

  /** 处理鼠标移动，显示可点击反馈和面高亮。 */
  function onPointerMove(event) {
    const hit = getGizmoHit(event);
    renderer.domElement.style.cursor = hit?.face ? 'pointer' : 'default';
    updateFaceHighlight(hit?.face?.normal ?? null);
  }

  /** 清理鼠标离开后留下的面高亮状态。 */
  function onPointerLeave() {
    renderer.domElement.style.cursor = 'default';
    updateFaceHighlight(null);
  }

  /** 将被点击的局部面法线交给宿主切换主相机方向。 */
  function onPointerDown(event) {
    if (event.button !== 0) return;
    const hit = getGizmoHit(event);
    if (!hit?.face) return;
    event.preventDefault();
    event.stopPropagation();
    options.onFaceClick(hit.face.normal.clone());
  }

  renderer.domElement.addEventListener('pointerdown', onPointerDown);
  renderer.domElement.addEventListener('pointermove', onPointerMove);
  renderer.domElement.addEventListener('pointerleave', onPointerLeave);

  return {
    render,
    /** 将既有方向立方体画布迁移到新的预览容器，保留已创建的 WebGL 资源。 */
    attach(nextContainer) {
      if (disposed || !nextContainer) return;
      nextContainer.append(renderer.domElement);
    },
    /** 调整控件画布尺寸并同步宽线材质分辨率。 */
    resize(width, height) {
      if (disposed) return;
      const safeWidth = Math.max(width, 1);
      const safeHeight = Math.max(height, 1);
      renderer.setSize(safeWidth, safeHeight, false);
      cube.children[0].material.resolution.set(safeWidth * pixelRatio, safeHeight * pixelRatio);
      renderLatestState();
    },
    /** 解绑事件并释放方向立方体独占的 GPU 资源及 WebGL 上下文。 */
    dispose() {
      if (disposed) return;
      disposed = true;
      renderer.domElement.removeEventListener('pointerdown', onPointerDown);
      renderer.domElement.removeEventListener('pointermove', onPointerMove);
      renderer.domElement.removeEventListener('pointerleave', onPointerLeave);
      disposeSceneResources(scene);
      renderer.dispose();
      renderer.forceContextLoss();
      renderer.domElement.remove();
    },
  };
}

/** 为立方体创建屏幕空间宽度的描边。 */
function createCubeEdges(cubeGeometry) {
  const edgeSource = new THREE.EdgesGeometry(cubeGeometry, 1);
  const edgeGeometry = new LineSegmentsGeometry().fromEdgesGeometry(edgeSource);
  edgeSource.dispose();
  const edgeMaterial = new LineMaterial({ color: 0x5a717c, linewidth: 1.25, alphaToCoverage: true });
  return new LineSegments2(edgeGeometry, edgeMaterial);
}

/** 向方向立方体场景加入 XYZ 方向箭头及其标签。 */
function addAxes(scene) {
  const up = new THREE.Vector3(0, 1, 0);
  const definitions = [
    { label: 'X', color: COORDINATE_AXIS_COLORS.x, direction: new THREE.Vector3(1, 0, 0) },
    { label: 'Y', color: COORDINATE_AXIS_COLORS.y, direction: new THREE.Vector3(0, 1, 0) },
    { label: 'Z', color: COORDINATE_AXIS_COLORS.z, direction: new THREE.Vector3(0, 0, 1) },
  ];
  definitions.forEach(({ label, color, direction }) => {
    const orientation = new THREE.Quaternion().setFromUnitVectors(up, direction);
    const shaft = new THREE.Mesh(new THREE.CylinderGeometry(0.04, 0.04, 0.76, 10), new THREE.MeshBasicMaterial({ color }));
    shaft.quaternion.copy(orientation);
    shaft.position.copy(direction).multiplyScalar(0.83);
    const head = new THREE.Mesh(new THREE.ConeGeometry(0.11, 0.2, 12), new THREE.MeshBasicMaterial({ color }));
    head.quaternion.copy(orientation);
    head.position.copy(direction).multiplyScalar(1.3);
    const axisLabel = createAxisLabel(label, color, 0.5);
    if (axisLabel) axisLabel.position.copy(direction).multiplyScalar(1.6);
    scene.add(shaft, head);
    if (axisLabel) scene.add(axisLabel);
  });
}

/** 创建带白色描边的三轴文字精灵。 */
function createAxisLabel(text, color, size) {
  const canvas = document.createElement('canvas');
  canvas.width = 256;
  canvas.height = 256;
  const context = canvas.getContext('2d');
  if (!context) return null;
  context.textAlign = 'center';
  context.textBaseline = 'middle';
  context.font = '800 176px sans-serif';
  context.lineJoin = 'round';
  context.lineWidth = 20;
  context.strokeStyle = 'rgba(255, 255, 255, 0.96)';
  context.strokeText(text, 128, 136);
  context.fillStyle = color;
  context.fillText(text, 128, 136);
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.generateMipmaps = false;
  texture.minFilter = THREE.LinearFilter;
  texture.magFilter = THREE.LinearFilter;
  const label = new THREE.Sprite(new THREE.SpriteMaterial({ map: texture, transparent: true, depthTest: true, depthWrite: false }));
  label.scale.set(size, size, 1);
  return label;
}

/** 以凸包构造带倒角轮廓的方向立方体几何体。 */
function createBeveledCubeGeometry(radius, bevelSize) {
  const halfSize = radius / 2;
  const cornerInset = halfSize - bevelSize;
  const edgeInset = halfSize - bevelSize / 2;
  const permutations = [
    [cornerInset, edgeInset, halfSize],
    [cornerInset, halfSize, edgeInset],
    [edgeInset, cornerInset, halfSize],
    [edgeInset, halfSize, cornerInset],
    [halfSize, cornerInset, edgeInset],
    [halfSize, edgeInset, cornerInset],
  ];
  const points = [];
  permutations.forEach((permutation) => {
    [-1, 1].forEach((xSign) => {
      [-1, 1].forEach((ySign) => {
        [-1, 1].forEach((zSign) => {
          points.push(new THREE.Vector3(permutation[0] * xSign, permutation[1] * ySign, permutation[2] * zSign));
        });
      });
    });
  });
  return new ConvexGeometry(points);
}

/** 遍历方向立方体子场景，释放几何、材质和纹理资源。 */
function disposeSceneResources(scene) {
  const disposedTextures = new Set();
  scene.traverse((object) => {
    if (!object.isMesh && !object.isLine && !object.isPoints && !object.isSprite) return;
    object.geometry?.dispose();
    const materials = Array.isArray(object.material) ? object.material : [object.material];
    materials.forEach((material) => {
      const texture = material.map;
      if (texture && !disposedTextures.has(texture)) {
        disposedTextures.add(texture);
        texture.dispose();
      }
      material.dispose();
    });
  });
}
