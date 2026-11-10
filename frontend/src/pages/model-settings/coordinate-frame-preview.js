/** 文件说明：坐标系草稿的 Three.js 辅助对象；只展示初始参考、新轴及质心，不保存设置或改写模型几何。 */
import * as THREE from 'three';
import { createCoordinateAxes, setCoordinateAxesSize } from '../../components/coordinate-axes.js';
import { currentToInitialMatrix, modelPoseMatrix } from './coordinate-frame.js';
import { disposeObject } from '../model-upload/model-preview-resources.js';

/** 创建可识别原始与草稿坐标系的文字标签。 */
function label(text, color) {
  const canvas = document.createElement('canvas'); canvas.width = 256; canvas.height = 96;
  const context = canvas.getContext('2d');
  context.fillStyle = '#172333'; context.fillRect(0, 0, 256, 96);
  context.fillStyle = color; context.textAlign = 'center'; context.font = 'bold 48px sans-serif'; context.fillText(text, 128, 66);
  const texture = new THREE.CanvasTexture(canvas);
  const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: texture, depthTest: false, depthWrite: false }));
  sprite.scale.set(0.55, 0.21, 1); sprite.position.set(0, -0.18, 0); return sprite;
}

/** 创建坐标编辑覆盖层；调用者负责让模型显示在初始坐标参考下。 */
export function createCoordinateFramePreview({ scene, camera, renderer, requestRender }) {
  const target = createCoordinateAxes({ name: 'COORDINATE_FRAME_DRAFT' });
  const initialLabel = new THREE.Group(); initialLabel.name = 'INITIAL_FRAME_LABEL'; initialLabel.userData.baseLength = 1;
  initialLabel.add(label('初始', '#ffffff')); target.add(label('预览', '#ffd36a'));
  const center = new THREE.Mesh(new THREE.SphereGeometry(1, 12, 8), new THREE.MeshBasicMaterial({ color: 0xffd36a, depthTest: false }));
  center.name = 'DRAFT_CENTER_OF_MASS';
  scene.add(target, initialLabel, center);
  let active = false;
  /** 更新固定屏幕尺寸，缩放和旋转相机后保持标签可读。 */
  function resize() {
    if (!active) return;
    setCoordinateAxesSize({ axes: target, camera, renderer }, target.position.clone());
    setCoordinateAxesSize({ axes: initialLabel, camera, renderer });
    center.scale.setScalar(target.scale.x * 0.035);
  }
  /** 显示经校验的新坐标和重新定位的质心；null 隐藏全部编辑对象。 */
  function update(frame, centerOfMass, transform = { scale: 1, rotation: [0, 0, 0] }) {
    active = Boolean(frame); target.visible = active; initialLabel.visible = active; center.visible = false;
    if (frame) {
      const pose = modelPoseMatrix(transform);
      const matrix = pose.clone().multiply(currentToInitialMatrix(frame));
      target.position.setFromMatrixPosition(matrix);
      target.quaternion.setFromRotationMatrix(new THREE.Matrix4().extractRotation(matrix));
      initialLabel.quaternion.setFromRotationMatrix(new THREE.Matrix4().extractRotation(pose));
      const values = ['x', 'y', 'z'].map((axis) => centerOfMass?.[axis]);
      if (values.every((v) => v !== '' && v != null && Number.isFinite(Number(v)))) {
        center.position.set(...values.map(Number)).applyMatrix4(matrix); center.visible = true;
      }
      resize();
    }
    requestRender();
  }
  /** 释放编辑覆盖层的几何、纹理和材质。 */
  function dispose() {
    [target, initialLabel, center].forEach((object) => {
      object.traverse((child) => child.material?.map?.dispose()); scene.remove(object); disposeObject(object);
    });
  }
  update(null);
  return { update, resize, dispose, getSnapshot: () => ({ active, origin: target.position.toArray(), center: center.visible ? center.position.toArray() : null }) };
}
