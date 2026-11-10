/** 文件说明：固定组临时草稿的本地持久化、丢弃和内容比较；只处理编辑参数，不向后端发布或缓存三维资源。 */
const STORAGE_KEY = 'sat-layout-opt:fixed-constraints-draft:v1';

/** 读取上次临时保存；损坏或浏览器禁止存储时返回空值，由页面继续读取正式配置。 */
export function readFixedDraft(storage) {
  try {
    storage ??= globalThis.localStorage;
    const value = JSON.parse(storage.getItem(STORAGE_KEY));
    return value && Array.isArray(value.groups) && Array.isArray(value.savedGroups) ? value : null;
  } catch { return null; }
}

/** 写入完整草稿和正式基线；失败抛出异常供界面提示，不能误报临时保存成功。 */
export function writeFixedDraft(value, storage = globalThis.localStorage) {
  storage.setItem(STORAGE_KEY, JSON.stringify(value));
}

/** 删除本地临时草稿；不写入正式配置，存储失败交由调用者提示。 */
export function clearFixedDraft(storage = globalThis.localStorage) {
  storage.removeItem(STORAGE_KEY);
}

/** 只替换指定固定组；新组追加，null 删除该组，其余组及顺序保持，用于独立发布和草稿合并。 */
export function replaceFixedGroup(groups, groupId, replacement) {
  const exists = groups.some((group) => group.group_id === groupId);
  const next = groups.flatMap((group) => group.group_id === groupId ? (replacement ? [replacement] : []) : [group]);
  return !exists && replacement ? [...next, replacement] : next;
}

/** 统一默认字段和字段顺序；忽略服务端参考尺寸及已移除的旧偏移范围，避免旧草稿误报变更。 */
export function fixedDraftSignature(groups, defaults = {}) {
  return JSON.stringify((groups || []).map((group) => Object.fromEntries(Object.entries({
    hard_constraint: true, auto_place: false, symmetry_mode: 'ring', attitude_quaternion: [0, 0, 0, 1], manual_suspension_mm: null,
    ...defaults, ...group,
  }).filter(([key]) => !key.startsWith('reference_')
    && !['soft_angle_deg', 'soft_height_mm', 'soft_suspension_mm'].includes(key))
    .sort(([left], [right]) => left.localeCompare(right)))));
}
