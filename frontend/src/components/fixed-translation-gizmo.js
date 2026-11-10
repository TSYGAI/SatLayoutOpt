/** 文件说明：选中卫星的世界坐标六向平移控件；只提供位置箭头与拾取元数据，不参与姿态编辑或质量统计。 */
import * as THREE from 'three';
import { labelTexture } from './fixed-gizmo-label.js';

const AXES = [['x', new THREE.Vector3(1, 0, 0), 0xf06b69], ['y', new THREE.Vector3(0, 1, 0), 0x66d5a2], ['z', new THREE.Vector3(0, 0, 1), 0x6c9fff]];

/** 建立始终沿世界轴的六向控件；按服务端安装方式禁用顶部横向箭头，点击事件由画布控制器处理。 */
export function createFixedTranslationGizmo() {
  const object = new THREE.Group(); object.visible = false; object.name = '卫星世界坐标六向微调';
  const translation = new THREE.Group(); object.add(translation);
  const shaftGeometry = new THREE.CylinderGeometry(1, 1, 1, 8);
  const coneGeometry = new THREE.ConeGeometry(1, 1, 12);
  const arrows = [], up = new THREE.Vector3(0, 1, 0);
  let selected = null, sizePx = null;
  for (const [axis, vector, color] of AXES) {
    for (const sign of [1, -1]) {
      const direction = vector.clone().multiplyScalar(sign);
      const quaternion = new THREE.Quaternion().setFromUnitVectors(up, direction);
      const material = new THREE.MeshBasicMaterial({ color, depthTest: false, depthWrite: false, transparent: true });
      const shaft = new THREE.Mesh(shaftGeometry, material);
      shaft.quaternion.copy(quaternion); shaft.scale.set(0.018, 0.7, 0.018); shaft.position.copy(direction).multiplyScalar(0.45);
      shaft.renderOrder = 20; shaft.raycast = () => {};
      const cone = new THREE.Mesh(coneGeometry, material);
      cone.quaternion.copy(quaternion); cone.scale.set(0.075, 0.2, 0.075); cone.position.copy(direction).multiplyScalar(0.9);
      cone.renderOrder = 21;
      const pick = new THREE.Mesh(shaftGeometry, new THREE.MeshBasicMaterial({ visible: false }));
      pick.quaternion.copy(quaternion); pick.scale.set(0.07, 0.65, 0.07); pick.position.copy(direction).multiplyScalar(0.57);
      const text = `${sign > 0 ? '+' : '-'}${axis.toUpperCase()}`;
      const label = new THREE.Sprite(new THREE.SpriteMaterial({ map: labelTexture(text), depthTest: false, depthWrite: false }));
      label.position.copy(direction).multiplyScalar(1.17); label.scale.set(0.48, 0.24, 1); label.renderOrder = 22;
      label.raycast = () => {};
      const metadata = { surfaceRole: 'fixed-nudge', kind: 'translate', axis, sign, label: text, disabled: false };
      cone.userData = { ...metadata, pickPart: 'head' }; pick.userData = { ...metadata, pickPart: 'shaft' };
      translation.add(shaft, cone, pick, label);
      arrows.push({ shaft, cone, pick, label, material, direction });
    }
  }
  return {
    object,
    /** 更新选中本体、实际全局中心和屏幕尺寸；取消选择时隐藏，不销毁或重新创建控件。 */
    show(selection, center, pixels) {
      selected = selection; sizePx = pixels; object.visible = Boolean(selection);
      if (!selection) return;
      object.position.copy(center);
      for (const arrow of arrows) {
        const disabled = arrow.cone.userData.kind === 'translate' && selection.mount === 'top' && arrow.cone.userData.axis !== 'z';
        arrow.material.opacity = disabled ? 0.25 : 1;
        arrow.label.material.opacity = disabled ? 0.35 : 1;
        for (const target of [arrow.cone, arrow.pick]) Object.assign(target.userData, {
          disabled, instanceId: selection.instanceId, groupId: selection.groupId,
        });
      }
    },
    /** 只返回当前可见的位置箭头拾取根组，取消选择后不拦截画布操作。 */
    pickObject() { return object.visible ? translation : null; },
    /** 根据相机距离更新世界尺寸，控件方向和卫星局部朝向无关。 */
    update(camera, viewportHeight) {
      if (!selected || !sizePx) return;
      const distance = camera.position.distanceTo(object.position);
      const units = 2 * distance * Math.tan(camera.fov * Math.PI / 360) / Math.max(viewportHeight, 1);
      object.scale.setScalar(units * sizePx); object.updateMatrixWorld(true);
    },
    /** 返回箭头世界端点与当前可点击状态，供真实浏览器点击回归；不修改任何位姿。 */
    snapshot() {
      if (!object.visible) return null;
      object.updateMatrixWorld(true);
      return { instanceId: selected.instanceId, kind: 'translate', center: object.position.toArray(),
        arrows: arrows.map((arrow) => ({ axis: arrow.cone.userData.axis, sign: arrow.cone.userData.sign,
          kind: arrow.cone.userData.kind,
          label: arrow.cone.userData.label, disabled: arrow.cone.userData.disabled,
          point: arrow.cone.getWorldPosition(new THREE.Vector3()).toArray() })) };
    },
    /** 释放本控件拥有的全部材质、纹理和共享几何；不操作卫星显示缓存。 */
    dispose() {
      shaftGeometry.dispose(); coneGeometry.dispose();
      for (const arrow of arrows) {
        arrow.material.dispose(); arrow.pick.material.dispose(); arrow.label.material.map.dispose(); arrow.label.material.dispose();
      }
      object.removeFromParent(); object.clear(); selected = null;
    },
  };
}
