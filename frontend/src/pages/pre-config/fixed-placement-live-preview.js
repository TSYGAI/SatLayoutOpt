/**
 * 文件说明：按当前筒尺寸将交互输入映射到缓存安装位姿；保持相对悬高和完整镜像，正式业务由后端验收。
 * 不解析模型、不生成包络或计算其安全下限；正式校验与保存始终使用后端规则。
 * 本体、包络、安装点和已知真实质心共用增量矩阵，实时草稿明确标记为未验收；空间提示统一由 fixed-space-preview 处理。
 */
import { previewFixedRigidChanges } from './fixed-placement-rigid-preview.js';
import { mirrorFixedCandidate } from './fixed-placement-mirror-preview.js';

/** 返回世界Z旋转和平移后的三元点；direction 为true时忽略平移。 */
function transformPoint(point, cosine, sine, offset, direction = false) {
  if (!point) return point;
  return [cosine * point[0] - sine * point[1] + (direction ? 0 : offset[0]),
    sine * point[0] + cosine * point[1] + (direction ? 0 : offset[1]), point[2] + (direction ? 0 : offset[2])];
}

/** 对源模型矩阵左乘刚性增量，保留原有单位、比例与原点，不重复缩放模型。 */
function transformMatrix(matrix, cosine, sine, offset) {
  return [matrix[0].map((value, index) => cosine * value - sine * matrix[1][index] + (index === 3 ? offset[0] : 0)),
    matrix[1].map((value, index) => sine * matrix[0][index] + cosine * value + (index === 3 ? offset[1] : 0)),
    matrix[2].map((value, index) => value + (index === 3 ? offset[2] : 0)), [...matrix[3]]];
}

/**
 * 在类型、数量和安装面方向未改变时即时变换缓存实例，返回同一快照的位置和质量加权真实质心。
 * 安全下限直接采用后端 required_suspension_mm；模型或离散姿态改变则返回null等待后端。
 */
export function previewFixedGroupChanges(candidate, previousGroups, nextGroups, meshes) {
  if (!candidate || previousGroups.length !== nextGroups.length) return null;
  const previous = new Map(previousGroups.map((group) => [group.group_id, group]));
  const next = new Map(nextGroups.map((group) => [group.group_id, group]));
  for (const group of nextGroups) {
    const before = previous.get(group.group_id);
    if (!before || ['record_id', 'mount', 'copies', 'roll_quarters'].some((key) => before[key] !== group[key])
        || (before.symmetry_mode || 'ring') !== (group.symmetry_mode || 'ring')
        || ![group.angle_deg, group.height_mm, group.suspension_mm].every(Number.isFinite)) return null;
    const contact = candidate.placements.some((item) => item.fixed_group_id === group.group_id
      && item.suspension_reference === 'envelope_contact_normal');
    if (contact && group.manual_suspension_mm == null && (group.suspension_mm !== before.suspension_mm
      || before.manual_suspension_mm != null)) return null;
  }
  if (nextGroups.some((group) => JSON.stringify(previous.get(group.group_id).attitude_quaternion || [0, 0, 0, 1])
      !== JSON.stringify(group.attitude_quaternion || [0, 0, 0, 1]))) {
    return previewFixedRigidChanges(candidate, previousGroups, nextGroups, meshes);
  }
  const placements = candidate.placements.map((placement) => {
    const before = previous.get(placement.fixed_group_id), after = next.get(placement.fixed_group_id);
    if (!before || !after || placement.fixed_mirrored) return placement;
    const angle = after.mount === 'side' ? (after.angle_deg - before.angle_deg) * Math.PI / 180 : 0;
    const cosine = Math.cos(angle), sine = Math.sin(angle);
    // 这里只将输入夹到服务端已提供的可交互下界，不重新求安全包络留距。
    const contact = placement.suspension_reference === 'envelope_contact_normal';
    const suspension = after.manual_suspension_mm ?? (contact ? placement.radial_offset_mm
      : Math.max(after.suspension_mm, placement.required_suspension_mm));
    const radialChange = suspension - (contact ? placement.radial_offset_mm : placement.suspension_mm);
    const worldAngle = (placement.rotation_z_deg * Math.PI / 180) + angle;
    const offset = after.mount === 'side'
      ? [radialChange * Math.cos(worldAngle), radialChange * Math.sin(worldAngle), after.height_mm - before.height_mm]
      : [0, 0, radialChange];
    const matrix = transformMatrix(placement.model_to_global_matrix, cosine, sine, offset);
    const updated = { ...placement, model_to_global_matrix: matrix,
      rotation_z_deg: ((placement.rotation_z_deg + angle * 180 / Math.PI) % 360 + 360) % 360,
      suspension_lower_mm: after.suspension_mm, suspension_mm: contact ? placement.suspension_mm : suspension,
      ...(contact ? { radial_offset_mm: suspension, pose_reference_pending: true } : {}),
      body_bottom_mm: Number.isFinite(placement.body_bottom_mm) ? placement.body_bottom_mm + offset[2] : null,
      bottom_mm: placement.bottom_mm + offset[2], top_mm: placement.top_mm + offset[2] };
    for (const key of ['translation_mm', 'center_of_mass_mm', 'model_origin_global_mm', 'installation_face_center_mm', 'installation_point_mm']) {
      updated[key] = transformPoint(placement[key], cosine, sine, offset);
    }
    for (const key of ['installation_face_normal', 'up_direction_global']) updated[key] = transformPoint(placement[key], cosine, sine, offset, true);
    if (placement.orientation_matrix) updated.orientation_matrix = [
      placement.orientation_matrix[0].map((value, index) => cosine * value - sine * placement.orientation_matrix[1][index]),
      placement.orientation_matrix[1].map((value, index) => sine * placement.orientation_matrix[0][index] + cosine * value),
      [...placement.orientation_matrix[2]]];
    if (placement.footprint_mm) updated.footprint_mm = placement.footprint_mm.map((point) => transformPoint([...point, 0], cosine, sine, offset).slice(0, 2));
    return updated;
  });
  const mass = placements.reduce((sum, item) => sum + item.mass_kg, 0);
  const center = [0, 1, 2].map((axis) => mass ? placements.reduce((sum, item) => sum + item.mass_kg * item.center_of_mass_mm[axis], 0) / mass : 0);
  return mirrorFixedCandidate({ ...candidate, placements, validation_pending: true,
    validation: { ...candidate.validation, valid: false, violations: [], total_mass_kg: mass,
      center_of_mass_mm: center, radial_com_mm: Math.hypot(center[0], center[1]) } }, nextGroups);
}

/** 构造世界轴平移描述；即时位姿与异步正式校验共用该输入，拒绝旧旋转动作及非法步长。 */
export function makeFixedNudgeAction(kind, groupId, instanceId, axis, sign, step) {
  if (!groupId || !instanceId || !Number.isFinite(step) || step <= 0
      || kind !== 'translate' || !['x', 'y', 'z'].includes(axis) || ![-1, 1].includes(sign)) return null;
  return { kind, group_id: groupId, instance_id: instanceId, axis, delta: sign * step };
}
