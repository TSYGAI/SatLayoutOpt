/** 文件说明：显示会话中进行中的上传和失败信息，已确认保存的进度项自动隐藏。 */

import { usePageSessionState } from '../../app/page-session-state.js';

/** 根据独立上传状态渲染进度列表；不发起上传或操作三维预览。 */
export function UploadProgressList() {
  const [uploads] = usePageSessionState('model-upload', 'uploads', []);
  return <div id="upload-queue" className="upload-queue" aria-live="polite">
    {uploads.filter((item) => item.status !== 'saved').map((item) => <div className="upload-item" key={item.id}>
      <strong>{item.filename}</strong>
      <span className={item.status === 'failed' ? 'error' : ''} title={item.error}>
        {item.status === 'failed' ? '上传失败' : `上传中 ${item.progress}%`}
      </span>
      <div className="progress-track"><b style={{ width: `${item.progress}%` }} /></div>
    </div>)}
  </div>;
}
