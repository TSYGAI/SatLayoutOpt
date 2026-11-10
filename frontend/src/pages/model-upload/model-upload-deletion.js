/**
 * 文件说明：上传模型删除流程，协调页面确认、API 请求、本地列表更新和后台刷新。
 * 弹窗由 React 页面展示；后端确认结果与本地清理错误分开处理，本模块不创建三维对象。
 */

import { deleteModel, deleteModels } from '../../api/model-upload-api.js';
import { showToast } from '../../components/toast.js';

/** 创建删除操作入口；依赖共享模型状态及页面生命周期、列表和预览清理回调。 */
export function createModelDeletionActions({
  state, getLifecycle, renderModelList, refreshModels,
  evictCachedPreviews, clearModelView, clearPreview, clearModelScene, syncPreviewQueue,
}) {
  /**
   * 移除后端已确认删除的本地记录并逐项清理预览；单项失败仍继续其他清理，返回是否需要提示刷新。
   * @param {string[]} modelIds 已确认删除或不存在的模型标识。
   */
  function reconcileDeletedModels(modelIds) {
    const removesCurrent = Boolean(state.selectedModel && modelIds.includes(state.selectedModel.id));
    state.modelsRefreshToken += 1;
    state.models = state.models.filter((model) => !modelIds.includes(model.id));
    state.selectedIds = new Set([...state.selectedIds].filter((id) => !modelIds.includes(id)));
    if (removesCurrent) state.selectedModel = null;
    let cleanupFailed = false;
    /** 执行独立清理步骤；记录原始异常以便排障，不改变已确认的删除结果。 */
    function cleanup(action) {
      try { action(); }
      catch (error) {
        cleanupFailed = true;
        console.error('模型已删除，但本地预览清理失败：', error);
      }
    }
    cleanup(syncPreviewQueue);
    modelIds.forEach((id) => cleanup(() => evictCachedPreviews([id])));
    Object.keys(state.pageSelections).forEach((pageMode) => {
      if (state.pageSelections[pageMode] && modelIds.includes(state.pageSelections[pageMode])) {
        cleanup(() => clearModelView(pageMode));
      }
    });
    if (removesCurrent) {
      cleanup(() => clearModelView());
      cleanup(() => {
        if (document.getElementById('model-viewport')) clearPreview();
        else clearModelScene();
      });
    }
    return cleanupFailed;
  }

  /** 请求页面弹窗，确认回调固定此次选择的模型集合，避免后续选择变化影响删除目标。 */
  function requestModelDeletion(modelIds) {
    if (!modelIds.length || state.deleting) return;
    const models = state.models.filter((model) => modelIds.includes(model.id));
    if (!models.length) return;
    state.onRequestDelete?.({ models, onConfirm: () => removeModels(models.map((model) => model.id)) });
  }

  /** 执行已确认的删除并返回弹窗结果；成功立即更新本地状态，补充查询不延长删除等待。 */
  async function removeModels(modelIds) {
    if (!modelIds.length || state.deleting) return { ok: false, error: '删除任务正在执行，请稍候' };
    state.deleting = true;
    let deletionConfirmed = false;
    try {
      renderModelList();
      showToast(`正在删除 ${modelIds.length} 个模型，请稍候`);
      let deleted = modelIds.length;
      if (modelIds.length === 1) {
        try { await deleteModel(modelIds[0]); }
        catch (error) {
          if (error.status !== 404) throw error;
          deleted = 0;
        }
      } else deleted = (await deleteModels(modelIds)).deleted;
      deletionConfirmed = true;
      // 删除响应是已确认结果；先让旧列表请求失效，再移除本地记录。
      const cleanupFailed = reconcileDeletedModels(modelIds);
      const lifecycle = getLifecycle();
      if (!lifecycle) return { ok: true };
      renderModelList();
      const resultMessage = deleted ? `已删除 ${deleted} 个模型` : '所选模型已不存在，已更新列表';
      const message = cleanupFailed ? `${resultMessage}，预览清理异常，请刷新页面` : resultMessage;
      showToast(message, cleanupFailed);
      const refreshToken = state.modelsRefreshToken + 1;
      void refreshModels({ quiet: true }).then((refreshed) => {
        if (!refreshed && getLifecycle() === lifecycle
          && state.modelsRefreshToken === refreshToken && !state.deleting) {
          showToast(`${message}，列表刷新失败，请稍后刷新`, cleanupFailed);
        }
      });
      return { ok: true };
    } catch (error) {
      if (deletionConfirmed) {
        console.error('模型已删除，但界面更新失败：', error);
        if (getLifecycle()) showToast('模型已删除，界面更新失败，请刷新页面', true);
        return { ok: true };
      }
      return { ok: false, error: `删除模型失败：${error.message}` };
    } finally {
      state.deleting = false;
      if (getLifecycle()) renderModelList();
    }
  }

  return { requestModelDeletion };
}
