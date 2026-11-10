/**
 * 文件说明：共用整流罩边线，按相机与真实罩体的遮挡关系分为实线和虚线。
 * 复用 Three.js 标准线材质与已有 BVH 依赖，兼容 WebGPU/WebGL；仅更新显示缓冲区，不改变罩体、卫星或业务校验。
 */
import * as THREE from 'three';
import { MeshBVH } from 'three-mesh-bvh';

/** 用原始顶点坐标标识无向边；跨分段重复顶点仍能找到两侧相邻面，且不修改业务网格索引。 */
function edgeKey(a, b) {
  const left = a.toArray().join(','), right = b.toArray().join(',');
  return left < right ? `${left}/${right}` : `${right}/${left}`;
}

/** 收集每条轮廓边相邻面的外法线，稳定识别端盖边界和与视线平行的切线，避免射线恰过三角边时漏判。 */
function collectEdgeNormals(geometry, positions) {
  const requested = new Map(), result = [], a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3();
  for (let offset = 0; offset < positions.length; offset += 6) {
    const key = edgeKey(a.fromArray(positions, offset), b.fromArray(positions, offset + 3));
    if (!requested.has(key)) requested.set(key, []);
    result.push(requested.get(key));
  }
  const source = geometry.getAttribute('position'), index = geometry.index;
  for (let offset = 0; offset < (index?.count ?? source.count); offset += 3) {
    a.fromBufferAttribute(source, index ? index.getX(offset) : offset);
    b.fromBufferAttribute(source, index ? index.getX(offset + 1) : offset + 1);
    c.fromBufferAttribute(source, index ? index.getX(offset + 2) : offset + 2);
    const normal = new THREE.Triangle(a, b, c).getNormal(new THREE.Vector3());
    for (const key of [edgeKey(a, b), edgeKey(b, c), edgeKey(c, a)]) requested.get(key)?.push(normal);
  }
  return result;
}

/**
 * 创建相机相关的整流罩轮廓；接管 edgeGeometry，返回的 object 由宿主加入与 surface 相同的父级并释放。
 * style 来自统一 TOML，包含虚线屏幕尺寸及自相交容差；未加载时保留完整实线，配置后下一帧即更新。
 */
