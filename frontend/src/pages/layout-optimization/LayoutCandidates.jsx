/** 文件说明：呈现原始方案编号、手动展示数量与筛选条件，卡片 H、R 最多显示一位小数且不补零；依赖候选展示工具和独立筛选组件，通过问号按钮展示方案优先级说明，不改变候选数据或预览选择。 */

import { useState } from 'react';
import { LayoutCompactionSummary } from './LayoutCompaction.jsx';
import { LayoutCandidateFilter } from './LayoutCandidateFilter.jsx';
import { LayoutHelp } from './LayoutHelp.jsx';
import { candidateFilterSummary, createCandidateFilter, selectCandidateRows } from './layout-candidate-view.js';
import '../../../styles/layout-candidate-controls.css';

const dimensionFormatter = new Intl.NumberFormat('zh-CN', { maximumFractionDigits: 1, useGrouping: false });

/** 仅格式化方案卡片的尺寸摘要；无效值显示占位符，舍入后去除负零，不回写原始尺寸。 */
function formatCandidateDimension(value) {
  return Number.isFinite(value) ? dimensionFormatter.format(value).replace(/^-0$/, '0') : '—';
}

/** 先筛选和排序全部候选再展示前 N 个；编号和选中 ID 始终对应后端原方案。 */
export function LayoutCandidates({ candidates, defaultCount, selectedId, onSelect }) {
  const [count, setCount] = useState(defaultCount);
  const [countInput, setCountInput] = useState(String(defaultCount));
  const [filter, setFilter] = useState(createCandidateFilter);
  const rows = selectCandidateRows(candidates, filter);
  const visibleRows = rows.slice(0, count);
  const summary = candidateFilterSummary(filter);
  const selectedHidden = !rows.some(({ candidate }) => candidate.candidate_id === selectedId);

  /** 保留手动输入过程；仅正整数立即更新列表，空白或无效输入离开时恢复最后的有效数量。 */
  function changeCount(event) {
    const value = event.target.value;
    setCountInput(value);
    const number = Number(value);
    if (Number.isSafeInteger(number) && number > 0) setCount(number);
  }

  return <>
    <div className="layout-parameter-heading"><h2 className="layout-sidebar-title">布局方案</h2>
      <LayoutHelp title="布局方案说明" popover>
        <ol className="layout-help-description layout-help-list">
          <li>高度更低与半径更大同优先级</li>
          <li>同尺寸时优先低质心、低偏移</li>
        </ol>
      </LayoutHelp>
    </div>
    <div className="layout-input layout-candidate-toolbar"><label htmlFor="layout-candidate-count">展示前 {visibleRows.length} 个方案（共 {rows.length} 个）</label>
      <div className="layout-candidate-tools">
        <input id="layout-candidate-count" className="layout-candidate-count-input" type="number" min="1" step="1"
          aria-label="列表展示数量" value={countInput} onChange={changeCount} onBlur={() => setCountInput(String(count))} />
        <LayoutCandidateFilter candidates={candidates} value={filter} onApply={setFilter} /></div>
    </div>
    {summary && <p className="layout-candidate-filter-summary" role="status">{summary}</p>}
    {rows.length === 0 && <p className="layout-optimization-hint" role="status">没有符合条件的方案，请调整筛选范围。</p>}
    {summary && selectedHidden && <p className="layout-optimization-hint">当前选中方案不在筛选结果中。</p>}
    <div className="layout-candidates">{visibleRows.map(({ candidate: item, number }) => <button type="button"
      key={item.candidate_id} className={selectedId === item.candidate_id ? 'active' : ''}
      aria-pressed={selectedId === item.candidate_id} onClick={() => onSelect(item.candidate_id)}>
      <strong>方案 {number}</strong>
      <span>H {formatCandidateDimension(item.height_mm)} · R {formatCandidateDimension(item.radius_mm)} mm</span>
      <span>{item.validation.loaded_count} 颗 · {item.side_layer_count} 个侧挂层 · 硬约束通过</span>
      <LayoutCompactionSummary report={item.geometric_compaction} />
    </button>)}</div>
  </>;
}
