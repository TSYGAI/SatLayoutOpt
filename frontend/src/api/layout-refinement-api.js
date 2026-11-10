/** 文件说明：人工微调上下文、完整校核与独立版本管理 API；数值请求只传来源指纹和操作，改名与删除由后端持久化。 */
import { requestJson } from './model-upload-api.js';

/** 生成已编码的方案接口路径，供微调与版本管理操作共用。 */
function endpoint(jobId, candidateId) {
  return `/api/layout-optimization/jobs/${encodeURIComponent(jobId)}/candidates/${encodeURIComponent(candidateId)}/refinement`;
}

/** 读取真实历史数值快照解析的编辑上下文；旧历史缺快照由服务端明确报错。 */
export function getRefinement(jobId, candidateId, signal) {
  return requestJson(endpoint(jobId, candidateId), { signal, cache: 'no-store' });
}

/** 请求完整校核；signal 取消旧请求，调用者另以版本号拒绝迟到结果。 */
export function previewRefinement(jobId, candidateId, body, signal) {
  return requestJson(`${endpoint(jobId, candidateId)}/preview`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal,
  });
}

/** 关闭当前编辑校验会话，取消旧计算并拒绝迟到请求；重置与离页不影响已保存版本。 */
export function cancelRefinementValidation(jobId, candidateId, sessionId) {
  return requestJson(`${endpoint(jobId, candidateId)}/preview/${encodeURIComponent(sessionId)}`, { method: 'DELETE', keepalive: true });
}

/** 保存前再次正式验收并创建独立版本，原始方案保持不变。 */
export function saveRefinement(jobId, candidateId, body) {
  return requestJson(`${endpoint(jobId, candidateId)}/versions`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
}

/** 重命名独立微调版本，返回已持久化的候选数据；非法名称由服务端拒绝。 */
export function renameRefinementVersion(jobId, candidateId, name) {
  return requestJson(`${endpoint(jobId, candidateId)}/name`, {
    method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name }),
  });
}

/** 删除已确认的单个微调版本，成功返回空响应；不删除项目及共享模型资源。 */
export function deleteRefinementVersion(jobId, candidateId) {
  return requestJson(endpoint(jobId, candidateId), { method: 'DELETE' });
}
