/** 文件说明：汇总固化操作前的表单缺项并给出字段级提示；只检查当前草稿和已知包络状态，正式资源与存储准入由后端复核。 */
import { areModelEnvelopeSettingsEqual } from './model-settings-state.js';

/** 区分未填写与有效零值，供质量和质心输入检查使用。 */
function empty(value) {
  return value === null || value === undefined || (typeof value === 'string' && value.trim() === '');
}

/** 返回全部待补充项；质心逐轴检查，未保存的包络几何改动不能使用旧包络存储。 */
export function getModelStorageIssues(settings, envelope, savedSettings) {
  const issues = [];
  if (envelope?.state !== 'ready' || (savedSettings && !areModelEnvelopeSettingsEqual(settings, savedSettings))) {
    issues.push('包络：尚未生成或已失效，请先生成包络');
  }
  if (empty(settings?.installation_face_id)) issues.push('安装面：未选择，请选择安装面');
  const missingAxes = ['x', 'y', 'z'].filter((axis) => empty(settings?.center_of_mass?.[axis]));
  if (missingAxes.length) issues.push(`质心：${missingAxes.map((axis) => axis.toUpperCase()).join('、')} 坐标未填写`);
  if (empty(settings?.mass)) issues.push('质量：未填写');
  return issues;
}
