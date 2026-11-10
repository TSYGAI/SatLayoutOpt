/**
 * 文件说明：前置配置数据层，规范化后端记录、校验独立的整流罩形态与安装筒请求，并管理会话草稿。
 * 历史字段仅在读取边界转换；基座上底面和筒体共用半径区间，不重复保存同步值。
 * 本模块只读写 `sessionStorage` 与纯数据；后端仍是参数校验和几何构建的最终权威。
 */

import { formatParameterNumber } from '../../utils/number-format.js';

export const SATELLITE_COUNT_EVENT = 'sat-layout-pre-config-satellite-count';

/** 整流舱段参数会话草稿的存储键，用于刷新后恢复当前状态。 */
export const FAIRING_DRAFT_STORAGE_KEY = 'sat-layout-pre-config-fairing-draft';
/** 草稿只保存可编辑字段；共通半径仅占一项，轮廓和外形边界均由后端返回。 */
const FAIRING_DRAFT_FIELDS = Object.freeze([
  'min_radius_mm', 'max_radius_mm', 'min_height_mm', 'max_height_mm', 'centroid_max_offset_mm',
  'base_lower_radius_mm', 'base_height_mm',
  'fairing_form', 'fairing_cylinder_radius_mm', 'fairing_cylinder_height_mm',
  'lower_cone_lower_radius_mm', 'lower_cone_height_mm', 'upper_cone_upper_radius_mm', 'upper_cone_height_mm',
]);

const FALLBACK_LIMITS = Object.freeze({
  min_satellite_count: 0,
  max_satellite_count: 1000,
  min_fairing_radius_mm: 0.001,
  min_fairing_height_mm: 0.001,
  max_fairing_size_mm: 1000000,
  min_centroid_offset_mm: 0.001,
});
/** 图片需求对应的四种整流罩组合，值用于 API，标签用于页面展示。 */
export const FAIRING_FORM_OPTIONS = Object.freeze([
  { value: 'lower_cone_cylinder_upper_cone', label: '下锥段 + 圆柱段 + 上锥段' },
  { value: 'lower_cone_cylinder', label: '下锥段 + 圆柱段' },
  { value: 'cylinder_upper_cone', label: '圆柱段 + 上锥段' },
  { value: 'cylinder', label: '圆柱段' },
]);

/** 规范化整流罩组合值；历史配置和未知值统一回退到圆柱段。 */
export function normalizeFairingForm(value) {
  const aliases = {
    'lower_cone+cylinder+upper_cone': 'lower_cone_cylinder_upper_cone',
    'lower_cone+cylinder': 'lower_cone_cylinder',
    'cylinder+upper_cone': 'cylinder_upper_cone',
  };
  const normalized = aliases[String(value ?? '')] || String(value ?? '');
  return FAIRING_FORM_OPTIONS.some((item) => item.value === normalized) ? normalized : 'cylinder';
}

/** 把后端保存的组合段规整为前端预览可直接使用的结构。 */
function normalizeFairingProfile(profile, radius, height) {
  const form = normalizeFairingForm(profile?.form || profile?.fairing_form);
  const sourceSegments = Array.isArray(profile?.segments) ? profile.segments : [];
  const segments = sourceSegments.length ? sourceSegments.map((item) => ({ ...item })) : [
    { kind: 'cylinder', radius_mm: Number(radius), height_mm: Number(height) },
  ];
  const totalHeight = Number(profile?.total_height_mm);
  const maxRadius = Number(profile?.max_radius_mm);
  return {
    form,
    segments,
    total_height_mm: Number.isFinite(totalHeight) && totalHeight > 0
      ? totalHeight : segments.reduce((sum, item) => sum + Number(item.height_mm || 0), 0),
    max_radius_mm: Number.isFinite(maxRadius) && maxRadius > 0
      ? maxRadius : Math.max(...segments.map((item) => Math.max(
        Number(item.radius_mm) || 0,
        Number(item.lower_radius_mm) || 0,
        Number(item.upper_radius_mm) || 0,
      ))),
  };
}

