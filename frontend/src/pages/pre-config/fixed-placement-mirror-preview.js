/** 文件说明：固定组的世界平面镜像显示及副本点击映射；所有源矩阵、安装基准和真实质心一起反射，不在客户端计算碰撞或安全留距。 */

/** 返回镜像平面的三轴符号；环向模式无反射，模式由接口契约校验。 */
export function fixedMirrorSigns(mode) {
  return mode === 'mirror_xoz' ? [1, -1, 1] : mode === 'mirror_yoz' ? [-1, 1, 1] : null;
}

/** 将镜像副本的世界平移映射到基准实例；安装面旋转由独立控件计算。 */
export function canonicalMirrorNudge(candidate, group, placement, action) {
  if (!placement?.fixed_mirrored) return { placement, action };
  const primary = candidate.placements.find((item) => item.fixed_group_id === group.group_id && !item.fixed_mirrored);
  const sign = fixedMirrorSigns(group.symmetry_mode)['xyz'.indexOf(action.axis)];
  return { placement: primary, action: { ...action, instance_id: primary.instance_id, delta: sign * action.delta } };
}

/** 基准即时变换后完整反射对应副本，保持其数量身份与违规快照；重新计算包含全部质量的真实质心。 */
export function mirrorFixedCandidate(candidate, groups) {
  const modes = new Map(groups.map((group) => [group.group_id, fixedMirrorSigns(group.symmetry_mode)]));
  const placements = candidate.placements.map((placement) => {
    const signs = modes.get(placement.fixed_group_id);
    if (!signs || !placement.fixed_mirrored) return placement;
    const primary = candidate.placements.find((item) => item.fixed_group_id === placement.fixed_group_id && !item.fixed_mirrored);
    const updated = { ...primary, instance_id: placement.instance_id, record_id: placement.record_id, name: placement.name,
      mass_kg: placement.mass_kg, fixed_mirrored: true, orientation_handedness: -1,
      constraint_valid: placement.constraint_valid, constraint_violations: placement.constraint_violations,
      model_to_global_matrix: primary.model_to_global_matrix.map((row, index) => row.map((value) => value * (signs[index] ?? 1))) };
    if (primary.space_preview_limits?.inner_normal_ring) {
      const [radial, tangent] = primary.space_preview_limits.inner_normal_ring;
      updated.space_preview_limits = { ...primary.space_preview_limits, inner_normal_ring: [radial, -tangent] };
    }
    for (const key of ['translation_mm', 'model_origin_global_mm', 'installation_point_mm', 'installation_face_center_mm',
      'center_of_mass_mm', 'installation_face_normal', 'up_direction_global']) {
      if (primary[key]) updated[key] = primary[key].map((value, axis) => value * signs[axis]);
    }
    if (primary.footprint_mm) updated.footprint_mm = primary.footprint_mm.map((point) => point.map((value, axis) => value * signs[axis]));
    updated.orientation_matrix = primary.orientation_matrix.map((row, index) => row.map((value) => value * signs[index]));
    const point = updated.installation_point_mm;
    updated.rotation_z_deg = ((Math.atan2(point[1], point[0]) * 180 / Math.PI) % 360 + 360) % 360;
    return updated;
  });
  const mass = placements.reduce((sum, placement) => sum + placement.mass_kg, 0);
  const center = [0, 1, 2].map((axis) => mass ? placements.reduce((sum, placement) => sum + placement.mass_kg * placement.center_of_mass_mm[axis], 0) / mass : 0);
  return { ...candidate, placements, validation: { ...candidate.validation, total_mass_kg: mass,
    center_of_mass_mm: center, radial_com_mm: Math.hypot(center[0], center[1]) } };
}
