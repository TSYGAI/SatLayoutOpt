/** 文件说明：统一参数的纯展示格式，最多三位小数且不补零；不修改计算、输入草稿或保存数据的精度。 */

const parameterFormatter = new Intl.NumberFormat('zh-CN', { maximumFractionDigits: 3, useGrouping: false });

/** 将有限数字或数值字符串显示为紧凑文本；空值和非法值使用调用方占位符，舍入后的负零统一显示为零。 */
export function formatParameterNumber(value, fallback = '—') {
  if (value === null || value === undefined || typeof value === 'boolean' || String(value).trim() === '') return fallback;
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  const formatted = parameterFormatter.format(number);
  return formatted === '-0' ? '0' : formatted;
}
