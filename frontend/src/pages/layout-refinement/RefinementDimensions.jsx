/** 文件说明：编辑安装筒直筒半径和高度，以最多三位小数显示并保留未编辑尺寸的原始精度；一次提交尺寸及全部随动，范围取历史后端响应，不编辑基座或整流罩。 */
import { useEffect, useState } from 'react';
import { ChevronDown, Cylinder } from '../../components/icons.js';
import { formatRefinementNumber, hasRefinementParameterChange } from './refinement-presentation.js';

/** 格式化尺寸输入，仅提交真正改变的字段，显示舍入不触发调整；最终联合边界和缩高拒绝由后端决定。 */
export function RefinementDimensions({ state }) {
  const candidate = state.snapshot.candidate, limits = state.snapshot.limits;
  const [radius, setRadius] = useState(() => formatRefinementNumber(candidate.radius_mm)), [height, setHeight] = useState(() => formatRefinementNumber(candidate.height_mm));
  const [focused, setFocused] = useState(null);
  useEffect(() => { setRadius(formatRefinementNumber(candidate.radius_mm)); setHeight(formatRefinementNumber(candidate.height_mm)); }, [candidate.radius_mm, candidate.height_mm, state.history.cursor]);
  const disabled = state.saving || state.pending || !state.checked;
  const radiusRange = limits.radius_mm, heightRange = limits.height_mm;
  const radiusChanged = hasRefinementParameterChange(radius, candidate.radius_mm), heightChanged = hasRefinementParameterChange(height, candidate.height_mm);
  /** 失焦时只格式化显示，待提交的原始输入仍保存在状态中，避免尺寸应用丢失用户输入精度。 */
  function inputText(key, text) { return focused === key || !text.trim() || !Number.isFinite(Number(text)) ? text : formatRefinementNumber(Number(text)); }
  /** 允许一次联合修改两维，任一不合法时后端拒绝整个动作，当前位姿和历史保持。 */
  function apply() {
    const command = { kind: 'resize' };
    if (radiusChanged) command.radius_mm = Number(radius);
    if (heightChanged) command.height_mm = Number(height);
    if (Object.keys(command).length > 1) state.execute(command);
  }
  return <details className="refinement-dimensions"><summary><Cylinder aria-hidden="true" /><span>安装筒尺寸（mm）<small>R {formatRefinementNumber(candidate.radius_mm)} · H {formatRefinementNumber(candidate.height_mm)}</small></span><ChevronDown className="refinement-disclosure" aria-hidden="true" /></summary>
    <label className="refinement-field" htmlFor="refinement-tube-radius"><span>安装筒半径 R（mm）</span><input id="refinement-tube-radius" type="number" step={limits.radius_step_mm}
      min={radiusRange[0]} max={radiusRange[1]} disabled={disabled || radiusRange[0] === radiusRange[1]} value={inputText('radius', radius)} onFocus={() => setFocused('radius')} onBlur={() => setFocused(null)} onChange={(event) => setRadius(event.target.value)} /></label>
    <label className="refinement-field" htmlFor="refinement-tube-height"><span>直筒高度 H（mm）</span><input id="refinement-tube-height" type="number" step={state.context.settings.height_step}
      min={heightRange[0]} max={heightRange[1]} disabled={disabled || heightRange[0] === heightRange[1]} value={inputText('height', height)} onFocus={() => setFocused('height')} onBlur={() => setFocused(null)} onChange={(event) => setHeight(event.target.value)} /></label>
    <button type="button" className="primary refinement-apply" disabled={disabled || !(radiusChanged || heightChanged) || !radius.trim() || !height.trim() || !Number.isFinite(Number(radius)) || !Number.isFinite(Number(height))} onClick={apply}>应用安装筒尺寸</button>
  </details>;
}
