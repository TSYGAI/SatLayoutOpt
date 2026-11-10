/**
 * 文件说明：读取、解析和合并模型预览资源，复用既有双档磁盘缓存格式。
 * 与场景及页面生命周期隔离；材质配色由调用方注入，完成的资源交给页面或有限缓存管理。
 */
import { observeSync, observe, reportError } from '../../observability/runtime-log.js';


import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { getFaceMapping, getInteractionPreviewManifest, getPreviewManifest, getPreviewRuntimeCache,
  resolveApiUrl, savePreviewRuntimeCache } from '../../api/model-upload-api.js';
import { deserializePreviewRuntimeCache, serializePreviewRuntimeCache } from './preview-runtime-cache.js';
import { disposeObject, loadGlb, prepareMappingEntries } from './model-preview-resources.js';

/** 按唯一 ArrayBuffer 统计预览网格数组占用，用于缓存淘汰；不估算浏览器及渲染器的额外开销。 */
export function measurePreviewBytes(preview) {
  const buffers = new Set();
  for (const object of [preview.interactionRoot, preview.detailRoot, preview.edgeOverlay].filter(Boolean)) {
    object.traverse((child) => {
      if (!child.geometry) return;
      for (const attribute of [...Object.values(child.geometry.attributes), child.geometry.index].filter(Boolean)) {
        if (attribute.array?.buffer) buffers.add(attribute.array.buffer);
      }
    });
  }
  return [...buffers].reduce((total, buffer) => total + buffer.byteLength, 0);
}

