/** 文件说明：提供布局参数网格中的搜索输入单元；默认值与上限由服务端提供，不实现布局规划。 */

import { ParameterNumberInput } from '../../components/ParameterNumberInput.jsx';

const SEARCH_FIELDS = [
  { key: 'radius_step_mm', label: '安装筒半径扫描步长 (mm)', min: 0, step: 'any' },
  { key: 'hybrid_attempt_budget', label: '总尝试次数', min: 1, step: 1 },
  { key: 'alns_budget_fraction', label: '自适应搜索预算比例（ALNS）', min: 0, max: 1, step: 'any' },
  { key: 'hybrid_radius_samples', label: '半径采样点数', min: 1, step: 1 },
  { key: 'cp_partition_limit', label: '初始分组方案上限', min: 1, step: 1 },
  { key: 'candidate_limit', label: '展示方案数量', min: 1, step: 1 },
];

/** 返回由父网格排版的搜索输入；运行中及历史查看时由父组件锁定，变更只更新当前任务草稿。 */
export function LayoutSearchParameters({ form, config, disabled, onChange }) {
  return <>
    {SEARCH_FIELDS.map(({ key, label, ...input }) => {
      const id = `layout-search-${key}`;
      const max = key === 'candidate_limit' ? config?.candidate_archive_limit
        : key === 'hybrid_attempt_budget' ? config?.max_attempts_per_round : input.max;
      return <div className="layout-input" key={key}>
        <label htmlFor={id}>{label}</label>
        <ParameterNumberInput {...input} id={id} max={max} value={form[key] ?? ''}
          placeholder={form[key] == null && disabled ? '历史未记录' : undefined}
          disabled={disabled}
          onChange={(event) => onChange(key, event.target.value)} />
      </div>;
    })}
  </>;
}
