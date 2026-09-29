/** 文件说明：把后端已验收的包络网格与位姿渲染为 Three.js 组；只显示正式包络和质心，不执行几何优化。 */

import * as THREE from 'three';

/** 创建毫米坐标的卫星包络与整体质心标记；返回的资源由宿主预览控制器统一释放。 */
export function createLayoutPlacementObjects(candidate, meshes) {
  const group = new THREE.Group();
  for (const placement of candidate.placements) {
    const source = meshes[placement.record_id];
    if (!source) throw new Error(`缺少 ${placement.name} 的正式包络快照`);
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(source.vertices.flat(), 3));
    geometry.setIndex(source.faces.flat());
    geometry.computeVertexNormals();
    const color = new THREE.Color().setHSL(placement.mount === 'top' ? 0.12 : (0.5 + placement.layer * 0.19) % 1, 0.65, 0.55);
    const mesh = new THREE.Mesh(geometry, new THREE.MeshStandardMaterial({
      color,
      roughness: 0.55,
      metalness: 0.05,
      transparent: true,
      opacity: 0.82,
      // 布局包络只显示外侧面，避免多颗卫星的背面面片叠加在内部。
      side: THREE.FrontSide,
    }));
    mesh.matrix.set(...placement.model_to_global_matrix.flat());
    mesh.matrixAutoUpdate = false;
    mesh.name = placement.name;
    mesh.userData.instanceId = placement.instance_id;
    mesh.userData.surfaceRole = 'payload';
    const edges = new THREE.LineSegments(new THREE.EdgesGeometry(geometry), new THREE.LineBasicMaterial({ color: color.clone().multiplyScalar(0.45) }));
    edges.userData.surfaceRole = 'payload';
    mesh.add(edges);
    group.add(mesh);
  }
  const marker = new THREE.Mesh(new THREE.SphereGeometry(candidate.fairing_radius_mm / 65, 16, 12), new THREE.MeshBasicMaterial({ color: 0xff456e, depthTest: false }));
  marker.position.fromArray(candidate.validation.center_of_mass_mm);
  marker.renderOrder = 5;
  marker.userData.surfaceRole = 'payload';
  marker.name = '整体卫星质心';
  group.add(marker);
  return group;
}
