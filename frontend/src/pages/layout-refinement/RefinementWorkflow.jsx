/** 文件说明：组合嵌套和完整对象交换的互斥确认流程；以最多三位小数展示双方基准及质量，确认前不改变位姿。 */
import { describeObject, formatRefinementNumber, satelliteName } from './refinement-presentation.js';
import { ArrowLeftRight, Boxes, X } from '../../components/icons.js';

/** 接收临时选择，仅确认时产生组合身份或交换命令。 */
export function RefinementWorkflow({ flow, pending, snapshot, satellites, groupName, setGroupName, onConfirm, onCancel, disabled }) {
  const combine = flow === 'combine', objects = pending.map((id) => describeObject(snapshot, id, satellites));
  const total = objects.reduce((sum, object) => sum + object.items.length, 0);
  return <aside className="refinement-parameters refinement-workflow" aria-label="当前操作"><span className="refinement-workflow-eyebrow">当前操作</span>
    <h2>{combine ? <Boxes aria-hidden="true" /> : <ArrowLeftRight aria-hidden="true" />}{combine ? '创建组合' : '交换位置'}</h2>
    {combine && <label className="refinement-field refinement-group-name-field"><span>组合名称</span><input aria-label="组合名称" maxLength={32} value={groupName} disabled={disabled} onChange={(event) => setGroupName(event.target.value)} /></label>}
    <h3>已选择 {pending.length} 个对象{combine ? '' : ' / 2'} · 共 {total} 颗卫星</h3>
    <ul className="refinement-workflow-members">{objects.map((object, index) => <li key={object.id}><span>{index + 1}. {object.name}</span>
      <small>{object.items.length} 颗 · 质量（kg）{formatRefinementNumber(object.items.reduce((sum, item) => sum + item.mass_kg, 0))}{object.group ? ` · 基准：${satelliteName(object.anchor, satellites)}` : ''}</small></li>)}</ul>
    {!combine && objects.length === 2 && <div className="refinement-swap-preview" aria-label="交换预览"><strong>{objects[0].name} ↔ {objects[1].name}</strong>
      <p>基准环向（°）{formatRefinementNumber(objects[0].anchor.rotation_z_deg)} ↔ {formatRefinementNumber(objects[1].anchor.rotation_z_deg)}</p><p>基准高度（mm）{formatRefinementNumber(objects[0].anchor.edit_height_mm)} ↔ {formatRefinementNumber(objects[1].anchor.edit_height_mm)}</p>
      <p>基准悬高（mm）{formatRefinementNumber(objects[0].anchor.suspension_mm)} ↔ {formatRefinementNumber(objects[1].anchor.suspension_mm)}</p></div>}
    <div className="refinement-workflow-confirm"><button type="button" className="primary" disabled={disabled || (combine ? pending.length < 2 || !groupName.trim() : pending.length !== 2)} onClick={onConfirm}>
      {combine ? <Boxes aria-hidden="true" /> : <ArrowLeftRight aria-hidden="true" />}{combine ? `组合 ${total} 颗` : '确认交换'}</button><button type="button" disabled={disabled} onClick={onCancel}><X aria-hidden="true" />取消</button></div></aside>;
}
