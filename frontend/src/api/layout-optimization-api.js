/** 文件说明：封装布局配置、任务、历史名称/删除与导出接口；只负责 HTTP，不计算业务几何。 */

import { requestJson, resolveApiUrl } from './model-upload-api.js';

const base = '/api/layout-optimization';

/** 读取左侧栏锁定模型清单、前置尺寸与悬高默认值，可用 signal 取消。 */
export function getLayoutConfig(signal) {
  return requestJson(`${base}/config`, { signal, cache: 'no-store' });
}

/** 提交独立参数快照并启动无时间上限的后台任务，返回任务标识。 */
export function startLayoutJob(parameters) {
  return requestJson(`${base}/jobs`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(parameters) });
}

/** 读取指定任务的最新状态及有效结果，支持取消当前 HTTP 读取。 */
export function getLayoutJob(id, signal) {
  return requestJson(`${base}/jobs/${encodeURIComponent(id)}`, { signal, cache: 'no-store' });
}

/** 分页读取布局历史摘要，默认展示最近任务。 */
export function getLayoutHistory(signal, offset = 0) {
  return requestJson(`${base}/jobs?offset=${offset}`, { signal, cache: 'no-store' });
}

/** 持久化历史项目名称并返回任务；由后端校验名称，原始备注保持不变。 */
export function renameLayoutJob(id, name) {
  return requestJson(`${base}/jobs/${encodeURIComponent(id)}/name`, {
    method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name }),
  });
}

/** 删除指定历史及其快照，运行中由后端拒绝；成功的 204 空响应无需解析。 */
export function deleteLayoutJob(id) {
  return requestJson(`${base}/jobs/${encodeURIComponent(id)}`, { method: 'DELETE' });
}

/** 请求协作取消后台任务；页面关闭本身不会取消计算。 */
export function cancelLayoutJob(id) {
  return requestJson(`${base}/jobs/${encodeURIComponent(id)}/cancel`, { method: 'POST' });
}

/** 读取任务自己的模型坐标包络快照，供 Three.js 用模型到全局毫米矩阵显示。 */
export function getLayoutMeshes(id, signal) {
  return requestJson(`${base}/jobs/${encodeURIComponent(id)}/meshes`, { signal, cache: 'no-store' });
}

/** 请求指定历史任务和候选的 Excel 文件，返回 Blob；失败时抛出可显示的后端错误。 */
export async function exportLayoutCandidate(id, candidateId) {
  const path = `${base}/jobs/${encodeURIComponent(id)}/candidates/${encodeURIComponent(candidateId)}/export`;
  const response = await fetch(await resolveApiUrl(path), { cache: 'no-store' });
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    throw new Error(body.detail || `导出失败（${response.status}）`);
  }
  return response.blob();
}
