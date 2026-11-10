/** 文件说明：提供模型坐标原点和卫星质心两种世界位置基准；将单轴输入换算为内部安装位移，不开放安装点编辑或改变姿态。 */

export const FIXED_POSE_REFERENCES = [
  { value: 'model-origin', label: '卫星模型坐标原点', field: 'model_origin_global_mm' },
  { value: 'center-of-mass', label: '卫星质心', field: 'center_of_mass_mm' },
];

/** 返回所选基准的世界毫米坐标副本；未知基准或缺失数据返回 null，避免误用其它点的位置。 */
export function fixedPoseReferencePoint(placement, reference = 'center-of-mass') {
  const field = FIXED_POSE_REFERENCES.find((item) => item.value === reference)?.field;
  const point = field && placement?.[field];
  return Array.isArray(point) && point.length === 3 && point.every(Number.isFinite) ? [...point] : null;
}

/** 将原点或质心的单轴输入换算为内部安装位移；安装点仅作为转换基准，未知选项或非法数据返回 null。 */
export function fixedPosePositionChange(placement, { reference = 'center-of-mass', axis, value }) {
  const point = fixedPoseReferencePoint(placement, reference);
  const anchor = placement?.installation_point_mm;
  if (!point || !Array.isArray(anchor) || anchor.length !== 3 || !anchor.every(Number.isFinite)
      || !Number.isInteger(axis) || axis < 0 || axis > 2 || !Number.isFinite(value)) return null;
  const installation = [...anchor];
  installation[axis] += value - point[axis];
  return installation.every(Number.isFinite) ? installation : null;
}
