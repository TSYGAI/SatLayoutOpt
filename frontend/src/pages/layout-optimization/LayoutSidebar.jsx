/** 文件说明：展示含固定/自由轴向的布局锁定参数、安装选项和任务操作；依赖状态 Hook，历史维护委托独立组件。 */

import { CircleStop, Play, RefreshCw } from 'lucide-react';
import { SettingsSelect } from '../../components/SettingsSelect.jsx';
import { GEOMETRY_FIELDS, JOB_LABELS, isLayoutRunning } from './layout-state.js';
import { LayoutHistory } from './LayoutHistory.jsx';

/** 显示带标签的只读物理参数，不用禁用输入替代真正的接口锁定。 */
function LockedValue({ label, value }) {
  return <div className="layout-parameter-card"><small>{label}</small><strong>{value ?? '未设置'}</strong></div>;
}

/** 显示用户当前任务输入和锁定的配置快照；事件由独立 Hook 处理。 */
export function LayoutSidebar({ state }) {
  const { config, form, changeForm, job, candidate, selectedId, setSelectedId, busy, error } = state;
  const running = isLayoutRunning(job);
  const locked = running || busy;
  const optionsLocked = locked || state.viewingHistory;
  const currentConfig = state.viewingHistory && job?.locked_config ? job.locked_config : config;
  const selectedSatellites = currentConfig?.satellites.filter((item) => item.count > 0) ?? [];

  /** 只更改获准的任务选项，不写前置配置或固化记录。 */
  function change(key, value) { changeForm({ [key]: value }); }

  /** 立即读取勾选状态，避免 React 批量更新时从 DOM 再读取到复原值。 */
  function changeTop(event) {
    const enabled = event.target.checked;
    changeForm({ top_enabled: enabled, top_record_id: enabled ? form.top_record_id : null });
  }

  return <aside className="model-sidebar layout-optimization-sidebar" aria-label="布局参数设置"><div className="layout-optimization-sidebar-body">
    <section className="layout-optimization-section">
      <div className="section-heading"><div><p>分层 · 配平 · 降高</p><h2>参数设置</h2></div></div>
      <div className="layout-parameter-grid">{GEOMETRY_FIELDS.map(([key, label]) => <LockedValue key={key} label={label} value={currentConfig?.geometry[key]} />)}</div>
      <button className="layout-action-button" type="button" disabled={locked} onClick={state.refreshConfig}>
        <RefreshCw aria-hidden="true" /><span>刷新锁定配置</span>
      </button>
    </section>
    <section className="layout-optimization-section">
      <details className="layout-satellite-list" open>
        <summary>卫星装载清单 · 已锁定</summary>
        <div className="layout-satellite-list-items">
          {selectedSatellites.map((item) => <details className="layout-satellite" key={item.record_id}>
            <summary>{item.name} <span>× {item.count}</span></summary>
            <p className="layout-optimization-hint">质量：{item.mass_kg ?? '未设置'} kg<br />指定安装面：{item.installation_face_id ?? '未设置'}<br />向上轴向：{item.up_orientation === 'free' ? '自由' : item.up_orientation ?? '历史未记录'}<br />模型自身质心：{item.center_of_mass ? ['x', 'y', 'z'].map((axis) => item.center_of_mass[axis]).join(', ') : '未设置'} {item.model_unit}</p>
          </details>)}
          {!selectedSatellites.length && <p className="layout-optimization-hint">请先在前置配置中设置卫星装载数量。</p>}
        </div>
      </details>
    </section>
    {form && <section className="layout-optimization-section">
      <h3>安装与顶部装载</h3>
      <div className="layout-parameter-grid">{[['min_suspension_mm', '悬高最小值 / mm'], ['max_suspension_mm', '悬高最大值 / mm'], ['radius_step_mm', '安装筒半径扫描步长 / mm']].map(([key, label]) => <label className="layout-input" key={key}><span>{label}</span><input type="number" min="0" step="any" value={form[key]} disabled={optionsLocked} onChange={(event) => change(key, event.target.value)} /></label>)}</div>
      <label className="layout-checkbox"><input type="checkbox" checked={form.top_enabled} disabled={optionsLocked} onChange={changeTop} />在顶部装载</label>
      {form.top_enabled && <div className="layout-input"><span>指定顶部卫星</span><SettingsSelect
        id="layout-top-satellite"
        label="指定顶部卫星"
        value={form.top_record_id ?? ''}
        disabled={optionsLocked}
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
    {(error || job?.error) && <p className="layout-optimization-message" role="alert">{error || job.error}</p>}
    {job && <section className="layout-optimization-section"><h3>{JOB_LABELS[job.status]}</h3><p className="layout-optimization-hint" aria-live="polite">{job.progress?.message ?? '正在读取锁定模型'} · 尝试 {job.progress?.attempts ?? 0} 次</p><details><summary>运行记录</summary><ol className="layout-progress-log">{job.events.map((event, index) => <li key={`${event.time}-${index}`}>{new Date(event.time).toLocaleTimeString()} {event.message}</li>)}</ol></details></section>}
    {job?.candidates?.length > 0 && <section className="layout-optimization-section">
      <h3>选择布局方案</h3><p className="layout-optimization-hint">结果对应本次任务保存的锁定参数快照。</p>
      <div className="layout-candidates">{job.candidates.map((item, index) => <button type="button" key={item.candidate_id} className={selectedId === item.candidate_id ? 'active' : ''} aria-pressed={selectedId === item.candidate_id} onClick={() => setSelectedId(item.candidate_id)}><strong>方案 {index + 1}</strong><span>H {item.height_mm.toFixed(1)} · R {item.radius_mm.toFixed(1)} mm</span><span>{item.validation.loaded_count} 颗 · {item.side_layer_count} 个侧挂层 · 全部约束通过</span></button>)}</div>
      {candidate && <>
        <p className="layout-optimization-hint">整体质心：[{candidate.validation.center_of_mass_mm.map((v) => v.toFixed(3)).join(', ')}] mm<br />侧挂层质量（下→上）：{candidate.validation.layer_masses_kg.map((v) => v.toFixed(3)).join(' ＞ ')} kg</p>
        <details><summary>当前方案装载明细</summary><ol className="layout-placement-list">{candidate.placements.map((item) => <li key={item.instance_id}>{item.name} · {item.mount === 'top' ? '圆柱正顶部' : `侧挂第 ${item.layer + 1} 层`} · {item.installation_face_id}<br />悬高 {item.suspension_mm?.toFixed(3)} mm · 模型原点全局位置 [{item.model_origin_global_mm.map((v) => v.toFixed(2)).join(', ')}] mm</li>)}</ol></details>
      </>}
    </section>}
    <LayoutHistory state={state} />
  </div></aside>;
}
