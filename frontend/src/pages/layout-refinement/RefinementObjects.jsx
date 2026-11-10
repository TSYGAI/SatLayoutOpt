/** 文件说明：布局对象树、组合层级及独立显示按钮；质量采用微调页统一数值格式，编辑按最外层联动，可见性可单独控制任一成员或子组。 */
import { useState } from 'react';
import { ArrowLeftRight, Boxes, ChevronDown, ChevronLeft, ChevronRight, Layers3, Satellite } from '../../components/icons.js';
import { describeObject, formatRefinementNumber, satelliteName } from './refinement-presentation.js';
import { RefinementVisibilityButton } from './RefinementVisibility.jsx';

/** 对象树只负责选择，组合确认和交换预览统一在右侧工作流中展示。 */
export function RefinementObjects({ snapshot, selection, flow, pending, onSelect, onFlow, onNavigate, disabled, job, candidateId, onLoad, hiddenIds, onToggleVisibility }) {
  const [version, setVersion] = useState('');
  const groups = snapshot.groups, placements = snapshot.candidate.placements;
  const grouped = new Set(groups.flatMap((group) => group.members));
  /** 名称来自锁定配置，内部标识仅用于事件定位，不输出到用户界面。 */
  function name(item) { return satelliteName(item, job?.locked_config?.satellites); }
  const activeIds = flow ? pending.flatMap((id) => describeObject(snapshot, id).ids) : selection;
  /** 固定、锁定或顶部成员会阻止整个对象交换，创建组合不改变其位姿。 */
  function unavailable(id) { return flow === 'swap' && describeObject(snapshot, id).items.some((item) => item.edit_locked || item.mount === 'top'); }
  /** 组合与交换均通过对象卡片切换选择，成员点击交给宿主解析为完整外层。 */
  function row(item, nested = false) {
    const active = activeIds.includes(item.instance_id), blocked = disabled || unavailable(item.instance_id), hidden = hiddenIds.includes(item.instance_id);
    return <div key={item.instance_id} className={`refinement-object${active ? ' selected' : ''}${nested ? ' nested' : ''}${hidden ? ' is-hidden' : ''}`}>
      <button type="button" data-instance={item.instance_id} disabled={blocked} onClick={() => onSelect(item.instance_id)} aria-pressed={active}>
        <span className="refinement-object-mark" aria-hidden="true"><Satellite /></span><span><strong>{name(item)}</strong>
          <small>质量 {formatRefinementNumber(item.mass_kg)} kg{item.fixed ? ' · 固定' : item.edit_locked ? ' · 锁定' : nested ? ' · 随组合联动' : item.mount === 'top' ? ' · 顶部' : ''}{hidden ? ' · 已隐藏' : ''}</small>
          {item.constraint_violations?.length > 0 && <small className="refinement-danger">{item.constraint_violations.length} 项约束问题</small>}</span>
      </button><RefinementVisibilityButton name={name(item)} ids={[item.instance_id]} hiddenIds={hiddenIds} onToggle={onToggleVisibility} /></div>;
  }
  /** 递归展示被保存的子组合；操作绑定最外层，拆解外层后子组合恢复独立身份。 */
  function groupTree(group, outer = group) {
    const children = group.children ?? [], childMembers = new Set(children.flatMap((child) => child.members));
    const active = activeIds.includes(outer.members[0]), nested = group !== outer, blocked = disabled || unavailable(outer.members[0]);
    return <section className={`refinement-group${nested ? ' refinement-child-group' : ''}`} key={group.id}>
      <div className="refinement-group-heading">
        <button type="button" className={`refinement-group-name${active ? ' selected' : ''}`} disabled={blocked} onClick={() => onSelect(outer.members[0])} aria-pressed={active}>
          <span className="refinement-object-mark" aria-hidden="true"><Boxes /></span><span>{group.name}<small>{group.members.length} 颗卫星{nested ? ' · 随外层联动' : group.system ? ' · 来源对称组' : ''}</small></span></button>
        <RefinementVisibilityButton name={group.name} ids={group.members} hiddenIds={hiddenIds} onToggle={onToggleVisibility} />
      </div>
      {children.map((child) => groupTree(child, outer))}
      {group.members.filter((id) => !childMembers.has(id)).map((id) => placements.find((item) => item.instance_id === id)).filter(Boolean).map((item) => row(item, true))}
    </section>;
  }
  return <aside className="refinement-objects" aria-label="卫星与组合"><h2><Satellite aria-hidden="true" />布局对象<span>{placements.length}</span></h2>
    <div className="refinement-workflow-actions"><button type="button" disabled={disabled || Boolean(flow)} onClick={() => onFlow('combine')}><Boxes aria-hidden="true" />组合</button>
      <button type="button" disabled={disabled || Boolean(flow)} onClick={() => onFlow('swap')}><ArrowLeftRight aria-hidden="true" />交换</button></div>
    <div className="refinement-object-list">{groups.map((group) => groupTree(group))}
      {placements.filter((item) => !grouped.has(item.instance_id)).map((item) => row(item))}</div>
    <nav className="refinement-object-navigation" aria-label="对象切换"><button type="button" aria-label="‹ 上一个" disabled={disabled || Boolean(flow)} onClick={() => onNavigate(-1)}><ChevronLeft aria-hidden="true" />上一个</button>
      <button type="button" aria-label="下一个 ›" disabled={disabled || Boolean(flow)} onClick={() => onNavigate(1)}>下一个<ChevronRight aria-hidden="true" /></button></nav>
    <details className="refinement-saved-versions"><summary><Layers3 aria-hidden="true" />已保存方案<ChevronDown className="refinement-disclosure" aria-hidden="true" /></summary><select aria-label="已保存方案" value={version} disabled={disabled} onChange={(event) => setVersion(event.target.value)}>
      <option value="">选择要载入的方案</option>{[...(job?.candidates ?? []), ...(job?.refinements ?? [])].map((item, index) => <option key={item.candidate_id} value={item.candidate_id} disabled={item.candidate_id === candidateId}>
        {item.refinement?.name || `优化方案 ${index + 1}`}{item.candidate_id === candidateId ? '（当前）' : ''}</option>)}</select>
      <button type="button" disabled={disabled || !version || version === candidateId} onClick={() => onLoad(version)}>载入方案</button></details>
  </aside>;
}