/** 创建预览资源服务，参数分别提供当前主题配色和拓扑边线透明度。 */
export function createPreviewResources({ getScenePalette, edgeOpacity }) {
  /** 将最终合并网格转换为可持久化的紧凑属性数据，并拒绝不完整的渲染对象。 */
  function serializePreviewGeometry(geometry, includeNormals, label) {
    const position = geometry?.getAttribute('position');
    const normal = geometry?.getAttribute('normal');
    const index = geometry?.getIndex();
    if (!position || position.itemSize !== 3
      || (index && index.itemSize !== 1)
      || (includeNormals && (!normal || normal.itemSize !== 3))) {
      throw new Error(`${label}网格数据不完整`);
    }
    const indices = index
      ? Uint32Array.from(index.array)
      : Uint32Array.from({ length: position.count }, (_, vertexIndex) => vertexIndex);
    return {
      positions: Float32Array.from(position.array),
      ...(includeNormals ? { normals: Float32Array.from(normal.array) } : {}),
      indices,
    };
  }

  /** 校验缓存中的索引均引用指定顶点数量范围内的数据。 */
  function hasValidGeometryIndices(indices, vertexCount) {
    for (let index = 0; index < indices.length; index += 1) {
      if (indices[index] >= vertexCount) return false;
    }
    return true;
  }

  /** 判断缓存属性数组中的全部数值是否有限，避免异常数据破坏相机与渲染计算。 */
  function hasFiniteGeometryValues(values) {
    for (let index = 0; index < values.length; index += 1) {
      if (!Number.isFinite(values[index])) return false;
    }
    return true;
  }

  /** 从持久化属性数据恢复 Three.js BufferGeometry，并完成基础结构校验。 */
  function createPreviewGeometryFromCache(data, includeNormals, label) {
    if (!data || typeof data !== 'object'
      || !(data.positions instanceof Float32Array)
      || !(data.indices instanceof Uint32Array)
      || data.positions.length === 0
      || data.positions.length % 3 !== 0
      || data.indices.length === 0
      || data.indices.length % (includeNormals ? 3 : 2) !== 0
      || !hasFiniteGeometryValues(data.positions)
      || !hasValidGeometryIndices(data.indices, data.positions.length / 3)
      || (includeNormals && (!(data.normals instanceof Float32Array)
        || data.normals.length !== data.positions.length
        || !hasFiniteGeometryValues(data.normals)))) {
      throw new Error(`${label}缓存结构无效`);
    }
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(data.positions, 3));
    if (includeNormals) geometry.setAttribute('normal', new THREE.BufferAttribute(data.normals, 3));
    geometry.setIndex(new THREE.BufferAttribute(data.indices, 1));
    geometry.computeBoundingSphere();
    return geometry;
  }

  /** 从缓存中一次性创建表面和可选边线网格，任一数据段异常时释放已分配资源。 */
  function createPreparedPreviewFromCache(surfaceData, edgeData, label) {
    let surfaceGeometry = null;
    let edgeGeometry = null;
    try {
      surfaceGeometry = createPreviewGeometryFromCache(surfaceData, true, label);
      edgeGeometry = edgeData ? createPreviewGeometryFromCache(edgeData, false, '拓扑边线') : null;
      return createPreparedPreviewFromGeometries(surfaceGeometry, edgeGeometry);
    } catch (error) {
      surfaceGeometry?.dispose();
      edgeGeometry?.dispose();
      throw error;
    }
  }

  /** 创建当前主题下已合并表面网格与可选拓扑边线覆盖层。 */
  function createPreparedPreviewFromGeometries(surfaceGeometry, edgeGeometry = null) {
    let edgeOverlay = null;
    try {
      if (!surfaceGeometry) throw new Error('GLB 预览不包含可渲染网格');
      surfaceGeometry.computeBoundingSphere();
      const [red, green, blue] = getScenePalette().preview.map((value) => value / 255);
      const baseMaterial = new THREE.MeshStandardMaterial({
        color: new THREE.Color(red, green, blue),
        emissive: new THREE.Color(red * 0.1, green * 0.1, blue * 0.1),
        emissiveIntensity: 1,
        metalness: 0.08,
        roughness: 0.64,
        side: THREE.DoubleSide,
        wireframe: false,
        polygonOffset: true,
        polygonOffsetFactor: 1,
        polygonOffsetUnits: 1,
      });
      const modelRoot = new THREE.Mesh(surfaceGeometry, baseMaterial);
      modelRoot.name = 'STEP_PREVIEW_MERGED';
      if (edgeGeometry) {
        edgeGeometry.computeBoundingSphere();
        const edgeMaterial = createTopologyEdgeMaterial();
        edgeOverlay = new THREE.LineSegments(edgeGeometry, edgeMaterial);
        edgeOverlay.name = 'STEP_TOPOLOGY_EDGES';
        edgeOverlay.renderOrder = 1;
      }
      return { modelRoot, edgeOverlay };
    } catch (error) {
      surfaceGeometry?.dispose();
      edgeGeometry?.dispose();
      edgeOverlay?.material.dispose();
      throw error;
    }
  }

  /** 创建参考色拓扑边线材质，通过降低覆盖强度获得略细的视觉效果。 */
  function createTopologyEdgeMaterial() {
    return new THREE.LineBasicMaterial({
      color: getScenePalette().edge,
      transparent: true,
      opacity: edgeOpacity,
      depthTest: true,
      depthWrite: false,
      toneMapped: false,
    });
  }

  /** 将当前双 LOD、拓扑边线、清单和面映射提取为跨刷新缓存负载。 */
  function getPreviewRuntimeCachePayload(preview) {
    const sceneState = preview;
    if (!sceneState?.interactionRoot || !sceneState.detailRoot || !preview.interactionManifest
      || !preview.previewManifest || !preview.mappingEntries?.length) return null;
    return {
      interaction: serializePreviewGeometry(sceneState.interactionRoot.geometry, true, '交互预览'),
      detail: serializePreviewGeometry(sceneState.detailRoot.geometry, true, '高清预览'),
      edge: sceneState.edgeOverlay ? serializePreviewGeometry(sceneState.edgeOverlay.geometry, false, '拓扑边线') : null,
      interactionManifest: preview.interactionManifest,
      previewManifest: preview.previewManifest,
      mappingEntries: preview.mappingEntries,
    };
  }

  /** 验证缓存恢复所需的清单基础字段，避免异常缓存破坏预览状态。 */
  function hasValidPreviewManifest(manifest) {
    return manifest && typeof manifest === 'object'
      && manifest.stats && typeof manifest.stats === 'object'
      && Number.isFinite(manifest.stats.body_count)
      && Number.isFinite(manifest.stats.face_count)
      && Number.isFinite(manifest.stats.triangle_count)
      && Array.isArray(manifest.bounds?.min)
      && Array.isArray(manifest.bounds?.max)
      && manifest.bounds.min.length === 3
      && manifest.bounds.max.length === 3
      && manifest.bounds.min.concat(manifest.bounds.max).every(Number.isFinite);
  }

  /** 将磁盘缓存负载还原为可直接接入当前 Three.js 场景的双 LOD 预览对象。 */
  function createPreviewFromRuntimeCache(payload) {
    if (!payload || typeof payload !== 'object'
      || !hasValidPreviewManifest(payload.interactionManifest)
      || !hasValidPreviewManifest(payload.previewManifest)
      || !Array.isArray(payload.mappingEntries)) {
      throw new Error('预览缓存结构无效');
    }
    let interactionPreview = null;
    let detailPreview = null;
    try {
      interactionPreview = createPreparedPreviewFromCache(payload.interaction, null, '交互预览');
      detailPreview = createPreparedPreviewFromCache(payload.detail, payload.edge, '高清预览');
      const triangleCount = detailPreview.modelRoot.geometry.getIndex().count / 3;
      const mappingEntries = prepareMappingEntries(payload.mappingEntries, triangleCount);
      return {
        interactionRoot: interactionPreview.modelRoot,
        detailRoot: detailPreview.modelRoot,
        edgeOverlay: detailPreview.edgeOverlay,
        interactionManifest: payload.interactionManifest,
        previewManifest: payload.previewManifest,
        mappingEntries,
      };
    } catch (error) {
      if (interactionPreview?.modelRoot) disposeObject(interactionPreview.modelRoot);
      if (interactionPreview?.edgeOverlay) disposeObject(interactionPreview.edgeOverlay);
      if (detailPreview?.modelRoot) disposeObject(detailPreview.modelRoot);
      if (detailPreview?.edgeOverlay) disposeObject(detailPreview.edgeOverlay);
      throw error;
    }
  }

  /** 读取并验证磁盘持久化预览缓存；缓存不可用时返回空以回退到 GLB 加载。 */
  async function loadPersistedPreview(modelId, signal) {
    try {
      const buffer = await getPreviewRuntimeCache(modelId, signal);
      return buffer ? createPreviewFromRuntimeCache(deserializePreviewRuntimeCache(buffer, modelId)) : null;
    } catch (error) {
      if (error.name === 'AbortError') throw error;
      console.warn(`预览持久缓存不可用，已回退 GLB 加载：${error.message}`);
      reportError(error, 'WARN');
      return null;
    }
  }

  /** 将已完成的当前模型预览异步写入后端磁盘缓存，失败不影响正在显示的模型。 */
  async function persistPreview(modelId, preview, signal) {
    try {
      const payload = getPreviewRuntimeCachePayload(preview);
      if (!payload) return;
      await savePreviewRuntimeCache(modelId, serializePreviewRuntimeCache(modelId, payload), signal);
    } catch (error) {
      if (!signal?.aborted) { console.warn(`预览持久缓存保存失败：${error.message}`); reportError(error, 'WARN'); }
    }
  }

  /** 把 GLB 中的逐面网格和拓扑线段分别合并为两个轻量渲染对象。 */
  function prepareLoadedModel(root) {
    return observeSync('合并场景几何', {}, () => prepareLoadedModelLogged(root));
  }

  /** 执行合并场景几何；日志边界由同名公开入口管理。 */
  function prepareLoadedModelLogged(root) {
    const surfaceGeometries = [];
    const edgeGeometries = [];
    let mergedGeometry = null;
    let mergedEdgeGeometry = null;
    let edgeOverlay = null;
    root.updateMatrixWorld(true);
    root.traverse((child) => {
      if (!child.isMesh && !child.isLineSegments) return;
      const geometry = child.geometry.clone();
      geometry.applyMatrix4(child.matrixWorld);
      if (child.isMesh) {
        if (!geometry.getAttribute('normal')) geometry.computeVertexNormals();
        surfaceGeometries.push(geometry);
      } else edgeGeometries.push(geometry);
    });
    try {
      if (!surfaceGeometries.length) throw new Error('GLB 预览不包含可渲染网格');
      mergedGeometry = mergeGeometries(surfaceGeometries, false);
      if (!mergedGeometry) throw new Error('GLB 逐面网格无法合并');
      mergedGeometry.computeBoundingSphere();
      const [red, green, blue] = getScenePalette().preview.map((value) => value / 255);
      const baseMaterial = new THREE.MeshStandardMaterial({
        color: new THREE.Color(red, green, blue),
        emissive: new THREE.Color(red * 0.1, green * 0.1, blue * 0.1),
        emissiveIntensity: 1,
        metalness: 0.08,
        roughness: 0.64,
        side: THREE.DoubleSide,
        wireframe: false,
        polygonOffset: true,
        polygonOffsetFactor: 1,
        polygonOffsetUnits: 1,
      });
      const model = new THREE.Mesh(mergedGeometry, baseMaterial);
      model.name = 'STEP_PREVIEW_MERGED';
      if (edgeGeometries.length) {
        mergedEdgeGeometry = mergeGeometries(edgeGeometries, false);
        if (mergedEdgeGeometry) {
          mergedEdgeGeometry.computeBoundingSphere();
          const edgeMaterial = createTopologyEdgeMaterial();
          edgeOverlay = new THREE.LineSegments(mergedEdgeGeometry, edgeMaterial);
          edgeOverlay.name = 'STEP_TOPOLOGY_EDGES';
          edgeOverlay.renderOrder = 1;
        }
      }
      return { modelRoot: model, edgeOverlay };
    } catch (error) {
      mergedGeometry?.dispose();
      mergedEdgeGeometry?.dispose();
      edgeOverlay?.material.dispose();
      throw error;
    } finally {
      surfaceGeometries.forEach((geometry) => geometry.dispose());
      edgeGeometries.forEach((geometry) => geometry.dispose());
      disposeObject(root);
    }
  }


  /** 读取一个质量档并完成解析，失败或取消时回收已创建的对象；完成后调用方取得资源所有权。 */
  async function loadTier(model, quality, signal) {
    return observe('模型预览加载与合并', { model: model.id, quality },
      () => loadTierLogged(model, quality, signal), { signal, long: true });
  }

  /** 执行模型预览加载与合并；日志边界由同名公开入口管理。 */
  async function loadTierLogged(model, quality, signal) {
    if (quality === 'interaction') {
      const cached = await loadPersistedPreview(model.id, signal);
      if (cached) return { preview: cached, complete: true };
    }
    const manifest = await (quality === 'interaction' ? getInteractionPreviewManifest : getPreviewManifest)(model.id, signal);
    signal.throwIfAborted();
    const [asset, mapping] = await Promise.allSettled([
      loadGlb(await resolveApiUrl(manifest.browser_asset.url), signal),
      manifest.face_mapping ? getFaceMapping(manifest.face_mapping.url, signal) : Promise.resolve(null),
    ]);
    if (asset.status === 'rejected' || mapping.status === 'rejected' || signal.aborted) {
      if (asset.status === 'fulfilled') disposeObject(asset.value);
      signal.throwIfAborted();
      throw asset.status === 'rejected' ? asset.reason : mapping.reason;
    }
    const prepared = prepareLoadedModel(asset.value);
    try {
      const count = prepared.modelRoot.geometry.getIndex().count / 3;
      const entries = mapping.value ? prepareMappingEntries(mapping.value.entries, count) : [];
      if (quality === 'detail' && !entries.length) throw new Error('高清预览缺少 STEP 面映射');
      if (quality === 'interaction') {
        if (prepared.edgeOverlay) disposeObject(prepared.edgeOverlay);
        return { preview: { interactionRoot: prepared.modelRoot, interactionManifest: manifest,
          previewManifest: manifest, mappingEntries: entries }, complete: false };
      }
      return { preview: { detailRoot: prepared.modelRoot, edgeOverlay: prepared.edgeOverlay,
        previewManifest: manifest, mappingEntries: entries }, complete: false };
    } catch (error) {
      disposeObject(prepared.modelRoot);
      if (prepared.edgeOverlay) disposeObject(prepared.edgeOverlay);
      throw error;
    }
  }

  return { loadTier, persistPreview };
}
