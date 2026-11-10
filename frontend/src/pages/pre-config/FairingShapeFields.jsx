/**
 * 文件说明：按下锥段、圆柱段、上锥段独立展示整流罩外形参数。
 * 连接处半径只保存一个共用值，任何输入位置都能自动同步更新；不读写内部安装筒参数。
 */

import { PreConfigNumberInput } from './PreConfigNumberInput.jsx';

/** 渲染毫米尺寸输入；变更交给页面草稿管理，不计算业务约束。 */
function DimensionField({ id, label, field, draft, disabled, onChange }) {
  return (
    <label className="model-settings-field pre-config-shape-field" htmlFor={id}>
      <span>{label} <small>(mm)</small></span>
      <PreConfigNumberInput id={id} label={label} min={draft.limits.min_fairing_radius_mm}
        max={draft.limits.max_fairing_size_mm} value={draft[field]} disabled={disabled}
        onValueChange={(value) => onChange(field, value)} />
    </label>
  );
}

/** 按当前形态显示所需的独立段分组，共通半径的三个输入都写入圆柱段半径。 */
export function FairingShapeFields({ draft, disabled, onChange }) {
  const lower = ['lower_cone_cylinder_upper_cone', 'lower_cone_cylinder'].includes(draft.fairing_form);
  const upper = ['lower_cone_cylinder_upper_cone', 'cylinder_upper_cone'].includes(draft.fairing_form);
  const shared = { draft, disabled, onChange };
  return (
    <div className="pre-config-shape-segments">
      {lower && (
        <fieldset className="pre-config-shape-segment">
          <legend>下锥段参数</legend>
          <div className="model-settings-field-grid">
            <DimensionField {...shared} id="lower-cone-lower-radius" label="下底面半径" field="lower_cone_lower_radius_mm" />
            <DimensionField {...shared} id="lower-cone-upper-radius" label="上底面半径" field="fairing_cylinder_radius_mm" />
            <DimensionField {...shared} id="lower-cone-height" label="高度" field="lower_cone_height_mm" />
          </div>
        </fieldset>
      )}
      <fieldset className="pre-config-shape-segment">
        <legend>圆柱段参数</legend>
        <div className="model-settings-field-grid">
          <DimensionField {...shared} id="fairing-cylinder-radius" label="半径" field="fairing_cylinder_radius_mm" />
          <DimensionField {...shared} id="fairing-cylinder-height" label="高度" field="fairing_cylinder_height_mm" />
        </div>
      </fieldset>
      {upper && (
        <fieldset className="pre-config-shape-segment">
          <legend>上锥段参数</legend>
          <div className="model-settings-field-grid">
            <DimensionField {...shared} id="upper-cone-lower-radius" label="下底面半径" field="fairing_cylinder_radius_mm" />
            <DimensionField {...shared} id="upper-cone-upper-radius" label="上底面半径" field="upper_cone_upper_radius_mm" />
            <DimensionField {...shared} id="upper-cone-height" label="高度" field="upper_cone_height_mm" />
          </div>
        </fieldset>
      )}
    </div>
  );
}
