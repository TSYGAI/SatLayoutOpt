/**
 * 文件说明：三维预览共享的世界原点坐标系，供模型上传、模型设置与前置配置页复用。
 * 坐标系固定在 STEP 或圆柱原点，由细杆、锥形箭头与 X/Y/Z 字母标签构成，并按屏幕像素高度
 * 保持恒定视觉大小，因此缩放视图时不会变大或变小。本模块只创建 Three.js 对象，
 * 不读取页面状态，也不注册事件。
 */

import * as THREE from 'three';

/** 坐标轴箭头在屏幕上占据的高度，单位为像素。 */
const COORDINATE_AXIS_PIXELS = 160;
/** X/Y/Z 字母标签的画布纹理边长，单位为像素。 */
const COORDINATE_AXIS_LABEL_TEXTURE_SIZE = 256;
/** 轴杆圆柱的圆周分段数。 */
const COORDINATE_AXIS_SHAFT_SEGMENTS = 12;
/** 锥形箭头的圆周分段数。 */
const COORDINATE_AXIS_HEAD_SEGMENTS = 16;
/** 轴杆与箭头在场景单位下的基准长度，实际显示比例由 `setCoordinateAxesSize` 统一缩放。 */
const AXIS_SHAFT_LENGTH = 0.88;
const AXIS_HEAD_LENGTH = 0.12;
/** 三个轴各自的颜色，X 红、Y 绿、Z 蓝，与方向立方体保持一致。 */
export const COORDINATE_AXIS_COLORS = Object.freeze({ x: '#d4493d', y: '#2f9863', z: '#3d6fc4' });

/** 复用的相机空间坐标缓存，避免每帧分配新向量。 */
const AXES_CAMERA_SPACE_POSITION = new THREE.Vector3();

/**
 * 创建一个带 X/Y/Z 字母标签的坐标轴箭头。
 * @param {string} label 轴名称，显示在箭头末端。
 * @param {string} color 轴颜色，CSS 颜色字符串。
 * @param {THREE.Vector3} direction 轴方向，必须为单位向量。
 * @returns {THREE.Group} 已按方向旋转的箭头组。
 */
function createCoordinateAxisArrow(label, color, direction) {
  const axis = new THREE.Group();
  const material = new THREE.MeshBasicMaterial({
    color,
    transparent: false,
    opacity: 1,
    depthTest: true,
    depthWrite: true,
    blending: THREE.NoBlending,
    toneMapped: false,
  });
  const shaft = new THREE.Mesh(
    new THREE.CylinderGeometry(0.008, 0.008, AXIS_SHAFT_LENGTH, COORDINATE_AXIS_SHAFT_SEGMENTS),
    material,
  );
  const tip = new THREE.Mesh(
    new THREE.ConeGeometry(0.026, AXIS_HEAD_LENGTH, COORDINATE_AXIS_HEAD_SEGMENTS),
    material.clone(),
  );
  shaft.position.y = AXIS_SHAFT_LENGTH / 2;
  tip.position.y = AXIS_SHAFT_LENGTH + AXIS_HEAD_LENGTH / 2;
  shaft.renderOrder = 2;
  tip.renderOrder = 2;
  axis.add(shaft, tip, createCoordinateAxisLabel(label, color));
  axis.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), direction);
  return axis;
}

/**
 * 创建白描边的字母标签精灵，保证在深浅背景上都可读。
 * @param {string} label 单字母轴名称。
 * @param {string} color 字母填充色。
 * @returns {THREE.Sprite} 固定在箭头末端的标签精灵。
 */
function createCoordinateAxisLabel(label, color) {
  const canvas = document.createElement('canvas');
  canvas.width = COORDINATE_AXIS_LABEL_TEXTURE_SIZE;
  canvas.height = COORDINATE_AXIS_LABEL_TEXTURE_SIZE;
  const context = canvas.getContext('2d');
  context.textAlign = 'center';
  context.textBaseline = 'middle';
  context.font = '700 216px sans-serif';
  context.lineJoin = 'round';
  context.lineWidth = 16;
  context.strokeStyle = 'rgba(255, 255, 255, 0.96)';
  context.strokeText(label, 128, 136);
  context.fillStyle = color;
  context.fillText(label, 128, 136);
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.generateMipmaps = false;
  texture.minFilter = THREE.LinearFilter;
  texture.magFilter = THREE.LinearFilter;
  const sprite = new THREE.Sprite(new THREE.SpriteMaterial({
    map: texture,
    transparent: true,
    opacity: 1,
    depthTest: true,
    depthWrite: false,
    toneMapped: false,
  }));
  sprite.scale.set(0.075, 0.075, 1);
  sprite.position.set(0, 1.1, 0);
  sprite.renderOrder = 3;
  return sprite;
}

/**
 * 创建固定在原点的世界坐标系。
 * @param {{ name?: string }} [options] 可选对象名，便于测试与排障时定位。
 * @returns {THREE.Group} 含三个箭头轴与字母标签的坐标系组。
 */
export function createCoordinateAxes(options = {}) {
  const axes = new THREE.Group();
  axes.name = options.name || 'STEP_ORIGIN_AXES';
  axes.userData.baseLength = 1;
  axes.add(
    createCoordinateAxisArrow('X', COORDINATE_AXIS_COLORS.x, new THREE.Vector3(1, 0, 0)),
    createCoordinateAxisArrow('Y', COORDINATE_AXIS_COLORS.y, new THREE.Vector3(0, 1, 0)),
    createCoordinateAxisArrow('Z', COORDINATE_AXIS_COLORS.z, new THREE.Vector3(0, 0, 1)),
  );
  return axes;
}

/**
 * 按相机距离缩放坐标系，使箭头在屏幕上始终占据恒定像素高度。
 * @param {{ axes: THREE.Group|null, camera: THREE.PerspectiveCamera, renderer: THREE.WebGLRenderer }} scene
 *   需要同步尺寸的场景对象；缺少任一项时直接返回。
 * @param {THREE.Vector3} [position] 坐标系应放置的世界坐标，缺省为原点。
 * @returns {void}
 */
export function setCoordinateAxesSize(scene, position = null) {
  const { axes, camera, renderer } = scene || {};
  if (!axes || !camera || !renderer) return;
  if (position) axes.position.copy(position);
  else axes.position.set(0, 0, 0);
  const viewportHeight = Math.max(renderer.domElement.clientHeight, 1);
  const baseLength = Number(axes.userData.baseLength);
  if (!Number.isFinite(baseLength) || baseLength <= 0) return;
  camera.updateMatrixWorld();
  const cameraSpacePosition = axes.getWorldPosition(AXES_CAMERA_SPACE_POSITION).applyMatrix4(camera.matrixWorldInverse);
  const depth = -cameraSpacePosition.z;
  if (!Number.isFinite(depth) || depth <= camera.near) return;
  const visibleHeight = 2 * depth * Math.tan(THREE.MathUtils.degToRad(camera.fov / 2));
  const scale = (visibleHeight * COORDINATE_AXIS_PIXELS) / viewportHeight / baseLength;
  if (Number.isFinite(scale) && scale > 0) axes.scale.setScalar(scale);
}
