/** 文件说明：将当前包络矩阵代入后端分段及线性许可，按各顶点高度即时提示锥段越界；正式验收由后端负责，手动位姿照常显示。 */
import { sourceVertexTriples } from '../../components/fixed-mesh-data.js';
import { fixedInstallationBounds } from './fixed-installation-preview.js';

/** 对服务端下发的线性截面许可代入世界高度，不创建新的几何规则或许可范围。 */
function radiusAt(section, height) {
  return section.lower_radius_mm + (section.upper_radius_mm - section.lower_radius_mm)
    * (height - section.bottom_mm) / (section.top_mm - section.bottom_mm);
}

/** 将整个包络高度代入服务端分段许可，跨段时核对连接处，不再使用旧圆柱边界分支。 */
function permittedOuterRadius(limits, lower, upper) {
  const radii = limits.outer_sections.flatMap((section) => {
    const start = Math.max(lower, section.bottom_mm), end = Math.min(upper, section.top_mm);
    return start <= end ? [radiusAt(section, start), radiusAt(section, end)] : [];
  });
  return radii.length ? Math.min(...radii) : -Infinity;
}

/** 仅代入后端生成的凸形罩线性许可；未知或旧许可仍走保守分段提示，不在客户端推导罩体规则。 */
function vertexOuterMargin(limits, radius, height) {
  let margin = Infinity;
  for (const plane of limits.outer_radial_planes || []) {
    margin = Math.min(margin, plane.slope * height + plane.intercept_mm - radius);
  }
  return margin;
}

/** 汇总逐点线性许可余量；非凸罩或旧响应保留跨段保守筛选，正式结果覆盖临时提示。 */
function outerMargin(limits, vertexMargin, maximumRadius, minimumZ, maximumZ) {
  return limits.outer_radial_planes?.length ? vertexMargin : permittedOuterRadius(limits, minimumZ, maximumZ) - maximumRadius;
}

/** 代入源包络与矩阵检查空间许可；手动编辑可放开外罩限制用于标红，缺数据或违反其余限制时返回false。 */
export function isFixedPreviewPermitted(candidate, meshes, { allowFairingOverflow = false } = {}) {
  if (!candidate) return false;
  for (const placement of candidate.placements) {
    const limits = placement.space_preview_limits;
    const vertices = meshes?.[placement.record_id]?.sourceVertices;
    const matrix = placement.model_to_global_matrix;
    if (!limits?.outer_sections || !limits.inner_obstacles || !vertices?.length || !matrix) return false;
    const tolerance = limits.tolerance_mm;
    const installation = fixedInstallationBounds(placement);
    if (installation && (installation.bottom < limits.installation_height_min_mm - tolerance
      || (limits.installation_height_max_mm != null && installation.top > limits.installation_height_max_mm + tolerance))) return false;
    if (limits.installation_radius_max_mm != null) {
      const point = placement.installation_point_mm;
      if (!point || Math.hypot(point[0], point[1]) > limits.installation_radius_max_mm + tolerance) return false;
    }
    const normals = [];
    if (limits.inner_normal_local) {
      const source = limits.inner_normal_local;
      const x = matrix[0][0] * source[0] + matrix[0][1] * source[1] + matrix[0][2] * source[2];
      const y = matrix[1][0] * source[0] + matrix[1][1] * source[1] + matrix[1][2] * source[2];
      const length = Math.hypot(x, y);
      if (length) normals.push([x / length, y / length]);
    }
    if (limits.inner_normal_ring) {
      const phase = placement.rotation_z_deg * Math.PI / 180, [x, y] = limits.inner_normal_ring;
      normals.push([Math.cos(phase) * x - Math.sin(phase) * y, Math.sin(phase) * x + Math.cos(phase) * y]);
    }
    if (limits.inner_normal_local && !normals.length) return false;
    const projections = normals.map(() => Infinity);
    let minimumZ = Infinity, maximumZ = -Infinity, maximumRadius = 0, vertexMargin = Infinity;
    for (const [sx, sy, sz] of sourceVertexTriples(vertices)) {
      const x = matrix[0][0] * sx + matrix[0][1] * sy + matrix[0][2] * sz + matrix[0][3];
      const y = matrix[1][0] * sx + matrix[1][1] * sy + matrix[1][2] * sz + matrix[1][3];
      const z = matrix[2][0] * sx + matrix[2][1] * sy + matrix[2][2] * sz + matrix[2][3];
      minimumZ = Math.min(minimumZ, z); maximumZ = Math.max(maximumZ, z);
      const radius = Math.hypot(x, y);
      maximumRadius = Math.max(maximumRadius, radius);
      if (!allowFairingOverflow) vertexMargin = Math.min(vertexMargin, vertexOuterMargin(limits, radius, z));
      if (![x, y, z].every(Number.isFinite)
        || z < limits.height_min_mm - tolerance || (limits.height_max_mm !== null && z > limits.height_max_mm + tolerance)) return false;
      normals.forEach(([nx, ny], index) => {
        projections[index] = Math.min(projections[index], x * nx + y * ny);
      });
    }
    if (!allowFairingOverflow && outerMargin(limits, vertexMargin, maximumRadius, minimumZ, maximumZ) < -tolerance) return false;
    for (const obstacle of limits.inner_obstacles) {
      const start = Math.max(minimumZ, obstacle.bottom_mm), end = Math.min(maximumZ, obstacle.top_mm);
      if (end - start <= tolerance) continue;
      const radius = Math.max(radiusAt(obstacle, start), radiusAt(obstacle, end));
      if (!projections.some((projection) => projection >= radius - tolerance)) return false;
    }
  }
  return true;
}

