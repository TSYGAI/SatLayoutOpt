/**
 * 文件说明：管理数据管理页 STL 包络下载的等待、防重复、按保存名称保存及右下角结果提示。
 * 依赖独立下载 API 与公共 toast；页面卸载时取消请求，避免向其他页面发送过期提示。
 */

import { useEffect, useRef, useState } from 'react';
import { fetchStoredEnvelopeFile } from '../../api/stored-envelope-download.js';
import { showToast } from '../../components/toast.js';

/** 返回下载操作及当前下载目标；同一时间只处理一份文件，成功后释放临时下载地址。 */
export function useStoredEnvelopeDownload() {
  const [downloadingVariant, setDownloadingVariant] = useState(null);
  const requestRef = useRef(null);

  /** 页面卸载时中止尚未完成的传输；取消不显示错误或成功提示。 */
  useEffect(() => () => requestRef.current?.abort(), []);

  /** 下载指定记录的正式包络，完整接收后交给浏览器保存；失败反馈错误并恢复可重试状态。 */
  async function downloadVariant(recordId, deviceName, variant) {
    if (requestRef.current) return;
    const controller = new AbortController();
    requestRef.current = controller;
    setDownloadingVariant({ recordId, rotZ: variant.rotZ });
    const label = variant.rotZ === 0 ? '基础包络' : `历史 Rz ${variant.rotZ}° 包络`;
    try {
      const name = deviceName.trim() || '未命名模型';
      const fallback = `${name}${variant.rotZ === 0 ? '' : `_Rz${variant.rotZ}`}.stl`;
      const file = await fetchStoredEnvelopeFile(variant.downloadUrl, fallback, controller.signal);
      if (controller.signal.aborted) return;
      const url = URL.createObjectURL(file.blob);
      const link = document.createElement('a');
      try {
        link.href = url;
        link.download = file.filename;
        document.body.appendChild(link);
        link.click();
      } finally {
        link.remove();
        URL.revokeObjectURL(url);
      }
      showToast(`${label}下载成功 · ${deviceName}`);
    } catch (error) {
      if (!controller.signal.aborted) showToast(`${label}下载失败：${error.message}`, true);
    } finally {
      requestRef.current = null;
      if (!controller.signal.aborted) setDownloadingVariant(null);
    }
  }

  return { downloadingVariant, downloadVariant };
}
