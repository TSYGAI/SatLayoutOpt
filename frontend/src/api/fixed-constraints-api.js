/** 文件说明：固定组读取、正式预览和保存 API；请求使用锁定指纹，显示资源由独立二进制加载器管理。 */
import { requestJson } from './model-upload-api.js';

/** 读取已保存组与当前指纹；signal 可取消页面离开后的读取。 */
export function getFixedConstraints(signal) {
  return requestJson('/api/pre-config/fixed-constraints', { signal, cache: 'no-store' });
}

/** 预览或保存完整组；保存重新经过服务端几何校验，失败由调用者展示。 */
export function calculateFixedConstraints(groups, fingerprint, { save = false, includeMeshes = false, enforceSpace = false, signal, action } = {}) {
  return requestJson(`/api/pre-config/fixed-constraints${save ? '' : '/preview'}`, {
    method: save ? 'PUT' : 'POST', headers: { 'Content-Type': 'application/json' }, signal,
    body: JSON.stringify({ groups, config_fingerprint: fingerprint, include_meshes: includeMeshes,
      ...(enforceSpace ? { enforce_space: true } : {}), ...(action ? { action } : {}) }),
  });
}
