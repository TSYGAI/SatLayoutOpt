/**
 * 文件说明：管理布局左栏可编辑选项、会话草稿和提交数据；前置/模型参数保持只读。
 * 草稿只保存用户输入，配置指纹始终使用页面重新进入时从服务端读取的最新值。
 */

export const LAYOUT_FORM_DRAFT_STORAGE_KEY = 'sat-layout-opt:layout-form-draft:v1';

export const GEOMETRY_FIELDS = [
  ['min_radius_mm', '安装筒半径最小值 / mm'], ['max_radius_mm', '安装筒半径最大值 / mm'],
  ['min_height_mm', '直筒高度最小值 / mm'], ['max_height_mm', '直筒高度最大值 / mm'],
  ['axis_radius_mm', '中轴半径 / mm'], ['fairing_radius_mm', '整流罩半径 / mm'],
];
export const JOB_LABELS = { queued: '准备计算', running: '正在优化', cancelling: '正在取消', cancelled: '已取消',
  completed: '5 组布局已验收', infeasible: '输入不可行', failed: '任务失败', interrupted: '服务重启中断' };

/** 判断任务是否仍占用计算资源，用于按钮和无截止时间轮询。 */
export function isLayoutRunning(job) { return ['queued', 'running', 'cancelling'].includes(job?.status); }

/** 返回可恢复的数字输入；损坏或异常长的会话值回退到服务端默认值。 */
function restoreNumberInput(value, fallback) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : fallback;
  return typeof value === 'string' && value.length <= 64 ? value : fallback;
}

/** 初始化用户明确允许填写的选项，并合并结构合法且仍适用于当前卫星清单的会话草稿。 */
export function createLayoutForm(config, draft = null) {
  const eligibleTopIds = new Set((config.satellites ?? [])
    .filter((item) => Number(item.count) > 0)
    .map((item) => item.record_id));
  const topRecordId = typeof draft?.top_record_id === 'string' && eligibleTopIds.has(draft.top_record_id)
    ? draft.top_record_id : null;
  return {
    min_suspension_mm: restoreNumberInput(draft?.min_suspension_mm, config.defaults.min_suspension_mm),
    max_suspension_mm: restoreNumberInput(draft?.max_suspension_mm, config.defaults.max_suspension_mm),
    radius_step_mm: restoreNumberInput(draft?.radius_step_mm, config.defaults.radius_step_mm ?? 1),
    top_enabled: draft?.top_enabled === true,
    top_record_id: topRecordId,
    notes: typeof draft?.notes === 'string' ? draft.notes.slice(0, 4000) : '',
    config_fingerprint: config.config_fingerprint,
  };
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
      radius_step_mm: form.radius_step_mm,
      top_enabled: form.top_enabled === true,
      top_record_id: form.top_record_id ?? null,
      notes: form.notes ?? '',
    }));
  } catch {
    // 隐私模式、禁用存储或配额不足时只保留当前组件内存状态。
  }
}

/** 序列化允许修改的选项；不发送尺寸、质量、质心、安装面或数量。 */
export function buildLayoutPayload(form) {
  if (form.min_suspension_mm === '' || form.max_suspension_mm === '' || form.radius_step_mm === '') throw new Error('请填写悬高范围和半径步长');
  if (form.top_enabled && !form.top_record_id) throw new Error('请明确指定顶部卫星');
  return { min_suspension_mm: Number(form.min_suspension_mm), max_suspension_mm: Number(form.max_suspension_mm),
    radius_step_mm: Number(form.radius_step_mm),
    top_enabled: form.top_enabled, top_record_id: form.top_enabled ? form.top_record_id : null,
    notes: form.notes, config_fingerprint: form.config_fingerprint };
}
