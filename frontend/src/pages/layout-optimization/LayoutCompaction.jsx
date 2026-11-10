/** 文件说明：展示后端给出的逐星下落量与限位原因，兼容历史整体下落结果，不计算几何或业务约束。 */

import { ChevronDown } from '../../components/icons.js';
import { formatParameterNumber } from '../../utils/number-format.js';

/** 在候选卡片显示独立下落范围或旧版共同下落量。 */
export function LayoutCompactionSummary({ report }) {
  if (!report) return null;
  return <>
    <span>{report.instances
      ? `逐颗下落 ${formatParameterNumber(report.min_drop_mm)}～${formatParameterNumber(report.max_drop_mm)} mm`
      : `整体下落 ${formatParameterNumber(report.drop_mm)} mm`} · 筒高减少 {formatParameterNumber(report.height_reduction_mm)} mm</span>
    {!report.instances && <span>下落限位：{report.limiting_constraints.map((item) => `${item.name}：${item.message}`).join('；')}</span>}
  </>;
}

/** 在当前方案中逐颗列出下移结果；零位移明确显示，便于检查哪个模型已经到边界。 */
export function LayoutCompactionDetails({ report }) {
  if (!report?.instances) return null;
  return <details open>
    <summary className="layout-sidebar-disclosure"><h3 className="layout-sidebar-subtitle">各颗卫星下落结果</h3><ChevronDown aria-hidden="true" /></summary>
    <p className="layout-optimization-hint">水平位置和姿态保持不变；各颗降到自身约束边界，硬对称配对同步下降。同层允许不同安装高度。</p>
    <ol className="layout-placement-list">{report.instances.map((item) => <li key={item.instance_id}>
      <strong>{item.name} · 下落 {formatParameterNumber(item.drop_mm)} mm</strong><br />
      限位：{item.limiting_constraints.map((limit) => limit.message).join('；')}
    </li>)}</ol>
  </details>;
}
