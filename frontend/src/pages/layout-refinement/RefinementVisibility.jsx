/** 文件说明：提供对象树眼睛按钮和批量显示复选框；支持组合部分显示状态，不改变选择和编辑锁定。 */
import { useEffect, useRef } from 'react';
import { Eye, EyeOff } from '../../components/icons.js';
import { objectVisibility } from './refinement-display.js';

/** 对单星或整组切换可见性；部分显示时按钮隐藏全部成员，全部隐藏时恢复全部成员。 */
export function RefinementVisibilityButton({ name, ids, hiddenIds, onToggle }) {
  const state = objectVisibility(ids, hiddenIds), Icon = state.some ? Eye : EyeOff;
  const label = `${state.some ? '隐藏' : '显示'} ${name}`;
  return <button type="button" className={`refinement-visibility${state.some ? '' : ' is-hidden'}${state.some && !state.all ? ' is-partial' : ''}`}
    aria-label={label} title={`${label}${state.some && !state.all ? '（部分成员可见）' : ''}`} onClick={() => onToggle(ids)}>
    <Icon size={16} aria-hidden="true" /></button>;
}

/** 批量复选框反映逐星隐藏后的中间状态；用户勾选时恢复全部，取消时隐藏全部。 */
export function RefinementVisibilityCheckbox({ ids, hiddenIds, onChange }) {
  const input = useRef(null), state = objectVisibility(ids, hiddenIds);
  useEffect(() => { input.current.indeterminate = state.some && !state.all; }, [state.some, state.all]);
  return <label><input ref={input} type="checkbox" checked={state.all} onChange={(event) => onChange(event.target.checked)} />所有卫星</label>;
}
