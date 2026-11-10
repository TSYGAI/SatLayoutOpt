/** 文件说明：微调工作台的质心指标、校核状态和草稿提示；数值按统一的最多三位小数展示，只呈现同一草稿的正式结果，保留失败重试。 */
import { ArrowUpDown, Crosshair, LoaderCircle, ShieldCheck, TriangleAlert } from '../../components/icons.js';
import { formatRefinementNumber } from './refinement-presentation.js';

/** 展示水平偏移、余量、整体高度变化和校核状态；所有数值取同一草稿。 */
export function RefinementMetrics({ state }) {
  const candidate = state.snapshot.candidate, validation = candidate.validation;
  const dz = validation.center_of_mass_mm[2] - state.context.candidate.validation.center_of_mass_mm[2];
  const margin = candidate.axis_radius_mm - validation.radial_com_mm;
  const dzText = formatRefinementNumber(dz);
  return <><section className="refinement-metrics" aria-label="布局实时检查">
    <div><span><Crosshair aria-hidden="true" />水平质心偏移（mm）</span><p><strong className={margin < 0 ? 'refinement-danger' : ''}>{formatRefinementNumber(validation.radial_com_mm)}</strong></p><small>余量 {formatRefinementNumber(margin)} mm · 允许 {formatRefinementNumber(candidate.axis_radius_mm)} mm</small></div>
    <div><span><ArrowUpDown aria-hidden="true" />整体质心 Z（mm）</span><p><strong>{formatRefinementNumber(validation.center_of_mass_mm[2])}</strong></p><small>相对来源方案 {Number(dzText) > 0 ? '+' : ''}{dzText} mm · 总质量 {formatRefinementNumber(validation.total_mass_kg)} kg</small></div>
    <div className="refinement-check-result"><span><ShieldCheck aria-hidden="true" />实时检查</span><strong className={state.error ? 'refinement-danger' : state.pending || !state.checked ? 'refinement-pending' : validation.valid ? 'refinement-success' : 'refinement-danger'}>
      {state.error ? <TriangleAlert aria-hidden="true" /> : state.pending || !state.checked ? <LoaderCircle className="refinement-spinning" aria-hidden="true" /> : validation.valid ? <ShieldCheck aria-hidden="true" /> : <TriangleAlert aria-hidden="true" />}
      {state.error ? '操作未通过' : state.pending ? '正在校核操作' : !state.checked ? '待正式校核' : validation.valid ? '完整约束通过' : '需要调整'}</strong>
      {state.checked && validation.violations.length > 0 ? <details><summary>{validation.violations.length} 项约束问题</summary><ul>{validation.violations.map((message) => <li key={message}>{message}</li>)}</ul></details>
        : <small>{state.checked ? '位置、包络与质心已完成正式校核' : '实时位姿与质心已更新，正在校核完整约束'}</small>}</div>
  </section><footer className="refinement-status"><span>全局 X / Y / Z（mm）· 正式安全包络</span><span>更改自动保存在本机</span>
    {(state.error || state.meshError || state.storageError) && <p role="alert">{state.error || state.meshError || state.storageError}
      {state.error && state.retryable && <button type="button" disabled={state.saving || state.pending} onClick={state.retry}>重试校核</button>}</p>}
    {state.notice && <p role="status">{state.notice}</p>}</footer></>;
}
