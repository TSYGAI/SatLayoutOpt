/** 文件说明：把服务端共面安装区域和高度许可代入当前矩阵，为安装高度显示及上下交互限位提供坐标换算。 */

/** 返回服务端安装区域在当前矩阵下的最低及最高世界高度；缺少区域时等待正式预览。 */
export function fixedInstallationBounds(placement) {
  const vertices = placement.space_preview_limits?.installation_vertices;
  const matrix = placement.model_to_global_matrix;
  if (!vertices?.length || !matrix) return null;
  return vertices.reduce((bounds, [x, y, z]) => {
    const height = matrix[2][0] * x + matrix[2][1] * y + matrix[2][2] * z + matrix[2][3];
    return { bottom: Math.min(bounds.bottom, height), top: Math.max(bounds.top, height) };
  }, { bottom: Infinity, top: -Infinity });
}

/** 将每个侧挂组夹到后端许可高度；区域高于直筒时优先贴下沿并保留违规，不改变其他坐标或姿态。 */
export function limitFixedInstallationHeight(candidate, groups) {
  let limited = false;
  const adjusted = groups.map((group) => {
    if (group.mount !== 'side') return group;
    let lower = -Infinity, upper = Infinity;
    for (const placement of candidate.placements.filter((item) => item.fixed_group_id === group.group_id)) {
      const bounds = fixedInstallationBounds(placement);
      const minimum = placement.space_preview_limits?.installation_height_min_mm;
      const maximum = placement.space_preview_limits?.installation_height_max_mm;
      if (bounds && Number.isFinite(minimum)) lower = Math.max(lower, minimum - bounds.bottom);
      if (bounds && Number.isFinite(maximum)) upper = Math.min(upper, maximum - bounds.top);
    }
    const correction = Math.max(lower, Math.min(0, upper));
    if (correction === 0) return group;
    limited = true;
    return { ...group, height_mm: group.height_mm + correction };
  });
  return { groups: limited ? adjusted : groups, limited };
}
