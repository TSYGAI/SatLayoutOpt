/** 文件说明：解码预制固定包络二进制；双精度顶点仅用于精确边界，GPU 数组和预算法向、边线直接复用，不计算业务规则。 */
import { decodeLegacyMesh, prepareLayoutMesh } from './layout-mesh-data.js';

/** 旧 JSON 固定包络先按规模准入并校验，再同时保留双精度源顶点和 GPU 显示数组；预算包含两者。 */
export function prepareFixedLegacyMesh(source, limits) {
  const sourceBytes = (source?.vertices?.length || 0) * 24;
  const decoded = decodeLegacyMesh(source, { ...limits,
    geometryMaxBytes: limits.geometryMaxBytes - sourceBytes,
    workerMaxBytes: limits.workerMaxBytes - sourceBytes });
  const sourceVertices = new Float64Array(source.vertices.length * 3);
  for (let row = 0; row < source.vertices.length; row += 1) sourceVertices.set(source.vertices[row], row * 3);
  const mesh = prepareLayoutMesh(decoded);
  return { ...mesh, sourceVertices, bytes: mesh.bytes + sourceVertices.byteLength };
}

/** 遍历双精度源顶点；兼容旧会话中的嵌套数组，新资源使用可转移的连续 Float64Array。 */
export function* sourceVertexTriples(vertices) {
  if (vertices instanceof Float64Array) {
    for (let index = 0; index < vertices.length; index += 3) yield vertices.subarray(index, index + 3);
  } else yield* vertices;
}

/** 校验版本、容量与数值后建立显示数组；仅执行线性解码，不再现场计算拓扑边和法向。 */
export function decodeFixedMesh(buffer, limits) {
  if (!(buffer instanceof ArrayBuffer) || buffer.byteLength < 64 || buffer.byteLength > limits.downloadMaxBytes) {
    throw new Error('固定包络显示资源长度无效或超过下载预算');
  }
  const header = new DataView(buffer);
  const count = header.getUint32(12, true), indexCount = header.getUint32(16, true), edgeCount = header.getUint32(20, true);
  if (new TextDecoder().decode(new Uint8Array(buffer, 0, 8)) !== 'SATFIX01' || header.getUint32(8, true) !== 1
      || !count || !indexCount || indexCount % 3 || edgeCount % 2
      || 64 + count * 36 + indexCount * 4 + edgeCount * 12 !== buffer.byteLength
      || Array.from(new Uint32Array(buffer, 24, 10)).some((value) => value !== 0)) throw new Error('固定包络显示格式无效');
  const bytes = buffer.byteLength + count * 12;
  if (bytes > limits.geometryMaxBytes || bytes > limits.workerMaxBytes) throw new Error('固定包络显示资源超过内存预算');
  const sourceVertices = new Float64Array(buffer, 64, count * 3);
  const indices = new Uint32Array(buffer, 64 + count * 24, indexCount);
  const normals = new Float32Array(buffer, 64 + count * 24 + indexCount * 4, count * 3);
  const edgePositions = new Float32Array(buffer, 64 + count * 36 + indexCount * 4, edgeCount * 3);
  const positions = new Float32Array(sourceVertices);
  for (const array of [sourceVertices, positions, normals, edgePositions]) {
    for (const value of array) if (!Number.isFinite(value)) throw new Error('固定包络显示资源包含非有限坐标');
  }
  for (const index of indices) if (index >= count) throw new Error('固定包络显示资源索引越界');
  const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
  for (let index = 0; index < positions.length; index += 3) {
    for (let axis = 0; axis < 3; axis += 1) {
      min[axis] = Math.min(min[axis], positions[index + axis]); max[axis] = Math.max(max[axis], positions[index + axis]);
    }
  }
  const center = min.map((value, axis) => (value + max[axis]) / 2);
  let radiusSquared = 0;
  for (let index = 0; index < positions.length; index += 3) {
    radiusSquared = Math.max(radiusSquared, (positions[index] - center[0]) ** 2
      + (positions[index + 1] - center[1]) ** 2 + (positions[index + 2] - center[2]) ** 2);
  }
  return { positions, indices, normals, edgePositions, sourceVertices, bounds: { min, max },
    sphere: { center, radius: Math.sqrt(radiusSquared) }, bytes };
}
