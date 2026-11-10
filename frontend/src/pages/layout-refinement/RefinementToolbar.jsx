/** 文件说明：组织视图、实体与名称显示及按安装类型开放的拖动工具；顶部支持水平平移与绕筒旋转，显示开关不改变布局。 */
import { createRefinementDisplay, setObjectVisibility } from './refinement-display.js';
import { RefinementVisibilityCheckbox } from './RefinementVisibility.jsx';
import { ArrowUpDown, Box, ChevronDown, Crosshair, Eye, Grid2X2, Maximize2, MousePointer2, Move, PanelBottom, PanelLeft, PanelTop, RotateCw, Scan, X } from '../../components/icons.js';

/** 保持显示、观察和编辑工具分区；定位针对完整对象，相机复位不更改布局。 */
export function RefinementToolbar({ mode, setMode, tool, setTool, flow, disabled, title, description, display, setDisplay, instanceIds, expanded, onExpand, onFit, onLocate, topOnly, hasTop }) {
  return <><div className="refinement-view-toolbar"><div className="refinement-segmented" role="group" aria-label="视图方向">{[['3d', '三维', Box], ['xy', '俯视', PanelTop], ['xz', '正视', PanelBottom], ['yz', '侧视', PanelLeft], ['quad', '四视图', Grid2X2]].map(([value, label, Icon]) =>
    <button type="button" key={value} aria-pressed={mode === value} onClick={() => setMode(value)}><Icon aria-hidden="true" />{label}</button>)}</div>
    <div className="refinement-view-actions"><details className="refinement-display-settings"><summary><Eye aria-hidden="true" />显示<ChevronDown className="refinement-disclosure" aria-hidden="true" /></summary><div>
      <RefinementVisibilityCheckbox ids={instanceIds} hiddenIds={display.hiddenIds} onChange={(visible) => setDisplay((current) => setObjectVisibility(current, instanceIds, visible))} />
      {[['satelliteNames', '卫星名称'], ['tube', '安装筒'], ['base', '基座'], ['fairing', '整流罩'], ['centerOfMass', '整体卫星质心'], ['axes', '坐标轴'], ['original', '原位置轮廓']].map(([key, label]) =>
        <label key={key}><input type="checkbox" checked={display[key]} onChange={(event) => setDisplay((current) => ({ ...current, [key]: event.target.checked }))} />{label}</label>)}
      <button type="button" onClick={() => setDisplay((current) => ({ ...createRefinementDisplay(), original: current.original }))}><Eye aria-hidden="true" />显示全部对象</button>
    </div></details><button type="button" onClick={onFit} title="完整显示卫星布局和安装筒，不改变布局"><Scan aria-hidden="true" />复位视图</button>
      <button type="button" data-preview-expand onClick={onExpand} aria-pressed={expanded}>{expanded ? <X aria-hidden="true" /> : <Maximize2 aria-hidden="true" />}{expanded ? '退出放大' : '放大预览'}</button></div></div>
    <div className="refinement-operation-bar"><div className="refinement-operation-context"><strong>{flow ? flow === 'combine' ? '正在选择组合成员' : '正在选择交换对象' : `正在调整 ${title}`}</strong><span>{description}</span></div>
      <div className="refinement-segmented" role="group" aria-label="调整工具">{[['browse', '观察', MousePointer2], ['angle', topOnly ? '水平旋转' : '绕筒旋转', RotateCw], ['translate', '水平平移', Move], ['height', '升降', ArrowUpDown]].map(([value, label, Icon]) =>
        <button type="button" key={value} disabled={Boolean(flow) || disabled || (value === 'translate' && !topOnly) || (value === 'height' && hasTop)} aria-pressed={tool === value} onClick={() => setTool(value)}><Icon aria-hidden="true" />{label}</button>)}</div>
      <button type="button" disabled={Boolean(flow)} onClick={onLocate}><Crosshair aria-hidden="true" />定位</button></div></>;
}