/** 把后端返回的范围约束规范化为可直接用于表单的数值，非法或非正值回落到默认约束。 */
export function normalizeLimits(values) {
  const source = values && typeof values === 'object' ? values : {};
  const satelliteMinimum = toFiniteNumber(source.min_satellite_count, FALLBACK_LIMITS.min_satellite_count);
  const satelliteMaximum = toFiniteNumber(source.max_satellite_count, FALLBACK_LIMITS.max_satellite_count);
  const sizeMaximum = toFiniteNumber(source.max_fairing_size_mm, FALLBACK_LIMITS.max_fairing_size_mm);
  return {
    min_satellite_count: satelliteMinimum >= 0 ? satelliteMinimum : FALLBACK_LIMITS.min_satellite_count,
    max_satellite_count: satelliteMaximum > 0 ? satelliteMaximum : FALLBACK_LIMITS.max_satellite_count,
    min_fairing_radius_mm: toPositiveNumber(source.min_fairing_radius_mm, FALLBACK_LIMITS.min_fairing_radius_mm),
    min_fairing_height_mm: toPositiveNumber(source.min_fairing_height_mm, FALLBACK_LIMITS.min_fairing_height_mm),
    max_fairing_size_mm: sizeMaximum > 0 ? sizeMaximum : FALLBACK_LIMITS.max_fairing_size_mm,
    min_centroid_offset_mm: toPositiveNumber(source.min_centroid_offset_mm, toPositiveNumber(source.min_axis_radius_mm, FALLBACK_LIMITS.min_centroid_offset_mm)),
  };
}

/**
 * 把数据管理页的固化记录整理为卫星类型清单，数量默认 0。
 * @param {unknown} satellites 后端返回的卫星类型数组。
 * @returns {Array<{ recordId: string, deviceName: string, count: number, updatedAt: string|null, symmetryEnabled: boolean, symmetryMode: string }>} 卫星类型清单，旧记录模式默认为硬约束。
 */
export function normalizeSatellites(satellites) {
  if (!Array.isArray(satellites)) return [];
  return satellites
    .filter((item) => item && typeof item.record_id === 'string' && item.record_id)
    .map((item) => ({
      recordId: item.record_id,
      deviceName: typeof item.device_name === 'string' && item.device_name ? item.device_name : item.record_id,
      count: toFiniteNumber(item.count, 0),
      updatedAt: item.updated_at || null,
      symmetryEnabled: item.symmetry_enabled === true,
      symmetryMode: item.symmetry_mode === 'soft' ? 'soft' : 'hard',
    }));
}

/** 把后台配置响应整理为表单可直接使用的整流舱段区间参数，并兼容旧版单值字段。 */
export function normalizePreConfig(config) {
  const source = config && typeof config === 'object' ? config : {};
  const fairing = source.fairing_segment || {};
  const limits = normalizeLimits(source.limits);
  const legacyRadius = toFiniteNumber(fairing.radius_mm, 0);
  const legacyHeight = toFiniteNumber(fairing.height_mm, 0);
  const installation = fairing.installation_tube && typeof fairing.installation_tube === 'object'
    ? fairing.installation_tube : fairing;
  const minRadius = toFiniteNumber(installation.min_radius_mm, legacyRadius);
  const minHeight = toFiniteNumber(installation.min_height_mm, legacyHeight);
  const profile = normalizeFairingProfile(fairing.fairing_profile, minRadius, minHeight);
  const cylinder = profile.segments.find((item) => item.kind === 'cylinder') || {};
  const legacyClearance = toFiniteNumber(fairing.radial_clearance_mm, 0);
  return {
    satellites: normalizeSatellites(source.satellites),
    min_radius_mm: minRadius,
    max_radius_mm: toFiniteNumber(installation.max_radius_mm, toFiniteNumber(fairing.max_radius_mm, legacyRadius)),
    min_height_mm: minHeight,
    max_height_mm: toFiniteNumber(installation.max_height_mm, toFiniteNumber(fairing.max_height_mm, legacyHeight)),
    centroid_max_offset_mm: toFiniteNumber(installation.centroid_max_offset_mm, toFiniteNumber(fairing.centroid_max_offset_mm, fairing.axis_radius_mm)),
    base_lower_radius_mm: installation.base?.lower_radius_mm ?? '',
    base_height_mm: installation.base?.height_mm ?? '',
    fairing_radius_mm: toFiniteNumber(fairing.fairing_radius_mm, minRadius + legacyClearance),
    fairing_form: normalizeFairingForm(fairing.fairing_form || fairing.fairing_profile?.form),
    fairing_cylinder_radius_mm: toFiniteNumber(
      fairing.fairing_cylinder_radius_mm,
      toFiniteNumber(cylinder.radius_mm, minRadius),
    ),
    fairing_cylinder_height_mm: toFiniteNumber(
      fairing.fairing_cylinder_height_mm,
      toFiniteNumber(cylinder.height_mm, minHeight),
    ),
    fairing_profile: profile,
    radial_segments: toFiniteNumber(fairing.radial_segments, 96),
    fairing_stored: Boolean(fairing.stored),
    fairing_updated_at: fairing.updated_at || null,
    limits,
  };
}

