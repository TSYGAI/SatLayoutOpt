/**
 * 文件说明：通过共享布局说明组件展示悬高与搜索参数的用途和调整建议。
 * 每项仅展示作用、调参建议及当前配置的默认值；不写表单、不请求计算，也不重复实现后端校验。
 * 弹窗交互、焦点与主题样式由 LayoutHelp 统一管理，当前文件只负责参数说明内容。
 */

import { LayoutHelp } from './LayoutHelp.jsx';
import { formatParameterNumber } from '../../utils/number-format.js';

/** 读取当前配置的默认值用于说明；缺项不展示，避免把现行常量冒充历史默认值。 */
function defaultLabel(config, key, unit = '') {
  const value = config?.defaults?.[key];
  return value == null ? null : `默认 ${formatParameterNumber(value)}${unit ? ` ${unit}` : ''}`;
}

/** 展示单个参数的名称、可选默认值及两行简短说明；不处理参数校验或修改。 */
function ParameterItem({ name, defaultValue, purpose, advice }) {
  return <div className="layout-parameter-help-item">
    <dt>{name}{defaultValue && <small>{defaultValue}</small>}</dt>
    <dd><p><b>作用：</b>{purpose}</p><p><b>建议：</b>{advice}</p></dd>
  </div>;
}

/** 展示参数用途与建议，使用当前配置的默认值；运行中或查看历史时仍可阅读。 */
export function LayoutParameterHelp({ config }) {
  return <LayoutHelp title="优化参数说明" bodyLabel="参数说明内容">
    <section>
      <h3>安装间距</h3>
      <dl>
        <ParameterItem name="卫星悬高最小值 / 最大值" defaultValue={config?.defaults?.min_suspension_mm != null && config?.defaults?.max_suspension_mm != null
          ? `默认 ${formatParameterNumber(config.defaults.min_suspension_mm)}–${formatParameterNumber(config.defaults.max_suspension_mm)} mm` : null}
          purpose="限定卫星离安装筒的距离范围。"
          advice="最小值满足安装留距即可；最大值适当调大可增加选择，需兼顾罩内空间。" />
      </dl>
    </section>
    <section>
      <h3>搜索范围与次数</h3>
      <dl>
        <ParameterItem name="安装筒半径扫描步长" defaultValue={defaultLabel(config, 'radius_step_mm', 'mm')}
          purpose="控制半径搜索的精细程度。"
          advice="越小越精细；先用默认值，需细搜时调小，并配合增加总尝试次数。" />
        <ParameterItem name="总尝试次数" defaultValue={defaultLabel(config, 'hybrid_attempt_budget', '次')}
          purpose="控制布局搜索的总尝试量。"
          advice="越大搜索越充分，通常也越耗时；找不到方案时优先调大。" />
        <ParameterItem name="半径采样点数" defaultValue={defaultLabel(config, 'hybrid_radius_samples', '个')}
          purpose="控制初始搜索覆盖的半径数量。"
          advice="越大覆盖越广；调大时配合增加总尝试次数，保证每个半径的搜索量。" />
      </dl>
    </section>
    <section>
      <h3>搜索策略</h3>
      <dl>
        <ParameterItem name="自适应搜索预算比例" defaultValue={defaultLabel(config, 'alns_budget_fraction')}
          purpose="分配给重排、换层等后续优化的尝试比例。"
          advice="先保持默认值；调大更侧重后续优化，同时会减少初始构造的预算。" />
        <ParameterItem name="初始分组方案上限" defaultValue={defaultLabel(config, 'cp_partition_limit', '套')}
          purpose="控制每次生成的卫星分组方案数量上限。"
          advice="越大分组选择越多，也可能越耗时；难以找到方案时适当调大。" />
      </dl>
    </section>
    <section>
      <h3>优化结果</h3>
      <dl>
        <ParameterItem name="展示方案数量" defaultValue={defaultLabel(config, 'candidate_limit', '个')}
          purpose="按默认评分顺序，保留本次优化中排名最高的指定数量方案。"
          advice="下方列表可单独输入当前显示数量，实际不足时按实际数量展示。" />
      </dl>
    </section>
  </LayoutHelp>;
}
