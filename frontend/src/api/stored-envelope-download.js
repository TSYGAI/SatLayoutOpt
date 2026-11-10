/**
 * 文件说明：读取数据管理页正式包络的 STL 导出响应，复用统一 API 地址并保留保存名称对应的文件名。
 * 只负责 HTTP、响应体与错误转换，不触发浏览器保存或管理页面提示。
 */
import { monitoredFetch } from '../observability/runtime-log.js';


import { resolveApiUrl } from './model-upload-api.js';

/** 解析服务端下载文件名；优先采用 UTF-8 扩展字段，编码无效或缺失时回退普通字段及默认名。 */
function readFilename(disposition, fallback) {
  const encoded = disposition.match(/filename\*\s*=\s*UTF-8''([^;]+)/i)?.[1];
  if (encoded) {
    try { return decodeURIComponent(encoded.trim()); } catch { /* 继续使用普通文件名。 */ }
  }
  return disposition.match(/filename\s*=\s*"([^"]+)"/i)?.[1]
    || disposition.match(/filename\s*=\s*([^;\s]+)/i)?.[1]
    || fallback;
}

/**
 * 请求并完整接收 STL 文件；拒绝旧服务忽略格式后返回的 NPZ，错误、中断或取消均抛出异常。
 * @param {string} downloadUrl 现有接口返回的包络下载路径。
 * @param {string} fallbackFilename 响应未指定文件名时使用的名称。
 * @param {AbortSignal} signal 页面离开时取消下载的信号。
 * @returns {Promise<{blob: Blob, filename: string}>} 完整文件内容及服务端文件名。
 */
export async function fetchStoredEnvelopeFile(downloadUrl, fallbackFilename, signal) {
  const separator = downloadUrl.includes('?') ? '&' : '?';
  const response = await monitoredFetch(await resolveApiUrl(`${downloadUrl}${separator}format=stl`), { signal, cache: 'no-store' });
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    throw new Error(body.detail || `请求失败（${response.status}）`);
  }
  if (response.headers.get('Content-Type')?.split(';')[0].trim() !== 'model/stl') {
    await response.body?.cancel();
    throw new Error('服务未返回 STL 模型，请重启后端后重试');
  }
  const blob = await response.blob();
  const filename = readFilename(response.headers.get('Content-Disposition') || '', fallbackFilename);
  return { blob, filename };
}
