/**
 * 文件说明：前置配置页的数据层，定义按类型区分的卫星数量、整流舱段参数的规范化、校验与展示格式，
 * 并管理用于刷新后恢复未保存输入的会话草稿。
 * 本模块只读写 `sessionStorage` 与纯数据；后端仍是参数校验和几何构建的最终权威。
 */

export const SATELLITE_COUNT_EVENT = 'sat-layout-pre-config-satellite-count';

/** 整流舱段参数会话草稿的存储键，用于刷新后恢复当前状态。 */
export const FAIRING_DRAFT_STORAGE_KEY = 'sat-layout-pre-config-fairing-draft';

const FALLBACK_LIMITS = Object.freeze({
  min_satellite_count: 0,
  max_satellite_count: 1000,
  min_fairing_radius_mm: 0.001,
  min_fairing_height_mm: 0.001,
  max_fairing_size_mm: 1000000,
  min_axis_radius_mm: 0.001,
  min_fairing_shell_radius_mm: 0.001,
});
/** 卫星类型列表的空值，供页面在加载前使用。 */
export const EMPTY_SATELLITES = Object.freeze([]);

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
    min_axis_radius_mm: toPositiveNumber(source.min_axis_radius_mm, FALLBACK_LIMITS.min_axis_radius_mm),
    min_fairing_shell_radius_mm: toPositiveNumber(
      source.min_fairing_shell_radius_mm,
      FALLBACK_LIMITS.min_fairing_shell_radius_mm,
    ),
  };
}