/**
 * 根据已保存的整流舱段参数恢复前端预览所需的几何摘要。
 * 该摘要只用于刷新后的画布与统计栏恢复，不重新构建或改写后端 STEP 构件。
 * @param {unknown} values `normalizePreConfig` 返回的整流舱段参数。
 * @returns {{ kind: string, radius_mm: number, height_mm: number, min_radius_mm: number, max_radius_mm: number, min_height_mm: number, max_height_mm: number, diameter_mm: number, axis_radius_mm: number, fairing_radius_mm: number, volume_mm3: number, axis: object }|null}
 *   已保存参数有效时返回几何摘要，否则返回空。
 */
export function restoreSavedFairingGeometry(values) {
  if (!values?.fairing_stored) return null;
  const minRadius = Number(values.min_radius_mm);
  const maxRadius = Number(values.max_radius_mm);
  const minHeight = Number(values.min_height_mm);
  const maxHeight = Number(values.max_height_mm);
  const centroidOffset = Number(values.centroid_max_offset_mm);
  const fairingRadius = Number(values.fairing_radius_mm);
  const profile = normalizeFairingProfile(values.fairing_profile, minRadius, minHeight);
  if (
    !Number.isFinite(minRadius) || minRadius <= 0
    || !Number.isFinite(maxRadius) || maxRadius < minRadius
    || !Number.isFinite(minHeight) || minHeight <= 0
    || !Number.isFinite(maxHeight) || maxHeight < minHeight
    || !Number.isFinite(centroidOffset) || centroidOffset <= 0 || centroidOffset >= minRadius
    || !Number.isFinite(fairingRadius) || fairingRadius <= maxRadius
    || fairingRadius < profile.max_radius_mm
  ) return null;
  const volume = profile.segments.reduce((sum, item) => {
    const segmentHeight = Number(item.height_mm) || 0;
    if (item.kind === 'cylinder') return sum + Math.PI * (Number(item.radius_mm) || 0) ** 2 * segmentHeight;
    const lower = Number(item.lower_radius_mm) || 0;
    const upper = Number(item.upper_radius_mm) || 0;
    return sum + Math.PI * segmentHeight * (lower ** 2 + lower * upper + upper ** 2) / 3;
  }, 0);
  return {
    kind: 'fairing_segment',
    radius_mm: minRadius,
    height_mm: minHeight,
    min_radius_mm: minRadius,
    min_height_mm: minHeight,
    max_height_mm: maxHeight,
    diameter_mm: minRadius * 2,
    axis_radius_mm: centroidOffset,
    centroid_max_offset_mm: centroidOffset,
    installation_tube: { min_radius_mm: minRadius, max_radius_mm: maxRadius, min_height_mm: minHeight,
      max_height_mm: maxHeight, centroid_max_offset_mm: centroidOffset,
      base: { lower_radius_mm: Number(values.base_lower_radius_mm), height_mm: Number(values.base_height_mm),
        min_upper_radius_mm: minRadius, max_upper_radius_mm: maxRadius } },
    fairing_radius_mm: fairingRadius,
    fairing_form: normalizeFairingForm(values.fairing_form || values.fairing_profile?.form),
    profile,
    fairing_profile: profile,
    total_height_mm: profile.total_height_mm,
    max_radius_mm: profile.max_radius_mm,
    volume_mm3: volume,
    axis: {
      origin: [0, 0, 0],
      direction: [0, 0, 1],
      radius_mm: centroidOffset,
    },
  };
}

