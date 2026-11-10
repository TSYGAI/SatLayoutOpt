/** 文件说明：在独立 Worker 校验显示数据、计算法向和边线；通过 Transferable 移交数组，不持有 GPU 或业务状态。 */
import { decodeLayoutMesh, decodeLegacyMesh, prepareLayoutMesh } from './layout-mesh-data.js';
import { decodeFixedMesh, prepareFixedLegacyMesh } from './fixed-mesh-data.js';

/** 处理一次可取消的型号加载；失败只回传错误文本，所有成功数组转移后由 Worker 宿主终止。 */
self.onmessage = ({ data }) => {
  /** 仅桌面请求回传阶段，不传数组或在每个顶点发送事件。 */
  const stage = (step, model = null) => { if (data.monitor) self.postMessage({ monitor: { step, model } }); };
  try {
    stage('Worker 校验资源预算并解析数据');
    const output = {};
    const jsonBytes = data.fixedLegacy ? data.buffer.byteLength * data.limits.jsonMemoryFactor : 0;
    if (data.fixedLegacy && (!Number.isFinite(jsonBytes) || jsonBytes >= data.limits.workerMaxBytes)) {
      throw new Error('机器可用内存不足以解析旧网格');
    }
    const legacy = data.legacy ? JSON.parse(new TextDecoder().decode(data.buffer)).meshes : null;
    let remaining = data.limits.geometryMaxBytes;
    let workerRemaining = data.limits.workerMaxBytes - jsonBytes;
    for (const record of data.records) {
      stage('Worker 解码型号网格', record);
      const limits = { ...data.limits, geometryMaxBytes: remaining, workerMaxBytes: workerRemaining };
      if (data.fixed) output[record] = decodeFixedMesh(data.buffer, limits);
      else if (data.fixedLegacy) output[record] = prepareFixedLegacyMesh(legacy?.[record], limits);
      else {
        const source = legacy ? decodeLegacyMesh(legacy[record], limits) : decodeLayoutMesh(data.buffer, limits);
        stage('Worker 生成法向与显示边线', record);
        output[record] = prepareLayoutMesh(source);
      }
      remaining -= output[record].bytes;
      workerRemaining -= output[record].bytes;
    }
    const buffers = new Set(Object.values(output).flatMap((mesh) =>
      [mesh.positions.buffer, mesh.indices.buffer, mesh.normals.buffer, mesh.edgePositions.buffer,
        ...(mesh.sourceVertices ? [mesh.sourceVertices.buffer] : [])]));
    stage('Worker 移交显示数组');
    self.postMessage({ meshes: output }, [...buffers]);
  } catch (failure) {
    self.postMessage({ error: failure.message, stack: failure.stack });
  }
};
