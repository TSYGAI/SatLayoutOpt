/** 文件说明：硬件设置页面的读写 API；配置类型、关联校验和文件写入由独立后端负责。 */
import { requestJson } from './model-upload-api.js';

/** 获取磁盘版本、当前运行值、字段说明和计算服务器硬件快照，支持取消。 */
export function getHardwareConfig(signal) {
  return requestJson('/api/hardware-config', { signal, cache: 'no-store' });
}

/** 携带读取版本提交增量；版本冲突和字段错误通过带 status 的异常交给页面处理。 */
export function saveHardwareConfig(revision, changes) {
  return requestJson('/api/hardware-config', {
    method: 'PUT', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ revision, changes }),
  });
}

/** 请求基于计算服务硬件生成的未保存推荐；只有用户确认后页面才会把它合并到草稿。 */
export function getHardwareRecommendation(signal) {
  return requestJson('/api/hardware-config/recommendation', {
    method: 'POST', signal, cache: 'no-store',
  });
}
