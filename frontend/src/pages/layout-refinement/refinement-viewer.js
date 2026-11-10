/** 文件说明：微调取景、拾取、名称显示和绕筒/顶部水平拖动；同步罩体实虚线，显示设置独立控制选中名称，释放才提交编辑动作。 */
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { PreviewRenderer } from '../../components/preview-renderer.js';
import { configureEnvelopeRenderer } from '../../components/envelope-preview-appearance.js';
import { setCoordinateAxesSize } from '../../components/coordinate-axes.js';
import { disposeOrbitControls } from '../../components/orbit-controls-lifecycle.js';
import { createPreviewPan } from '../../components/preview-pan.js';
import { getCurrentTheme } from '../../theme/theme.js';
import { createRefinementScene } from './refinement-scene.js';
import { screenAngularDelta, screenPlanarDelta } from './refinement-drag.js';
import { fitCameraBounds } from './refinement-camera.js';
import { resolveCameraClipping } from '../pre-config/cylinder-preview.js';
import { createRefinementDisplay } from './refinement-display.js';

/** 建立一个三维或正交视口；onDrag 回调返回整组命令，释放后由宿主合并为一次撤销。 */
export function createRefinementViewer({ container, labels, mode, candidate, source, meshes, satellites = [], style, radialSegments, pixelRatio, callbacks }) {
  const content = createRefinementScene(candidate, meshes, style, radialSegments, getCurrentTheme(), source);
  const { span, scene, axes } = content;
  const renderer = new PreviewRenderer({ antialias: true }); configureEnvelopeRenderer(renderer);
  renderer.setPixelRatio(Math.min(devicePixelRatio || 1, pixelRatio)); container.append(renderer.domElement);
  const camera = mode === '3d' ? new THREE.PerspectiveCamera(42, 1, span / 10000, span * 100)
    : new THREE.OrthographicCamera(-span, span, span, -span, span / 10000, span * 100);
  camera.up.set(0, 0, 1);
  const controls = new OrbitControls(camera, renderer.domElement);
  controls.enableRotate = mode === '3d'; controls.enableDamping = false;
  controls.enablePan = false; controls.minDistance = 0.01; controls.maxDistance = 10000000;
  const raycaster = new THREE.Raycaster(), mouse = new THREE.Vector2();
  let current = candidate, selected = [], tool = 'browse', frame, disposed = false, start = null, framing = null;
  let satelliteNamesVisible = createRefinementDisplay().satelliteNames;
  const clippingSphere = content.orbitBounds().getBoundingSphere(new THREE.Sphere());
  const previewPan = createPreviewPan({ camera, element: renderer.domElement, onChange: draw, onStart: navigateView,
    /** 卫星编辑期间不接管第二个鼠标手势，避免移动物体时相机跳动。 */
    enabled: () => controls.enabled });
  const nodes = new Map();
  const names = new Map(satellites.map((item) => [item.record_id, item.name]));
  for (const item of candidate.placements) {
    const node = document.createElement('button'); node.type = 'button'; node.className = 'refinement-instance-label';
    node.textContent = names.get(item.record_id) ?? item.name ?? ''; node.title = node.textContent; node.hidden = true;
    node.addEventListener('click', () => callbacks.select(item.instance_id));
    labels.append(node); nodes.set(item.instance_id, node);
  }
  /** 按显示开关投影选中卫星的名称；关闭名称、隐藏卫星、未选中及屏外标签均隐藏，避免遮挡布局。 */
  function projectLabels() {
    camera.updateMatrixWorld();
    const { width, height } = container.getBoundingClientRect();
    for (const item of current.placements) {
      const vector = new THREE.Vector3().fromArray(item.center_of_mass_mm).project(camera), node = nodes.get(item.instance_id);
      node.hidden = !satelliteNamesVisible || !content.objects.get(item.instance_id).visible || !selected.includes(item.instance_id) || !node.textContent
        || vector.z < -1 || vector.z > 1 || Math.abs(vector.x) > 1 || Math.abs(vector.y) > 1;
      node.style.left = `${(vector.x + 1) * width / 2}px`; node.style.top = `${(1 - vector.y) * height / 2}px`;
    }
  }
  /** 按需绘制一帧；相机、尺寸、模型和主题变化复用同一调度。 */
  function draw() {
    if (disposed || frame) return;
    frame = requestAnimationFrame(() => {
      frame = null;
      const { near, far } = resolveCameraClipping(clippingSphere.radius, camera.position.distanceTo(clippingSphere.center));
      if (camera.near !== near || camera.far !== far) { camera.near = near; camera.far = far; camera.updateProjectionMatrix(); }
      if (mode === '3d') setCoordinateAxesSize({ axes, camera, renderer });
      else axes.scale.setScalar((camera.top - camera.bottom) / camera.zoom * 100 / Math.max(container.clientHeight, 1));
      content.updateFairingEdges(camera, container.clientHeight);
      renderer.render(scene, camera); projectLabels();
    });
  }
  /** 适配完整卫星与安装筒的真实边界，默认视角与项目 +X/+Y/+Z 约定一致。 */
  function fit() {
    const direction = { '3d': [0.95, 0.95, 1.35], xy: [0, 0, 1], xz: [0, -1, 0], yz: [1, 0, 0] }[mode];
    camera.up.set(0, mode === 'xy' ? 1 : 0, mode === 'xy' ? 0 : 1);
    const sphere = content.orbitBounds().getBoundingSphere(new THREE.Sphere());
    clippingSphere.copy(sphere);
    controls.target.copy(sphere.center); controls.minDistance = Math.max(sphere.radius, 1);
    camera.position.copy(controls.target).add(new THREE.Vector3(...direction).normalize().multiplyScalar(span * 2));
    camera.lookAt(controls.target); framing = content.layoutBounds();
    frameBounds(); draw();
  }
  /** 取景只调整距离与投影偏移，保持整体旋转中心，定位后继续旋转也不跳向选中卫星。 */
  function frameBounds() {
    // 远距离缩放后的动态近裁剪面不能成为重新取景的距离下限。
    camera.near = Math.min(camera.near, controls.minDistance / 1000);
    fitCameraBounds(camera, framing, style.refinementFillRatio, { target: controls.target,
      width: Math.max(container.clientWidth, 1), height: Math.max(container.clientHeight, 1), minDistance: controls.minDistance });
    previewPan.syncFromCamera(); controls.update();
  }
  /** 按选中对象可见成员的实际包围盒定位；均隐藏时保留当前视角，不自动恢复模型。 */
  function locate() {
    scene.updateMatrixWorld(true);
    const bounds = new THREE.Box3();
    for (const id of selected) { const object = content.objects.get(id); if (object?.visible) bounds.expandByObject(object); }
    if (bounds.isEmpty()) return;
    framing = bounds;
    frameBounds(); draw();
  }
  /** 按容器尺寸同步投影，不改变用户已选视角。 */
  function resize() {
    const width = Math.max(container.clientWidth, 1), height = Math.max(container.clientHeight, 1), aspect = width / height;
    renderer.setSize(width, height);
    if (camera.isPerspectiveCamera) camera.aspect = aspect;
    else { camera.left = -span * aspect * 0.62; camera.right = span * aspect * 0.62; camera.top = span * 0.62; camera.bottom = -span * 0.62; }
    camera.updateProjectionMatrix();
    if (framing) frameBounds(); else previewPan.apply();
    draw();
  }
  /** 用户主动缩放、平移或旋转后停止自动重取景，后续尺寸变化不覆盖用户观察意图。 */
  function navigateView() { framing = null; }
  /** 仅对可见正式模型射线拾取；透明空间和隐藏卫星均不拦截点击或启动拖动。 */
  function pick(event) {
    const rect = container.getBoundingClientRect();
    mouse.set((event.clientX - rect.left) / rect.width * 2 - 1, -(event.clientY - rect.top) / rect.height * 2 + 1);
    scene.updateMatrixWorld(true); raycaster.setFromCamera(mouse, camera);
    return raycaster.intersectObjects([...content.objects.values()].filter((object) => object.visible), false)[0];
  }
  /** 在命中物体时开始编辑；浏览操作仍交给共享 OrbitControls。 */
  function down(event) {
    if (event.button !== 0) return;
    const hit = pick(event), id = hit?.object.userData.instanceId;
    if (!id) return;
    if (tool === 'browse') { start = { id, x: event.clientX, y: event.clientY, browse: true }; return; }
    const placement = current.placements.find((item) => item.instance_id === id);
    if ((['angle', 'translate'].includes(tool) && !['3d', 'xy'].includes(mode)) || (tool === 'height' && mode === 'xy')) return;
    const origin = new THREE.Vector3().fromArray(placement.center_of_mass_mm).project(camera);
    const up = new THREE.Vector3().fromArray(placement.center_of_mass_mm).add(new THREE.Vector3(0, 0, span)).project(camera);
    const screenZ = [(up.x - origin.x) * container.clientWidth / 2 / span, -(up.y - origin.y) * container.clientHeight / 2 / span];
    const descriptor = callbacks.dragStart(id);
    if (!descriptor) return;
    start = { id, ids: descriptor, x: event.clientX, y: event.clientY, angle: 0, point: hit.point.clone(), screenZ,
      previousX: event.clientX, previousY: event.clientY };
    controls.enabled = false; renderer.domElement.setPointerCapture(event.pointerId); event.stopImmediatePropagation();
  }
  /** 只发布当前拖动的共同增量，不逐帧追加撤销历史。 */
  function move(event) {
    if (!start || start.browse) return;
    let delta;
    if (tool === 'angle') {
      const point = start.point.clone().applyAxisAngle(new THREE.Vector3(0, 0, 1), start.angle);
      start.angle += screenAngularDelta(camera, point, [event.clientX - start.previousX, event.clientY - start.previousY],
        container.clientWidth, container.clientHeight);
      start.previousX = event.clientX; start.previousY = event.clientY;
      delta = { angle: start.angle * 180 / Math.PI };
    } else if (tool === 'translate') {
      const shift = screenPlanarDelta(camera, start.point, [event.clientX - start.x, event.clientY - start.y],
        container.clientWidth, container.clientHeight);
      if (!shift) return;
      delta = { x: shift[0], y: shift[1] };
    } else {
      const [x, y] = start.screenZ, denominator = x * x + y * y;
      if (denominator < 1e-12) return;
      delta = { height: ((event.clientX - start.x) * x + (event.clientY - start.y) * y) / denominator };
    }
    start.command = { kind: 'transform', ids: start.ids, ...delta }; callbacks.drag(start.command); event.stopImmediatePropagation();
  }
  /** 释放拖动时提交单一动作；浏览点击不把视角拖动误判为选择。 */
  function up(event) {
    if (!start) return;
    if (start.browse) { if (Math.hypot(event.clientX - start.x, event.clientY - start.y) < 4) callbacks.select(start.id); }
    else { callbacks.dragEnd(start.command); event.stopImmediatePropagation(); }
    start = null; controls.enabled = true;
    if (renderer.domElement.hasPointerCapture(event.pointerId)) renderer.domElement.releasePointerCapture(event.pointerId);
  }
  /** 指针意外取消时清除瞬时变换，不提交半次动作。 */
  function cancel() { if (start && !start.browse) callbacks.dragEnd(null); start = null; controls.enabled = true; }
  /** 主题事件只改变场景环境，不重置编辑和选择。 */
  function theme() { content.setTheme(getCurrentTheme()); draw(); }
  renderer.domElement.addEventListener('pointerdown', down, true);
  renderer.domElement.addEventListener('pointermove', move, true);
  renderer.domElement.addEventListener('pointerup', up, true);
  renderer.domElement.addEventListener('pointercancel', cancel, true);
  controls.addEventListener('change', draw);
  controls.addEventListener('start', navigateView);
  window.addEventListener('sat-layout-theme-change', theme);
  const observer = new ResizeObserver(resize); observer.observe(container);
  fit(); resize();
  return { fit, locate,
    /** 显示开关同步实体、选中卫星名称与来源轮廓，只重绘而不重新取景。 */
    setDisplay(options) {
      satelliteNamesVisible = options.satelliteNames ?? createRefinementDisplay().satelliteNames;
      content.setDisplay(options); draw();
    },
    /** 更新共享草稿和工具；拖动中的相机与起点保持稳定。 */
    update(next, ids, valid, nextTool) {
      current = next; selected = ids; tool = nextTool; content.update(current, selected, valid);
      content.orbitBounds().getBoundingSphere(clippingSphere); draw();
    },
    /** 返回屏幕投影供浏览器回归从真实显示位置发起鼠标操作。 */
    projections() { return current.placements.map((item) => { const v = new THREE.Vector3().fromArray(item.center_of_mass_mm).project(camera); return { id: item.instance_id, x: (v.x + 1) * container.clientWidth / 2, y: (1 - v.y) * container.clientHeight / 2 }; }); },
    /** 返回相机只读快照，供真实鼠标回归核对旋转中心、缩放与投影平移。 */
    getInteractionSnapshot() { return { cameraPosition: camera.position.toArray(), cameraUp: camera.up.toArray(),
      target: controls.target.toArray(), zoom: camera.zoom, panOffset: previewPan.panOffset.toArray(),
      viewOffsetEnabled: Boolean(camera.view?.enabled) }; },
    /** 返回只读绘制状态供浏览器检查真实可见性与材质，不提供修改场景的测试接口。 */
    getDisplaySnapshot() {
      const parts = [];
      scene.traverse((object) => { if (object.material && object.userData.appearanceRole) parts.push({
        role: object.userData.appearanceRole, visible: object.visible, edge: Boolean(object.isLineSegments),
        color: object.material.color.getHex(), opacity: object.material.opacity }); });
      const ghosts = scene.getObjectByName('source-outlines');
      return { parts, fairingEdges: content.fairingEdgeSnapshot(), axes: axes.visible, visibleIds: [...content.objects].filter(([, object]) => object.visible).map(([id]) => id),
        originalIds: ghosts.visible ? ghosts.children.filter((object) => object.visible).map((object) => object.userData.instanceId) : [] };
    },
    /** 移除全部监听、动画、标签与 GPU 资源，允许路由和视图反复切换。 */
    dispose() {
      disposed = true; if (frame) cancelAnimationFrame(frame); observer.disconnect();
      window.removeEventListener('sat-layout-theme-change', theme);
      renderer.domElement.removeEventListener('pointerdown', down, true); renderer.domElement.removeEventListener('pointermove', move, true);
      renderer.domElement.removeEventListener('pointerup', up, true); renderer.domElement.removeEventListener('pointercancel', cancel, true);
      previewPan.dispose(); disposeOrbitControls(controls); renderer.dispose(); renderer.domElement.remove(); labels.replaceChildren(); content.dispose();
    } };
}
