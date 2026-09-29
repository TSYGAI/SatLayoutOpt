/**
 * 文件说明：数据管理页的数据层，封装固化记录的读取、选择、删除状态及含自由轴向的字段格式化。
 * 本模块只处理固化存储数据、展示格式与 sessionStorage 选择缓存，不包含三维渲染和页面结构。
 */

const RECORD_SELECTION_STORAGE_KEY = 'sat-layout-opt:data-management-selection:v1';

/** 读取本标签页上次查看的固化记录 ID；缓存不可用或为空时返回 null。 */
export function readStoredRecordSelection() {
  try {
    return window.sessionStorage.getItem(RECORD_SELECTION_STORAGE_KEY)?.trim() || null;
  } catch {
    return null;
  }
}

/** 缓存当前记录 ID；传入空值时清除缓存，存储失败不影响页面查看。 */
export function writeStoredRecordSelection(recordId) {
  try {
    if (recordId) window.sessionStorage.setItem(RECORD_SELECTION_STORAGE_KEY, recordId);
    else window.sessionStorage.removeItem(RECORD_SELECTION_STORAGE_KEY);
  } catch {
    // 隐私模式或存储配额限制下仍允许正常选择记录。
  }
}

/** 把 UTC ISO-8601 时间戳格式化为本地可读时间，无效输入返回占位符。 */
export function formatStoreTime(value) {
  if (!value) return '--';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '--';
  return date.toLocaleString('zh-CN', { hour12: false });
}

/** 把字节数格式化为带单位的可读体积。 */
export function formatByteSize(value) {
  const size = Number(value);
  if (!Number.isFinite(size) || size <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  let remaining = size;
  let index = 0;
  while (remaining >= 1024 && index < units.length - 1) {
    remaining /= 1024;
    index += 1;
  }
  const digits = index === 0 ? 0 : remaining >= 100 ? 0 : 1;
  return `${remaining.toFixed(digits)} ${units[index]}`;
}

/** 把包围范围压缩为单行摘要，缺少数据时返回占位符。 */
export function formatBounds(bounds) {
  if (!Array.isArray(bounds) || bounds.length !== 2) return '--';
  const minimum = Array.isArray(bounds[0]) ? bounds[0] : [];
  const maximum = Array.isArray(bounds[1]) ? bounds[1] : [];
  if (minimum.length !== 3 || maximum.length !== 3) return '--';
  const axis = ['X', 'Y', 'Z'];
  return axis
    .map((name, index) => `${name} ${Number(minimum[index]).toFixed(1)}~${Number(maximum[index]).toFixed(1)}`)
    .join('  ');
}

/** 把六向包络增量压缩为单行摘要。 */
export function formatSafetyClearance(settings) {
  const clearance = settings?.safety_clearance_mm;
  if (!clearance) return '--';
  const directions = [
    ['front', '前'],
    ['back', '后'],
    ['left', '左'],
    ['right', '右'],
    ['top', '上'],
    ['bottom', '下'],
  ];
  return directions
    .map(([key, label]) => `${label} ${Number(clearance[key] ?? 0).toLocaleString('zh-CN')}`)
    .join(' / ');
}

/** 把模型设置中的初始姿态压缩为单行摘要。 */
export function formatPose(settings) {
  if (!settings) return '--';
  const rotation = `Rx ${settings.rotation_x}° · Ry ${settings.rotation_y}° · Rz ${settings.rotation_z}°`;
  const scale = `比例 ${settings.model_scale} · 单位 ${settings.model_unit}`;
  return `${rotation} · ${scale} · 向上 ${settings.front_orientation === 'free' ? '自由' : settings.front_orientation}`;
}

/** 把记录列表整理为可直接渲染的条目，只保留列表需要的字段。 */
export function toStoredListItems(records) {
  if (!Array.isArray(records)) return [];
  return records.map((record) => ({
    recordId: record.record_id,
    deviceName: record.device_name,
    sourceFilename: record.source.filename,
    createdAt: record.created_at,
    createdAtText: formatStoreTime(record.created_at),
    sourceSizeText: formatByteSize(record.source.size),
    variantCount: record.envelope.variant_count,
    state: record.envelope.state,
  }));
}

/** 把一条完整固化记录整理为详情面板的结构。 */
export function toStoredDetail(record) {
  if (!record) return null;
  const settings = record.settings || {};
  return {
    recordId: record.record_id,
    deviceName: record.device_name,
    createdAtText: formatStoreTime(record.created_at),
    source: {
      filename: record.source.filename,
      format: record.source.format,
      sizeText: formatByteSize(record.source.size),
      sha256: record.source.sha256,
    },
    settings: {
      mass: settings.mass === null || settings.mass === undefined ? '未设置' : settings.mass,
      pose: formatPose(settings),
      safetyClearance: formatSafetyClearance(settings),
      installationFace: settings.installation_face_id || '未选择',
      centerOfMass: settings.center_of_mass
        ? `X ${settings.center_of_mass.x} · Y ${settings.center_of_mass.y} · Z ${settings.center_of_mass.z}`
        : '未设置',
    },
    envelope: {
      state: record.envelope.state,
      algorithm: record.envelope.algorithm || '--',
      generatedAtText: formatStoreTime(record.envelope.generated_at),
      variantCount: record.envelope.variant_count,
      meshSha256: record.envelope.mesh_sha256 || '--',
      previewUrl: record.envelope.preview_url,
      variants: (record.envelope.variants || []).map((variant) => ({
        rotZ: variant.rot_z,
        sizeText: formatByteSize(variant.size),
        triangleText: `${Number(variant.vertex_count).toLocaleString('zh-CN')} 顶点 / ${Number(variant.face_count).toLocaleString('zh-CN')} 面`,
        watertight: Boolean(variant.watertight),
        boundsText: formatBounds(variant.bounds),
        downloadUrl: variant.download_url,
      })),
    },
  };
}
