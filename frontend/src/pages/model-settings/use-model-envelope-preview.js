/**
 * 文件说明：连接模型设置页与独立安全包络渲染器，管理显示开关、加载反馈和卸载清理。
 * 显示开关按模型及产物版本保留于会话；仅几何草稿暂停覆盖层，安装面和安装点保存期间保留当前包络。
 */

import { useEffect, useState } from 'react';
import { usePageSessionState } from '../../app/page-session-state.js';
import { setCurrentModelEnvelopePreview } from '../model-upload/model-preview-loader.js';
import { ENVELOPE_PREVIEW_STATE_EVENT } from './model-preview-events.js';
import { areModelEnvelopeSettingsEqual } from './model-settings-state.js';

/** 根据当前模型和后端状态加载覆盖层，返回供工具栏使用的显示状态及切换方法。 */
export function useModelEnvelopePreview({ modelId, envelope, settings, savedSettings }) {
  const [visible, setVisible] = usePageSessionState('model-envelope', `${modelId || ''}:${envelope.generated_at || ''}`, true);
  const [display, setDisplay] = useState({ state: 'idle', message: '' });
  const hasGeometryDraft = !savedSettings || !areModelEnvelopeSettingsEqual(settings, savedSettings);
  const available = Boolean(modelId && envelope.state === 'ready' && !hasGeometryDraft);

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
