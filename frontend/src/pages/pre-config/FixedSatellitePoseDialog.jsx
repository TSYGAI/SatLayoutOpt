/** 文件说明：固定卫星的非模态世界位姿浮窗，仅支持模型原点与质心基准；单轴输入失焦/Enter提交，约束违规以中文展示，不处理模型或碰撞。 */
import { useEffect, useId, useRef, useState } from 'react';
import { X } from '../../components/icons.js';
import { SettingsSelect } from '../../components/SettingsSelect.jsx';
import { usePageSessionState } from '../../app/page-session-state.js';
import { FIXED_POSE_REFERENCES, fixedPoseReferencePoint } from './fixed-pose-reference.js';
import { PreConfigNumberInput } from './PreConfigNumberInput.jsx';
import { formatPreConfigError } from './pre-config-errors.js';
import { formatParameterNumber } from '../../utils/number-format.js';

/** 保留世界数值的完整编辑精度；失焦显示由共用数字输入格式化，模型矩阵不受影响。 */
function formatValue(value) {
  return Number.isFinite(value) ? String(value) : '';
}

/** 编辑一个位姿分量；焦点期间保留草稿，失焦或Enter提交，Escape取消当前输入，空值/非有限数不改变位姿。 */
function PoseField({ label, value, disabled, onCommit }) {
  const [text, setText] = useState(() => formatValue(value));
  const [error, setError] = useState('');
  const errorId = useId();
  const focused = useRef(false), dirty = useRef(false);
  useEffect(() => {
    if (!focused.current || !dirty.current) setText(formatValue(value));
  }, [value, disabled]);
  /** 提交有效输入并展示拒绝原因；未修改字段不会因为显示舍入而制造位置漂移。 */
  function commit() {
    focused.current = false;
    if (!dirty.current) return;
    const number = Number(text);
    if (text.trim() && Number.isFinite(number) && (number === value || number === Number(formatParameterNumber(value)))) {
      dirty.current = false; setText(formatValue(value)); setError(''); return;
    }
    const reason = !text.trim() || !Number.isFinite(number) ? '请输入有限数值' : onCommit(number);
    if (reason) { setError(reason); return; }
    dirty.current = false; setError('');
  }
  return <label className="fixed-pose-field"><span>{label}</span>
    <PreConfigNumberInput label={label} value={text} disabled={disabled} aria-invalid={Boolean(error)} aria-describedby={error ? errorId : undefined}
      onFocus={() => { focused.current = true; }} onValueChange={(value) => { dirty.current = true; setText(value); setError(''); }}
      onBlur={commit} onKeyDown={(event) => {
        if (event.key === 'Enter') { event.preventDefault(); event.currentTarget.blur(); }
        if (event.key === 'Escape') {
          event.stopPropagation(); dirty.current = false; setText(formatValue(value)); setError(''); event.currentTarget.blur();
        }
      }} />
    {error && <small role="alert" id={errorId}>{error}</small>}
  </label>;
}

/** 显示选中实例的实时世界位姿；顶部横向坐标由居中姿态决定，环向与镜像成员仍按同一组联动。 */
export function FixedSatellitePoseDialog({ state, placement }) {
  const [savedReference, setReference] = usePageSessionState('pre-config', 'fixedPoseReference', 'center-of-mass');
  const reference = FIXED_POSE_REFERENCES.some((item) => item.value === savedReference) ? savedReference : 'center-of-mass';
  // 已移除的基准恢复为质心，只更新界面选择，不提交位姿修改。
  useEffect(() => { if (savedReference !== reference) setReference(reference); }, [savedReference, reference, setReference]);
  const point = fixedPoseReferencePoint(placement, reference);
  const disabled = !state.poseEditable;
  return <section className="fixed-pose-dialog" role="dialog" aria-modal="false" aria-label="卫星世界位姿" key={placement.instance_id}
    onKeyDown={(event) => { if (event.key === 'Escape') state.closePose(); }}>
    <header><div className="fixed-pose-title"><h3>卫星世界位姿</h3><span title={placement.name}>{placement.name}</span></div>
      <button type="button" aria-label="关闭卫星位姿窗口" onClick={state.closePose}><X aria-hidden="true" /></button></header>
    <div className="model-settings-field fixed-pose-reference"><span>位置基准点</span>
      <SettingsSelect id="fixed-pose-reference-select" label="位置基准点" value={reference} onChange={setReference} options={FIXED_POSE_REFERENCES} />
    </div>
    <div className="fixed-pose-fields">
      {['X', 'Y', 'Z'].map((axis, index) => <PoseField key={`${placement.instance_id}-${reference}-${axis}`} label={`世界 ${axis} (mm)`}
        value={point?.[index]} disabled={disabled || !point || (placement.mount === 'top' && index < 2)}
        onCommit={(value) => state.editWorldPose(placement.instance_id, { position: { reference, axis: index, value } })} />)}
    </div>
    {!point && <p className="fixed-pose-violations" role="alert">当前基准点数据暂不可用</p>}
    <p className={placement.constraint_valid === false ? 'fixed-pose-status invalid' : 'fixed-pose-status'} role="status">
      {state.status === 'error' ? '正式校验失败 · 调整后再保存' : state.snapshot?.validation_pending ? '位姿已即时更新 · 正式校验中' : placement.constraint_valid === false ? '约束违规 · 修正后才能保存' : '当前位姿已校验'}</p>
    {state.error && <p className="fixed-pose-violations" role="alert">{state.error}</p>}
    {placement.constraint_violations?.length > 0 && <ul className="fixed-pose-violations">{placement.constraint_violations.map((reason) => <li key={reason}>{formatPreConfigError(reason, '当前位姿未通过约束校验，请调整后重试。')}</li>)}</ul>}
  </section>;
}
