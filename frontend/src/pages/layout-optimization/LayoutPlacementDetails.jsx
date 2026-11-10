/** 文件说明：在布局预览下用表格展示当前方案，依安装位置从低到高、每行并排两颗卫星；按快照实例数隐藏单颗编号，复用对齐的圆形轴标展示全局质心，兼容历史下落报告，不计算安装约束或质心。 */

import { Fragment, useId } from 'react';
import { ChevronDown } from '../../components/icons.js';
import { LayoutCompactionDetails } from './LayoutCompaction.jsx';
import { sortPlacementsForDisplay } from './layout-placement-view.js';
import { formatParameterNumber } from '../../utils/number-format.js';
import '../../../styles/layout-placement-details.css';

/** 展示一组卫星单元格并关联其专属表头；空组保留分隔线，单颗型号隐藏自动追加的 #1，历史缺失质心时显示占位符。 */
function PlacementCells({ item, headingId, columnsId, second, singleInstance }) {
  if (!item) return <td className="layout-placement-empty layout-placement-group-start" colSpan={4} />;
  const displayName = singleInstance ? item.name.replace(/\s+#1$/, '') : item.name;
  return <>
    <th id={headingId} scope="row" className={second ? 'layout-placement-group-start' : undefined}>{displayName}</th>
    <td headers={`${headingId} ${columnsId}-mount`}>{item.mount === 'top' ? '圆柱正顶部' : `侧挂第 ${item.layer + 1} 层`}</td>
    <td className="layout-placement-suspension" headers={`${headingId} ${columnsId}-suspension`}>{formatParameterNumber(item.suspension_mm)}</td>
    <td headers={`${headingId} ${columnsId}-center`}>
      <div className="layout-placement-coordinate-cell"><dl className="layout-centroid-values layout-placement-coordinates">{['X', 'Y', 'Z'].map((axis, index) => <div key={axis}>
        <dt>{axis}</dt><dd><strong>{formatParameterNumber(item.center_of_mass_mm?.[index])}</strong></dd>
      </div>)}</dl></div>
    </td>
  </>;
}

/** 渲染可折叠的方案明细，先按安装位置排序副本再每两颗组成一行；名称和颗数随当前选择更新，切换方案保留用户的展开状态。 */
export function LayoutPlacementDetails({ candidate, name }) {
  const tableId = useId();
  if (!candidate) return null;
  const instanceCounts = new Map();
  for (const item of candidate.placements) {
    if (item.record_id) instanceCounts.set(item.record_id, (instanceCounts.get(item.record_id) ?? 0) + 1);
  }
  const placements = sortPlacementsForDisplay(candidate.placements);
  const rows = Array.from({ length: Math.ceil(placements.length / 2) }, (_, index) => placements.slice(index * 2, index * 2 + 2));
  return <details className="layout-placement-details">
    <summary className="layout-placement-summary">
      <h3>当前方案装载明细</h3>
      <span className="layout-placement-current" title={name}>{name}</span>
      <span className="layout-placement-count">{candidate.placements.length} 颗</span>
      <ChevronDown aria-hidden="true" />
    </summary>
    <table className="layout-placement-table" aria-label={`${name}装载明细`}>
      <thead><tr>{[0, 1].map((side) => <Fragment key={side}>
        <th scope="col" className={side ? 'layout-placement-group-start' : undefined}>卫星</th>
        <th id={`${tableId}-${side}-mount`} scope="col">安装位置</th>
        <th id={`${tableId}-${side}-suspension`} scope="col" className="layout-placement-suspension">悬高（mm）</th>
        <th id={`${tableId}-${side}-center`} scope="col">卫星质心全局位置（mm）</th>
      </Fragment>)}</tr></thead>
      <tbody>{rows.map((items, index) => <tr key={items[0].instance_id}>
        {[0, 1].map((side) => <PlacementCells key={side} item={items[side]} second={Boolean(side)}
          singleInstance={instanceCounts.get(items[side]?.record_id) === 1}
          headingId={`${tableId}-satellite-${index}-${side}`} columnsId={`${tableId}-${side}`} />)}
      </tr>)}</tbody>
    </table>
    {candidate.geometric_compaction?.instances && <div className="layout-placement-history">
      <LayoutCompactionDetails report={candidate.geometric_compaction} />
    </div>}
  </details>;
}
