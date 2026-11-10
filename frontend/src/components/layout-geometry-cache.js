/** 文件说明：视口独占管理同型号共享 BufferGeometry 的生命周期；实例只拥有材质和位姿，数组由 Worker 提供。 */
import * as THREE from 'three';

/** 创建有明确所有权的几何池；只保存当前选择提供的型号，释放操作幂等。 */
export function createLayoutGeometryCache() {
  const entries = new Map();
  let created = 0, released = 0;
  /** 释放一个型号的表面和边线，调用前宿主须先移除引用该型号的实例。 */
  function release(id) {
    const entry = entries.get(id);
    if (!entry) return;
    entry.geometry.dispose(); entry.edges.dispose(); entries.delete(id); released += 1;
  }
  return {
    /** 移除已不需要或源数组已变化的型号；不清空仍被新方案使用的几何。 */
    sync(meshes) {
      for (const [id, entry] of entries) if (meshes[id] !== entry.source) release(id);
    },
    /** 获取共享表面、法向、索引与边线；BufferAttribute 直接引用 TypedArray，不复制数组。 */
    get(id, source) {
      if (entries.get(id)?.source === source) return entries.get(id);
      if (!(source?.positions instanceof Float32Array) || !(source?.indices instanceof Uint32Array)
          || !(source?.normals instanceof Float32Array) || !(source?.edgePositions instanceof Float32Array)) {
        throw new Error(`型号 ${id} 缺少已准备的显示网格`);
      }
      release(id);
      const geometry = new THREE.BufferGeometry(), edges = new THREE.BufferGeometry();
      geometry.setAttribute('position', new THREE.BufferAttribute(source.positions, 3));
      geometry.setAttribute('normal', new THREE.BufferAttribute(source.normals, 3));
      geometry.setIndex(new THREE.BufferAttribute(source.indices, 1));
      geometry.boundingBox = new THREE.Box3(new THREE.Vector3().fromArray(source.bounds.min), new THREE.Vector3().fromArray(source.bounds.max));
      geometry.boundingSphere = new THREE.Sphere(new THREE.Vector3().fromArray(source.sphere.center), source.sphere.radius);
      edges.setAttribute('position', new THREE.BufferAttribute(source.edgePositions, 3));
      edges.boundingBox = geometry.boundingBox.clone(); edges.boundingSphere = geometry.boundingSphere.clone();
      const entry = { source, geometry, edges };
      entries.set(id, entry); created += 1;
      return entry;
    },
    /** 释放所有型号；宿主清空、切任务或卸载时调用，重复调用安全。 */
    dispose() { for (const id of [...entries.keys()]) release(id); },
    /** 返回只读统计，记录真实数组容量以及累计建立/释放数供长期切换验收。 */
    snapshot() {
      return { models: entries.size, bytes: [...entries.values()].reduce((sum, item) => sum + item.source.bytes, 0), created, released };
    },
  };
}
