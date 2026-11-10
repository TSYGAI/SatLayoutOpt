/**
 * 文件说明：呈现每模型独立的体素分辨率输入和标题旁的推荐配置入口。
 * 仅派发表单变更和失焦事件；建议浮窗独立呈现，持久化、默认值及计算校验由页面和后端负责。
 */

import { EnvelopeResolutionHelp } from './EnvelopeResolutionHelp.jsx';
import '../../../styles/model-envelope-settings.css';

/** 渲染最长边体素格数输入；values 为当前模型设置，onBlur 触发页面统一保存。 */
export function ModelEnvelopeSettingsSection({ values, disabled, onChange, onBlur }) {
  return (
    <section className="model-settings-form-section model-envelope-settings-section" aria-labelledby="envelope-settings-title">
      <div className="model-settings-section-heading model-envelope-settings-heading">
        <h2 id="envelope-settings-title">体素分辨率设置</h2>
        <EnvelopeResolutionHelp />
      </div>
      <div className="model-envelope-settings-input">
        <label className="model-settings-field" htmlFor="envelope-refinement-grid-size">
          <span>体素分辨率<span className="model-envelope-resolution-hint">（越大越精准）</span></span>
          <input
            id="envelope-refinement-grid-size"
            type="number"
            min="1"
            step="1"
            required
            value={values?.refinement_grid_size ?? ''}
            disabled={disabled}
            aria-label="体素分辨率"
            onChange={(event) => onChange(event.target.value)}
            onBlur={onBlur}
          />
        </label>
      </div>
    </section>
  );
}
