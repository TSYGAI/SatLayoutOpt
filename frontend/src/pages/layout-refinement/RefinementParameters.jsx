/** 文件说明：编辑侧挂及顶部世界坐标和绕筒角度，以最多三位小数和名称后的括号单位展示参数；保留正式精度与整组增量，安装边界及最终可行性由后端提供。 */
import { useEffect, useRef, useState } from 'react';
import { groupFor } from './refinement-state.js';
import { formatRefinementNumber, hasRefinementParameterChange, satelliteName, selectionSummary } from './refinement-presentation.js';
import { RefinementDimensions } from './RefinementDimensions.jsx';
import { Boxes, ChevronDown, Crosshair, LockKeyhole, LockKeyholeOpen, Minus, Plus, Satellite, Save, Ungroup } from '../../components/icons.js';

const EMPTY_DELTA = { angle: '0', height: '0', suspension: '0', x: '0', y: '0' };

/** 相邻步进按钮立即调整；绝对参数只有实际改值才提交，查看或原值重输保持完整精度。 */
function ParameterField({ label, unit, value, step, disabled, pending, onChange, onNudge, id, revision, absolute = false }) {
  const [text, setText] = useState(() => formatRefinementNumber(value)), edited = useRef(false);
  useEffect(() => { setText(formatRefinementNumber(value)); edited.current = false; }, [value, revision]);
  /** 区分真实编辑和显示舍入；空值恢复，回车和失焦只提交一次，原值重输不增加动作。 */
  function commit() {
    if (!absolute) {
      if (text.trim() && Number.isFinite(Number(text))) setText(formatRefinementNumber(Number(text)));
      return;
    }
    if (!edited.current) return;
    edited.current = false;
    const number = Number(text);
    if (hasRefinementParameterChange(text, value)) onChange(number);
    else setText(formatRefinementNumber(value));
  }
  return <div className="refinement-field"><label htmlFor={id}>{label}<span>（{unit}）</span></label><div className="refinement-number-stepper">
    <button type="button" aria-label={`${label}减小`} disabled={disabled} onClick={() => onNudge(-step)}><Minus aria-hidden="true" /></button>
    <input id={id} type="number" step={step} value={text} disabled={disabled || pending} onChange={(event) => { edited.current = true; setText(event.target.value); if (!absolute) onChange(event.target.value); }}
      onBlur={commit} onKeyDown={(event) => { if (event.key === 'Enter') event.currentTarget.blur(); }} />
    <button type="button" aria-label={`${label}增加`} disabled={disabled} onClick={() => onNudge(step)}><Plus aria-hidden="true" /></button></div></div>;
}

