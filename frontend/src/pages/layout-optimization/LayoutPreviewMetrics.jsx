/** 文件说明：用统一只读卡片展示布局预览尺寸、轴标质心坐标与从下到上的侧挂层质量；质心最多显示三位小数并去除末尾零，只格式化当前方案数据，不计算业务指标。 */

import { formatMillimeters } from '../pre-config/pre-config-state.js';
import { formatParameterNumber } from '../../utils/number-format.js';

/** 沿用共享毫米格式的精度和占位符；单位由卡片标题显示，数值行仅保留数字。 */
function formatPreviewDimension(value) {
  return formatMillimeters(value).replace(/ mm$/, '');
}

/** 展示当前预览的基础参数及已选方案的验收指标；未选择方案时仅显示空间参数。 */
export function LayoutPreviewMetrics({ geometry, candidate }) {
  return <div className={`model-stats layout-optimization-stats${candidate ? ' has-result' : ''}`} aria-live="polite">
    <div><small>安装筒半径（mm）</small><strong>{geometry ? formatPreviewDimension(geometry.radius_mm) : '--'}</strong></div>
    <div><small>安装筒高度（mm）</small><strong>{geometry ? formatPreviewDimension(geometry.height_mm) : '--'}</strong></div>
    <div><small>整流罩半径（mm）</small><strong>{geometry ? formatPreviewDimension(geometry.fairing_radius_mm) : '--'}</strong></div>
    {candidate && <>
      <div className="layout-centroid-card"><small>整体质心（mm）</small>
        <dl className="layout-centroid-values">{['X', 'Y', 'Z'].map((axis, index) => <div key={axis}>
          <dt>{axis}</dt><dd><strong>{formatParameterNumber(candidate.validation.center_of_mass_mm[index])}</strong></dd>
        </div>)}</dl>
      </div>
      <div className="layout-layer-mass-card"><small>侧挂层质量（下→上，kg）</small>
        {candidate.validation.layer_masses_kg.length ? <ol className="layout-layer-masses">
          {candidate.validation.layer_masses_kg.map((mass, index) => <li key={index} aria-label={`第 ${index + 1} 层，${formatParameterNumber(mass)} 千克`}>
            <strong>{formatParameterNumber(mass)}</strong>
          </li>)}
        </ol> : <strong>—</strong>}
      </div>
    </>}
  </div>;
}
