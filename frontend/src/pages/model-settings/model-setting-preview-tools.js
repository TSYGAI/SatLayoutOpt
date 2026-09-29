/**
 * 文件说明：为模型设置页提供质心标记、安装面轮廓、曲面点击点和基于 BVH 的单击拾取。
 * 本模块只消费高清 GLB 网格与 STEP 面映射；精确曲面投影和法向校验仍由后端 STEP 完成。
 */

import * as THREE from 'three';

export const INSTALLATION_FACE_SELECTED_EVENT = 'sat-layout-installation-face-selected';
export const INSTALLATION_PICKER_STATE_EVENT = 'sat-layout-installation-picker-state';

const POINTER_CLICK_TOLERANCE = 5;
const CENTER_OF_MASS_PIXELS = 34;
const INSTALLATION_NORMAL_PIXELS = 58;
const INSTALLATION_FACE_COLOR = 0xffc857;
const CENTER_AXIS_COLORS = Object.freeze([0xd4493d, 0x2f9863, 0x3d6fc4]);

/** 按三角形序号使用二分查找返回对应的 STEP 面映射。 */
export function findMappingEntryForTriangle(entries, triangleIndex) {
  if (!Array.isArray(entries) || !Number.isInteger(triangleIndex) || triangleIndex < 0) return null;
  let lower = 0;
  let upper = entries.length - 1;
  while (lower <= upper) {
    const middle = Math.floor((lower + upper) / 2);
    const entry = entries[middle];
    const start = Number(entry?.triangle_start);
    const end = start + Number(entry?.triangle_count);
    if (triangleIndex < start) upper = middle - 1;
    else if (triangleIndex >= end) lower = middle + 1;
    else return entry;
  }
  return null;
}

/** 返回几何中指定顶点的三维位置。 */
function readVertex(position, vertexIndex, target) {
  return target.set(position.getX(vertexIndex), position.getY(vertexIndex), position.getZ(vertexIndex));
}

/**
 * 提取一个映射面的外边界、稳定表面点和三角网格法向。
 * 只保留出现一次的边，因此不会把面内部三角剖分线显示为安装面轮廓。
 */
export function extractMappedFaceGeometry(geometry, entry, referencePoint = null) {
  const position = geometry?.getAttribute('position');
  const index = geometry?.getIndex();
  const triangleStart = Number(entry?.triangle_start);
  const triangleCount = Number(entry?.triangle_count);
  if (!position || !index || !Number.isInteger(triangleStart) || !Number.isInteger(triangleCount) || triangleCount <= 0) {
    throw new Error('安装面三角网格数据不完整');
  }
  const edgeCounts = new Map();
  const pointA = new THREE.Vector3();
  const pointB = new THREE.Vector3();
  const pointC = new THREE.Vector3();
  const edgeAB = new THREE.Vector3();
  const edgeAC = new THREE.Vector3();
  const cross = new THREE.Vector3();
  const closestPoint = new THREE.Vector3();
  const triangle = new THREE.Triangle();
  const preferred = Array.isArray(referencePoint) && referencePoint.length === 3
    && referencePoint.every(Number.isFinite) ? new THREE.Vector3().fromArray(referencePoint) : null;
  let largestAreaSquared = -1;
  let closestDistanceSquared = Infinity;
  let anchor = null;
  let normal = null;

  /** 记录一条无方向索引边的出现次数。 */
  function recordEdge(start, end) {
    const key = start < end ? `${start}:${end}` : `${end}:${start}`;
    const current = edgeCounts.get(key);
    if (current) current.count += 1;
    else edgeCounts.set(key, { start, end, count: 1 });
  }

  for (let offset = triangleStart * 3; offset < (triangleStart + triangleCount) * 3; offset += 3) {
    const a = index.getX(offset);
    const b = index.getX(offset + 1);
    const c = index.getX(offset + 2);
    recordEdge(a, b);
    recordEdge(b, c);
    recordEdge(c, a);
    readVertex(position, a, pointA);
    readVertex(position, b, pointB);
    readVertex(position, c, pointC);
    cross.crossVectors(edgeAB.subVectors(pointB, pointA), edgeAC.subVectors(pointC, pointA));
    const areaSquared = cross.lengthSq();
    if (preferred && areaSquared > 1e-20) {
      triangle.set(pointA, pointB, pointC).closestPointToPoint(preferred, closestPoint);
      const distanceSquared = closestPoint.distanceToSquared(preferred);
      if (distanceSquared < closestDistanceSquared) {
        closestDistanceSquared = distanceSquared;
        anchor = closestPoint.clone();
        normal = cross.clone().normalize();
      }
    } else if (!preferred && areaSquared > largestAreaSquared) {
      largestAreaSquared = areaSquared;
      anchor = pointA.clone().add(pointB).add(pointC).multiplyScalar(1 / 3);
      normal = areaSquared > 1e-20 ? cross.clone().normalize() : null;
    }
  }
  const boundary = [];
  edgeCounts.forEach((edge) => {
    if (edge.count !== 1) return;
    readVertex(position, edge.start, pointA);
    readVertex(position, edge.end, pointB);
    boundary.push(...pointA.toArray(), ...pointB.toArray());
  });
  if (!boundary.length || !anchor || !normal) throw new Error('安装面没有可显示的有效边界');
  return { boundary: new Float32Array(boundary), anchor: anchor.toArray(), normal: normal.toArray() };
}

