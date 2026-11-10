/** 文件说明：将服务端包络和位姿渲染为Three.js组；按统一配置区分固定星/剩余星，材质复用包络显示模块；显示真实质心标签，不执行几何优化。 */

import * as THREE from 'three';
import { createEnvelopeSurfaceMaterial, createEnvelopeEdgeMaterial } from './envelope-preview-appearance.js';

/** 创建毫米坐标的实例与质心标记；共享几何由显式 cache 拥有，实例材质由宿主逐个释放。 */
export function createLayoutPlacementObjects(candidate, meshes, cache, style) {
  const group = new THREE.Group();
  const resources = new Map();
  for (const placement of candidate.placements) {
    const source = meshes[placement.record_id];
    if (!source) throw new Error(`缺少 ${placement.name} 的正式包络快照`);
    if (!resources.has(placement.record_id)) resources.set(placement.record_id, cache.get(placement.record_id, source));
  }
  for (const placement of candidate.placements) {
    const { geometry, edges: edgeGeometry } = resources.get(placement.record_id);
    const color = new THREE.Color(placement.fixed === true ? style.fixedColor : style.optimizedColor);
    const mesh = new THREE.Mesh(geometry, createEnvelopeSurfaceMaterial(color, style.opacity));
    mesh.matrix.set(...placement.model_to_global_matrix.flat());
    mesh.matrixAutoUpdate = false;
    mesh.name = placement.name;
    mesh.userData.instanceId = placement.instance_id;
    mesh.userData.fixed = placement.fixed === true;
    mesh.userData.surfaceRole = 'payload';
    mesh.userData.sharedLayoutGeometry = true;
    const edges = new THREE.LineSegments(edgeGeometry, createEnvelopeEdgeMaterial(color));
    edges.userData.surfaceRole = 'payload';
    edges.userData.sharedLayoutGeometry = true;
    mesh.add(edges);
    group.add(mesh);
  }
  const marker = new THREE.Mesh(new THREE.SphereGeometry(candidate.fairing_radius_mm / 65, 16, 12), new THREE.MeshBasicMaterial({ color: 0xff456e, depthTest: false }));
  marker.position.fromArray(candidate.validation.center_of_mass_mm);
  marker.renderOrder = 5;
  marker.userData.surfaceRole = 'payload';
  marker.name = candidate.validation.center_label || '整体卫星质心';
  group.add(marker);
  return group;
}
