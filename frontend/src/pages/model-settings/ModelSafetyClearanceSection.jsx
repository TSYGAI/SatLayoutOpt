/**
 * 文件说明：呈现模型设置页的六向包络尺寸增量输入栏，复用页面字段样式。
 * 仅派发字段变更与失焦事件，由页面统一排队保存，不持有业务规则或生成逻辑。
 */

import { SAFETY_CLEARANCE_FIELDS } from './model-safety-clearance-state.js';

/**
 * 渲染前后、左右、上下三组毫米距离；每次失焦请求保存完整模型设置。
 * @param {{ values: object, disabled: boolean, onChange: Function, onBlur: Function }} props 受控值、禁用状态及页面回调。
 */
export function ModelSafetyClearanceSection({ values, disabled, onChange, onBlur }) {
  return (
    <section className="model-settings-form-section" aria-labelledby="safety-clearance-title">
      <div className="model-settings-section-heading">
        <h2 id="safety-clearance-title">包络增量 <small className="model-settings-unit-hint">(mm)</small></h2>
      </div>
      <div className="model-settings-field-grid">
        {SAFETY_CLEARANCE_FIELDS.map(({ key, label, axis }) => (
          <label key={key} className="model-settings-field" htmlFor={`safety-clearance-${key}`}>
            <span>{label} <small>{axis}</small></span>
            <input
              id={`safety-clearance-${key}`}
              type="number"
              min="0"
              step="any"
              required
              value={values[key]}
              disabled={disabled}
              aria-label={`${label}方包络增量（mm）`}
              onChange={(event) => onChange(key, event.target.value)}
              onBlur={onBlur}
            />
          </label>
        ))}
      </div>
      <p className="model-settings-clearance-hint">按当前模型姿态设置，修改后需重新生成包络。</p>
    </section>
  );
}