/** 组合没有成员编辑入口，只有拆解后才能显示单颗绝对参数。 */
export function RefinementParameters({ state, selection, execute, name, setName }) {
  const snapshot = state.snapshot, [delta, setDelta] = useState(EMPTY_DELTA);
  const identity = selection.join('|');
  useEffect(() => { setDelta(EMPTY_DELTA); }, [identity]);
  const items = selection.map((id) => snapshot.candidate.placements.find((item) => item.instance_id === id)).filter(Boolean);
  const group = groupFor(snapshot.groups, selection[0]), summary = selectionSummary(items);
  const locked = items.some((item) => item.edit_locked), fixed = items.some((item) => item.fixed), top = items.some((item) => item.mount === 'top');
  const topOnly = items.length > 0 && items.every((item) => item.mount === 'top');
  const disabled = state.saving || (!state.checked && !state.pending) || !items.length, immovable = disabled || locked;
  const settings = state.context.settings, single = items.length === 1 && !group ? items[0] : null, satellites = state.job?.locked_config?.satellites;
  const fields = [['angle', group ? '共同旋转' : topOnly ? '水平旋转' : '环向角度', group ? 'Δ°' : '°', settings.angle_step],
    ...(topOnly ? [['x', group ? '共同 X 平移' : '水平 X 位置', group ? 'Δmm' : 'mm', settings.translation_step],
      ['y', group ? '共同 Y 平移' : '水平 Y 位置', group ? 'Δmm' : 'mm', settings.translation_step]] : []),
    ['height', group ? '共同升降' : '安装区域高度', group ? 'Δmm' : 'mm', settings.height_step],
    ['suspension', group ? '共同悬高' : '悬高', group ? 'Δmm' : 'mm', settings.suspension_step]];
  /** 顶部 XY 位置使用安装面中心的世界坐标，角度与悬高沿用正式响应，显示舍入不写回。 */
  function valueFor(key) {
    return { angle: single?.rotation_z_deg, height: single?.edit_height_mm, suspension: single?.suspension_mm,
      x: single?.installation_face_center_mm[0], y: single?.installation_face_center_mm[1] }[key];
  }
  /** 共同增量作为单一命令应用于完整对象，锁定状态由后端再次验证。 */
  function transform(changes) { return execute({ kind: 'transform', ids: [...selection], ...changes }); }
  /** 将单颗绝对值换算成统一命令使用的增量。 */
  function absolute(key, value) { return transform({ [key]: value - valueFor(key) }); }
  /** 只提交当前对象开放的共同参数，保持一次撤销恢复完整操作。 */
  async function applyDelta() {
    const keys = fields.map(([key]) => key).filter((key) => !(top && key === 'height'));
    const values = Object.fromEntries(keys.map((key) => [key, Number(delta[key])]));
    if (keys.every((key) => delta[key].trim()) && Object.values(values).every(Number.isFinite)) {
      if (!Object.values(values).some((value) => value !== 0) || await transform(values)) setDelta(EMPTY_DELTA);
    }
  }
  return <aside className="refinement-parameters" aria-label="选中对象参数"><div className="refinement-inspector-title">
    <h2>{group ? <Boxes aria-hidden="true" /> : <Satellite aria-hidden="true" />}{group?.name || (single && satelliteName(single, satellites)) || '选择卫星'}</h2><span>{group ? '组合' : '卫星'}</span></div>
    <p className="refinement-help">{group ? `${items.length} 颗 · 质量 ${formatRefinementNumber(summary.mass)} kg · 整体联动` : single ? `质量 ${formatRefinementNumber(summary.mass)} kg · ${single.mount === 'top' ? '顶部' : '侧挂'}` : '在左侧列表或画布中选择对象。'}</p>
    <RefinementDimensions state={state} />
    {items.length > 0 && <>{locked && <p className="refinement-notice">{fixed ? '含来源固定卫星，禁止单独调整；修改筒尺寸时沿用原有随动规则。' : '对象已锁定，禁止单独调整；修改筒尺寸时保持相对安装关系随动。'}</p>}
      {top && !topOnly && <p className="refinement-notice">含顶部成员，可共同绕筒旋转和调整悬高；水平平移需先拆解组合。</p>}
      {group && <div className="refinement-object-actions"><button type="button" disabled={disabled || state.pending} onClick={() => execute({ kind: 'decompose', id: group.id })}><Ungroup aria-hidden="true" />拆解组合</button>
        <p className="refinement-help">{group.children?.length ? '每次拆解一层；恢复子组合后可继续拆成单颗，当前位置保持。' : '拆解后各成员可单独选择，当前位置保持。'}{group.system ? '原有对称约束仍参与完整校核。' : ''}</p></div>}
      {!fixed && <button type="button" className="refinement-lock" aria-pressed={locked} disabled={disabled || state.pending} onClick={() => execute({ kind: 'lock', ids: [...selection], locked: !locked })}>{locked ? <LockKeyhole aria-hidden="true" /> : <LockKeyholeOpen aria-hidden="true" />}{locked ? '解锁对象' : '锁定对象'}</button>}
      <div className="refinement-fields">{fields.map(([key, label, unit, step]) => <div key={`${identity}:${key}`}><ParameterField id={`refinement-${single ? '' : 'delta-'}${key}`} label={label} unit={unit} step={step}
        value={single ? valueFor(key) : delta[key]} revision={single ? state.history.cursor : undefined} absolute={Boolean(single)} pending={state.pending} disabled={immovable || (top && key === 'height')}
        onChange={(value) => single ? absolute(key, value) : setDelta((current) => ({ ...current, [key]: value }))} onNudge={(value) => transform({ [key]: value })} /></div>)}</div>
      {group && <><button type="button" className="primary refinement-apply" disabled={immovable || Object.values(delta).some((value) => !value.trim() || !Number.isFinite(Number(value)))} onClick={applyDelta}>应用整组调整</button>
        <p className="refinement-help">组合内始终一起调整。需要单独调整或交换成员，请先拆解组合。</p></>}
      <div className="refinement-coordinate-block"><span><Crosshair aria-hidden="true" />{group ? '组合质心' : '卫星质心'}（mm）</span><dl>{['X', 'Y', 'Z'].map((axis, index) => <div key={axis}><dt>{axis}</dt><dd>{formatRefinementNumber(summary.center[index])}</dd></div>)}</dl></div>
      {group && <details className="refinement-member-details"><summary>组合成员 · {items.length} 颗</summary>{items.map((item) => <p key={item.instance_id}><strong>{satelliteName(item, satellites)}</strong><br />质量（kg）{formatRefinementNumber(item.mass_kg)} · 悬高（mm）{formatRefinementNumber(item.suspension_mm)}<br />质心（mm）[{item.center_of_mass_mm.map(formatRefinementNumber).join(', ')}]</p>)}</details>}
      </>}
    <details className="refinement-version-name"><summary><Save aria-hidden="true" />另存版本名称<ChevronDown className="refinement-disclosure" aria-hidden="true" /></summary><label className="refinement-field"><span>新版本名称（可选）</span><input aria-label="微调版本名称" value={name} disabled={state.saving} onChange={(event) => setName(event.target.value)} placeholder="自动命名微调版本" /></label></details>
  </aside>;
}
