/** 文件说明：为原始方案和微调版本提供排序、高度上限及半径下限筛选；沿用后端评分或保存顺序，仅处理展示副本并保留原始编号。 */

import { formatParameterNumber } from '../../utils/number-format.js';

/** 创建独立的展示筛选状态；sort 指定默认评分或保存顺序，保存顺序默认从旧到新，空字符串表示该尺寸不限。 */
export function createCandidateFilter(sort = 'score') {
  return { sort, scoreDirection: 'desc', savedDirection: 'asc', heightDirection: 'asc', radiusDirection: 'asc', maxHeight: '', minRadius: '' };
}

/** 校验展示用高度上限和半径下限；返回中文错误信息，空字符串表示有效，不影响模型或求解参数。 */
export function candidateFilterError(filter) {
  for (const value of [filter.maxHeight, filter.minRadius]) {
    if (value !== '' && (!Number.isFinite(Number(value)) || Number(value) < 0)) return '请输入大于或等于 0 的有效数值。';
  }
  return '';
}

/** 筛出高度严格小于上限且半径严格大于下限的副本；排序保留原始编号及同值顺序，不改源数组。 */
export function selectCandidateRows(candidates, filter) {
  const rows = candidates.map((candidate, index) => ({ candidate, number: index + 1 }))
    .filter(({ candidate }) => (filter.maxHeight === '' || candidate.height_mm < Number(filter.maxHeight))
      && (filter.minRadius === '' || candidate.radius_mm > Number(filter.minRadius)));
  if (filter.sort === 'score') return filter.scoreDirection === 'asc' ? rows.reverse() : rows;
  if (filter.sort === 'saved') return filter.savedDirection === 'desc' ? rows.reverse() : rows;
  if (filter.sort !== 'height' && filter.sort !== 'radius') return rows;
  const key = filter.sort === 'radius' ? 'radius_mm' : 'height_mm';
  const direction = filter[`${filter.sort}Direction`] === 'desc' ? -1 : 1;
  return rows.sort((a, b) => (a.candidate[key] - b.candidate[key]) * direction || a.number - b.number);
}

/** 生成已应用排序及范围的说明；沿用默认后端评价或保存顺序且没有范围限制时返回空字符串。 */
export function candidateFilterSummary(filter) {
  const parts = [];
  if (filter.sort === 'score' && filter.scoreDirection === 'asc') parts.push('评分升序');
  if (filter.sort === 'saved' && filter.savedDirection === 'desc') parts.push('保存顺序：新到旧');
  if (filter.sort === 'height' || filter.sort === 'radius') {
    parts.push(`${filter.sort === 'height' ? '高度' : '半径'}${filter[`${filter.sort}Direction`] === 'desc' ? '降序' : '升序'}`);
  }
  if (filter.maxHeight !== '') parts.push(`高度 < ${formatParameterNumber(filter.maxHeight)} mm`);
  if (filter.minRadius !== '') parts.push(`半径 > ${formatParameterNumber(filter.minRadius)} mm`);
  return parts.join(' · ');
}
