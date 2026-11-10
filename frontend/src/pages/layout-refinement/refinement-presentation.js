/** 文件说明：微调展示层的数值格式、用户名称、对象导航与质量统计；显示最多三位小数，不回写显示舍入或复制后端安装约束规则。 */
import { groupFor, selectionFor } from './refinement-state.js';
import { formatParameterNumber } from '../../utils/number-format.js';

/** 数值最多显示三位小数并去除末尾零；编辑中的字符串原样保留，返回文本而不修改原始精度。 */
export function formatRefinementNumber(value) { return Number.isFinite(value) ? formatParameterNumber(value) : String(value ?? ''); }

/** 判断输入是否真正改变数值；空值、非法值和原显示值重输不产生操作，避免将三位显示值写回完整精度来源。 */
export function hasRefinementParameterChange(text, value) {
  const number = Number(text);
  return Boolean(String(text).trim()) && Number.isFinite(number) && number !== Number(formatRefinementNumber(value)) && Math.abs(number - value) > 1e-9;
}

/** 优先显示来源配置中用户填写的名称，不暴露内部 ID 或后端实例后缀。 */
export function satelliteName(item, satellites = []) { return satellites.find((entry) => entry.record_id === item.record_id)?.name ?? item.name ?? '未命名卫星'; }

/** 从项目数据解析方案展示名；优化候选沿用原始编号，微调版本使用保存名称，数据未到达时返回空串而不显示内部 ID。 */
export function refinementSourceName(job, candidateId) {
  const version = job?.refinements?.find((item) => item.candidate_id === candidateId);
  if (version) return version.refinement?.name?.trim() || '未命名微调版本';
  const index = job?.candidates?.findIndex((item) => item.candidate_id === candidateId) ?? -1;
  return index >= 0 ? `方案 ${index + 1}` : '';
}

/** 将任意成员解析为最外层完整对象及稳定基准，供组合选择、交换预览和名称展示共用。 */
export function describeObject(snapshot, id, satellites = []) {
  const group = groupFor(snapshot.groups, id), ids = selectionFor(snapshot.groups, id);
  const items = ids.map((key) => snapshot.candidate.placements.find((item) => item.instance_id === key));
  return { id: ids[0], ids, items, group, anchor: items[0], name: group?.name ?? satelliteName(items[0], satellites) };
}

/** 按对象树顺序返回整组与独立卫星，组合成员不成为单独导航目标。 */
export function navigationObjects(snapshot) {
  const members = new Set(snapshot.groups.flatMap((group) => group.members));
  return [...snapshot.groups.map((group) => group.members), ...snapshot.candidate.placements.filter((item) => !members.has(item.instance_id)).map((item) => [item.instance_id])];
}

/** 汇总真实质量与加权质心，并取后端许可增量区间的交集；暂未正式校核时由宿主隐藏范围。 */
export function selectionSummary(items) {
  const mass = items.reduce((sum, item) => sum + item.mass_kg, 0);
  const center = [0, 1, 2].map((axis) => mass ? items.reduce((sum, item) => sum + item.mass_kg * item.center_of_mass_mm[axis], 0) / mass : 0);
  /** 组合只能采用所有成员同时允许的范围。 */
  function range(key) {
    const values = items.map((item) => item.adjustment_range?.[key]);
    return values.length && values.every(Boolean) ? [Math.max(...values.map((value) => value[0])), Math.min(...values.map((value) => value[1]))] : null;
  }
  return { mass, center, height: range('height_delta_mm'), suspension: range('suspension_delta_mm') };
}
