/** 文件说明：将世界轴微调转为当前安装筒参考系草稿，并按相对悬高做刚性显示变换；安全留距、碰撞和保存可行性由后端验收。 */
import { Box3, Matrix4, Quaternion, Vector3 } from 'three';
import { sourceVertexTriples } from '../../components/fixed-mesh-data.js';
import { canonicalMirrorNudge, fixedMirrorSigns, mirrorFixedCandidate } from './fixed-placement-mirror-preview.js';

const axes = { x: new Vector3(1, 0, 0), y: new Vector3(0, 1, 0), z: new Vector3(0, 0, 1) };

/** 将角度转换为绕世界Z的单位四元数，供安装框与世界框互换。 */
function carrier(degrees) {
  return new Quaternion().setFromAxisAngle(axes.z, degrees * Math.PI / 180);
}

/** 绕所选实例的世界安装面外法向旋转；正角表示面对安装面逆时针，镜像轴按轴矢量映射，返回新草稿或 null。 */
export function fixedMountRotationGroups(candidate, groups, instanceId, degrees) {
  const selected = candidate?.placements.find((item) => item.instance_id === instanceId);
  const group = groups.find((item) => item.group_id === selected?.fixed_group_id);
  if (!selected || !group || !Number.isFinite(degrees) || !selected.installation_face_normal?.every(Number.isFinite)) return null;
  const normal = new Vector3().fromArray(selected.installation_face_normal);
  if (!normal.lengthSq()) return null;
  const primary = selected.fixed_mirrored
    ? candidate.placements.find((item) => item.fixed_group_id === group.group_id && !item.fixed_mirrored) : selected;
  if (!primary) return null;
  if (selected.fixed_mirrored) normal.multiply(new Vector3(...fixedMirrorSigns(group.symmetry_mode))).negate();
  const delta = new Quaternion().setFromAxisAngle(normal.normalize(), degrees * Math.PI / 180);
  const frame = carrier(primary.rotation_z_deg);
  const attitude = frame.clone().invert().multiply(delta).multiply(frame)
    .multiply(new Quaternion().fromArray(group.attitude_quaternion || [0, 0, 0, 1])).normalize();
  return groups.map((item) => item === group ? { ...item, attitude_quaternion: attitude.toArray(),
    manual_suspension_mm: primary.radial_offset_mm ?? primary.suspension_mm,
    reference_radius_mm: candidate.radius_mm, reference_height_mm: candidate.height_mm } : item);
}

/** 将世界轴点击转换成完整安装参数；仅变换坐标，允许违规草稿继续显示及交给后端验收。 */
export function fixedNudgeGroups(candidate, groups, action) {
  if (action?.kind !== 'translate') return null;
  let placement = candidate.placements.find((item) => item.fixed_group_id === action.group_id && item.instance_id === action.instance_id);
  const group = groups.find((item) => item.group_id === action.group_id);
  if (!placement || !group || (group.mount === 'top' && action.axis !== 'z')) return null;
  ({ placement, action } = canonicalMirrorNudge(candidate, group, placement, action));
  const attitude = new Quaternion().fromArray(group.attitude_quaternion || [0, 0, 0, 1]);
  const update = { manual_suspension_mm: placement.radial_offset_mm ?? placement.suspension_mm,
    reference_radius_mm: candidate.radius_mm, reference_height_mm: candidate.height_mm };
  const point = new Vector3().fromArray(placement.installation_point_mm).addScaledVector(axes[action.axis], action.delta);
  if (group.mount === 'side') {
    const phase = Math.atan2(point.y, point.x) * 180 / Math.PI;
    const change = action.axis === 'z' ? 0 : phase - placement.rotation_z_deg;
    update.angle_deg = ((group.angle_deg + change) % 360 + 360) % 360;
    update.height_mm = point.z - candidate.installation_base.height_mm;
    update.manual_suspension_mm = Math.hypot(point.x, point.y) - candidate.radius_mm;
    if (change !== 0) update.attitude_quaternion = carrier(-change).multiply(attitude).normalize().toArray();
  } else update.manual_suspension_mm = point.z - candidate.installation_base.height_mm - candidate.height_mm;
  update.suspension_mm = placement.suspension_reference === 'envelope_contact_normal'
    ? group.suspension_mm : Math.max(0, update.manual_suspension_mm);
  return groups.map((item) => item === group ? { ...item, ...update } : item);
}

/** 用世界刚性增量变换点或方向；保留缺省字段，不修改原快照。 */
function transformed(point, rotation, offset, direction = false) {
  if (!point) return point;
  const vector = new Vector3().fromArray(point).applyQuaternion(rotation);
  if (!direction) vector.add(offset);
  return vector.toArray();
}

/** 用源坐标正式包络取得当前显示外接盒；仅用于顶部居中和显示高度，不作碰撞验收。 */
function envelopeBounds(placement, mesh) {
  if (!mesh?.sourceVertices) return null;
  const matrix = new Matrix4().set(...placement.model_to_global_matrix.flat()), bounds = new Box3();
  for (const vertex of sourceVertexTriples(mesh.sourceVertices)) bounds.expandByPoint(new Vector3().fromArray(vertex).applyMatrix4(matrix));
  return bounds;
}