/** 创建始终可见的质心 XYZ 标记。 */
function createCenterOfMassMarker() {
  const marker = new THREE.Group();
  marker.name = 'CENTER_OF_MASS_MARKER';
  const sphere = new THREE.Mesh(
    new THREE.SphereGeometry(0.11, 14, 10),
    new THREE.MeshBasicMaterial({ color: 0xf5f8fa, depthTest: false, depthWrite: false, toneMapped: false }),
  );
  sphere.renderOrder = 10;
  marker.add(sphere);
  const directions = [new THREE.Vector3(1, 0, 0), new THREE.Vector3(0, 1, 0), new THREE.Vector3(0, 0, 1)];
  directions.forEach((direction, index) => {
    const geometry = new THREE.BufferGeometry().setFromPoints([
      direction.clone().multiplyScalar(-0.62),
      direction.clone().multiplyScalar(0.62),
    ]);
    const line = new THREE.Line(
      geometry,
      new THREE.LineBasicMaterial({ color: CENTER_AXIS_COLORS[index], depthTest: false, depthWrite: false, toneMapped: false }),
    );
    line.renderOrder = 10;
    marker.add(line);
  });
  marker.visible = false;
  return marker;
}

/** 释放一个覆盖层对象拥有的几何、材质和纹理。 */
function disposeOverlayObject(object) {
  if (!object) return;
  object.traverse((child) => {
    child.geometry?.dispose();
    const materials = Array.isArray(child.material) ? child.material : [child.material];
    materials.filter(Boolean).forEach((material) => {
      material.map?.dispose();
      material.dispose();
    });
  });
}

/** 把表单中的完整有限质心转换为局部坐标，不完整时返回空。 */
function readCenterOfMass(settings) {
  const center = settings?.center_of_mass;
  if (!center || typeof center !== 'object') return null;
  const raw = [center.x, center.y, center.z];
  if (raw.some((value) => value === '' || value === null || value === undefined)) return null;
  const coordinates = raw.map(Number);
  return coordinates.every(Number.isFinite) ? coordinates : null;
}

/** 从设置读取有限的 STEP 源坐标安装点，旧平面记录没有该字段时返回空。 */
function readInstallationPoint(settings) {
  const point = settings?.installation_point;
  if (!point || typeof point !== 'object') return null;
  const raw = [point.x, point.y, point.z];
  if (raw.some((value) => value === '' || value === null || value === undefined)) return null;
  const coordinates = raw.map(Number);
  return coordinates.every(Number.isFinite) ? coordinates : null;
}

