/** 文件说明：把选中实例的绝对世界位置映射为固定组参数；只处理平移并保持已有朝向，几何可行性由后端验收。 */
import { Quaternion, Vector3 } from 'three';
import { fixedMirrorSigns } from './fixed-placement-mirror-preview.js';

/** 构造角度制环向安装框的单位四元数，不修改传入的组或显示快照。 */
function carrier(degrees) {
  return new Quaternion().setFromAxisAngle(new Vector3(0, 0, 1), degrees * Math.PI / 180);
}

/** 将绝对世界安装点投影回所选组；拒绝姿态输入，保留镜像关系和顶部居中规则。 */
export function fixedWorldPoseGroups(candidate, groups, instanceId, changes) {
  const selected = candidate?.placements.find((item) => item.instance_id === instanceId);
  const group = groups.find((item) => item.group_id === selected?.fixed_group_id);
  if (!selected || !group || !changes.position_mm || Object.hasOwn(changes, 'attitude_angles_deg')) return null;
  const point = changes.position_mm;
  if (!Array.isArray(point) || point.length !== 3 || !point.every(Number.isFinite)) return null;
  if (group.mount === 'top' && point.slice(0, 2).some((value, axis) => value !== selected.installation_point_mm[axis])) return null;
  const primary = selected.fixed_mirrored
    ? candidate.placements.find((item) => item.fixed_group_id === group.group_id && !item.fixed_mirrored) : selected;
  const signs = selected.fixed_mirrored ? fixedMirrorSigns(group.symmetry_mode) : [1, 1, 1];
  const target = new Vector3().fromArray(point.map((value, axis) => value * signs[axis]));
  const oldPhase = primary.rotation_z_deg;
  const newPhase = group.mount === 'side' ? Math.atan2(target.y, target.x) * 180 / Math.PI : oldPhase;
  const attitude = carrier(newPhase).invert().multiply(carrier(oldPhase))
    .multiply(new Quaternion().fromArray(group.attitude_quaternion || [0, 0, 0, 1])).normalize();
  const baseHeight = candidate.installation_base.height_mm;
  const actual = group.mount === 'side' ? Math.hypot(target.x, target.y) - candidate.radius_mm : target.z - baseHeight - candidate.height_mm;
  if (!Number.isFinite(actual) || !attitude.toArray().every(Number.isFinite)) return null;
  const update = { attitude_quaternion: attitude.toArray(), manual_suspension_mm: actual,
    suspension_mm: selected.suspension_reference === 'envelope_contact_normal' ? group.suspension_mm : Math.max(0, actual),
    reference_radius_mm: candidate.radius_mm, reference_height_mm: candidate.height_mm,
    ...(group.mount === 'side' ? { angle_deg: ((group.angle_deg + newPhase - oldPhase) % 360 + 360) % 360, height_mm: target.z - baseHeight } : {}) };
  return groups.map((item) => item === group ? { ...item, ...update } : item);
}
