/**
 * 文件说明：管理布局左栏可编辑选项、任务状态标签、会话草稿和历史恢复；前置/模型参数保持只读。
 * 搜索参数从服务端默认值初始化并允许任务独立修改；草稿保留用户输入，历史保留实际快照。
 */

export const LAYOUT_FORM_DRAFT_STORAGE_KEY = 'sat-layout-opt:layout-form-draft:v1';
const SEARCH_PARAMETER_KEYS = ['radius_step_mm', 'hybrid_attempt_budget', 'alns_budget_fraction', 'hybrid_radius_samples', 'cp_partition_limit', 'candidate_limit'];

export const GEOMETRY_FIELDS = [
  ['min_radius_mm', '安装筒半径最小值 (mm)'], ['max_radius_mm', '安装筒半径最大值 (mm)'],
  ['min_height_mm', '安装筒高度最小值 (mm)'], ['max_height_mm', '安装筒高度最大值 (mm)'],
  ['axis_radius_mm', '质心最大偏移 (mm)'], ['fairing_radius_mm', '整流罩半径 (mm)'],
];
export const JOB_LABELS = { queued: '正在校验数据', running: '正在优化', cancelling: '正在取消', cancelled: '已取消',
  completed: '布局已验收', infeasible: '未找到可行布局', failed: '任务失败', interrupted: '服务重启中断' };

/** 判断任务是否仍占用计算资源，用于按钮和无截止时间轮询。 */
export function isLayoutRunning(job) { return ['queued', 'running', 'cancelling'].includes(job?.status); }

/** 判断普通导航是否可继续显示会话方案；显式历史链接总是保留，配置已改变时先显示当前保存的固定星。 */
export function canRestoreLayoutSession(job, config, projectId = null) {
  if (projectId || !job) return true;
  const fingerprint = job.locked_config?.config_fingerprint || job.options?.config_fingerprint;
  return !fingerprint || fingerprint === config.config_fingerprint;
}

/** 返回可恢复的数字输入；损坏或异常长的会话值回退到服务端默认值。 */
function restoreNumberInput(value, fallback) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : fallback;
  return typeof value === 'string' && value.length <= 64 ? value : fallback;
}

/** 合并任务参数草稿；未设置的搜索选项读取服务端默认值，始终使用当前配置指纹。 */
export function createLayoutForm(config, draft = null) {
  const fixedTop = config.fixed_groups?.find((group) => group.mount === 'top' && group.hard_constraint !== false);
  const eligibleTopIds = new Set((config.satellites ?? [])
    .filter((item) => Number(item.count) > 0)
    .map((item) => item.record_id));
  const topRecordId = typeof draft?.top_record_id === 'string' && eligibleTopIds.has(draft.top_record_id)
    ? draft.top_record_id : null;
  return {
    min_suspension_mm: restoreNumberInput(draft?.min_suspension_mm, config.defaults.min_suspension_mm),
    max_suspension_mm: restoreNumberInput(draft?.max_suspension_mm, config.defaults.max_suspension_mm),
    ...Object.fromEntries(SEARCH_PARAMETER_KEYS.map((key) => [key, restoreNumberInput(draft?.[key], config.defaults[key] ?? null)])),
    top_enabled: Boolean(fixedTop) || draft?.top_enabled === true,
    top_record_id: fixedTop?.record_id ?? topRecordId,
    notes: typeof draft?.notes === 'string' ? draft.notes.slice(0, 4000) : '',
    config_fingerprint: config.config_fingerprint,
  };
}

/** 恢复历史任务选项；旧记录缺少可编辑参数时保留未知值，避免把现行默认值冒充历史输入。 */
export function restoreTaskForm(config, options) {
  return { ...createLayoutForm(config), ...(options ?? {}),
    ...Object.fromEntries(SEARCH_PARAMETER_KEYS.map((key) => [key, options?.[key] ?? null])) };
}

/** 从当前标签页读取布局输入草稿；存储缺失、损坏或不可用时返回空。 */
export function readLayoutFormDraft() {
  try {
    const raw = window.sessionStorage.getItem(LAYOUT_FORM_DRAFT_STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/** 保存用户可编辑的布局输入；不保存配置指纹或任何锁定物理参数。 */
export function writeLayoutFormDraft(form) {
  if (!form) return;
  try {
    window.sessionStorage.setItem(LAYOUT_FORM_DRAFT_STORAGE_KEY, JSON.stringify({
      min_suspension_mm: form.min_suspension_mm,
      max_suspension_mm: form.max_suspension_mm,
      ...Object.fromEntries(SEARCH_PARAMETER_KEYS.map((key) => [key, form[key]])),
      top_enabled: form.top_enabled === true,
      top_record_id: form.top_record_id ?? null,
      notes: form.notes ?? '',
    }));
  } catch {
    // 隐私模式、禁用存储或配额不足时只保留当前组件内存状态。
  }
}

/** 将数字输入转为有限数值；拒绝空白、非法类型或无穷大，不将空值误当作零。 */
function numberInput(value, label) {
  if (value == null || !['string', 'number'].includes(typeof value) || String(value).trim() === '') throw new Error(`请填写${label}`);
  const number = Number(value);
  if (!Number.isFinite(number)) throw new Error(`${label}必须为有效数字`);
  return number;
}

/** 序列化任务独立参数并检查输入类型；不发送尺寸、质量、质心、安装面或数量。 */
export function buildLayoutPayload(form) {
  const minimum = numberInput(form.min_suspension_mm, '卫星悬高最小值');
  const maximum = numberInput(form.max_suspension_mm, '卫星悬高最大值');
  const step = numberInput(form.radius_step_mm, '半径步长');
  if (step <= 0) throw new Error('半径步长必须大于0');
  const budget = numberInput(form.hybrid_attempt_budget, '总尝试次数');
  if (!Number.isSafeInteger(budget) || budget < 1) throw new Error('总尝试次数必须为正整数');
  const fraction = numberInput(form.alns_budget_fraction, '自适应搜索预算比例');
  if (fraction < 0 || fraction >= 1) throw new Error('自适应搜索预算比例必须大于等于0且小于1');
  const samples = numberInput(form.hybrid_radius_samples, '半径采样点数');
  if (!Number.isSafeInteger(samples) || samples < 1) throw new Error('半径采样点数必须为正整数');
  const partitions = numberInput(form.cp_partition_limit, '初始分组方案上限');
  if (!Number.isSafeInteger(partitions) || partitions < 1) throw new Error('初始分组方案上限必须为正整数');
  const limit = numberInput(form.candidate_limit, '展示方案数量');
  if (!Number.isSafeInteger(limit) || limit < 1) throw new Error('展示方案数量必须为正整数');
  if (form.top_enabled && !form.top_record_id) throw new Error('请明确指定顶部卫星');
  return { min_suspension_mm: minimum, max_suspension_mm: maximum, radius_step_mm: step,
    hybrid_attempt_budget: budget, alns_budget_fraction: fraction, hybrid_radius_samples: samples,
    cp_partition_limit: partitions, candidate_limit: limit,
    top_enabled: form.top_enabled, top_record_id: form.top_enabled ? form.top_record_id : null,
    notes: form.notes, config_fingerprint: form.config_fingerprint };
}
