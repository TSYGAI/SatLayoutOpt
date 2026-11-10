/**
 * 文件说明：序列化模型包络设置中的受控整数输入；默认值与分辨率范围由后端统一提供和校验。
 * 本模块不访问 DOM 或 API，不根据模型复杂度自动调整用户指定的分辨率。
 */

/** 将体素分辨率表单值转换为整数载荷；空白、布尔值和非整数输入抛出面向用户的错误。 */
export function buildEnvelopeSettingsPayload(values) {
  const raw = values?.refinement_grid_size;
  const resolution = typeof raw === 'number' || typeof raw === 'string' ? Number(raw) : NaN;
  if (raw === undefined || String(raw).trim() === '' || !Number.isSafeInteger(resolution) || resolution <= 0) {
    throw new Error('体素分辨率必须为正整数');
  }
  return { refinement_grid_size: resolution };
}
