/**
 * 文件说明：展示安装筒圆柱与下方同轴基座的独立尺寸；基座上底面直接绑定筒体半径范围。
 * 本组件只呈现草稿和转发输入，不复制后端校验规则，不保存第二组共通半径。
 */

import { PreConfigNumberInput } from './PreConfigNumberInput.jsx';

/** 按字段定义渲染尺寸输入；输入副作用统一交给页面草稿管理。 */
function Dimensions({ fields, draft, disabled, onChange }) {
  return <div className="model-settings-field-grid pre-config-fairing-fields">
    {fields.map(([id, label, field, minimum]) => <label className="model-settings-field" htmlFor={id} key={id}>
      <span>{label} <small>(mm)</small></span>
      <PreConfigNumberInput id={id} label={label} min={draft.limits[minimum]} max={draft.limits.max_fairing_size_mm}
        value={draft[field]} disabled={disabled}
        onValueChange={(value) => onChange(field, value)} />
    </label>)}
  </div>;
}

/** 展示筒体和基座；上底面两个端点与筒体共用字段，修改任一位置都会同步。 */
export function InstallationTubeFields(props) {
  return <div className="pre-config-shape-segments">
    <fieldset className="pre-config-shape-segment">
      <legend>安装筒</legend>
      <Dimensions {...props} fields={[
        ['fairing-min-radius', '半径最小值', 'min_radius_mm', 'min_fairing_radius_mm'],
        ['fairing-max-radius', '半径最大值', 'max_radius_mm', 'min_fairing_radius_mm'],
        ['fairing-min-height', '高度最小值', 'min_height_mm', 'min_fairing_height_mm'],
        ['fairing-max-height', '高度最大值', 'max_height_mm', 'min_fairing_height_mm'],
        ['fairing-axis-radius', '质心最大偏移', 'centroid_max_offset_mm', 'min_centroid_offset_mm'],
      ]} />
    </fieldset>
    <fieldset className="pre-config-shape-segment">
      <legend>安装筒基座</legend>
      <Dimensions {...props} fields={[
        ['installation-base-min-upper-radius', '上底面半径最小值', 'min_radius_mm', 'min_fairing_radius_mm'],
        ['installation-base-max-upper-radius', '上底面半径最大值', 'max_radius_mm', 'min_fairing_radius_mm'],
        ['installation-base-lower-radius', '下底面半径', 'base_lower_radius_mm', 'min_fairing_radius_mm'],
        ['installation-base-height', '高度', 'base_height_mm', 'min_fairing_height_mm'],
      ]} />
    </fieldset>
  </div>;
}
