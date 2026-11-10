/** 文件说明：编排侧挂与顶部微调、拖动工具及多视图显示；安装类型决定操作入口，正式校核和历史由专门模块管理。 */
import { useEffect, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { AppShell } from '../app/AppShell.jsx';
import { ArrowLeft, LoaderCircle, Redo2, RotateCcw, Save, Undo2 } from '../components/icons.js';
import { useLayoutRefinement } from './layout-refinement/use-layout-refinement.js';
import { groupFor, selectionFor } from './layout-refinement/refinement-state.js';
import { RefinementObjects } from './layout-refinement/RefinementObjects.jsx';
import { RefinementParameters } from './layout-refinement/RefinementParameters.jsx';
import { RefinementViewport } from './layout-refinement/RefinementViewport.jsx';
import { RefinementLeaveDialog } from './layout-refinement/RefinementLeaveDialog.jsx';
import { RefinementResetDialog } from './layout-refinement/RefinementResetDialog.jsx';
import { RefinementWorkflow } from './layout-refinement/RefinementWorkflow.jsx';
import { RefinementToolbar } from './layout-refinement/RefinementToolbar.jsx';
import { RefinementMetrics } from './layout-refinement/RefinementMetrics.jsx';
import { describeObject, navigationObjects, refinementSourceName, satelliteName } from './layout-refinement/refinement-presentation.js';
import { RefinementPreview } from './layout-refinement/RefinementPreview.jsx';
import { createRefinementDisplay, setObjectVisibility } from './layout-refinement/refinement-display.js';
import '../../styles/layout-refinement.css';

/** 以整组选择和互斥工作流编辑真实来源方案，保存成功后返回新版本预览。 */
export function LayoutRefinementPage() {
  const { jobId, candidateId } = useParams(), navigate = useNavigate();
  const state = useLayoutRefinement(jobId, candidateId);
  const [selection, setSelection] = useState([]), [flow, setFlow] = useState(null), [pending, setPending] = useState([]);
  const [mode, setMode] = useState('3d'), [tool, setTool] = useState('browse'), [fitToken, setFitToken] = useState(0);
  const [name, setName] = useState(''), [saved, setSaved] = useState(null);
  const [resetOpen, setResetOpen] = useState(false);
  const [groupName, setGroupName] = useState(''), [focusToken, setFocusToken] = useState(0);
  const [display, setDisplay] = useState(createRefinementDisplay);
  const latest = useRef(null); latest.current = { state, selection, display };
  const snapshot = state.snapshot, candidate = snapshot?.candidate;
  const returnUrl = `/index?project=${encodeURIComponent(jobId)}&candidate=${encodeURIComponent(saved || candidateId)}`;
  /** 载入其他已保存方案时清空来源专属临时交互，草稿由 Hook 按来源恢复。 */
  useEffect(() => { setSelection([]); setFlow(null); setPending([]); setName(''); setGroupName(''); setSaved(null); setDisplay(createRefinementDisplay()); }, [jobId, candidateId]);
  /** 来源加载或组合拆解后保证选择仍指向完整、现存的操作对象。 */
  useEffect(() => {
    if (!snapshot) return;
    setSelection((current) => selectionFor(snapshot.groups, candidate.placements.some((item) => item.instance_id === current[0]) ? current[0] : candidate.placements[0].instance_id));
  }, [snapshot?.groups, state.context]);
  /** 保存已清除脏状态后再导航，避免保存动作被自身离页保护拦截。 */
  useEffect(() => { if (saved && !state.dirty && !state.saving) navigate(returnUrl); }, [saved, state.dirty, state.saving]);
  /** 按完整对象切换临时选择；已有组合可再次成组或整体交换，成员不能绕过外层。 */
  function select(id) {
    if (!snapshot || state.saving) return;
    if (!flow) { setSelection(selectionFor(snapshot.groups, id)); return; }
    const object = describeObject(snapshot, id);
    if (flow === 'swap' && object.items.some((item) => item.edit_locked || item.mount === 'top')) return;
    setPending((current) => current.includes(object.id) ? current.filter((entry) => entry !== object.id)
      : flow === 'swap' && current.length === 2 ? current : [...current, object.id]);
  }
  /** 互斥切换工作流，清除临时选择与拖动工具，不改变任何卫星位置。 */
  function changeFlow(next) {
    setFlow(next); setPending([]); setTool('browse'); state.setTransient(null);
    if (next === 'combine') setGroupName(`组合 ${snapshot.groups.filter((group) => !group.system).length + 1}`);
  }
  /** 确认组合或交换作为一条操作；组合不是复选状态，保存后有独立组合身份。 */
  async function confirm() {
    const members = pending.flatMap((id) => selectionFor(snapshot.groups, id));
    const accepted = await state.execute(flow === 'combine'
      ? { kind: 'combine', id: `group-${crypto.randomUUID()}`, name: groupName.trim(), ids: members }
      : { kind: 'swap', ids: [...pending] });
    if (!accepted) return;
    setSelection(flow === 'combine' ? members : selectionFor(snapshot.groups, pending[0])); changeFlow(null);
  }
  /** 拖动开始时取得完整对象并检查是否允许当前工具操作，固定成员阻止整组。 */
  function dragStart(id) {
    if (flow || state.saving || state.pending || !state.checked) return null;
    const ids = selectionFor(snapshot.groups, id), items = ids.map((key) => candidate.placements.find((item) => item.instance_id === key));
    setSelection(ids);
    if (items.some((item) => item.edit_locked) || (tool === 'height' && items.some((item) => item.mount === 'top'))
        || (tool === 'translate' && items.some((item) => item.mount !== 'top'))) return null;
    return ids;
  }
  /** 保存前由 Hook 重新完整校核，成功后选择新版本返回来源项目。 */
  async function save() { const result = await state.save(name); if (result) setSaved(result.candidate_id); }
  /** 确认后清空本次编辑和临时工作流；相机与视图保留，恢复对象以来源组合规则重新解析。 */
  function reset() {
    state.reset(); changeFlow(null); setName('');
    setSelection(selectionFor(state.context.groups, state.context.candidate.placements[0].instance_id)); setResetOpen(false);
  }
  /** 按左侧树顺序切换完整对象，不把组合成员作为独立操作目标。 */
  function navigateObject(direction) {
    const objects = navigationObjects(snapshot), index = objects.findIndex((ids) => ids.includes(selection[0]));
    setSelection(objects[(index + direction + objects.length) % objects.length]);
  }
  /** 逐星或整组切换预览可见性，不触发后端命令、选择变更或撤销历史。 */
  function toggleVisibility(ids) { setDisplay((current) => setObjectVisibility(current, ids)); }
  /** 只在开发环境公开只读快照，供浏览器回归核对草稿、选择、质心及视口投影。 */
  useEffect(() => {
    if (!import.meta.env.DEV) return undefined;
    window.__layoutRefinementTestApi = { snapshot: () => ({ candidate: latest.current.state.snapshot?.candidate,
      groups: latest.current.state.snapshot?.groups, selected: latest.current.selection, display: latest.current.display, checked: latest.current.state.checked,
      history: latest.current.state.history, pending: latest.current.state.pending, projections: [...document.querySelectorAll('[data-refinement-view]')].map((node) => ({ mode: node.dataset.refinementView, items: node.querySelector('.refinement-canvas').__refinementViewer?.projections() })) }) };
    return () => { delete window.__layoutRefinementTestApi; };
  }, []);
  const callbacks = { select, dragStart,
    /** 拖动帧只显示临时共同位姿，释放后才记入操作历史。 */
    drag: (command) => state.setTransient(command),
    /** 一次拖动只提交一个命令，无位移或取消时恢复原草稿。 */
    dragEnd: (command) => { state.setTransient(null); if (command && Object.entries(command).some(([key, value]) => ['angle', 'height', 'x', 'y'].includes(key) && Math.abs(value) > 1e-8)) state.execute(command); },
  };
  const views = mode === 'quad' ? ['3d', 'xy', 'xz', 'yz'] : [mode];
  const selectedGroup = snapshot && groupFor(snapshot.groups, selection[0]);
  const selectedItems = candidate?.placements.filter((item) => selection.includes(item.instance_id)) ?? [];
  const title = selectedGroup?.name || (selectedItems[0] && satelliteName(selectedItems[0], state.job?.locked_config?.satellites)) || '选择卫星';
  const description = flow ? flow === 'combine' ? '点击选择卫星或组合 · 在右侧创建组合' : '点击选择两个完整对象 · 在右侧预览交换'
    : selectedGroup ? `${selectedItems.map((item) => satelliteName(item, state.job?.locked_config?.satellites)).join(' / ')} · 整体联动` : '单颗调整 · 点击列表或包络切换对象';
  return <AppShell className="refinement-page" pageTitle="人工微调" preservePagePosition={false}>
    <header className="refinement-header"><div><button type="button" className="refinement-back" aria-label="← 返回方案" disabled={state.saving} onClick={() => navigate(returnUrl)}><ArrowLeft aria-hidden="true" />返回方案</button>
      <div><p>布局优化 / 人工微调</p><h1>{state.job?.name || '来源方案'}<small>{refinementSourceName(state.job, candidateId) || (state.loading ? '读取方案…' : '来源方案')}</small></h1></div></div>
      <div className="refinement-header-actions"><span className={`refinement-draft-status${state.dirty ? ' is-dirty' : ''}`}>{state.dirty ? '未另存 · 本地草稿' : '来源快照'}</span>
        <button type="button" disabled={!state.history.cursor || state.saving || state.pending || Boolean(flow)} onClick={() => state.travel(-1)}><Undo2 aria-hidden="true" />撤销</button>
        <button type="button" disabled={state.history.cursor >= state.history.commands.length || state.saving || state.pending || Boolean(flow)} onClick={() => state.travel(1)}><Redo2 aria-hidden="true" />重做</button>
        <button type="button" disabled={!snapshot || state.saving || (!state.history.commands.length && !flow && !state.pending)} onClick={() => setResetOpen(true)}><RotateCcw aria-hidden="true" />重置</button>
        <button type="button" className="primary" disabled={!state.canSave || Boolean(flow)} onClick={save}>{state.saving ? <LoaderCircle className="refinement-spinning" aria-hidden="true" /> : <Save aria-hidden="true" />}{state.saving ? '校核并保存中…' : '另存微调版本'}</button></div></header>
    {state.loading || !snapshot ? <main className="refinement-loading" aria-busy={state.loading}><h2 role={state.loading ? 'status' : undefined}>{state.loading ? '读取方案安装快照…' : '当前方案无法人工微调'}</h2>{state.error && <p role="alert">{state.error}</p>}</main> : <>
      <main className="refinement-workspace"><RefinementObjects snapshot={snapshot} selection={selection} flow={flow} pending={pending} onSelect={select}
        hiddenIds={display.hiddenIds} onToggleVisibility={toggleVisibility}
        onFlow={changeFlow} onNavigate={navigateObject} disabled={state.saving} job={state.job} candidateId={candidateId}
        onLoad={(id) => navigate(`/layout-refinement/${encodeURIComponent(jobId)}/${encodeURIComponent(id)}`)} />
        <RefinementPreview renderToolbar={(expanded, toggleExpanded) => <RefinementToolbar mode={mode} setMode={setMode} tool={tool} setTool={setTool} flow={flow} disabled={state.saving}
          title={title} description={description} display={display} setDisplay={setDisplay} instanceIds={candidate.placements.map((item) => item.instance_id)} expanded={expanded} onExpand={toggleExpanded}
          topOnly={selectedItems.length > 0 && selectedItems.every((item) => item.mount === 'top')} hasTop={selectedItems.some((item) => item.mount === 'top')}
          onFit={() => setFitToken((value) => value + 1)} onLocate={() => setFocusToken((value) => value + 1)} />
          }>
          <div className={`refinement-view-grid${mode === 'quad' ? ' quad' : ''}`} data-tool={tool}>{views.map((view) => <RefinementViewport key={view} mode={view} state={state} selection={flow ? pending.flatMap((id) => selectionFor(snapshot.groups, id)) : selection} tool={tool} callbacks={callbacks}
            radialSegments={state.job?.locked_config?.geometry?.radial_segments || 96} fitToken={fitToken} focusToken={focusToken} display={display} onMaximize={mode === 'quad' ? () => setMode(view) : null} />)}</div>
          <p className="refinement-coordinate-caption"><span>{tool === 'angle' ? '在三维或俯视中沿鼠标方向拖动，组合整体绕筒旋转' : tool === 'translate' ? '在三维或俯视中拖动顶部卫星，沿全局 X/Y 水平平移' : tool === 'height' ? '在三维、正视或侧视中拖动，组合整体升降' : '点击包络选择对象 · 拖动空白处旋转 · 右键平移 · 滚轮缩放'}</span><span>整流罩底面中心为原点，+Z 向上 · 红点为整体卫星质心</span></p>
        </RefinementPreview>
        {flow ? <RefinementWorkflow flow={flow} pending={pending} snapshot={snapshot} satellites={state.job?.locked_config?.satellites} groupName={groupName} setGroupName={setGroupName}
          onConfirm={confirm} onCancel={() => changeFlow(null)} disabled={state.saving || state.pending || !state.checked} />
          : <RefinementParameters state={state} selection={selection} execute={state.execute} name={name} setName={setName} />}
      </main>
      <RefinementMetrics state={state} /></>}
    <RefinementLeaveDialog dirty={state.dirty || state.pending} saving={state.saving} storageError={state.storageError} />
    <RefinementResetDialog open={resetOpen} onCancel={() => setResetOpen(false)} onConfirm={reset} />
  </AppShell>;
}
