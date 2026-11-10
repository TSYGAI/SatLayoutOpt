/** 文件说明：校验版本化布局显示网格并派生共享法向/边线；供 Worker 和纯数据测试使用，不接触页面或 GPU。 */
import * as THREE from 'three';

/** 根据数组规模预估派生资源及边线临时表，超出预算时在计算前拒绝；返回最终资源上界。 */
export function checkMeshBudget(vertices, indices, limits) {
  const bytes = vertices * 24 + indices * 28;
  if (bytes > limits.geometryMaxBytes || vertices * 24 + indices * 160 > limits.workerMaxBytes) {
    throw new Error('当前型号超过布局预览内存预算，请降低预览复杂度或调整配置');
  }
  return bytes;
}

/** 校验小端格式、长度和全部数组元素，返回直接引用二进制缓冲的 TypedArray，失败抛出可显示错误。 */
export function decodeLayoutMesh(buffer, limits) {
  if (!(buffer instanceof ArrayBuffer) || buffer.byteLength < 32 || buffer.byteLength > limits.downloadMaxBytes) {
    throw new Error('布局网格文件长度无效或超过下载预算');
  }
  const header = new DataView(buffer);
  if (new TextDecoder().decode(new Uint8Array(buffer, 0, 8)) !== 'SATMSH01' || header.getUint32(8, true) !== 1
      || header.getUint32(20, true) !== 0 || header.getUint32(24, true) !== 0 || header.getUint32(28, true) !== 0) {
    throw new Error('不支持的布局网格格式');
  }
  if (new Uint8Array(new Uint32Array([1]).buffer)[0] !== 1) throw new Error('显示网格要求小端运行环境');
  const count = header.getUint32(12, true), indexCount = header.getUint32(16, true);
  if (!count || !indexCount || indexCount % 3 || 32 + count * 12 + indexCount * 4 !== buffer.byteLength) {
    throw new Error('布局网格数组长度不匹配');
  }
  checkMeshBudget(count, indexCount, limits);
  const positions = new Float32Array(buffer, 32, count * 3);
  const indices = new Uint32Array(buffer, 32 + count * 12, indexCount);
  for (const value of positions) if (!Number.isFinite(value)) throw new Error('布局网格包含非有限坐标');
  for (const value of indices) if (value >= count) throw new Error('布局网格包含越界索引');
  return { positions, indices };
}

/** 为已校验的基础数组计算共享法向、边线和包围盒；仅创建 CPU 数据，返回资源由视口接管。 */
export function prepareLayoutMesh(source) {
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(source.positions, 3));
  geometry.setIndex(new THREE.BufferAttribute(source.indices, 1));
  geometry.computeVertexNormals();
  geometry.computeBoundingBox();
  geometry.computeBoundingSphere();
  const edges = new THREE.EdgesGeometry(geometry);
  const normals = geometry.getAttribute('normal').array, edgePositions = edges.getAttribute('position').array;
  const result = { ...source, normals, edgePositions,
    bounds: { min: geometry.boundingBox.min.toArray(), max: geometry.boundingBox.max.toArray() },
    sphere: { center: geometry.boundingSphere.center.toArray(), radius: geometry.boundingSphere.radius },
    bytes: source.positions.byteLength + source.indices.byteLength + normals.byteLength + edgePositions.byteLength };
  geometry.dispose(); edges.dispose();
  return result;
}

/** 旧 JSON 服务器仅作兼容读取；先按规模准入，再逐项校验，避免 flat 产生额外中间数组。 */
export function decodeLegacyMesh(source, limits) {
  const vertices = source?.vertices, faces = source?.faces;
  if (!Array.isArray(vertices) || !vertices.length || !Array.isArray(faces) || !faces.length) throw new Error('旧历史网格缺失');
  checkMeshBudget(vertices.length, faces.length * 3, limits);
  const positions = new Float32Array(vertices.length * 3), indices = new Uint32Array(faces.length * 3);
  for (let row = 0; row < vertices.length; row += 1) {
    if (!Array.isArray(vertices[row]) || vertices[row].length !== 3) throw new Error('旧历史坐标形状无效');
    for (let col = 0; col < 3; col += 1) {
      const value = vertices[row][col];
      if (typeof value !== 'number' || !Number.isFinite(value) || !Number.isFinite(Math.fround(value))) throw new Error('旧历史坐标无效');
      positions[row * 3 + col] = value;
    }
  }
  for (let row = 0; row < faces.length; row += 1) {
    if (!Array.isArray(faces[row]) || faces[row].length !== 3) throw new Error('旧历史索引形状无效');
    for (let col = 0; col < 3; col += 1) {
      const value = faces[row][col];
      if (!Number.isInteger(value) || value < 0 || value >= vertices.length) throw new Error('旧历史索引越界');
      indices[row * 3 + col] = value;
    }
  }
  return { positions, indices };
}
