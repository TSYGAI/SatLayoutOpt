/** 文件说明：仅渲染固定卫星包络和真实质心，包络承担拾取并按实例标红；缓存矩阵逐帧更新，不计算碰撞规则。 */
import * as THREE from 'three';

/** 更新单个包络的违规颜色，保留几何/材质对象；返回合法后恢复各自默认颜色。 */
function setConstraintColor(mesh, placement) {
  const invalid = placement.constraint_valid === false || placement.boundary_valid === false;
  mesh.userData.constraintInvalid = invalid;
  mesh.material.color.setHex(invalid ? 0xff405d : 0x39d0e9);
  mesh.material.emissive?.setHex(invalid ? 0x480817 : 0x000000);
  for (const outline of mesh.children) if (outline.isLineSegments) outline.material.color.setHex(invalid ? 0xff405d : 0x39d0e9);
}

/** 创建共享包络实例组；包络接收射线、轮廓忽略射线，无已放置质量时不创建质心标记。 */
export function createFixedPlacementObjects(candidate, meshes, cache, opacity) {
  const group = new THREE.Group();
  group.userData.fixedInstances = new Map();
  for (const placement of candidate.placements) {
    const key = placement.record_id;
    if (!meshes[key]) continue;
    const { geometry, edges } = cache.get(key, meshes[key]);
    const mesh = new THREE.Mesh(geometry, new THREE.MeshStandardMaterial({
      color: 0x39d0e9, transparent: true, opacity,
      depthWrite: false, roughness: 0.6, side: THREE.DoubleSide,
    }));
    mesh.matrix.set(...placement.model_to_global_matrix.flat());
    mesh.matrixAutoUpdate = false;
    mesh.userData = { sharedLayoutGeometry: true, surfaceRole: 'fixed-envelope',
      instanceId: placement.instance_id, groupId: placement.fixed_group_id, mount: placement.mount };
    const outline = new THREE.LineSegments(edges, new THREE.LineBasicMaterial({ color: 0x39d0e9 }));
    outline.userData = { sharedLayoutGeometry: true, surfaceRole: 'fixed-envelope' };
    outline.raycast = () => {};
    mesh.add(outline);
    setConstraintColor(mesh, placement);
    group.add(mesh);
    if (!group.userData.fixedInstances.has(placement.instance_id)) group.userData.fixedInstances.set(placement.instance_id, []);
    group.userData.fixedInstances.get(placement.instance_id).push(mesh);
  }
  if (candidate.validation.total_mass_kg > 0) {
    const marker = new THREE.Mesh(new THREE.SphereGeometry(candidate.fairing_radius_mm / 65, 16, 12),
      new THREE.MeshBasicMaterial({ color: 0xff456e, depthTest: false }));
    marker.position.fromArray(candidate.validation.center_of_mass_mm);
    marker.name = candidate.validation.center_label;
    marker.renderOrder = 5;
    marker.raycast = () => {};
    group.userData.fixedCenterMarker = marker;
    group.add(marker);
  }
  return group;
}

/** 在成员不变时直接更新包络的缓存矩阵及同快照质心；返回false要求重新建立成员。 */
export function updateFixedPlacementObjects(group, candidate) {
  const instances = group.userData.fixedInstances;
  if (!instances || instances.size !== candidate.placements.length || candidate.placements.some((item) => !instances.has(item.instance_id))) return false;
  for (const placement of candidate.placements) {
    for (const mesh of instances.get(placement.instance_id)) {
      if (mesh.userData.groupId !== placement.fixed_group_id || mesh.userData.mount !== placement.mount) return false;
    }
  }
  for (const placement of candidate.placements) {
    for (const mesh of instances.get(placement.instance_id)) {
      mesh.matrix.set(...placement.model_to_global_matrix.flat()); mesh.matrixWorldNeedsUpdate = true;
      setConstraintColor(mesh, placement);
    }
  }
  const marker = group.userData.fixedCenterMarker;
  if (marker) { marker.position.fromArray(candidate.validation.center_of_mass_mm); marker.name = candidate.validation.center_label; }
  group.userData.fixedCandidate = candidate;
  return true;
}
