/** 文件说明：把鼠标位移换算为绕筒转角或顶部水平平移；使用真实抓取点与相机投影，不判断业务约束。 */
import * as THREE from 'three';

/** 根据当前相机计算绕世界 Z 轴的拖动弧度；像素位移沿可见切线换算，退化视角返回零。 */
export function screenAngularDelta(camera, point, delta, width, height) {
  const projection = new THREE.Matrix4().multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
  const position = new THREE.Vector4(point.x, point.y, point.z, 1).applyMatrix4(projection);
  const direction = new THREE.Vector4(-point.y, point.x, 0, 0).applyMatrix4(projection);
  if (position.w <= 0) return 0;
  const divisor = position.w * position.w;
  const x = (direction.x * position.w - position.x * direction.w) / divisor * width / 2;
  const y = -(direction.y * position.w - position.y * direction.w) / divisor * height / 2;
  const length = x * x + y * y;
  if (!Number.isFinite(length) || length <= Number.EPSILON * width * height) return 0;
  return Math.atan2(delta[0] * x + delta[1] * y, length);
}

/** 将屏幕位移投影到抓取点所在的水平面，返回世界 XY 增量；射线平行或位于相机后方时返回 null。 */
export function screenPlanarDelta(camera, point, delta, width, height) {
  if (width <= 0 || height <= 0) return null;
  const projected = point.clone().project(camera), raycaster = new THREE.Raycaster();
  raycaster.setFromCamera(new THREE.Vector2(projected.x + delta[0] * 2 / width, projected.y - delta[1] * 2 / height), camera);
  if (Math.abs(raycaster.ray.direction.z) <= Number.EPSILON) return null;
  const target = raycaster.ray.intersectPlane(new THREE.Plane(new THREE.Vector3(0, 0, 1), -point.z), new THREE.Vector3());
  return target && Number.isFinite(target.x) && Number.isFinite(target.y) ? [target.x - point.x, target.y - point.y] : null;
}
