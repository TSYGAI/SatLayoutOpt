/** 文件说明：坐标系独立草稿编辑器；确认后请求保存，失败保留草稿并明确提示，定义始终参考最初 STEP。 */
import { useEffect, useRef, useState } from 'react';
import { SettingsSelect } from '../../components/SettingsSelect.jsx';
import { defaultCoordinateFrame, normalizeCoordinateFrame } from './coordinate-frame.js';
import { setCoordinateFrameDraft } from '../model-upload/model-preview-loader.js';
import { coordinateScale, scaledCoordinateFrame } from './scaled-coordinates.js';
import { formatParameterNumber } from '../../utils/number-format.js';
import { ParameterNumberInput } from '../../components/ParameterNumberInput.jsx';

const COORDINATE_MODE_OPTIONS = Object.freeze([
  { value: 'euler_xyz', label: '旋转角度' },
  { value: 'three_points', label: '三点定义' },
]);

/** 渲染三轴数值输入；保留字符串草稿，空值由完整定义校验拒绝。 */
function VectorFields({ title, name, value, onChange, disabled }) {
  return <fieldset className="coordinate-vector" disabled={disabled}><legend>{title}</legend>
    <div className="model-settings-vector-grid">{['x', 'y', 'z'].map((axis) => <label className="model-settings-center-input" key={axis}>
      <span className="model-settings-center-axis">{axis.toUpperCase()}</span><ParameterNumberInput aria-label={`${title} ${axis.toUpperCase()}`} id={`frame-${name}-${axis}`} step="any"
        value={value[axis]} onChange={(event) => onChange({ ...value, [axis]: event.target.value })} />
    </label>)}</div></fieldset>;
}

/** 管理单个模型的坐标草稿；父组件负责保存队列、模型选择和普通设置锁定。 */
export function CoordinateFrameSection({ modelId, frame, unit, scale, disabled, onBegin, onCommit, onEnd }) {
  const [draft, setDraft] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const mounted = useRef(true);
  let valid = null, validationError = '';
  if (draft) {
    try { valid = normalizeCoordinateFrame(scaledCoordinateFrame(draft, 1 / coordinateScale(scale))); } catch (failure) { validationError = failure.message; }
  }
  const serialized = valid ? JSON.stringify(valid) : '';
  useEffect(() => {
    if (draft && serialized) setCoordinateFrameDraft(JSON.parse(serialized));
  }, [serialized, Boolean(draft)]);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; setCoordinateFrameDraft(null); };
  }, []);

  /** 等待其他参数保存完成，再从当前已生效定义复制草稿。 */
  async function begin() {
    setBusy(true); setError('');
    try {
      const saved = await onBegin();
      if (saved && mounted.current) setDraft(scaledCoordinateFrame(saved.coordinate_frame ?? defaultCoordinateFrame(), coordinateScale(saved.model_scale)));
    } catch (failure) { if (mounted.current) setError(failure.message); }
    finally { if (mounted.current) setBusy(false); }
  }
  /** 退出草稿，恢复正式预览；只有父组件保存成功才采用新的定义。 */
  function finish() { setCoordinateFrameDraft(null); setDraft(null); setError(''); onEnd(); }
  /** 原子提交有效定义，失败时保留输入供修正或重试。 */
  async function confirm() {
    if (!valid) return;
    setBusy(true); setError('');
    try {
      const success = await onCommit(valid);
      if (!mounted.current) return;
      if (success) finish();
      else setError('坐标系保存失败，当前坐标系未替换；可以重试或取消。');
    } catch (failure) { if (mounted.current) setError(failure.message); }
    finally { if (mounted.current) setBusy(false); }
  }
  /** 切换输入方式时以初始轴生成合法草稿，不累加上次旋转。 */
  function changeMode(mode) {
    const origin = draft.origin;
    const orientation = mode === 'euler_xyz' ? defaultCoordinateFrame().orientation : {
      mode, x_point: { x: Number(origin.x) + 1, y: Number(origin.y), z: Number(origin.z) },
      xy_point: { x: Number(origin.x), y: Number(origin.y) + 1, z: Number(origin.z) },
    };
    setDraft({ ...draft, orientation });
  }
  const active = scaledCoordinateFrame(frame ?? defaultCoordinateFrame(), coordinateScale(scale));
  return <section className="model-settings-form-section coordinate-frame-section" aria-labelledby="coordinate-frame-title">
    <div className="model-settings-section-heading"><h2 id="coordinate-frame-title">坐标系设置</h2></div>
    {!draft ? <>
      <div className="coordinate-summary" aria-label="当前坐标系摘要">
        <span>原点：{['x', 'y', 'z'].map((axis) => formatParameterNumber(active.origin[axis])).join(' / ')} {unit}</span>
        <span>{active.orientation.mode === 'three_points' ? '三点定义' : `轴向角：${['x', 'y', 'z'].map((axis) => formatParameterNumber(active.orientation.angles_deg[axis])).join(' / ')}°`}</span>
      </div>
      <button id="edit-coordinate-frame" type="button" disabled={!modelId || disabled || busy} onClick={begin}>{busy ? '正在准备' : '修改坐标系'}</button>
    </> : <>
      <VectorFields title="新原点" name="origin" value={draft.origin} disabled={busy} onChange={(origin) => setDraft({ ...draft, origin })} />
      <div className="coordinate-mode">
        <span id="frame-mode-label">轴向定义</span>
        <SettingsSelect id="frame-mode" label="轴向定义" value={draft.orientation.mode} options={COORDINATE_MODE_OPTIONS}
          disabled={busy} onChange={changeMode} />
      </div>
      {draft.orientation.mode === 'euler_xyz' ? <>
        <VectorFields title="轴向角" name="angle" value={draft.orientation.angles_deg} disabled={busy}
          onChange={(angles_deg) => setDraft({ ...draft, orientation: { mode: 'euler_xyz', angles_deg } })} />
      </> : <>
        <VectorFields title="X 正向参考点" name="x-point" value={draft.orientation.x_point} disabled={busy}
          onChange={(x_point) => setDraft({ ...draft, orientation: { ...draft.orientation, x_point } })} />
        <VectorFields title="XY 平面参考点" name="xy-point" value={draft.orientation.xy_point} disabled={busy}
          onChange={(xy_point) => setDraft({ ...draft, orientation: { ...draft.orientation, xy_point } })} />
      </>}
      <p className="coordinate-hint">确认后质心填写值保留，实际位置按新坐标系计算；包络需要重新生成。</p>
      <div className="coordinate-actions">
        <button id="confirm-coordinate-frame" type="button" disabled={busy || !valid} onClick={confirm}>{busy ? '正在保存' : '确认应用'}</button>
        <button id="cancel-coordinate-frame" type="button" disabled={busy} onClick={finish}>取消</button>
        <button id="reset-coordinate-frame" type="button" disabled={busy} onClick={() => setDraft(defaultCoordinateFrame())}>恢复初始</button>
      </div>
    </>}
    {(error || validationError) && <p className="coordinate-error" role="alert">{error || `${validationError}；预览保留上一次有效输入。`}</p>}
  </section>;
}