/** 创建管理单个预览场景设置覆盖层和安装面拾取的控制器。 */
export function createModelSettingPreviewTools(options) {
  const { scene, camera, renderer, requestRender, onStatus, onError } = options;
  const overlayRoot = new THREE.Group();
  overlayRoot.name = 'MODEL_SETTING_OVERLAYS';
  overlayRoot.visible = false;
  scene.add(overlayRoot);
  const centerMarker = createCenterOfMassMarker();
  overlayRoot.add(centerMarker);

  const pickerResources = new Map();
  const raycaster = new THREE.Raycaster();
  raycaster.firstHitOnly = true;
  const pointer = new THREE.Vector2();
  const cameraSpacePosition = new THREE.Vector3();
  const parentWorldScale = new THREE.Vector3();
  let worker = null;
  let bvhModulesPromise = null;
  let workerQueue = Promise.resolve();
  let context = { enabled: false, modelId: null, detailRoot: null, mappingEntries: [], settings: {}, transform: null };
  let faceOutline = null;
  let faceIndicator = null;
  let faceOverlayKey = null;
  let picking = false;
  let pickingRequestToken = 0;
  let pointerStart = null;
  let destroyed = false;

  /** 返回当前设置对应的安装面映射。 */
  function getSelectedFace() {
    const faceId = context.settings?.installation_face_id;
    return context.mappingEntries.find((entry) => entry.step_face_id === faceId) || null;
  }

  /** 向 React 设置栏发送拾取准备状态和当前面摘要。 */
  function emitState(status, message = '') {
    const selectedFace = getSelectedFace();
    window.dispatchEvent(new CustomEvent(INSTALLATION_PICKER_STATE_EVENT, {
      detail: {
        modelId: context.modelId,
        status,
        message,
        selectedFace: selectedFace ? {
          step_face_id: selectedFace.step_face_id,
          surface_type: selectedFace.surface_type,
          area: selectedFace.area,
        } : null,
        invalidSelection: Boolean(context.settings?.installation_face_id && !selectedFace),
      },
    }));
  }

  /** 根据当前高清映射和索引状态发送可用性。 */
  function emitCurrentState() {
    if (!context.enabled || !context.detailRoot || !context.mappingEntries.length) {
      emitState('unavailable', '等待高清预览与 STEP 面映射');
      return;
    }
    const resource = pickerResources.get(context.detailRoot);
    if (resource?.status === 'error') emitState('error', '安装面拾取索引构建失败');
    else if (resource?.status === 'building') emitState('building', '正在准备安装面拾取');
    else emitState(picking ? 'active' : 'ready', picking ? '安装面选择中' : '可以选择安装面');
  }

  /** 移除当前安装面可视覆盖层。 */
  function clearFaceOverlay() {
    faceOverlayKey = null;
    if (faceOutline) {
      overlayRoot.remove(faceOutline);
      disposeOverlayObject(faceOutline);
      faceOutline = null;
    }
    if (faceIndicator) {
      overlayRoot.remove(faceIndicator);
      disposeOverlayObject(faceIndicator);
      faceIndicator = null;
    }
  }

  /** 根据设置中的 STEP 面 ID 和点击点重建边界、局部点及近似法向标记。 */
  function renderSelectedFace() {
    const entry = getSelectedFace();
    const referencePoint = readInstallationPoint(context.settings);
    const nextKey = context.enabled && context.detailRoot && entry
      ? `${context.detailRoot.uuid}:${entry.step_face_id}:${referencePoint?.join(',') || 'legacy-center'}`
      : null;
    if (nextKey && nextKey === faceOverlayKey && faceOutline && faceIndicator) return;
    clearFaceOverlay();
    if (!nextKey) return;
    try {
      const extracted = extractMappedFaceGeometry(context.detailRoot.geometry, entry, referencePoint);
      const outlineGeometry = new THREE.BufferGeometry();
      outlineGeometry.setAttribute('position', new THREE.BufferAttribute(extracted.boundary, 3));
      faceOutline = new THREE.LineSegments(
        outlineGeometry,
        new THREE.LineBasicMaterial({
          color: INSTALLATION_FACE_COLOR,
          depthTest: false,
          depthWrite: false,
          transparent: false,
          toneMapped: false,
        }),
      );
      faceOutline.name = 'INSTALLATION_FACE_OUTLINE';
      faceOutline.renderOrder = 11;
      faceIndicator = new THREE.Group();
      faceIndicator.name = 'INSTALLATION_FACE_NORMAL';
      faceIndicator.position.fromArray(extracted.anchor);
      const normal = new THREE.Vector3().fromArray(extracted.normal);
      const arrow = new THREE.ArrowHelper(normal, new THREE.Vector3(), 1, INSTALLATION_FACE_COLOR, 0.25, 0.14);
      arrow.line.material.depthTest = false;
      arrow.line.material.depthWrite = false;
      arrow.cone.material.depthTest = false;
      arrow.cone.material.depthWrite = false;
      arrow.line.renderOrder = 12;
      arrow.cone.renderOrder = 12;
      const point = new THREE.Mesh(
        new THREE.SphereGeometry(0.075, 12, 8),
        new THREE.MeshBasicMaterial({ color: INSTALLATION_FACE_COLOR, depthTest: false, depthWrite: false, toneMapped: false }),
      );
      point.renderOrder = 12;
      faceIndicator.add(arrow, point);
      overlayRoot.add(faceOutline, faceIndicator);
      faceOverlayKey = nextKey;
    } catch (error) {
      onError(`安装面标记无法显示：${error.message}`);
    }
  }

  /** 将覆盖层应用与模型一致的单位缩放和 XYZ 旋转。 */
  function applyTransform() {
    const transform = context.transform;
    if (!transform) return;
    overlayRoot.scale.setScalar(transform.scale);
    overlayRoot.rotation.set(...transform.rotation, 'XYZ');
    overlayRoot.updateMatrixWorld(true);
  }

  /** 将指定像素尺寸换算为一个覆盖标记的局部缩放。 */
  function scaleMarkerToPixels(marker, pixels) {
    if (!marker?.visible) return;
    camera.updateMatrixWorld();
    overlayRoot.updateMatrixWorld(true);
    const worldPosition = marker.getWorldPosition(cameraSpacePosition).applyMatrix4(camera.matrixWorldInverse);
    const depth = -worldPosition.z;
    if (!Number.isFinite(depth) || depth <= camera.near) return;
    const viewportHeight = Math.max(renderer.domElement.clientHeight, 1);
    const visibleHeight = 2 * depth * Math.tan(THREE.MathUtils.degToRad(camera.fov / 2));
    const worldLength = (visibleHeight * pixels) / viewportHeight;
    const inheritedScale = overlayRoot.getWorldScale(parentWorldScale).x;
    if (Number.isFinite(worldLength) && worldLength > 0 && inheritedScale > 0) {
      marker.scale.setScalar(worldLength / inheritedScale);
    }
  }

  /** 更新质心和安装面法向标记的固定屏幕尺寸。 */
  function updateScreenScale() {
    scaleMarkerToPixels(centerMarker, CENTER_OF_MASS_PIXELS);
    scaleMarkerToPixels(faceIndicator, INSTALLATION_NORMAL_PIXELS);
  }

  /** 根据当前设置显示或隐藏质心标记。 */
  function renderCenterOfMass() {
    const coordinates = context.enabled ? readCenterOfMass(context.settings) : null;
    centerMarker.visible = Boolean(coordinates);
    if (coordinates) centerMarker.position.fromArray(coordinates);
  }

  /** 首次需要拾取时动态加载 BVH 主模块与 Worker，避免增加普通预览启动成本。 */
  function loadBvhModules() {
    bvhModulesPromise ||= Promise.all([
      import('three-mesh-bvh'),
      import('three-mesh-bvh/worker'),
    ]).then(([core, workers]) => ({
      acceleratedRaycast: core.acceleratedRaycast,
      GenerateMeshBVHWorker: workers.GenerateMeshBVHWorker,
    }));
    return bvhModulesPromise;
  }

  /** 串行地在复用 Worker 中构建一个克隆网格的 BVH。 */
  function enqueueBvhBuild(geometry) {
    const task = workerQueue.catch(() => undefined).then(async () => {
      if (destroyed) throw new Error('安装面拾取控制器已释放');
      const modules = await loadBvhModules();
      worker ||= new modules.GenerateMeshBVHWorker();
      const boundsTree = await worker.generate(geometry, { indirect: true, maxLeafTris: 12 });
      geometry.boundsTree = boundsTree;
      return modules.acceleratedRaycast;
    });
    workerQueue = task.then(() => undefined, () => undefined);
    return task;
  }

  /** 返回指定高清模型可复用的 BVH 拾取网格，首次调用时异步创建。 */
  function preparePicker(detailRoot) {
    const existing = pickerResources.get(detailRoot);
    if (existing?.status === 'ready') return Promise.resolve(existing);
    if (existing?.status === 'building') return existing.promise;
    if (existing?.status === 'error') return Promise.reject(existing.error);
    const geometry = detailRoot.geometry.clone();
    const material = new THREE.MeshBasicMaterial({ side: THREE.DoubleSide });
    const pickMesh = new THREE.Mesh(geometry, material);
    pickMesh.matrixAutoUpdate = false;
    const resource = { status: 'building', geometry, material, pickMesh, promise: null, error: null, disposed: false };
    resource.promise = enqueueBvhBuild(geometry).then((acceleratedRaycast) => {
      if (resource.disposed) {
        throw new Error('安装面拾取模型已释放');
      }
      pickMesh.raycast = acceleratedRaycast;
      resource.status = 'ready';
      return resource;
    }).catch((error) => {
      resource.status = 'error';
      resource.error = error;
      if (resource.disposed) {
        geometry.dispose();
        material.dispose();
      }
      throw error;
    });
    pickerResources.set(detailRoot, resource);
    return resource.promise;
  }

  /** 在当前画布位置执行一次加速射线拾取并更新安装面草稿。 */
  async function pickFace(clientX, clientY) {
    const activeContext = context;
    try {
      const resource = await preparePicker(activeContext.detailRoot);
      if (!picking || context !== activeContext || destroyed) return;
      const bounds = renderer.domElement.getBoundingClientRect();
      pointer.set(
        ((clientX - bounds.left) / Math.max(bounds.width, 1)) * 2 - 1,
        -((clientY - bounds.top) / Math.max(bounds.height, 1)) * 2 + 1,
      );
      raycaster.setFromCamera(pointer, camera);
      activeContext.detailRoot.updateMatrixWorld(true);
      resource.pickMesh.matrixWorld.copy(activeContext.detailRoot.matrixWorld);
      const hit = raycaster.intersectObject(resource.pickMesh, false)[0];
      if (!hit) {
        onError('未命中模型表面，请重新选择');
        return;
      }
      const entry = findMappingEntryForTriangle(activeContext.mappingEntries, hit.faceIndex);
      if (!entry) {
        onError('未能把点击位置映射到 STEP 安装面');
        return;
      }
      const localHitPoint = activeContext.detailRoot.worldToLocal(hit.point.clone());
      const installationPoint = {
        x: localHitPoint.x,
        y: localHitPoint.y,
        z: localHitPoint.z,
      };
      context = {
        ...context,
        settings: {
          ...context.settings,
          installation_face_id: entry.step_face_id,
          installation_point: installationPoint,
        },
      };
      faceOverlayKey = null;
      renderSelectedFace();
      updateScreenScale();
      window.dispatchEvent(new CustomEvent(INSTALLATION_FACE_SELECTED_EVENT, {
        detail: {
          modelId: context.modelId,
          face: {
            step_face_id: entry.step_face_id,
            surface_type: entry.surface_type,
            area: entry.area,
          },
          point: installationPoint,
        },
      }));
      emitCurrentState();
      requestRender();
    } catch (error) {
      if (context === activeContext) {
        picking = false;
        renderer.domElement.classList.remove('installation-picking');
        emitState('error', '安装面拾取索引构建失败');
        onError(`安装面拾取不可用：${error.message}`);
        onStatus('高清预览可用，安装面拾取失败', 'error');
      }
    }
  }

  /** 开始记录可能的左键单击，拖动超过阈值后不会触发拾取。 */
  function handlePointerDown(event) {
    if (!picking || event.button !== 0) return;
    pointerStart = { pointerId: event.pointerId, x: event.clientX, y: event.clientY, moved: false };
  }

  /** 标记当前指针操作是否已经成为拖动。 */
  function handlePointerMove(event) {
    if (!pointerStart || event.pointerId !== pointerStart.pointerId) return;
    if (Math.hypot(event.clientX - pointerStart.x, event.clientY - pointerStart.y) > POINTER_CLICK_TOLERANCE) {
      pointerStart.moved = true;
    }
  }

  /** 在无拖动的左键释放时执行唯一一次面拾取。 */
  function handlePointerUp(event) {
    if (!pointerStart || event.pointerId !== pointerStart.pointerId) return;
    const shouldPick = event.type === 'pointerup' && picking && !pointerStart.moved && event.button === 0;
    pointerStart = null;
    if (shouldPick) void pickFace(event.clientX, event.clientY);
  }

  /** 使用 Escape 退出安装面选择状态。 */
  function handleKeyDown(event) {
    const resource = context.detailRoot ? pickerResources.get(context.detailRoot) : null;
    if (event.key === 'Escape' && (picking || resource?.status === 'building')) void setPickingEnabled(false);
  }

  /** 为当前 React 页面生命周期绑定拾取所需的画布和键盘事件。 */
  function bindEvents(signal) {
    const canvas = renderer.domElement;
    canvas.addEventListener('pointerdown', handlePointerDown, { capture: true, signal });
    canvas.addEventListener('pointermove', handlePointerMove, { capture: true, signal });
    canvas.addEventListener('pointerup', handlePointerUp, { capture: true, signal });
    canvas.addEventListener('pointercancel', handlePointerUp, { capture: true, signal });
    window.addEventListener('keydown', handleKeyDown, { signal });
  }

  /** 更新当前模型、高清映射、设置草稿和模型变换。 */
  function setContext(nextContext) {
    const modelChanged = context.modelId !== nextContext.modelId || context.detailRoot !== nextContext.detailRoot;
    if (modelChanged || !nextContext.enabled) {
      picking = false;
      pickingRequestToken += 1;
      pointerStart = null;
      renderer.domElement.classList.remove('installation-picking');
    }
    context = {
      enabled: Boolean(nextContext.enabled),
      modelId: nextContext.modelId || null,
      detailRoot: nextContext.detailRoot || null,
      mappingEntries: Array.isArray(nextContext.mappingEntries) ? nextContext.mappingEntries : [],
      settings: nextContext.settings || {},
      transform: nextContext.transform || null,
    };
    overlayRoot.visible = context.enabled;
    applyTransform();
    renderCenterOfMass();
    renderSelectedFace();
    updateScreenScale();
    emitCurrentState();
    requestRender();
  }

  /** 清空当前模型覆盖层，但保留其他模型已经生成的 BVH 内存缓存。 */
  function clearPreview() {
    setContext({ enabled: false, modelId: null, detailRoot: null, mappingEntries: [], settings: {}, transform: null });
  }

  /** 开启或关闭安装面选择；首次开启会等待 Worker 完成 BVH。 */
  async function setPickingEnabled(enabled) {
    if (!enabled) {
      picking = false;
      pickingRequestToken += 1;
      pointerStart = null;
      renderer.domElement.classList.remove('installation-picking');
      const resource = context.detailRoot ? pickerResources.get(context.detailRoot) : null;
      if (resource?.status === 'building') emitState('ready', '安装面选择已取消');
      else emitCurrentState();
      onStatus(context.detailRoot ? '高清预览与映射就绪' : '等待高清预览', context.detailRoot ? 'ready' : 'busy');
      requestRender();
      return true;
    }
    if (!context.enabled || !context.detailRoot || !context.mappingEntries.length) {
      emitCurrentState();
      return false;
    }
    const activeRoot = context.detailRoot;
    const requestToken = pickingRequestToken + 1;
    pickingRequestToken = requestToken;
    emitState('building', '正在准备安装面拾取');
    onStatus('正在准备安装面拾取', 'busy');
    try {
      await preparePicker(activeRoot);
      if (destroyed || context.detailRoot !== activeRoot || !context.enabled || pickingRequestToken !== requestToken) return false;
      picking = true;
      renderer.domElement.classList.add('installation-picking');
      emitState('active', '安装面选择中');
      onStatus('安装面选择中', 'busy');
      return true;
    } catch (error) {
      if (context.detailRoot === activeRoot) {
        emitState('error', '安装面拾取索引构建失败');
        onError(`安装面拾取不可用：${error.message}`);
        onStatus('高清预览可用，安装面拾取失败', 'error');
      }
      return false;
    }
  }

  /** 释放不再缓存的高清模型对应的拾取几何和材质。 */
  function releasePreview(detailRoot) {
    const resource = pickerResources.get(detailRoot);
    if (!resource) return;
    resource.disposed = true;
    if (resource.status !== 'building') {
      resource.geometry.dispose();
      resource.material.dispose();
    }
    pickerResources.delete(detailRoot);
  }

  /** 释放全部覆盖层、拾取资源和后台 Worker。 */
  function dispose() {
    destroyed = true;
    picking = false;
    pointerStart = null;
    renderer.domElement.classList.remove('installation-picking');
    pickerResources.forEach((resource, detailRoot) => releasePreview(detailRoot));
    worker?.dispose();
    worker = null;
    clearFaceOverlay();
    overlayRoot.remove(centerMarker);
    disposeOverlayObject(centerMarker);
    scene.remove(overlayRoot);
  }

  return {
    bindEvents,
    clearPreview,
    dispose,
    releasePreview,
    setContext,
    setPickingEnabled,
    updateScreenScale,
  };
}
