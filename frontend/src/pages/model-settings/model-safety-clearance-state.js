/**
 * 文件说明：定义六向包络尺寸增量的表单标签与数值序列化，单位固定为毫米。
 * 本模块仅服务客户端输入；距离校验、持久化和包络计算由后端负责。
 */

export const SAFETY_CLEARANCE_FIELDS = Object.freeze([
  { key: 'front', label: '前', axis: '−Y' },
  { key: 'back', label: '后', axis: '+Y' },
  { key: 'left', label: '左', axis: '−X' },
  { key: 'right', label: '右', axis: '+X' },
  { key: 'top', label: '上', axis: '+Z' },
  { key: 'bottom', label: '下', axis: '−Z' },
]);

/** 将后端六向包络增量补全为独立受控表单值，保留输入中的空字符串。 */
export function normalizeSafetyClearance(values = {}) {
  return Object.fromEntries(SAFETY_CLEARANCE_FIELDS.map(({ key }) => [key, values?.[key] ?? 0]));
}

/** 将六个输入转换为毫米数值，空值或非法输入时抛出面向用户的错误，避免误存为零。 */
export function buildSafetyClearancePayload(values) {
  const normalized = normalizeSafetyClearance(values);
  return Object.fromEntries(SAFETY_CLEARANCE_FIELDS.map(({ key, label }) => {
    const value = normalized[key];
    const distance = Number(value);
    if (String(value).trim() === '' || !Number.isFinite(distance) || distance < 0) {
      throw new Error(`${label}方包络增量必须是大于或等于 0 的有限数值，单位为 mm`);
    }
    return [key, distance];
  }));
}
