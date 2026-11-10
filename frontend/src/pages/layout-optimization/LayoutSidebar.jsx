/** 文件说明：展示锁定参数、卫星清单与优化参数，顶部仅显示独立操作错误，任务失败交由进度阶段展示；委托独立组件管理方案和历史，不实现几何规则。 */

import { ChevronDown, CircleStop, Play, RefreshCw } from '../../components/icons.js';
import { SettingsSelect } from '../../components/SettingsSelect.jsx';
import { GEOMETRY_FIELDS, isLayoutRunning } from './layout-state.js';
import { LayoutProgress } from './LayoutProgress.jsx';
import { LayoutHistory } from './LayoutHistory.jsx';
import { LayoutRefinements } from './LayoutRefinements.jsx';
import { LayoutCandidates } from './LayoutCandidates.jsx';
import { LayoutSearchParameters } from './LayoutSearchParameters.jsx';
import { LayoutParameterHelp } from './LayoutParameterHelp.jsx';
import { formatParameterNumber } from '../../utils/number-format.js';
import { ParameterNumberInput } from '../../components/ParameterNumberInput.jsx';
import { formatErrorMessage } from '../../utils/error-message.js';

/** 显示带标签的只读物理参数，不用禁用输入替代真正的接口锁定。 */
function LockedValue({ label, value }) {
  return <div className="layout-parameter-card"><small>{label}</small><strong>{formatParameterNumber(value, '未设置')}</strong></div>;
}

