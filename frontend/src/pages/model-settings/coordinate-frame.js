/** 文件说明：模型坐标系编辑的纯数值定义与预览矩阵；后端负责最终校验，输入始终相对初始 STEP。 */
import { Euler, Matrix4, Quaternion, Vector3 } from 'three';

/** 返回每次独立分配的初始坐标系定义。 */
export function defaultCoordinateFrame() {
  return { version: 1, origin: { x: 0, y: 0, z: 0 }, orientation: { mode: 'euler_xyz', angles_deg: { x: 0, y: 0, z: 0 } } };
}

/** 读取完整有限的三维输入；空值不自动解释成零。 */
function point(value) {
  if (!value || Object.keys(value).length !== 3) throw new Error('坐标必须完整填写 X、Y、Z');
  const numbers = ['x', 'y', 'z'].map((axis) => {
    const v = value[axis];
    if (v === '' || v == null || typeof v === 'boolean' || !Number.isFinite(Number(v))) throw new Error('坐标和角度必须为有限数值');
    return Number(v);
  });
  return new Vector3(...numbers);
}

/** 校验并复制编辑定义，保留原始输入模式和参数供再次编辑回填。 */
export function normalizeCoordinateFrame(value) {
  const frame = value ?? defaultCoordinateFrame();
  if (frame.version !== 1) throw new Error('坐标系版本不受支持');
  const origin = point(frame.origin);
  const orientation = frame.orientation;
  let result;
  if (orientation?.mode === 'euler_xyz') {
    const angles = point(orientation.angles_deg);
    result = { version: 1, origin: vectorObject(origin), orientation: { mode: 'euler_xyz', angles_deg: vectorObject(angles) } };
  } else if (orientation?.mode === 'three_points') {
    result = { version: 1, origin: vectorObject(origin), orientation: { mode: 'three_points',
      x_point: vectorObject(point(orientation.x_point)), xy_point: vectorObject(point(orientation.xy_point)) } };
    axesMatrix(result);
  } else throw new Error('请选择角度或三点定义');
  return result;
}

/** 将 Three.js 向量转换为可保存的坐标对象。 */
function vectorObject(v) { return { x: v.x, y: v.y, z: v.z }; }

/** 对参考方向进行稳定归一化；拒绝重合和数值溢出。 */
function unitDirection(v) {
  const magnitude = Math.max(Math.abs(v.x), Math.abs(v.y), Math.abs(v.z));
  if (!Number.isFinite(magnitude) || magnitude === 0) throw new Error('参考点不能与原点重合或超出数值范围');
  return v.divideScalar(magnitude).normalize();
}

/** 构造当前轴在初始坐标中的方向；固定初始轴 X→Y→Z 对应 Rz·Ry·Rx。 */
function axesMatrix(frame) {
  const o = frame.orientation;
  if (o.mode === 'euler_xyz') {
    const degrees = point(o.angles_deg);
    const a = new Vector3(...['x', 'y', 'z'].map((axis) => ((degrees[axis] % 360 + 360) % 360) * Math.PI / 180));
    return new Matrix4().makeRotationFromEuler(new Euler(a.x, a.y, a.z, 'ZYX'));
  }
  const origin = point(frame.origin);
  const x = unitDirection(point(o.x_point).sub(origin));
  const plane = unitDirection(point(o.xy_point).sub(origin));
  const z = new Vector3().crossVectors(x, plane);
  if (z.length() <= Number.EPSILON * 64) throw new Error('三个参考点不能共线或接近共线');
  z.normalize();
  return new Matrix4().makeBasis(x, new Vector3().crossVectors(z, x), z);
}

/** 返回当前坐标到初始坐标的编辑矩阵，仅供定义和预览，不供优化中转。 */
export function currentToInitialMatrix(value) {
  const frame = normalizeCoordinateFrame(value);
  return axesMatrix(frame).setPosition(point(frame.origin));
}

/** 返回初始模型几何进入当前模型坐标的准备矩阵。 */
export function initialToCurrentMatrix(value) { return currentToInitialMatrix(value).invert(); }

/** 返回现有单位、比例和 XYZ 初始姿态的渲染矩阵。 */
export function modelPoseMatrix(transform) {
  return new Matrix4().compose(new Vector3(), new Quaternion().setFromEuler(new Euler(...transform.rotation, 'XYZ')),
    new Vector3().setScalar(transform.scale));
}

/** 给原始几何对象设置完整准备与显示矩阵，不改写共享顶点缓存。 */
export function applySourceDisplayTransform(object, transform, frame) {
  const matrix = modelPoseMatrix(transform).multiply(initialToCurrentMatrix(frame));
  matrix.decompose(object.position, object.quaternion, object.scale);
  object.updateMatrixWorld(true);
}