/** 对安装方式或环向位置草稿即时变换所有副本；安装点、源矩阵和真实质心使用同一刚性增量。 */
export function previewFixedRigidChanges(candidate, previousGroups, nextGroups, meshes) {
  const previous = new Map(previousGroups.map((item) => [item.group_id, item]));
  const next = new Map(nextGroups.map((item) => [item.group_id, item]));
  if (previousGroups.length !== nextGroups.length) return null;
  for (const after of nextGroups) {
    const before = previous.get(after.group_id);
    if (!before || ['record_id', 'mount', 'copies', 'roll_quarters'].some((key) => before[key] !== after[key])) return null;
    if ((before.symmetry_mode || 'ring') !== (after.symmetry_mode || 'ring')) return null;
    const changed = JSON.stringify(before.attitude_quaternion || [0, 0, 0, 1]) !== JSON.stringify(after.attitude_quaternion || [0, 0, 0, 1]);
    // 自动安装方式的全新方向需要后端重新求安全留距，不在客户端复制业务规则。
    if (changed && after.manual_suspension_mm == null) return null;
    if (changed && after.mount === 'top' && !meshes?.[after.record_id]?.sourceVertices) return null;
  }
  const placements = candidate.placements.map((placement) => {
    const before = previous.get(placement.fixed_group_id), after = next.get(placement.fixed_group_id);
    if (!before || !after || before === after || placement.fixed_mirrored) return placement;
    const phase = placement.rotation_z_deg + (after.mount === 'side' ? after.angle_deg - before.angle_deg : 0);
    const rotation = carrier(phase).multiply(new Quaternion().fromArray(after.attitude_quaternion || [0, 0, 0, 1]))
      .multiply(new Quaternion().fromArray(before.attitude_quaternion || [0, 0, 0, 1]).invert()).multiply(carrier(placement.rotation_z_deg).invert()).normalize();
    const contact = placement.suspension_reference === 'envelope_contact_normal';
    const suspension = after.manual_suspension_mm ?? (contact ? placement.radial_offset_mm
      : Math.max(after.suspension_mm, placement.required_suspension_mm));
    const pivot = new Vector3().fromArray(placement.installation_point_mm);
    const target = after.mount === 'side'
      ? new Vector3(candidate.radius_mm + suspension, 0, candidate.installation_base.height_mm + after.height_mm).applyQuaternion(carrier(phase))
      : pivot.clone().add(new Vector3(0, 0, suspension - placement.suspension_mm));
    const offset = target.clone().sub(pivot.clone().applyQuaternion(rotation));
    const matrix = new Matrix4().makeRotationFromQuaternion(rotation).setPosition(offset)
      .multiply(new Matrix4().set(...placement.model_to_global_matrix.flat()));
    const updated = { ...placement, model_to_global_matrix: Array.from({ length: 4 }, (_, row) =>
      [0, 1, 2, 3].map((column) => matrix.elements[column * 4 + row])),
      rotation_z_deg: ((phase % 360) + 360) % 360, suspension_lower_mm: after.suspension_mm,
      suspension_mm: contact ? placement.suspension_mm : suspension,
      ...(contact ? { radial_offset_mm: suspension } : {}) };
    let bounds = envelopeBounds(updated, meshes?.[placement.record_id]);
    if (after.mount === 'top' && bounds) {
      const center = bounds.getCenter(new Vector3()), recenter = new Vector3(-center.x, -center.y, 0);
      offset.add(recenter); bounds.translate(recenter);
      for (let axis = 0; axis < 3; axis += 1) updated.model_to_global_matrix[axis][3] += recenter.getComponent(axis);
    }
    for (const key of ['translation_mm', 'center_of_mass_mm', 'model_origin_global_mm', 'installation_face_center_mm', 'installation_point_mm']) {
      updated[key] = transformed(placement[key], rotation, offset);
    }
    for (const key of ['installation_face_normal', 'up_direction_global']) updated[key] = transformed(placement[key], rotation, offset, true);
    if (placement.orientation_matrix) {
      const orientation = new Matrix4().set(...placement.orientation_matrix[0], 0, ...placement.orientation_matrix[1], 0,
        ...placement.orientation_matrix[2], 0, 0, 0, 0, 1).premultiply(new Matrix4().makeRotationFromQuaternion(rotation));
      updated.orientation_matrix = [0, 1, 2].map((row) => [0, 1, 2].map((column) => orientation.elements[column * 4 + row]));
    }
    if (bounds) { updated.bottom_mm = bounds.min.z; updated.top_mm = bounds.max.z; }
    // 世界平移或环向调整不改变本体竖直支撑方向，沿用后端底高。
    const preservesHeight = Math.abs(rotation.x) <= Number.EPSILON * 16 && Math.abs(rotation.y) <= Number.EPSILON * 16;
    updated.body_bottom_mm = preservesHeight && Number.isFinite(placement.body_bottom_mm)
      ? placement.body_bottom_mm + offset.z : null;
    updated.pose_reference_pending = true;
    return updated;
  });
  const mass = placements.reduce((sum, item) => sum + item.mass_kg, 0);
  const center = [0, 1, 2].map((axis) => mass ? placements.reduce((sum, item) => sum + item.mass_kg * item.center_of_mass_mm[axis], 0) / mass : 0);
  return mirrorFixedCandidate({ ...candidate, placements, validation_pending: true,
    validation: { ...candidate.validation, valid: false, violations: [], total_mass_kg: mass,
      center_of_mass_mm: center, radial_com_mm: Math.hypot(center[0], center[1]) } }, nextGroups);
}
