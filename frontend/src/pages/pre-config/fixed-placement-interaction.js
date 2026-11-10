/** 文件说明：固定星选择、逐帧拖动及世界轴点击；镜像副本反向映射基准角度，缓存即时反馈，正式业务由后端验收。 */
import * as THREE from 'three';

/** 建立捕获阶段交互，选择和放置独占指针；移动合并到每个浏览器帧，松开前刷新最后一步。 */
export function createFixedPlacementInteraction(canvas, camera, controls, object, onChange, gizmo = () => null) {
  let options = null, pointer = null, anchor = null, pending = null, frame = null;
  const raycaster = new THREE.Raycaster();
  /** 鼠标输入保留三位小数，手动输入不受此限制。 */
  function displayInput(value) { return Number(value.toFixed(3)); }
  /** 将屏幕指针投射为世界射线，包含当前相机的投影平移。 */
  function ray(event) {
    camera.updateMatrixWorld();
    const rect = canvas.getBoundingClientRect();
    raycaster.setFromCamera(new THREE.Vector2((event.clientX - rect.left) / rect.width * 2 - 1,
      -(event.clientY - rect.top) / rect.height * 2 + 1), camera);
    return raycaster.ray;
  }
  /** 求射线与同轴无限圆柱的交点，高度越界由正式后端校验。 */
  function surface(event, radius) {
    const { origin: o, direction: d } = ray(event);
    const a = d.x ** 2 + d.y ** 2, b = 2 * (o.x * d.x + o.y * d.y);
    const c = o.x ** 2 + o.y ** 2 - radius ** 2, discriminant = b * b - 4 * a * c;
    if (a < Number.EPSILON || discriminant < 0) return null;
    const roots = [(-b - Math.sqrt(discriminant)) / (2 * a), (-b + Math.sqrt(discriminant)) / (2 * a)].filter((t) => t >= 0);
    return roots.length ? raycaster.ray.at(Math.min(...roots), new THREE.Vector3()) : null;
  }
  /** 阻止 OrbitControls 抢占一次卫星选择、放置或微调手势。 */
  function consume(event) { event.preventDefault(); event.stopImmediatePropagation(); }
  /** 向 React 和缓存场景发布本帧最新的角度/高度，不等待网络。 */
  function flush() {
    if (frame !== null) window.cancelAnimationFrame(frame);
    frame = null;
    if (!pending) return;
    const update = pending; pending = null; onChange('move', update);
  }
  /** 合并同一帧中的指针更新，避免鼠标高采样率导致 React 重复渲染。 */
  function queue(update) {
    pending = update;
    if (frame === null) frame = window.requestAnimationFrame(flush);
  }
  /** 开始一次独占手势，记录相机原启用状态，离开页面时也能恢复。 */
  function capture(event, state) {
    consume(event);
    pointer = event.pointerId; anchor = { ...state, cameraEnabled: controls.enabled };
    controls.enabled = false; canvas.setPointerCapture(pointer);
  }
  /** 优先点击世界轴箭头，再拾取已放置包络；选择不受数值/点选/拖动模式限制。 */
  function down(event) {
    if (!options || event.button !== 0 || pointer !== null) return;
    ray(event);
    const helper = gizmo();
    if (helper?.visible) {
      const hits = raycaster.intersectObjects(helper.children, true).filter((hit) => hit.object.userData.surfaceRole === 'fixed-nudge');
      const arrow = hits.find((hit) => hit.object.userData.pickPart === 'head') || hits[0];
      if (arrow) {
        capture(event, { kind: 'nudge', action: { ...arrow.object.userData } });
        return;
      }
    }
    const bodies = [];
    object()?.updateMatrixWorld(true);
    object()?.traverse((child) => { if (child.isMesh && child.userData.surfaceRole === 'fixed-envelope') bodies.push(child); });
    const hit = raycaster.intersectObjects(bodies, false)[0];
    if (hit) {
      const group = options.groups.find((entry) => entry.group_id === hit.object.userData.groupId);
      if (!group) return;
      onChange('select', { groupId: group.group_id, instanceId: hit.object.userData.instanceId });
      if (options.mode !== 'drag' || group.mount !== 'side') { capture(event, { kind: 'select' }); return; }
      const radius = Math.hypot(hit.point.x, hit.point.y), point = surface(event, radius);
      if (!point) return;
      const placement = options.placements.find((item) => item.instance_id === hit.object.userData.instanceId);
      capture(event, { kind: 'drag', radius, angle: Math.atan2(point.y, point.x), z: point.z, placement, group: { ...group },
        angleSign: placement?.fixed_mirrored ? -1 : 1 });
      onChange('start');
      return;
    }
    const group = options.groups.find((entry) => entry.group_id === options.groupId);
    if (options.mode === 'pick' && group?.mount === 'side') {
      const point = surface(event, options.radius);
      if (!point) return;
      capture(event, { kind: 'pick' }); onChange('start');
      const placement = options.placements.find((item) => item.instance_id === options.instanceId)
        || options.placements.find((item) => item.fixed_group_id === group.group_id);
      const phase = Math.atan2(point.y, point.x) * 180 / Math.PI;
      const angle = placement?.fixed_mirrored ? (group.symmetry_mode === 'mirror_xoz' ? -phase : 180 - phase) : phase;
      queue({ angle_deg: displayInput(((angle % 360) + 360) % 360) % 360,
        height_mm: displayInput(point.z - options.tubeBottom) });
    } else if (options.mode !== 'pick') onChange('select', { groupId: null, instanceId: null });
  }
  /** 鼠标拖动只记录最新点并按帧更新，不触发后端请求或相机移动。 */
  function move(event) {
    if (event.pointerId !== pointer) return;
    consume(event);
    if (anchor.kind !== 'drag') return;
    const point = surface(event, anchor.radius);
    if (!point) return;
    const delta = (Math.atan2(point.y, point.x) - anchor.angle) * 180 / Math.PI;
    queue({ angle_deg: displayInput(((anchor.group.angle_deg + anchor.angleSign * delta) % 360 + 360) % 360) % 360,
      height_mm: displayInput(anchor.group.height_mm + point.z - anchor.z) });
  }
  /** 松开时先发布最后一帧，再提交正式校验；箭头一次点击只产生一次微调和历史步骤。 */
  function up(event) {
    if (event.pointerId !== pointer) return;
    consume(event); flush();
    const finished = anchor;
    if (canvas.hasPointerCapture(pointer)) canvas.releasePointerCapture(pointer);
    pointer = null; anchor = null; controls.enabled = finished.cameraEnabled;
    if (finished.kind === 'drag' || finished.kind === 'pick') onChange('end');
    if (finished.kind === 'nudge') onChange('nudge', finished.action);
  }
  /** 指针取消只结束已发布的拖动，不把取消误当作箭头点击。 */
  function cancel(event) {
    if (event.pointerId !== pointer) return;
    if (anchor.kind === 'nudge') anchor.kind = 'select';
    up(event);
  }
  canvas.addEventListener('pointerdown', down, true);
  canvas.addEventListener('pointermove', move, true);
  canvas.addEventListener('pointerup', up, true);
  canvas.addEventListener('pointercancel', cancel, true);
  return {
    /** 更新组草稿和交互方式；null结束手势，并禁止离开页面后残留事件。 */
    setOptions(value) {
      options = value;
      if (!value && pointer !== null) cancel({ pointerId: pointer, preventDefault() {}, stopImmediatePropagation() {} });
    },
    /** 卸载监听器并取消尚未执行的帧，恢复相机。 */
    dispose() {
      if (pointer !== null) cancel({ pointerId: pointer, preventDefault() {}, stopImmediatePropagation() {} });
      if (frame !== null) window.cancelAnimationFrame(frame);
      frame = null; pending = null;
      canvas.removeEventListener('pointerdown', down, true); canvas.removeEventListener('pointermove', move, true);
      canvas.removeEventListener('pointerup', up, true); canvas.removeEventListener('pointercancel', cancel, true);
    },
  };
}