/**
 * 校验整流罩形态与安装筒输入，直接生成后端请求；仅提交当前形态启用的锥段。
 * @param {object} values 表单草稿，长度单位为毫米。
 * @param {ReturnType<typeof normalizeLimits>} limits 后端给出的取值范围。
 * @returns {object} 含 installation_tube、形态、圆柱尺寸和启用锥段尺寸的 API 请求体。
 * @throws {Error} 尺寸、质心偏移为空、非有限、非正、超出范围或区间倒置时抛出。
 */
export function buildFairingSegmentPayload(values, limits) {
  const safeLimits = normalizeLimits(limits);
  const minRadius = parsePositiveInput(values?.min_radius_mm, '安装筒半径最小值');
  const maxRadius = parsePositiveInput(values?.max_radius_mm, '安装筒半径最大值');
  const minHeight = parsePositiveInput(values?.min_height_mm, '安装筒高度最小值');
  const maxHeight = parsePositiveInput(values?.max_height_mm, '安装筒高度最大值');
  if (minRadius < safeLimits.min_fairing_radius_mm || maxRadius > safeLimits.max_fairing_size_mm) {
    throw new Error(`安装筒半径区间必须在 ${safeLimits.min_fairing_radius_mm} 至 ${safeLimits.max_fairing_size_mm} 毫米之间`);
  }
  if (minHeight < safeLimits.min_fairing_height_mm || maxHeight > safeLimits.max_fairing_size_mm) {
    throw new Error(`安装筒高度区间必须在 ${safeLimits.min_fairing_height_mm} 至 ${safeLimits.max_fairing_size_mm} 毫米之间`);
  }
  if (minRadius > maxRadius) {
    throw new Error('安装筒半径最小值不得大于最大值');
  }
  if (minHeight > maxHeight) {
    throw new Error('安装筒高度最小值不得大于最大值');
  }
  const centroidOffset = parsePositiveInput(values?.centroid_max_offset_mm, '质心最大偏移');
  if (centroidOffset < safeLimits.min_centroid_offset_mm) {
    throw new Error(`质心最大偏移必须大于等于 ${safeLimits.min_centroid_offset_mm} 毫米`);
  }
  if (centroidOffset >= minRadius) {
    throw new Error('质心最大偏移必须小于安装筒半径最小值');
  }
  const fairingForm = normalizeFairingForm(values?.fairing_form);
  const payload = {
    installation_tube: { min_radius_mm: minRadius, max_radius_mm: maxRadius, min_height_mm: minHeight,
      max_height_mm: maxHeight, centroid_max_offset_mm: centroidOffset },
    fairing_form: fairingForm,
  };
  payload.installation_tube.base = {
    lower_radius_mm: parsePositiveInput(values?.base_lower_radius_mm, '基座下底面半径'),
    height_mm: parsePositiveInput(values?.base_height_mm, '基座高度'),
  };
  const fields = [
    ['fairing_cylinder_radius_mm', '整流罩圆柱段半径', safeLimits.min_fairing_radius_mm],
    ['fairing_cylinder_height_mm', '整流罩圆柱段高度', safeLimits.min_fairing_height_mm],
  ];
  if (fairingForm.startsWith('lower_cone')) {
    fields.push(['lower_cone_lower_radius_mm', '下锥段下底面半径', safeLimits.min_fairing_radius_mm],
      ['lower_cone_height_mm', '下锥段高度', safeLimits.min_fairing_height_mm]);
  }
  if (fairingForm.endsWith('upper_cone')) {
    fields.push(['upper_cone_upper_radius_mm', '上锥段上底面半径', safeLimits.min_fairing_radius_mm],
      ['upper_cone_height_mm', '上锥段高度', safeLimits.min_fairing_height_mm]);
  }
  for (const [field, label, minimum] of fields) {
    const value = parsePositiveInput(values?.[field], label);
    if (value < minimum || value > safeLimits.max_fairing_size_mm) {
      throw new Error(`${label}必须在 ${minimum} 至 ${safeLimits.max_fairing_size_mm} 毫米之间`);
    }
    payload[field] = value;
  }
  return payload;
}

/**
 * 校验某一类卫星的数量输入并返回可提交的整数。
 * @param {unknown} value 输入框中的原始文本。
 * @param {ReturnType<typeof normalizeLimits>} limits 后端给出的取值范围。
 * @returns {number} 可直接提交的整数数量。
 * @throws {Error} 输入为空、非整数或超出范围时抛出。
 */