/** 根据当前矩阵标红空间违规；不能由保守平面确认的穿筒风险明确标记待验收，不夹取或回退位姿。 */
export function markFixedSpaceWarnings(candidate, meshes) {
  const placements = candidate.placements.map((placement) => {
    const matrix = placement.model_to_global_matrix, limits = placement.space_preview_limits;
    const vertices = meshes?.[placement.record_id]?.sourceVertices;
    if (!limits?.outer_sections || !vertices) return placement;
    let minimumZ = Infinity, maximumZ = -Infinity, maximumRadius = 0, vertexMargin = Infinity;
    for (const [sx, sy, sz] of sourceVertexTriples(vertices)) {
      const x = matrix[0][0] * sx + matrix[0][1] * sy + matrix[0][2] * sz + matrix[0][3];
      const y = matrix[1][0] * sx + matrix[1][1] * sy + matrix[1][2] * sz + matrix[1][3];
      const z = matrix[2][0] * sx + matrix[2][1] * sy + matrix[2][2] * sz + matrix[2][3];
      const radius = Math.hypot(x, y);
      maximumRadius = Math.max(maximumRadius, radius);
      vertexMargin = Math.min(vertexMargin, vertexOuterMargin(limits, radius, z));
      minimumZ = Math.min(minimumZ, z); maximumZ = Math.max(maximumZ, z);
    }
    const messages = [], codes = [];
    const installation = fixedInstallationBounds(placement);
    if (installation && (installation.bottom < limits.installation_height_min_mm - limits.tolerance_mm
      || (limits.installation_height_max_mm != null && installation.top > limits.installation_height_max_mm + limits.tolerance_mm))) {
      messages.push(`${placement.name} 共面安装区域超出直筒高度范围`); codes.push('installation_height');
    }
    if (outerMargin(limits, vertexMargin, maximumRadius, minimumZ, maximumZ) < -limits.tolerance_mm) {
      messages.push(`${placement.name} 安全包络超出整流罩径向范围`); codes.push('fairing_radius');
    }
    if (minimumZ < limits.height_min_mm - limits.tolerance_mm
      || (limits.height_max_mm !== null && maximumZ > limits.height_max_mm + limits.tolerance_mm)) {
      messages.push(`${placement.name} 安全包络超出允许高度`); codes.push('height');
    }
    if (limits.installation_radius_max_mm != null
      && Math.hypot(...placement.installation_point_mm.slice(0, 2)) > limits.installation_radius_max_mm + limits.tolerance_mm) {
      messages.push(`${placement.name} 安装基准点超出筒顶范围`); codes.push('top_mount');
    }
    if (!codes.includes('height') && !codes.includes('installation_height') && !codes.includes('top_mount')
      && !isFixedPreviewPermitted({ placements: [placement] }, meshes, { allowFairingOverflow: true })) {
      messages.push(`${placement.name} 安装筒边界可能冲突，正在正式校验`); codes.push('cylinder_check_pending');
    }
    const previous = new Set([...(placement.boundary_violations || []), ...(placement.local_space_violations || [])]);
    const constraints = [...(placement.constraint_violations || []).filter((entry) => !previous.has(entry)), ...messages];
    return { ...placement, ...(installation ? { installation_region_bottom_mm: installation.bottom, installation_region_top_mm: installation.top } : {}),
      boundary_valid: messages.length === 0, boundary_violations: messages,
      boundary_violation_codes: codes, local_space_violations: messages,
      constraint_valid: constraints.length === 0, constraint_violations: constraints };
  });
  const violations = placements.flatMap((placement) => placement.boundary_violations || []);
  return { ...candidate, placements, boundary_validation: { valid: violations.length === 0, violations },
    validation: { ...candidate.validation, valid: false, violations: placements.flatMap((placement) => placement.constraint_violations || []) } };
}

/** 校验服务失败只追加错误并标红，不恢复旧矩阵；保留当前草稿供继续编辑、重试或用户主动撤销。 */
export function markFixedValidationFailure(candidate, message) {
  const placements = candidate.placements.map((placement) => ({ ...placement, constraint_valid: false,
    constraint_violations: [...(placement.constraint_violations || []), message] }));
  return { ...candidate, placements, validation_pending: true,
    validation: { ...candidate.validation, valid: false, violations: [...(candidate.validation.violations || []), message] } };
}
