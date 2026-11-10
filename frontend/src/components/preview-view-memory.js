/**
 * 文件说明：保存三维预览的纯数值视角，支持页面卸载后用新渲染器恢复同一内容。
 * 不持有 GPU 资源；内容标识由调用方提供，不同页面与不同几何不能互相套用视角。
 */

import { readPageSession, writePageSession } from '../app/page-session-state.js';

/** 创建视角会话接口；相机与控制器仅在当前实例使用，恢复后由调用方更新投影平移和画面。 */
export function createPreviewViewMemory(sessionKey, { camera, controls, panOffset = null, version = null }) {
  return {
    /** 保存有效内容的相机、旋转中心、裁剪面及投影平移，不写入空场景。 */
    save(contentKey) {
      if (!sessionKey || !contentKey) return;
      writePageSession('preview-views', sessionKey, {
        contentKey, position: camera.position.toArray(), up: camera.up.toArray(), target: controls.target.toArray(),
        near: camera.near, far: camera.far, pan: panOffset?.toArray(),
        ...(version === null ? {} : { version }),
      });
    },
    /** 同一内容才恢复；返回是否命中，避免新模型误用上一模型的取景距离。 */
    restore(contentKey) {
      const view = sessionKey ? readPageSession('preview-views', sessionKey) : null;
      if (!view || view.contentKey !== contentKey || (version !== null && view.version !== version)) return false;
      camera.position.fromArray(view.position);
      camera.up.fromArray(view.up);
      controls.target.fromArray(view.target);
      camera.near = view.near;
      camera.far = view.far;
      if (panOffset && view.pan) panOffset.fromArray(view.pan);
      camera.updateProjectionMatrix();
      controls.update();
      return true;
    },
  };
}
