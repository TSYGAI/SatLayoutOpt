/**
 * 文件说明：加载后端生成的安全包络，仅渲染半透明面，管理模型切换和 GPU 资源生命周期。
 * 只执行渲染变换与可见性控制，不计算包络或判定业务有效性；有效状态由 API 提供。
 */

import * as THREE from 'three';
import { getEnvelopePreviewConfig, getModelEnvelopePreview } from '../../api/model-upload-api.js';
import { disposeObject, parseGlb } from '../model-upload/model-preview-resources.js';
import { getModelPreviewTransform } from './model-settings-state.js';

export const ENVELOPE_PREVIEW_STATE_EVENT = 'sat-layout-envelope-preview-state';

/** 将覆盖层加载状态发送给当前设置页，模型标识用于隔离迟到事件。 */
function publishState(detail) {
  window.dispatchEvent(new CustomEvent(ENVELOPE_PREVIEW_STATE_EVENT, { detail }));
}

/** 从 API 读取并解析已有包络，同时读取统一显示配置；取消时不保留解析资源。 */
async function loadEnvelope(modelId, signal) {
  const [buffer, style] = await Promise.all([
    getModelEnvelopePreview(modelId, signal), getEnvelopePreviewConfig(),
  ]);
  const root = await parseGlb(buffer, signal);
  try {
    const meshes = [];
    root.traverse((child) => { if (child.isMesh) meshes.push(child); });
    if (!meshes.length) throw new Error('包络资源没有可显示的三角网格');
    meshes.forEach((mesh) => {
      const previous = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
      previous.forEach((material) => material.dispose());
      mesh.material = new THREE.MeshBasicMaterial({
        color: style.color, opacity: style.opacity, transparent: true,
        // 包络预览只显示外侧面，避免透明材质把背面三角面叠加成内部结构。
        side: THREE.FrontSide, depthWrite: false,
        polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -1,
      });
      mesh.renderOrder = 2;
    });
    root.name = 'MODEL_SAFETY_ENVELOPE';
    return root;
  } catch (error) {
    disposeObject(root);
    throw error;
  }
}

/**
 * 创建独立覆盖层控制器，返回上下文更新、清理与只读快照接口。
 * scene 为宿主场景；requestRender 请求重绘；onChange 接收状态；load 支持隔离测试注入。
 */
export function createModelEnvelopePreview({ scene, requestRender, onChange = publishState, load = loadEnvelope }) {
  let context = null;
  let root = null;
  let controller = null;
  let key = '';
  let revision = 0;
  let previewState = 'idle';

  /** 发布当前模型的显示状态，不影响生成状态或模型本体。 */
  function report(state, message = '') {
    previewState = state;
    onChange({ modelId: context?.modelId || null, state, message });
  }

  /** 取消在途加载并释放旧覆盖层；可反复调用。 */
  function clear() {
    revision += 1;
    controller?.abort();
    controller = null;
    key = '';
    if (root) {
      scene.remove(root);
      disposeObject(root);
      root = null;
    }
    report('idle');
    requestRender();
  }

  /** 将源模型局部坐标包络应用与模型相同的显示变换，且保留用户相机。 */
  function applyDisplay() {
    if (!root || !context) return;
    const transform = getModelPreviewTransform(context.settings);
    root.visible = context.visible && Boolean(transform);
    if (transform) {
      root.scale.setScalar(transform.scale);
      root.rotation.set(...transform.rotation, 'XYZ');
      root.updateMatrixWorld(true);
    }
    report(root.visible ? 'visible' : 'hidden');
    requestRender();
  }

  /** 加载当前版本，丢弃切换模型、重新生成或卸载后迟到的响应。 */
  async function startLoading() {
    const loadingRevision = revision;
    const loadingController = new AbortController();
    controller = loadingController;
    report('loading');
    try {
      const loaded = await load(context.modelId, loadingController.signal);
      if (loadingController.signal.aborted || loadingRevision !== revision) {
        disposeObject(loaded);
        return;
      }
      root = loaded;
      scene.add(root);
      applyDisplay();
    } catch (error) {
      if (!loadingController.signal.aborted && loadingRevision === revision) report('error', error.message);
    } finally {
      if (controller === loadingController) controller = null;
    }
  }

  /** 接收页面已确认的模型、版本、变换和显示意图；无效或未保存草稿时清除覆盖层。 */
  function setContext(next) {
    const nextKey = next?.available ? `${next.modelId}:${next.generatedAt}` : '';
    if (!nextKey || nextKey !== key) clear();
    context = next;
    key = nextKey;
    if (!key) { report('idle'); return; }
    if (root) { applyDisplay(); return; }
    if (!next.visible) { report('hidden'); return; }
    if (!controller) void startLoading();
  }

  /** 返回覆盖层可见性、版本和世界坐标边界，供开发验收定位错位或资源残留。 */
  function getSnapshot() {
    const bounds = root ? new THREE.Box3().setFromObject(root) : null;
    return {
      modelId: context?.modelId || null, state: previewState, visible: Boolean(root?.visible),
      generatedAt: context?.generatedAt || null,
      bounds: bounds ? { min: bounds.min.toArray(), max: bounds.max.toArray() } : null,
    };
  }

  /** 停止覆盖层所有任务并释放资源，随后不再保留模型上下文。 */
  function dispose() {
    clear();
    context = null;
  }

  return { setContext, clear, dispose, getSnapshot };
}
