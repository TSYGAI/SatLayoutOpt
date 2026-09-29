/**
 * 文件说明：连接模型设置页与独立安全包络渲染器，管理显示开关、加载反馈和卸载清理。
 * 使用后端生成状态控制可用性；未保存草稿期间暂停覆盖层，避免显示过时结果。
 */

import { useEffect, useState } from 'react';
import { setCurrentModelEnvelopePreview } from '../model-upload/model-upload-page.js';
import { ENVELOPE_PREVIEW_STATE_EVENT } from './model-envelope-preview.js';

/** 根据当前模型和后端状态加载覆盖层，返回供工具栏使用的显示状态及切换方法。 */
export function useModelEnvelopePreview({ modelId, envelope, settings, hasDraft }) {
  const [visible, setVisible] = useState(true);
  const [display, setDisplay] = useState({ state: 'idle', message: '' });
  const available = Boolean(modelId && envelope.state === 'ready' && !hasDraft);

  useEffect(() => {
    setVisible(true);
  }, [modelId, envelope.generated_at]);

  useEffect(() => { setDisplay({ state: 'idle', message: '' }); }, [modelId]);

  useEffect(() => {
    /** 忽略旧模型迟到的覆盖层状态，保留当前页面的加载反馈。 */
    function handleState(event) {
      if (event.detail.modelId === modelId) setDisplay(event.detail);
    }
    window.addEventListener(ENVELOPE_PREVIEW_STATE_EVENT, handleState);
    return () => window.removeEventListener(ENVELOPE_PREVIEW_STATE_EVENT, handleState);
  }, [modelId]);

  useEffect(() => {
    setCurrentModelEnvelopePreview({ modelId, available, generatedAt: envelope.generated_at, settings, visible });
  }, [modelId, available, envelope.generated_at, settings, visible]);

  useEffect(() => () => setCurrentModelEnvelopePreview(null), []);

  /** 切换显示意图；失败后的点击先关闭，再次打开即可重试加载。 */
  function toggle() {
    setVisible((current) => !current);
  }

  return { available, visible, display, toggle };
}