export function buildSatelliteCountPayload(value, limits) {
  const safeLimits = normalizeLimits(limits);
  const text = value === '' || value === null || value === undefined ? '' : String(value).trim();
  if (!text || !/^-?\d+$/.test(text)) throw new Error('卫星数量必须是整数');
  const count = Number(text);
  if (!Number.isSafeInteger(count)) throw new Error('卫星数量超出可表示范围');
  if (count < safeLimits.min_satellite_count || count > safeLimits.max_satellite_count) {
    throw new Error(`卫星数量必须在 ${safeLimits.min_satellite_count} 至 ${safeLimits.max_satellite_count} 之间`);
  }
  return count;
}

/**
 * 读取当前可编辑字段，旧安装筒尺寸与中轴字段在此一次性转换，不恢复已删除的半径设置。
 * @returns {object|null} 字符串草稿；保留主动清空的输入，缺少的形态字段交由后台配置补齐。
 */
export function readFairingDraft() {
  try {
    const raw = window.sessionStorage.getItem(FAIRING_DRAFT_STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    const source = {
      ...parsed,
      min_radius_mm: parsed.min_radius_mm ?? parsed.radius_mm,
      max_radius_mm: parsed.max_radius_mm ?? parsed.radius_mm,
      min_height_mm: parsed.min_height_mm ?? parsed.height_mm,
      max_height_mm: parsed.max_height_mm ?? parsed.height_mm,
      centroid_max_offset_mm: parsed.centroid_max_offset_mm ?? parsed.axis_radius_mm,
      fairing_form: parsed.fairing_form ?? parsed.fairing_profile?.form,
    };
    const draft = Object.fromEntries(FAIRING_DRAFT_FIELDS
      .filter((field) => source[field] !== undefined && source[field] !== null)
      .map((field) => [field, field === 'fairing_form' ? normalizeFairingForm(source[field]) : String(source[field])]));
    return Object.keys(draft).length ? draft : null;
  } catch (error) {
    return null;
  }
}

/**
 * 仅写入当前可编辑字段，避免再次存入历史半径、旧中轴字段和重复轮廓；存储不可用时跳过。
 * @param {object} draft 当前表单草稿。
 */
export function writeFairingDraft(draft) {
  try {
    window.sessionStorage.setItem(FAIRING_DRAFT_STORAGE_KEY,
      JSON.stringify(Object.fromEntries(FAIRING_DRAFT_FIELDS.map((field) => [field, draft?.[field] ?? '']))));
  } catch (error) {
    // 浏览器禁用会话存储时仅在内存中保留草稿。
  }
}

/** 清除整流舱段会话草稿。 */
export function clearFairingDraft() {
  try {
    window.sessionStorage.removeItem(FAIRING_DRAFT_STORAGE_KEY);
  } catch (error) {
    // 存储不可用时无需处理。
  }
}

/** 把毫米尺寸格式化为带单位的紧凑文本。 */
export function formatMillimeters(value) {
  const formatted = formatParameterNumber(value, '--');
  return formatted === '--' ? formatted : `${formatted} mm`;
}

/** 把立方毫米体积格式化为 mm³ 或 m³ 文本。 */
export function formatVolume(value) {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) return '--';
  // 1 m³ = 1e9 mm³；超过 1e9 mm³ 时改用 m³，避免单行出现过长的数字。
  if (number >= 1e9) return `${formatParameterNumber(number / 1e9)} m³`;
  return `${formatParameterNumber(number)} mm³`;
}

/** 把 UTC ISO-8601 时间戳格式化为本地可读时间，无效输入返回占位符。 */
export function formatTimestamp(value) {
  if (!value) return '--';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '--';
  return date.toLocaleString('zh-CN', { hour12: false });
}

/** 把输入转换为有限数值，无效时返回回退值。 */
function toFiniteNumber(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

/** 把输入转换为有限正数值，非正或无效时返回回退值。 */
function toPositiveNumber(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : fallback;
}

/** 把表单文本转换为正的有限数值，非法输入抛出可展示错误。 */
function parsePositiveInput(value, label) {
  const text = value === '' || value === null || value === undefined ? '' : String(value).trim();
  if (!text) throw new Error(`${label}不能为空`);
  const number = Number(text);
  if (!Number.isFinite(number) || number <= 0) throw new Error(`${label}必须是正的有限数值`);
  return number;
}