export function createFairingBoundaryEdges({ surface, edgeGeometry, color, opacity, style = null }) {
  const source = edgeGeometry.index ? edgeGeometry.toNonIndexed() : edgeGeometry;
  const positions = source.getAttribute('position').array.slice();
  source.dispose();
  if (source !== edgeGeometry) edgeGeometry.dispose();
  // BVH 节点边界包含数值余量；实体取景继续使用原始顶点边界，避免改变相机中心和历史坐标快照。
  if (!surface.geometry.boundingBox) surface.geometry.computeBoundingBox();
  const bvh = new MeshBVH(surface.geometry, { indirect: true, setBoundingBox: false });
  const edgeNormals = collectEdgeNormals(surface.geometry, positions);
  const sphere = surface.geometry.boundingBox.getBoundingSphere(new THREE.Sphere());
  const object = new THREE.Group(); object.name = 'fairing-boundary-edges';
  const solid = new THREE.LineSegments(new THREE.BufferGeometry(), new THREE.LineBasicMaterial({
    color, transparent: true, opacity, depthWrite: false,
  }));
  const hidden = new THREE.LineSegments(new THREE.BufferGeometry(), new THREE.LineDashedMaterial({
    color, transparent: true, opacity, depthWrite: false,
  }));
  for (const line of [solid, hidden]) {
    line.geometry.setAttribute('position', new THREE.BufferAttribute(positions.slice(), 3).setUsage(THREE.DynamicDrawUsage));
    line.geometry.boundingSphere = sphere.clone();
    line.userData.appearanceRole = 'fairing-boundary';
    line.userData.fairingEdgeStyle = line === solid ? 'solid' : 'hidden';
    line.renderOrder = 2;
  }
  hidden.geometry.setAttribute('lineDistance', new THREE.BufferAttribute(new Float32Array(positions.length / 3), 1)
    .setUsage(THREE.DynamicDrawUsage));
  hidden.geometry.setDrawRange(0, 0);
  object.add(solid, hidden);
  const start = new THREE.Vector3(), end = new THREE.Vector3(), midpoint = new THREE.Vector3();
  const eye = new THREE.Vector3(), towardCamera = new THREE.Vector3(), previousEye = new THREE.Vector3();
  const previousDirection = new THREE.Vector3(), scale = new THREE.Vector3(), inverse = new THREE.Matrix4(), ray = new THREE.Ray();
  const distances = new Float32Array(positions.length / 3);
  let currentStyle = style, dirty = true, previousOrthographic = false;
  // 圆环按局部极角保持连续虚线相位，避免交错排列的上、下圆环互相影响；侧向边线按高度累计。
  for (let offset = 0; offset < positions.length; offset += 6) {
    start.fromArray(positions, offset); end.fromArray(positions, offset + 3);
    const radius = Math.hypot(start.x, start.y);
    const angle = (Math.atan2(start.y, start.x) + 2 * Math.PI) % (2 * Math.PI);
    let delta = (Math.atan2(end.y, end.x) + 2 * Math.PI) % (2 * Math.PI) - angle;
    if (delta > Math.PI) delta -= 2 * Math.PI;
    if (delta < -Math.PI) delta += 2 * Math.PI;
    const index = offset / 3;
    distances[index] = start.z === end.z ? angle * radius : start.z;
    distances[index + 1] = start.z === end.z ? (angle + delta) * radius : end.z;
  }

  return { object,
    /** 替换已加载的显示配置；宿主负责请求下一帧，无需重建几何或 BVH。 */
    configure(next) { currentStyle = next; dirty = true; },
    /**
     * 每次绘制前同步遮挡与虚线尺寸；相机和罩体相对位置不变时复用分类结果。
     * 透视使用逐点视线，正交使用平行视线；排除边线自身的数值误差，不受卫星显示开关影响。
     */
    update(camera, viewportHeight) {
      if (!currentStyle || !object.visible || (!solid.visible && !hidden.visible)) return;
      surface.updateWorldMatrix(true, false); camera.updateWorldMatrix(true, false);
      inverse.copy(surface.matrixWorld).invert();
      eye.setFromMatrixPosition(camera.matrixWorld).applyMatrix4(inverse);
      towardCamera.set(0, 0, 1).transformDirection(camera.matrixWorld).transformDirection(inverse);
      const orthographic = Boolean(camera.isOrthographicCamera);
      const worldScale = scale.setFromMatrixScale(surface.matrixWorld).x;
      const unitsPerPixel = orthographic ? (camera.top - camera.bottom) / camera.zoom / worldScale / Math.max(viewportHeight, 1)
        : 2 * eye.distanceTo(sphere.center) * Math.tan(THREE.MathUtils.degToRad(camera.fov / 2))
          / camera.zoom / Math.max(viewportHeight, 1);
      hidden.material.dashSize = currentStyle.dashPx * unitsPerPixel;
      hidden.material.gapSize = currentStyle.gapPx * unitsPerPixel;
      if (!dirty && previousOrthographic === orthographic && eye.equals(previousEye)
        && (!orthographic || towardCamera.equals(previousDirection))) return;
      dirty = false; previousOrthographic = orthographic;
      previousEye.copy(eye); previousDirection.copy(towardCamera);
      const epsilon = sphere.radius * currentStyle.rayEpsilonRatio;
      const counts = [0, 0], lines = [solid, hidden];
      for (let offset = 0; offset < positions.length; offset += 6) {
        start.fromArray(positions, offset); end.fromArray(positions, offset + 3);
        midpoint.copy(start).add(end).multiplyScalar(0.5);
        ray.origin.copy(midpoint);
        if (orthographic) ray.direction.copy(towardCamera);
        else ray.direction.subVectors(eye, midpoint).normalize();
        const normals = edgeNormals[offset / 6];
        const facing = !normals.length || normals.some((normal) => normal.dot(ray.direction) > currentStyle.rayEpsilonRatio);
        const hit = facing && bvh.raycastFirst(ray, THREE.DoubleSide, epsilon, orthographic ? Infinity : midpoint.distanceTo(eye) - epsilon);
        const bucket = !facing || hit ? 1 : 0, target = lines[bucket].geometry, vertex = counts[bucket];
        target.getAttribute('position').array.set(positions.subarray(offset, offset + 6), vertex * 3);
        if (bucket) target.getAttribute('lineDistance').array.set(distances.subarray(offset / 3, offset / 3 + 2), vertex);
        counts[bucket] += 2;
      }
      lines.forEach((line, index) => {
        line.geometry.setDrawRange(0, counts[index]);
        line.geometry.getAttribute('position').needsUpdate = true;
      });
      hidden.geometry.getAttribute('lineDistance').needsUpdate = true;
    },
    /** 返回当前分类计数，供交互验收确认相机旋转确实更新边线；不暴露场景修改入口。 */
    snapshot() { return { solidSegments: solid.geometry.drawRange.count === Infinity ? positions.length / 6 : solid.geometry.drawRange.count / 2,
      hiddenSegments: hidden.geometry.drawRange.count / 2 }; },
  };
}
