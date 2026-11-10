/**
 * 文件说明：负责多文件上传及已确认结果的会话登记，上传生命周期独立于页面和三维场景。
 * 上传进度独立保存，成功模型自动加入预览队列；批量上传完成前优先准备简易预览。
 */

import { uploadModel } from '../../api/model-upload-api.js';
import { showToast } from '../../components/toast.js';
import { startUploadProgress, updateUploadProgress } from './upload-progress-state.js';

const VALID_EXTENSIONS = new Set(['stp', 'step']);

/** 创建上传操作入口；通过注入的列表和预览回调避免与 Three.js 资源管理耦合。 */
export function createModelUploadActions({ state, getLifecycle, renderModelList, refreshModels, selectModel, syncPreviewQueue }) {
  /** 校验并并发上传文件；每个成功结果立即登记，离页后不丢失结果也不操作其他页面。 */
  async function uploadFiles(files) {
    const lifecycle = getLifecycle();
    const selectionToken = state.loadToken;
    const validFiles = files.filter((file) => VALID_EXTENSIONS.has(file.name.split('.').pop()?.toLowerCase()));
    if (validFiles.length < files.length) showToast(`已拒绝 ${files.length - validFiles.length} 个文件：仅允许 .stp 或 .step`, true);
    if (!validFiles.length) return;
    state.pendingUploads += validFiles.length;
    const results = await Promise.all(validFiles.map(async (file) => {
      const progressId = startUploadProgress(file.name);
      try {
        const model = await uploadModel(file, (progress) => updateUploadProgress(progressId, { progress }));
        state.modelsRefreshToken += 1;
        state.models = [model, ...state.models.filter((item) => item.id !== model.id)];
        state.modelsLoaded = true;
        updateUploadProgress(progressId, { status: 'saved', progress: 100 });
        const currentLifecycle = getLifecycle();
        if (currentLifecycle && !currentLifecycle.signal.aborted) renderModelList();
        return model;
      } catch (error) {
        updateUploadProgress(progressId, { status: 'failed', error: error.message });
        return null;
      } finally {
        state.pendingUploads -= 1;
        syncPreviewQueue();
      }
    }));
    if (lifecycle !== getLifecycle() || lifecycle?.signal.aborted) return;
    await refreshModels({ quiet: true });
    if (lifecycle !== getLifecycle() || lifecycle?.signal.aborted) return;
    const uploaded = results.filter(Boolean);
    if (uploaded.length) {
      const latest = state.models.find((model) => model.id === uploaded.at(-1).id);
      if (latest && !state.selectedModel && state.loadToken === selectionToken) await selectModel(latest, true);
      if (lifecycle === getLifecycle() && !lifecycle?.signal.aborted) {
        showToast(`${uploaded.length} 个 STEP 模型已保存，预览将在后台依次加载`);
      }
    }
  }
  return { uploadFiles };
}
