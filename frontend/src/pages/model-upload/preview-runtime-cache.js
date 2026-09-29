/**
 * 文件说明：编码和解码模型页已合并的 Three.js 预览数据，用于跨页面刷新复用本地后端磁盘缓存。
 * 本模块只处理稳定二进制容器与 TypedArray 引用，不访问 DOM、Three.js 或 HTTP 接口。
 */

export const PREVIEW_RUNTIME_CACHE_MEDIA_TYPE = 'application/vnd.sat-layout-opt.runtime-preview';

const CACHE_MAGIC = new Uint8Array([0x53, 0x41, 0x54, 0x50, 0x52, 0x45, 0x56, 0x31, 0x00]);
const CACHE_HEADER_LENGTH = 16;
const CACHE_GENERATOR_VERSION = '1';

/** 将值向上对齐到四字节边界，确保 TypedArray 可直接复用缓存缓冲区。 */
function alignToFour(value) {
  return (value + 3) & ~3;
}

/** 判断值是否为当前预览缓存支持的数值二进制数组。 */
function isSupportedTypedArray(value) {
  return value instanceof Float32Array || value instanceof Uint32Array;
}

/** 将递归对象中的 TypedArray 替换为元数据引用，并按遇到顺序收集二进制块。 */
function encodeValue(value, chunks) {
  if (isSupportedTypedArray(value)) {
    chunks.push(new Uint8Array(value.buffer, value.byteOffset, value.byteLength));
    return {
      $satLayoutTypedArray: value instanceof Float32Array ? 'Float32Array' : 'Uint32Array',
      byteLength: value.byteLength,
    };
  }
  if (Array.isArray(value)) return value.map((item) => encodeValue(item, chunks));
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, encodeValue(item, chunks)]));
  }
  return value;
}

/** 判断解码元数据中的对象是否为合法的 TypedArray 二进制块引用。 */
function isTypedArrayReference(value) {
  return value
    && typeof value === 'object'
    && (value.$satLayoutTypedArray === 'Float32Array' || value.$satLayoutTypedArray === 'Uint32Array')
    && Number.isSafeInteger(value.byteLength)
    && value.byteLength >= 0
    && value.byteLength % 4 === 0;
}

/** 依据元数据引用从共享二进制缓冲区还原递归对象中的 TypedArray。 */
function decodeValue(value, buffer, cursor) {
  if (Array.isArray(value)) return value.map((item) => decodeValue(item, buffer, cursor));
  if (!value || typeof value !== 'object') return value;
  if (isTypedArrayReference(value)) {
    if (cursor.offset + value.byteLength > buffer.byteLength) throw new Error('预览缓存二进制数据不完整');
    const length = value.byteLength / 4;
    const array = value.$satLayoutTypedArray === 'Float32Array'
      ? new Float32Array(buffer, cursor.offset, length)
      : new Uint32Array(buffer, cursor.offset, length);
    cursor.offset += value.byteLength;
    return array;
  }
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, decodeValue(item, buffer, cursor)]));
}

/** 将指定模型的已合并预览负载编码为可写入后端的二进制 Blob。 */
export function serializePreviewRuntimeCache(modelId, payload) {
  if (typeof modelId !== 'string' || !modelId) throw new Error('预览缓存缺少模型标识');
  const chunks = [];
  const metadata = encodeValue({ generatorVersion: CACHE_GENERATOR_VERSION, modelId, payload }, chunks);
  const metadataBytes = new TextEncoder().encode(JSON.stringify(metadata));
  const dataOffset = alignToFour(CACHE_HEADER_LENGTH + metadataBytes.byteLength);
  const header = new Uint8Array(dataOffset);
  header.set(CACHE_MAGIC);
  new DataView(header.buffer).setUint32(CACHE_MAGIC.byteLength, metadataBytes.byteLength, true);
  header.set(metadataBytes, CACHE_HEADER_LENGTH);
  return new Blob([header, ...chunks], { type: PREVIEW_RUNTIME_CACHE_MEDIA_TYPE });
}

/** 校验缓存容器版本和模型归属后，解码其携带的已合并预览负载。 */
export function deserializePreviewRuntimeCache(buffer, modelId) {
  if (!(buffer instanceof ArrayBuffer) || buffer.byteLength < CACHE_HEADER_LENGTH) {
    throw new Error('预览缓存文件过短');
  }
  const bytes = new Uint8Array(buffer);
  if (!CACHE_MAGIC.every((value, index) => bytes[index] === value)) throw new Error('预览缓存版本不兼容');
  const metadataLength = new DataView(buffer).getUint32(CACHE_MAGIC.byteLength, true);
  const metadataEnd = CACHE_HEADER_LENGTH + metadataLength;
  const dataOffset = alignToFour(metadataEnd);
  if (dataOffset > buffer.byteLength) throw new Error('预览缓存元数据不完整');
  let metadata;
  try {
    metadata = JSON.parse(new TextDecoder().decode(bytes.subarray(CACHE_HEADER_LENGTH, metadataEnd)));
  } catch {
    throw new Error('预览缓存元数据无效');
  }
  const cursor = { offset: dataOffset };
  const decoded = decodeValue(metadata, buffer, cursor);
  if (cursor.offset !== buffer.byteLength) throw new Error('预览缓存包含无效尾部数据');
  if (!decoded || typeof decoded !== 'object'
    || decoded.generatorVersion !== CACHE_GENERATOR_VERSION
    || decoded.modelId !== modelId
    || !decoded.payload || typeof decoded.payload !== 'object') {
    throw new Error('预览缓存结构无效');
  }
  return decoded.payload;
}
