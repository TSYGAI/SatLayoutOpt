/** 文件说明：固定组软硬约束选择、包络底高、位置微调和组内保存/删除；约束错误统一展示中文，正式验收和持久化由后端负责。 */
import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { ChevronDown, Plus } from '../../components/icons.js';
import { SettingsSelect } from '../../components/SettingsSelect.jsx';
import { useFixedConstraints } from './use-fixed-constraints.js';
import { FixedSatellitePoseDialog } from './FixedSatellitePoseDialog.jsx';
import { FixedLeaveDialog } from './FixedLeaveDialog.jsx';
import { PreConfigNumberInput } from './PreConfigNumberInput.jsx';
import { formatPreConfigError } from './pre-config-errors.js';
import { formatParameterNumber } from '../../utils/number-format.js';

/** 渲染固化类型、安装参数、真实卫星质心和明确冲突信息；active 决定画布所有权。 */
export function FixedConstraintsPanel(props) {
  const state = useFixedConstraints(props);
  const [adding, setAdding] = useState(false);
  const addButtonRef = useRef(null);
  const addPickerRef = useRef(null);
  /** 模型选择器出现后接收焦点，便于键盘继续选择或取消。 */
  useEffect(() => { if (adding) addPickerRef.current?.querySelector('button')?.focus(); }, [adding]);
  const group = state.groups.find((item) => item.group_id === state.selected);
  const placement = state.snapshot?.placements.find((item) => item.instance_id === state.selectedInstance && item.fixed_group_id === state.selected)
    || state.snapshot?.placements.find((item) => item.fixed_group_id === state.selected);
  const validation = state.snapshot?.validation;
  const locked = ['saving', 'loading'].includes(state.status) || !props.geometry || Boolean(state.snapshot?.initial_display);
  const current = state.status === 'ready';
  const visibleGroupIds = new Set(state.snapshot?.placements.map((item) => item.fixed_group_id));
  const pendingGroupLoading = state.groups.some((item) => !visibleGroupIds.has(item.group_id));
  const loadingPreview = props.active && props.geometry && (state.entryLoading || pendingGroupLoading)
    && state.status !== 'error';
  const visiblePose = current || (state.snapshot?.validation_pending && ['dragging', 'calculating', 'error'].includes(state.status));
  /** 单一菜单同时更新对称规则和数量；环向读取所选副本数，两种镜像都占用两颗。 */
  function changeSymmetry(value) {
    state.patch(value === 'mirror_xoz' || value === 'mirror_yoz'
      ? { symmetry_mode: value, copies: 2 } : { symmetry_mode: 'ring', copies: Number(value) });
  }
  /** 选择模型后直接添加并展开新组，收起选择框并恢复添加按钮焦点。 */
  function addGroup(value) {
    if (!value) return;
    state.add(value);
    setAdding(false);
    addButtonRef.current?.focus();
  }
  /** Escape 取消本次模型选择，不修改固定组草稿。 */
  function handleAddKeyDown(event) {
    if (event.key !== 'Escape') return;
    event.preventDefault();
    setAdding(false);
    addButtonRef.current?.focus();
  }
  return <><div className="model-settings-form fixed-constraints-form" aria-label="固定位置约束">
    <section className="model-settings-form-section" aria-labelledby="fixed-constraint-title">
    <div className="model-settings-section-heading fixed-constraint-heading">
      <h2 id="fixed-constraint-title">固定位置约束</h2>
      <button ref={addButtonRef} type="button" className="pre-config-action-button" disabled={locked || !props.satellites.length || !state.snapshot}
        aria-expanded={adding} aria-controls="fixed-group-picker" onClick={() => setAdding(!adding)}>
        <Plus aria-hidden="true" />添加固定组
      </button>
    </div>
    {adding && <div id="fixed-group-picker" ref={addPickerRef} className="model-settings-field" onKeyDown={handleAddKeyDown}><span>固化卫星类型</span>
      <SettingsSelect id="fixed-model-select" label="固化卫星类型" value="" disabled={locked} onChange={addGroup}
        options={[{ value: '', label: '请选择要添加的模型' }, ...props.satellites.map((item) => ({ value: item.recordId, label: `${item.deviceName} · ${item.count} 颗` }))]} />
    </div>}
    {!state.groups.length && <p className="pre-config-hint">{!props.satellites.length
      ? '请先在模型设定中设置卫星数量' : '暂无固定组，点击“添加固定组”开始'}</p>}
    <ul className="fixed-group-list" aria-label="固定组列表">
    {state.groups.map((item, index) => {
      const expanded = item.group_id === state.selected && state.detailsOpen;
      const name = props.satellites.find((entry) => entry.recordId === item.record_id)?.deviceName || item.record_id;
      return <li key={item.group_id} className={`fixed-group-item${expanded ? ' is-selected' : ''}`} data-group-id={item.group_id}>
      <div className="pre-config-satellite-row fixed-group-heading">
      <button type="button" className="fixed-group-trigger" disabled={locked}
        id={`fixed-group-trigger-${item.group_id}`} aria-expanded={expanded} aria-controls={`fixed-group-details-${item.group_id}`}
        onClick={() => state.toggleGroup(item.group_id)}>
        <span className="pre-config-satellite-meta"><strong title={name}>{index + 1}. {name}</strong>
          <small>{item.mount === 'top' ? '顶部单颗居中' : `${item.copies} 颗侧挂`} · {item.hard_constraint === false ? '优先满足固定设置' : '严格固定'}</small></span>
        <ChevronDown aria-hidden="true" />
      </button>
      <select className="fixed-constraint-mode" aria-label={`${index + 1}. ${name} 固定约束类型`}
        title="硬约束严格固定；软约束先尝试固定设置，未找到可行布局后再放开。"
        value={item.hard_constraint === false ? 'soft' : 'hard'} disabled={locked}
        onChange={(event) => state.patch({ hard_constraint: event.target.value === 'hard' }, item.group_id)}>
        <option value="hard">硬约束</option>
        <option value="soft">软约束</option>
      </select>
      </div>
    {expanded && group && <fieldset className="fixed-group-details" id={`fixed-group-details-${item.group_id}`}
      aria-labelledby={`fixed-group-trigger-${item.group_id}`} disabled={locked}>
      <div className="model-settings-field"><span>安装位置</span><SettingsSelect id="fixed-mount-select" label="安装位置" value={group.mount} disabled={locked}
        onChange={(mount) => state.patch({ mount })} options={[{ value: 'side', label: '筒体外侧' }, { value: 'top', label: '顶部单颗居中' }]} /></div>
      {group.mount === 'side' && <>
        <div className="model-settings-field"><span>放置方式</span><SettingsSelect id="fixed-mode-select" label="放置方式" value={state.mode} disabled={locked} onChange={state.setMode}
          options={[{ value: 'numeric', label: '输入具体数值' }, { value: 'pick', label: '鼠标点选筒面' }, { value: 'drag', label: '鼠标拖动包络' }]} /></div>
        <div className="model-settings-field"><span>对称方式</span><SettingsSelect id="fixed-symmetry-select" label="对称方式" disabled={locked}
          value={(group.symmetry_mode || 'ring') === 'ring' ? String(group.copies) : group.symmetry_mode}
          onChange={changeSymmetry} options={[...[1, 2, 3, 4, 6, 8].map((copies) => ({ value: String(copies), label: copies === 1 ? '不对称单颗' : `${copies}x 环向对称` })),
            { value: 'mirror_xoz', label: '关于 xOz 平面镜像' }, { value: 'mirror_yoz', label: '关于 yOz 平面镜像' }]} /></div>
        <label className="model-settings-field"><span>环向位置角度 (°)</span><PreConfigNumberInput label="环向位置角度 (°)" min="0" max="359.999999" value={group.angle_deg}
          onValueChange={(value) => state.patch({ angle_deg: Number(value) })} /></label>
        <label className="model-settings-field"><span>安装高度 (mm)</span><PreConfigNumberInput label="安装高度 (mm)" min="0"
          value={Number.isFinite(placement?.installation_region_bottom_mm) ? placement.installation_region_bottom_mm - state.snapshot.installation_base.height_mm : ''}
          disabled={!state.poseEditable || !Number.isFinite(placement?.installation_region_bottom_mm)}
          onValueChange={(value) => state.editInstallationHeight(Number(value))} />
          <small>{Number.isFinite(placement?.installation_region_bottom_mm) ? '共面安装区域最低点相对直筒下沿的高度'
            : state.snapshot?.validation_pending ? '正在计算安装区域高度' : '安装区域基准暂不可用，请检查安装面设置'}</small></label>
      </>}
      <label className="model-settings-field"><span>安装悬高下限 (mm)</span><PreConfigNumberInput label="安装悬高下限 (mm)" min="0" value={group.suspension_mm}
        onValueChange={(value) => state.patch({ suspension_mm: Number(value) })} />
        {group.mount === 'side' && <small>沿安装面法向，从安全包络刚好不穿筒的位置向外退让。</small>}</label>
      <label className="model-settings-field"><span>箭头微调步长 (mm)</span><PreConfigNumberInput label="箭头微调步长 (mm)" min="0" value={state.nudgeStep}
        onValueChange={state.setNudgeStep} /></label>
      <div className="fixed-group-clearance" aria-live="polite">
        {placement?.suspension_reference !== 'envelope_contact_normal' && <div><span>包络所需悬高</span><strong>{visiblePose && placement && !placement.pose_reference_pending ? `${formatParameterNumber(placement.required_suspension_mm)} mm` : '计算中'}</strong></div>}
        <div><span>实际悬高</span><strong>{visiblePose && placement && !placement.pose_reference_pending ? `${formatParameterNumber(placement.suspension_mm)} mm` : '计算中'}</strong></div>
      </div>
      <div className="fixed-group-actions">
        <button type="button" className="pre-config-action-button" onClick={state.remove}>删除</button>
        <button type="button" className="pre-config-action-button primary" disabled={!current || !validation?.valid} onClick={state.save}>保存</button>
      </div>
    </fieldset>}
      </li>;
    })}
    </ul>
    </section>
    <div className="fixed-info-card" aria-live="polite">
    <p className="fixed-draft-status">{state.storageError || (state.dirty ? '更改已临时保存 · 尚未应用到其它流程' : '固定约束已保存')}</p>
    <p className="fixed-info-status" role="status">{!props.geometry ? '请先在模型设定中保存安装筒尺寸' : state.status === 'saving' ? '正在更新固定约束' : state.status === 'error' ? '固定放置计算失败，请调整参数后重试'
      : state.status === 'loading' && state.snapshot ? '已显示上次预览 · 正在核对配置'
      : state.status === 'dragging' ? '实时拖动预览 · 松开后检查碰撞'
        : state.snapshot?.initial_display ? '模型已显示 · 正在校验位置与约束'
        : state.snapshot?.validation_pending && !current ? '位置与质心已实时更新 · 正式校验中'
          : !current ? '正在计算放置与质心' : '当前放置预览已更新'}</p>
    {validation && visiblePose && <div className="fixed-validation-summary">
      <div className="fixed-summary-heading"><strong>{validation.center_label}</strong><span>mm</span></div>
      {validation.total_mass_kg > 0 ? <dl className="fixed-center-values">{validation.center_of_mass_mm.map((value, axis) =>
        <div key={axis}><dt>{'XYZ'[axis]}</dt><dd>{formatParameterNumber(value)}</dd></div>)}</dl> : <p className="pre-config-hint">尚无已放置卫星</p>}
      <div className="fixed-validation-metrics"><span>仅卫星质量 <b>{formatParameterNumber(validation.total_mass_kg)} kg</b></span><span>已放置 <b>{validation.loaded_count} 颗</b></span></div>
      {current && validation.violations.length > 0 && <ul>{validation.violations.map((message) => <li key={message}>{formatPreConfigError(message, '当前放置未通过约束校验，请调整后重试。')}</li>)}</ul>}
    </div>}
    {state.error && <p role="alert">{state.error}</p>}
    {state.notice && <p className="pre-config-hint" aria-live="polite">{state.notice}</p>}
    </div></div>
    <FixedLeaveDialog state={state} active={props.active} navigationRef={props.navigationRef} />
    {loadingPreview && props.poseContainer && createPortal(
      <div className="model-loading fixed-preview-loading" role="status" aria-live="polite" aria-label="固定约束正在加载">
        <span className="loading-spinner" aria-hidden="true" />
        <strong>正在加载</strong>
      </div>, props.poseContainer)}
    {props.active && props.poseContainer && state.poseOpen && placement && state.selected && createPortal(
      <FixedSatellitePoseDialog state={state} placement={placement} key={`${placement.fixed_group_id}-${placement.instance_id}`} />, props.poseContainer)}
  </>;
}
