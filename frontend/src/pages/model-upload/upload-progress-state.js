/** 文件说明：在应用会话保存进行中的上传及失败信息；后端确认保存成功后移除进度项，不访问页面 DOM。 */

import { readPageSession, writePageSession } from '../../app/page-session-state.js';

/** 登记单个文件并返回进度标识，不持有 File 内容，避免上传结束后继续占用文件内存。 */
export function startUploadProgress(filename) {
  const id = crypto.randomUUID();
  const current = readPageSession('model-upload', 'uploads', []);
  writePageSession('model-upload', 'uploads', [...current, { id, filename, progress: 0, status: 'uploading', error: '' }]);
  return id;
}

/** 更新指定上传；传输进度满时仍等待保存确认，成功后移除该项，失败信息跨页保留。 */
export function updateUploadProgress(id, changes) {
  writePageSession('model-upload', 'uploads', (current) => changes.status === 'saved'
    ? current.filter((item) => item.id !== id)
    : current.map((item) => item.id === id ? { ...item, ...changes } : item));
}
