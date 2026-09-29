/**
 * 文件说明：管理模型与包络共用的 GLB 解析、面映射校验及 Three.js 资源释放。
 * 本模块不持有页面或场景状态，调用方负责请求取消、模型选择及资源挂载。
 */

import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';

/** 释放对象的全部独立几何与材质；调用方须先从场景移除对象。 */
export function disposeObject(object) {
  const geometries = new Set();
  const materials = new Set();
  object.traverse((child) => {
    if (child.geometry) geometries.add(child.geometry);
    if (Array.isArray(child.material)) child.material.forEach((material) => materials.add(material));
    else if (child.material) materials.add(child.material);
  });
  geometries.forEach((geometry) => geometry.dispose());
  materials.forEach((material) => material.dispose());
}

/** 将 URL 加载的 GLB 转换为 Promise，并响应当前请求的取消信号。 */
export function loadGlb(url, signal) {
  return new Promise((resolve, reject) => {
    if (signal.aborted) { reject(new DOMException('模型加载已取消', 'AbortError')); return; }
    const loader = new GLTFLoader();
    const onAbort = () => reject(new DOMException('模型加载已取消', 'AbortError'));
    signal.addEventListener('abort', onAbort, { once: true });
    loader.load(url, (gltf) => {
      signal.removeEventListener('abort', onAbort);
      if (signal.aborted) { disposeObject(gltf.scene); reject(new DOMException('模型加载已取消', 'AbortError')); return; }
      resolve(gltf.scene);
    }, undefined, (error) => {
      signal.removeEventListener('abort', onAbort);
      reject(new Error(`GLB 预览加载失败：${error.message || '资源不可用'}`));
    });
  });
}

/** 解析 API 返回的 GLB 字节；解析完成前被取消时释放对象并抛出 AbortError。 */
export async function parseGlb(buffer, signal) {
  signal.throwIfAborted();
  const gltf = await new GLTFLoader().parseAsync(buffer, '');
  if (signal.aborted) {
    disposeObject(gltf.scene);
    signal.throwIfAborted();
  }
  return gltf.scene;
}

/** 校验并按三角形起点排序面映射，确保其范围与合并网格一致。 */
export function prepareMappingEntries(entries, triangleCount) {
  if (!Array.isArray(entries)) throw new Error('STEP 面映射格式无效，请重新生成预览');
  const sortedEntries = [...entries].sort((left, right) => left.triangle_start - right.triangle_start);
  let triangleCursor = 0;
  for (const entry of sortedEntries) {
    if (entry.triangle_start !== triangleCursor || entry.triangle_count <= 0) {
      throw new Error('GLB 网格与 STEP 面映射不一致，请重新生成预览');
    }
    triangleCursor += entry.triangle_count;
  }
  if (!sortedEntries.length || triangleCursor !== triangleCount) throw new Error('GLB 网格与 STEP 面映射不一致，请重新生成预览');
  return sortedEntries;
}
