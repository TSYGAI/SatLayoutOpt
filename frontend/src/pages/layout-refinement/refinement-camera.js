/** 文件说明：按真实包围盒精确取景；以投影偏移居中局部对象，保持项目预览的整体旋转中心。 */
import * as THREE from 'three';

/** 保持观察方向和可选旋转中心，完整取景并返回 OrbitControls 目标；width/height 使用画布 CSS 像素。 */
export function fitCameraBounds(camera, bounds, fillRatio, options = {}) {
  const center = bounds.getCenter(new THREE.Vector3());
  const target = options.target ?? center;
  const width = options.width ?? (camera.aspect || 1), height = options.height ?? 1;
  camera.clearViewOffset();
  camera.updateMatrixWorld(true);
  const right = new THREE.Vector3().setFromMatrixColumn(camera.matrixWorld, 0);
  const up = new THREE.Vector3().setFromMatrixColumn(camera.matrixWorld, 1);
  const backward = new THREE.Vector3().setFromMatrixColumn(camera.matrixWorld, 2);
  const offset = center.clone().sub(target);
  const cx = offset.dot(right), cy = offset.dot(up), cz = offset.dot(backward);
  const corners = [];
  for (const x of [bounds.min.x, bounds.max.x]) for (const y of [bounds.min.y, bounds.max.y]) for (const z of [bounds.min.z, bounds.max.z]) {
    const relative = new THREE.Vector3(x, y, z).sub(center);
    corners.push([relative.dot(right), relative.dot(up), relative.dot(backward)]);
  }
  const extent = Math.max(bounds.getSize(new THREE.Vector3()).length(), camera.near * 2);
  let distance = Math.max(extent * 2 + cz, extent * 2, options.minDistance ?? 0);
  if (camera.isPerspectiveCamera) {
    const tangent = Math.tan(THREE.MathUtils.degToRad(camera.fov) / 2);
    const aspect = width / height;
    /** 按中心投影平移后的角点计算占比；保持固定旋转中心时同时计入透视深度差。 */
    function fits(value) {
      const depth = value - cz;
      return corners.every(([x, y, z]) => {
        const pointDepth = depth - z;
        return pointDepth > camera.near
          && Math.abs((cx + x) / pointDepth - cx / depth) <= tangent * aspect * fillRatio
          && Math.abs((cy + y) / pointDepth - cy / depth) <= tangent * fillRatio;
      });
    }
    let lower = Math.max(options.minDistance ?? 0, cz + Math.max(...corners.map(([, , z]) => z)) + camera.near);
    let upper = Math.max(distance, lower + extent);
    while (!fits(upper)) upper = lower + (upper - lower) * 2;
    for (let step = 0; step < 60; step += 1) {
      const middle = (lower + upper) / 2;
      if (fits(middle)) upper = middle; else lower = middle;
    }
    distance = upper;
    camera.zoom = 1;
  } else {
    const width = Math.max(...corners.map(([x]) => Math.abs(x))) * 2;
    const height = Math.max(...corners.map(([, y]) => Math.abs(y))) * 2;
    camera.zoom = Math.min((camera.right - camera.left) / Math.max(width, camera.near), (camera.top - camera.bottom) / Math.max(height, camera.near)) * fillRatio;
  }
  camera.position.copy(target).addScaledVector(backward, distance);
  camera.far = Math.max(camera.far, distance - cz + extent * 2);
  camera.lookAt(target); camera.updateProjectionMatrix(); camera.updateMatrixWorld(true);
  const projected = center.clone().project(camera);
  if (Math.abs(projected.x) + Math.abs(projected.y) > 1e-8) {
    camera.setViewOffset(width, height, projected.x * width / 2, -projected.y * height / 2, width, height);
  }
  return target;
}