/**
 * 把数据管理页的固化记录整理为卫星类型清单，数量默认 0。
 * @param {unknown} satellites 后端返回的卫星类型数组。
 * @returns {Array<{ recordId: string, deviceName: string, count: number, updatedAt: string|null }>} 卫星类型清单。
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
    }));
}

/** 把后台配置响应整理为表单可直接使用的整流舱段区间参数，并兼容旧版单值字段。 */
export function normalizePreConfig(config) {
  const source = config && typeof config === 'object' ? config : {};
  const fairing = source.fairing_segment || {};
  const limits = normalizeLimits(source.limits);
  const legacyRadius = toFiniteNumber(fairing.radius_mm, 0);
  const legacyHeight = toFiniteNumber(fairing.height_mm, 0);
  const minRadius = toFiniteNumber(fairing.min_radius_mm, legacyRadius);
  const legacyClearance = toFiniteNumber(fairing.radial_clearance_mm, 0);
  return {
    satellites: normalizeSatellites(source.satellites),
    min_radius_mm: minRadius,
    max_radius_mm: toFiniteNumber(fairing.max_radius_mm, legacyRadius),
    min_height_mm: toFiniteNumber(fairing.min_height_mm, legacyHeight),
    max_height_mm: toFiniteNumber(fairing.max_height_mm, legacyHeight),
    axis_radius_mm: toFiniteNumber(fairing.axis_radius_mm, 0),
    fairing_radius_mm: toFiniteNumber(fairing.fairing_radius_mm, minRadius + legacyClearance),
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
  const axisRadius = Number(values.axis_radius_mm);
  const fairingRadius = Number(values.fairing_radius_mm);
  if (
    !Number.isFinite(minRadius) || minRadius <= 0
    || !Number.isFinite(maxRadius) || maxRadius < minRadius
    || !Number.isFinite(minHeight) || minHeight <= 0
    || !Number.isFinite(maxHeight) || maxHeight < minHeight
    || !Number.isFinite(axisRadius) || axisRadius <= 0 || axisRadius >= minRadius
    || !Number.isFinite(fairingRadius) || fairingRadius <= maxRadius
  ) return null;
  return {
    kind: 'fairing_segment',
    radius_mm: minRadius,
    height_mm: minHeight,
    min_radius_mm: minRadius,
    max_radius_mm: maxRadius,
    min_height_mm: minHeight,
    max_height_mm: maxHeight,
    diameter_mm: minRadius * 2,
    axis_radius_mm: axisRadius,
    fairing_radius_mm: fairingRadius,
    volume_mm3: Math.PI * minRadius * minRadius * minHeight,
    axis: {
      origin: [0, 0, 0],
      direction: [0, 0, 1],
      radius_mm: axisRadius,
    },
  };
}

/**
 * 校验整流舱段表单并转换为后端请求需要的数值。
 * @param {{ min_radius_mm: unknown, max_radius_mm: unknown, min_height_mm: unknown, max_height_mm: unknown, axis_radius_mm?: unknown, fairing_radius_mm?: unknown }} values 表单草稿，长度单位为毫米。
 * @param {ReturnType<typeof normalizeLimits>} limits 后端给出的取值范围。
 * @returns {{ minRadiusMm: number, maxRadiusMm: number, minHeightMm: number, maxHeightMm: number, axisRadiusMm: number, fairingRadiusMm: number }} 可直接提交的尺寸区间、中轴半径与整流罩半径。
 * @throws {Error} 尺寸、中轴半径或整流罩半径为空、非有限、非正或超出范围时抛出。
 */
export function buildFairingSegmentPayload(values, limits) {
  const safeLimits = normalizeLimits(limits);
  const minRadius = parsePositiveInput(values?.min_radius_mm, '整流舱段底面半径最小值');
  const maxRadius = parsePositiveInput(values?.max_radius_mm, '整流舱段底面半径最大值');
  const minHeight = parsePositiveInput(values?.min_height_mm, '整流舱段高度最小值');
  const maxHeight = parsePositiveInput(values?.max_height_mm, '整流舱段高度最大值');
  if (minRadius < safeLimits.min_fairing_radius_mm || maxRadius > safeLimits.max_fairing_size_mm) {
    throw new Error(`整流舱段底面半径区间必须在 ${safeLimits.min_fairing_radius_mm} 至 ${safeLimits.max_fairing_size_mm} 毫米之间`);
  }
  if (minHeight < safeLimits.min_fairing_height_mm || maxHeight > safeLimits.max_fairing_size_mm) {
    throw new Error(`整流舱段高度区间必须在 ${safeLimits.min_fairing_height_mm} 至 ${safeLimits.max_fairing_size_mm} 毫米之间`);
  }
  if (minRadius > maxRadius) {
    throw new Error('整流舱段底面半径最小值不得大于最大值');
  }
  if (minHeight > maxHeight) {
    throw new Error('整流舱段高度最小值不得大于最大值');
  }
  const axisRadius = parsePositiveInput(values?.axis_radius_mm, '中轴半径');
  if (axisRadius < safeLimits.min_axis_radius_mm) {
    throw new Error(`中轴半径必须大于等于 ${safeLimits.min_axis_radius_mm} 毫米`);
  }
  if (axisRadius >= minRadius) {
    throw new Error('中轴半径必须小于整流舱段底面半径最小值');
  }
  const fairingRadius = parsePositiveInput(values?.fairing_radius_mm, '整流罩半径');
  if (
    fairingRadius < safeLimits.min_fairing_shell_radius_mm
    || fairingRadius > safeLimits.max_fairing_size_mm
  ) {
    throw new Error(
      `整流罩半径必须在 ${safeLimits.min_fairing_shell_radius_mm} 至 ${safeLimits.max_fairing_size_mm} 毫米之间`,
    );
  }
  if (fairingRadius <= maxRadius) throw new Error('整流罩半径必须大于整流舱段底面半径最大值');
  return {
    minRadiusMm: minRadius,
    maxRadiusMm: maxRadius,
    minHeightMm: minHeight,
    maxHeightMm: maxHeight,
    axisRadiusMm: axisRadius,
    fairingRadiusMm: fairingRadius,
  };
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
 * 比较整流舱段表单草稿与后端参数是否一致。
 * @param {{ min_radius_mm: unknown, max_radius_mm: unknown, min_height_mm: unknown, max_height_mm: unknown, axis_radius_mm?: unknown, fairing_radius_mm?: unknown }} draft 表单草稿。
 * @param {{ min_radius_mm: number, max_radius_mm: number, min_height_mm: number, max_height_mm: number, axis_radius_mm: number, fairing_radius_mm: number } | null} saved 后端已保存参数。
 * @returns {boolean} 尺寸区间、中轴半径与整流罩半径都一致时为 true。
 */
export function isFairingSegmentDraftSaved(draft, saved) {
  if (!saved) return false;
  const minRadius = Number(draft?.min_radius_mm);
  const maxRadius = Number(draft?.max_radius_mm);
  const minHeight = Number(draft?.min_height_mm);
  const maxHeight = Number(draft?.max_height_mm);
  const axisRadius = Number(draft?.axis_radius_mm);
  const fairingRadius = Number(draft?.fairing_radius_mm);
  return Number.isFinite(minRadius) && Number.isFinite(maxRadius)
    && Number.isFinite(minHeight) && Number.isFinite(maxHeight)
    && Number.isFinite(axisRadius) && Number.isFinite(fairingRadius)
    && draft?.fairing_radius_mm !== '' && draft?.fairing_radius_mm !== null
    && draft?.fairing_radius_mm !== undefined
    && minRadius === Number(saved.min_radius_mm)
    && maxRadius === Number(saved.max_radius_mm)
    && minHeight === Number(saved.min_height_mm)
    && maxHeight === Number(saved.max_height_mm)
    && axisRadius === Number(saved.axis_radius_mm)
    && fairingRadius === Number(saved.fairing_radius_mm);
}

/**
 * 读取整流舱段会话草稿，刷新页面后用于恢复未保存的输入。
 * @returns {{ min_radius_mm: string, max_radius_mm: string, min_height_mm: string, max_height_mm: string, axis_radius_mm: string, fairing_radius_mm?: string } | null} 合法草稿，缺失或损坏时返回空；旧尺寸和净距草稿会转换为当前字段。
 */
export function readFairingDraft() {
  try {
    const raw = window.sessionStorage.getItem(FAIRING_DRAFT_STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return null;
    const legacyRadius = parsed.radius_mm === undefined || parsed.radius_mm === null ? '' : String(parsed.radius_mm);
    const legacyHeight = parsed.height_mm === undefined || parsed.height_mm === null ? '' : String(parsed.height_mm);
    const minRadius = parsed.min_radius_mm === undefined || parsed.min_radius_mm === null
      ? legacyRadius : String(parsed.min_radius_mm);
    const maxRadius = parsed.max_radius_mm === undefined || parsed.max_radius_mm === null
      ? legacyRadius : String(parsed.max_radius_mm);
    const minHeight = parsed.min_height_mm === undefined || parsed.min_height_mm === null
      ? legacyHeight : String(parsed.min_height_mm);
    const maxHeight = parsed.max_height_mm === undefined || parsed.max_height_mm === null
      ? legacyHeight : String(parsed.max_height_mm);
    const axisRadius = parsed.axis_radius_mm === undefined || parsed.axis_radius_mm === null
      ? '' : String(parsed.axis_radius_mm);
    const hasFairingRadius = Object.prototype.hasOwnProperty.call(parsed, 'fairing_radius_mm');
    const legacyClearance = Number(parsed.radial_clearance_mm);
    const legacyMinRadius = Number(minRadius);
    const fairingRadius = hasFairingRadius && parsed.fairing_radius_mm !== null
      ? String(parsed.fairing_radius_mm ?? '')
      : Number.isFinite(legacyClearance) && legacyClearance > 0 && Number.isFinite(legacyMinRadius)
        ? String(legacyMinRadius + legacyClearance)
        : undefined;
    if (!minRadius && !maxRadius && !minHeight && !maxHeight && !axisRadius && !fairingRadius) return null;
    return {
      min_radius_mm: minRadius,
      max_radius_mm: maxRadius,
      min_height_mm: minHeight,
      max_height_mm: maxHeight,
      axis_radius_mm: axisRadius,
      ...(fairingRadius !== undefined ? { fairing_radius_mm: fairingRadius } : {}),
    };
  } catch (error) {
    return null;
  }
}

/**
 * 写入整流舱段会话草稿；存储不可用时静默跳过，不影响页面使用。
 * @param {{ min_radius_mm: unknown, max_radius_mm: unknown, min_height_mm: unknown, max_height_mm: unknown, axis_radius_mm: unknown, fairing_radius_mm: unknown }} draft 当前表单草稿。
 */
export function writeFairingDraft(draft) {
  try {
    window.sessionStorage.setItem(FAIRING_DRAFT_STORAGE_KEY, JSON.stringify({
      min_radius_mm: draft?.min_radius_mm ?? '',
      max_radius_mm: draft?.max_radius_mm ?? '',
      min_height_mm: draft?.min_height_mm ?? '',
      max_height_mm: draft?.max_height_mm ?? '',
      axis_radius_mm: draft?.axis_radius_mm ?? '',
      fairing_radius_mm: draft?.fairing_radius_mm ?? '',
    }));
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
  const number = Number(value);
  if (!Number.isFinite(number)) return '--';
  const digits = number >= 1000 ? 0 : number >= 10 ? 2 : 4;
  return `${number.toFixed(digits)} mm`;
}

/** 把立方毫米体积格式化为 mm³ 或 m³ 文本。 */
export function formatVolume(value) {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) return '--';
  // 1 m³ = 1e9 mm³；超过 1e9 mm³ 时改用 m³，避免单行出现过长的数字。
  if (number >= 1e9) return `${(number / 1e9).toFixed(4)} m³`;
  const digits = number >= 1000 ? 0 : 2;
  return `${number.toFixed(digits)} mm³`;
}

/** 把字节数格式化为带单位的可读体积。 */
export function formatByteSize(value) {
  const size = Number(value);
  if (!Number.isFinite(size) || size <= 0) return '--';
  const units = ['B', 'KB', 'MB', 'GB'];
  let remaining = size;
  let index = 0;
  while (remaining >= 1024 && index < units.length - 1) {
    remaining /= 1024;
    index += 1;
  }
  return `${remaining.toFixed(index === 0 ? 0 : 1)} ${units[index]}`;
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
