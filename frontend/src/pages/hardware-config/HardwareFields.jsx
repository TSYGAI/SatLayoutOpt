/** 文件说明：按后端字段契约渲染常用与高级硬件设置，展示单位、用途、修改状态与当前生效值。 */
import { displayValue } from './hardware-config-state.js';
import { formatParameterNumber } from '../../utils/number-format.js';
import { ParameterNumberInput } from '../../components/ParameterNumberInput.jsx';

/** 渲染单个有标签及说明的设置项；数值边界用于输入提示，最终关联校验由后端执行。 */
function HardwareField({ field, state }) {
  const id = `hardware-${field.key.replaceAll('.', '-')}`;
  const dirty = Object.hasOwn(state.changes, field.key);
  const pending = state.snapshot.pending_keys.includes(field.key);
  const busy = state.status !== 'ready';
  return <div className={`hardware-field${dirty ? ' is-edited' : ''}`}>
    <div className="hardware-field-label"><label htmlFor={id}>{field.label}</label>
      {dirty ? <span className="hardware-tag">未保存</span> : pending && <span className="hardware-tag pending">待重启</span>}
    </div>
    <div className="hardware-input-wrap">
      {field.kind === 'select' ? <select id={id} value={state.draft[field.key]} disabled={busy}
        aria-describedby={`${id}-description`} onChange={(event) => state.edit(field.key, event.target.value)}>
        {field.options.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
      </select> : <><ParameterNumberInput id={id} required min={field.min} max={field.max} step={field.step}
        value={state.draft[field.key]} disabled={busy} aria-describedby={`${id}-description`}
        onChange={(event) => state.edit(field.key, event.target.value)} />
        {field.unit && <span className="hardware-input-unit">{field.unit}</span>}</>}
    </div>
    <p id={`${id}-description`}>{field.description}</p>
    {(dirty || pending) && <small className="hardware-active-value">当前生效：{field.kind === 'select'
      ? field.options.find(([key]) => key === state.snapshot.active_values[field.key])?.[1]
      : `${formatParameterNumber(displayValue(field, state.snapshot.active_values[field.key]))} ${field.unit}`}</small>}
  </div>;
}

/** 按后端可见性展示资源参数；隐藏的显示细节仍保留配置，常用与高级项分别排列。 */
export function HardwareFields({ fields, state }) {
  const visible = fields.filter((field) => field.visible !== false);
  const common = visible.filter((field) => !field.advanced);
  const advanced = visible.filter((field) => field.advanced);
  return <>
    <div className="hardware-fields">{common.map((field) => <HardwareField key={field.key} field={field} state={state} />)}</div>
    {advanced.length > 0 && <details className="hardware-advanced">
      <summary>高级设置 <span>{advanced.length} 项 · 内存估计与处理细节</span></summary>
      <div className="hardware-fields">{advanced.map((field) => <HardwareField key={field.key} field={field} state={state} />)}</div>
    </details>}
  </>;
}
