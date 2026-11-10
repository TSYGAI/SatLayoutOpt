/** 文件说明：展示微调版本的名称、来源、筒体尺寸与验收状态，复用候选筛选工具管理独立的显示数量、保存顺序及尺寸范围；版本操作复用历史弹窗，持久化交由布局状态 Hook。 */

import { useRef, useState } from 'react';
import { formatParameterNumber } from '../../utils/number-format.js';
import { Pencil, Trash2 } from '../../components/icons.js';
import { LayoutCandidateFilter } from './LayoutCandidateFilter.jsx';
import { LayoutHistoryDialog } from './LayoutHistoryDialog.jsx';
import { candidateFilterSummary, createCandidateFilter, selectCandidateRows } from './layout-candidate-view.js';
import { isLayoutRunning } from './layout-state.js';
import '../../../styles/layout-candidate-controls.css';

/** 显示来源方案或父版本的当前名称；已删除父版本保留来源关系的明确提示。 */
function sourceName(item, versions) {
  const source = item.refinement.source_candidate_id;
  if (!source.startsWith('manual-')) return `方案 ${source.split('-').at(-1)}`;
  return versions.find((version) => version.candidate_id === source)?.refinement.name ?? '微调版本（已删除）';
}

/** 用独立按钮选择、重命名或删除版本；小字来源紧邻名称右侧基线，尺寸直接读取后端保存结果。 */
function RefinementItem({ item, state, onAction }) {
  const { candidate_id: id, refinement: { name } } = item;
  const active = state.selectedId === id;
  const locked = state.busy || isLayoutRunning(state.job);
  const source = `来源 ${sourceName(item, state.job.refinements)}`;
  return <article className={`layout-history-item layout-refinement-item${active ? ' active' : ''}`} data-refinement-id={id}>
    <button className="layout-history-open" type="button" disabled={locked} aria-pressed={active} onClick={() => state.setSelectedId(id)}>
      <span className="layout-refinement-title"><strong title={name}>{name}</strong>
        <span className="layout-refinement-source" title={source}>{source}</span></span>
      <span className="layout-refinement-dimensions">H {formatParameterNumber(item.height_mm)} · R {formatParameterNumber(item.radius_mm)} mm</span>
      <span>{item.validation.loaded_count} 颗 · {item.side_layer_count} 个侧挂层 · 硬约束通过</span>
    </button>
    <div className="layout-history-actions">
      <button type="button" aria-label="重命名" title="重命名" disabled={locked}
        onClick={() => onAction({ mode: 'rename', id, name })}><Pencil aria-hidden="true" /></button>
      <button className="layout-history-delete" type="button" aria-label="删除" title="删除该微调版本" disabled={locked}
        onClick={() => onAction({ mode: 'delete', id, name })}><Trash2 aria-hidden="true" /></button>
    </div>
  </article>;
}

/** 先筛选、排序全部版本再展示前 N 项；列表状态与原方案独立，保持选中版本，删除最后一项后保留标题供焦点恢复。 */
export function LayoutRefinements({ state, defaultCount }) {
  const [dialog, setDialog] = useState(null);
  const [count, setCount] = useState(defaultCount);
  const [countInput, setCountInput] = useState(String(defaultCount));
  const [filter, setFilter] = useState(() => createCandidateFilter('saved'));
  const headingRef = useRef(null);

  /** 仅以有效正整数更新展示数量；保留输入过程，失焦后由输入框恢复最近一次有效值。 */
  function changeCount(event) {
    const value = event.target.value;
    setCountInput(value);
    const number = Number(value);
    if (Number.isSafeInteger(number) && number > 0) setCount(number);
  }

  if (!state.job.refinements) return null;
  const versions = state.job.refinements;
  const rows = selectCandidateRows(versions, filter);
  const visibleRows = rows.slice(0, count);
  const summary = candidateFilterSummary(filter);
  const selectedHidden = versions.some((item) => item.candidate_id === state.selectedId)
    && !visibleRows.some(({ candidate }) => candidate.candidate_id === state.selectedId);
  return <section className="layout-refinements" aria-label="微调版本">
    <h2 className="layout-sidebar-title" ref={headingRef} tabIndex={-1}>微调版本</h2>
    <div className="layout-input layout-candidate-toolbar"><label htmlFor="layout-refinement-count">展示前 {visibleRows.length} 个版本（共 {rows.length} 个）</label>
      <div className="layout-candidate-tools">
        <input id="layout-refinement-count" className="layout-candidate-count-input" type="number" min="1" step="1"
          aria-label="微调版本展示数量" value={countInput} onChange={changeCount} onBlur={() => setCountInput(String(count))} />
        <LayoutCandidateFilter candidates={versions} value={filter} onApply={setFilter} refinements /></div>
    </div>
    {summary && <p className="layout-candidate-filter-summary" role="status">{summary}</p>}
    {versions.length > 0 && rows.length === 0 && <p className="layout-optimization-hint" role="status">没有符合条件的微调版本，请调整筛选范围。</p>}
    {selectedHidden && <p className="layout-optimization-hint">当前选中版本不在当前展示列表中。</p>}
    <div className="layout-history">
      {visibleRows.map(({ candidate: item }) => <RefinementItem key={item.candidate_id} item={item} state={state} onAction={setDialog} />)}
    </div>
    {!versions.length && <p className="layout-optimization-hint">暂无微调版本。</p>}
    {dialog && <LayoutHistoryDialog target={dialog} state={state} subject="微调版本" fallbackFocusRef={headingRef}
      onRename={(id, name) => state.renameRefinement(state.job.job_id, id, name)}
      onDelete={(id) => state.deleteRefinement(state.job.job_id, id)}
      deleteDescription="该微调版本将永久删除。原始方案、其他微调版本及项目快照会保留。"
      onClose={() => setDialog(null)} />}
  </section>;
}
