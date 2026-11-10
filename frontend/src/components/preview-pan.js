/** 文件说明：共享预览右键投影平移；只移动画面，不改变相机位姿或 OrbitControls 的旋转中心。 */
import * as THREE from 'three';

/** 绑定右键拖动并返回投影同步、复位与释放接口；调用方负责相机旋转、缩放和渲染。 */
export function createPreviewPan({ camera, element, panOffset = new THREE.Vector2(), onChange, onStart = () => {}, enabled = () => true }) {
  const lastPosition = new THREE.Vector2();
  let pointerId = null;

  /** 按画布 CSS 像素应用投影偏移；窗口变化时保持拖动距离和旋转中心。 */
  function apply() {
    const width = Math.max(element.clientWidth, 1), height = Math.max(element.clientHeight, 1);
    if (panOffset.lengthSq() < 1e-8) camera.clearViewOffset();
    else camera.setViewOffset(width, height, panOffset.x, panOffset.y, width, height);
  }

  /** 清除平移量，由调用方决定何时重新绘制。 */
  function reset() { panOffset.set(0, 0); camera.clearViewOffset(); }

  /** 接收自动取景产生的投影偏移，使后续手动拖动从当前画面连续开始。 */
  function syncFromCamera() {
    panOffset.set(camera.view?.enabled ? camera.view.offsetX : 0, camera.view?.enabled ? camera.view.offsetY : 0);
  }

  /** 捕获右键手势，防止 OrbitControls 将其解释为改变观察目标的世界平移。 */
  function down(event) {
    if (event.button !== 2 || pointerId !== null || !enabled()) return;
    event.preventDefault(); event.stopImmediatePropagation();
    pointerId = event.pointerId; lastPosition.set(event.clientX, event.clientY);
    element.setPointerCapture(pointerId); onStart();
  }

  /** 跟随鼠标的屏幕位移更新投影，并请求一帧渲染。 */
  function move(event) {
    if (event.pointerId !== pointerId) return;
    event.preventDefault(); event.stopImmediatePropagation();
    panOffset.x -= event.clientX - lastPosition.x; panOffset.y -= event.clientY - lastPosition.y;
    lastPosition.set(event.clientX, event.clientY); apply(); onChange();
  }

  /** 结束或取消平移，释放指针捕获，避免离开画布后遗留拖动状态。 */
  function finish(event) {
    if (event.pointerId !== pointerId) return;
    event.preventDefault(); event.stopImmediatePropagation(); pointerId = null;
    if (element.hasPointerCapture(event.pointerId)) element.releasePointerCapture(event.pointerId);
  }

  /** 预览右键用于平移，阻止浏览器菜单覆盖画布。 */
  function contextmenu(event) { event.preventDefault(); }

  element.addEventListener('pointerdown', down, true);
  element.addEventListener('pointermove', move, true);
  element.addEventListener('pointerup', finish, true);
  element.addEventListener('pointercancel', finish, true);
  element.addEventListener('contextmenu', contextmenu);
  return { apply, reset, syncFromCamera, panOffset,
    /** 移除本模块注册的监听并释放尚未结束的捕获，不销毁调用方相机。 */
    dispose() {
      if (pointerId !== null && element.hasPointerCapture(pointerId)) element.releasePointerCapture(pointerId);
      pointerId = null;
      element.removeEventListener('pointerdown', down, true); element.removeEventListener('pointermove', move, true);
      element.removeEventListener('pointerup', finish, true); element.removeEventListener('pointercancel', finish, true);
      element.removeEventListener('contextmenu', contextmenu);
    } };
}