/** 显示用户当前任务输入和锁定的配置快照；事件由独立 Hook 处理。 */
export function LayoutSidebar({ state }) {
  const { config, form, changeForm, job, selectedId, setSelectedId, busy, error } = state;
  const running = isLayoutRunning(job);
  const locked = running || busy;
  const optionsLocked = locked || state.viewingHistory;
  const currentConfig = state.viewingHistory && job?.locked_config ? job.locked_config : config;
  const selectedSatellites = currentConfig?.satellites.filter((item) => item.count > 0) ?? [];
  const fixedGroups = currentConfig?.fixed_groups ?? [];
  const fixedTop = fixedGroups.find((group) => group.mount === 'top' && group.hard_constraint !== false);

  /** 只更改获准的任务选项，不写前置配置或固化记录。 */
  function change(key, value) { changeForm({ [key]: value }); }

  /** 立即读取勾选状态，避免 React 批量更新时从 DOM 再读取到复原值。 */
  function changeTop(event) {
    const enabled = event.target.checked;
    changeForm({ top_enabled: enabled, top_record_id: enabled ? form.top_record_id : null });
  }

  return <aside className="model-sidebar layout-optimization-sidebar" aria-label="布局参数设置"><div className="layout-optimization-sidebar-body">
    <section className="layout-optimization-section">
      <h2 className="layout-sidebar-title">锁定参数</h2>
      <div className="layout-parameter-grid">{GEOMETRY_FIELDS.map(([key, label]) => <LockedValue key={key} label={label} value={currentConfig?.geometry[key]} />)}</div>
      <button className="layout-action-button" type="button" disabled={locked} onClick={state.refreshConfig}>
        <RefreshCw aria-hidden="true" /><span>刷新锁定配置</span>
      </button>
    </section>
    <section className="layout-optimization-section">
      <details className="layout-satellite-list" open>
        <summary className="layout-sidebar-disclosure"><h2 className="layout-sidebar-title">卫星装载清单</h2><span className="layout-sidebar-meta">已锁定</span><ChevronDown aria-hidden="true" /></summary>
        <div className="layout-satellite-list-items">
          {selectedSatellites.map((item) => <details className="layout-satellite" key={item.record_id}>
            <summary className="layout-sidebar-disclosure"><h3 className="layout-sidebar-subtitle">{item.name}</h3><span className="layout-sidebar-meta">× {item.count}</span><ChevronDown aria-hidden="true" /></summary>
            <dl className="layout-satellite-detail">
              <div><dt>质量：</dt><dd>{formatParameterNumber(item.mass_kg, '未设置')} kg</dd></div>
              <div><dt>向上轴向：</dt><dd>{item.up_orientation === 'free' ? '自由' : item.up_orientation ?? '历史未记录'}</dd></div>
              <div><dt>模型自身质心：</dt><dd>{item.center_of_mass ? ['x', 'y', 'z'].map((axis) => formatParameterNumber(item.center_of_mass[axis])).join(', ') : '未设置'} {item.model_unit}</dd></div>
            </dl>
          </details>)}
          {!selectedSatellites.length && <p className="layout-optimization-hint">请先在前置配置中设置卫星装载数量。</p>}
        </div>
      </details>
    </section>
    {form && <section className="layout-optimization-section">
      <div className="layout-parameter-heading"><h2 className="layout-sidebar-title">优化参数</h2><LayoutParameterHelp config={currentConfig} /></div>
      <div className="layout-parameter-grid layout-search-parameter-grid">
        {[['min_suspension_mm', '卫星悬高最小值 (mm)'], ['max_suspension_mm', '卫星悬高最大值 (mm)']].map(([key, label]) => <label className="layout-input" key={key}><span>{label}</span><ParameterNumberInput min="0" step="any" value={form[key]} disabled={optionsLocked} onChange={(event) => change(key, event.target.value)} /></label>)}
        <LayoutSearchParameters form={form} config={currentConfig} disabled={optionsLocked} onChange={change} />
      </div>
      {fixedGroups.length > 0 && <div className="layout-optimization-hint">
        <strong>已锁定固定卫星 · {fixedGroups.reduce((sum, group) => sum + group.copies, 0)} 颗</strong>
        <p>优化器安排剩余卫星；固定侧挂保持环向角度、安装高度和实际悬高，半径变化时贴合新筒面。悬高范围必须包含固定卫星的实际悬高，否则报告不可行。</p>
      </div>}
      <label className="layout-checkbox"><input type="checkbox" checked={form.top_enabled} disabled={optionsLocked || Boolean(fixedTop)} onChange={changeTop} />在顶部装载{fixedTop ? '（固定约束已锁定）' : ''}</label>
      {form.top_enabled && <div className="layout-input"><span>指定顶部卫星</span><SettingsSelect
        id="layout-top-satellite"
        label="指定顶部卫星"
        value={form.top_record_id ?? ''}
        disabled={optionsLocked || Boolean(fixedTop)}
        options={[{ value: '', label: '请选择，不自动指定' }, ...(currentConfig?.satellites ?? [])
          .filter((item) => item.count > 0)
          .map((item) => ({ value: item.record_id, label: `${item.name}（取已配置数量中的 1 颗）` }))]}
        onChange={(value) => change('top_record_id', value || null)}
      /></div>}
      <label className="layout-input"><span>任务备注</span><textarea value={form.notes} rows={3} maxLength={4000} disabled={optionsLocked} onChange={(event) => change('notes', event.target.value)} /></label>
      <div className="layout-task-actions">
        <button className="layout-action-button layout-action-button--primary" type="button" disabled={locked || state.viewingHistory || (form.top_enabled && !form.top_record_id)} onClick={state.start}>
          <Play aria-hidden="true" /><span>开始优化</span>
        </button>
        {running && <button className="layout-action-button layout-action-button--cancel" type="button" disabled={busy || job.status === 'cancelling'} onClick={state.cancel}>
          <CircleStop aria-hidden="true" /><span>取消计算</span>
        </button>}
      </div>
      {state.viewingHistory && <p className="layout-optimization-message">正在查看历史快照。点击“刷新锁定配置”后才可按当前设置新建任务。</p>}
    </section>}
    {error && <p className="layout-optimization-message" role="alert">{formatErrorMessage(error, '优化操作未能完成，请查看运行日志。')}</p>}
    {job && <LayoutProgress key={job.job_id} job={job} />}
    {job?.candidates?.length > 0 && <section className="layout-optimization-section">
      <LayoutCandidates key={job.job_id} candidates={job.candidates} defaultCount={currentConfig?.candidate_count ?? 5}
        selectedId={selectedId} onSelect={setSelectedId} />
      <LayoutRefinements key={`refinements-${job.job_id}`} state={state} defaultCount={currentConfig?.candidate_count ?? 5} />
    </section>}
    <LayoutHistory state={state} />
  </div></aside>;
}
