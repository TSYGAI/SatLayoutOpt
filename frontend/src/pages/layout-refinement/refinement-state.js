/** 文件说明：管理组合层级和侧挂/顶部即时刚体显示；水平平移使用世界坐标，排队预览不写历史，正式约束交给后端。 */

/** 返回成员所属组合，独立实例返回 undefined。 */
export function groupFor(groups, id) { return groups.find((group) => group.members.includes(id)); }

/** 组合成员始终扩展为整组，禁止通过画布或对象列表单独操作成员。 */
export function selectionFor(groups, id) { return groupFor(groups, id)?.members ?? [id]; }

/** 检查本地日志的结构和实例引用，防止损坏存储使即时显示崩溃；正式命令语义仍由后端校验。 */
export function restoreDraft(value, context) {
  if (value?.fingerprint !== context.source_fingerprint || !Array.isArray(value.commands)
      || value.commands.length > context.settings.command_limit || !Number.isInteger(value.cursor)
      || value.cursor < 0 || value.cursor > value.commands.length) return null;
  const ids = new Set(context.candidate.placements.map((item) => item.instance_id));
  const fields = { combine: ['kind', 'id', 'name', 'ids'], decompose: ['kind', 'id'], lock: ['kind', 'ids', 'locked'],
    transform: ['kind', 'ids', 'angle', 'height', 'suspension', 'x', 'y'], swap: ['kind', 'ids'], resize: ['kind', 'radius_mm', 'height_mm'] };
  for (const command of value.commands) {
    if (!command || typeof command !== 'object' || !Object.hasOwn(fields, command.kind)
        || Object.keys(command).some((key) => !fields[command.kind].includes(key))) return null;
    if (!['decompose', 'resize'].includes(command.kind) && (!Array.isArray(command.ids) || !command.ids.length
        || new Set(command.ids).size !== command.ids.length || command.ids.some((id) => !ids.has(id)))) return null;
    if (['combine', 'decompose'].includes(command.kind) && (typeof command.id !== 'string' || !command.id)) return null;
    if (command.kind === 'combine' && (typeof command.name !== 'string' || !command.name.trim() || command.ids.length < 2)) return null;
    if (command.kind === 'lock' && typeof command.locked !== 'boolean') return null;
    if (command.kind === 'swap' && command.ids.length !== 2) return null;
    if (command.kind === 'transform' && ['angle', 'height', 'suspension', 'x', 'y'].some((key) => command[key] !== undefined
        && (typeof command[key] !== 'number' || !Number.isFinite(command[key])))) return null;
    if (command.kind === 'resize' && (!['radius_mm', 'height_mm'].some((key) => Object.hasOwn(command, key))
        || ['radius_mm', 'height_mm'].some((key) => Object.hasOwn(command, key)
          && (typeof command[key] !== 'number' || !Number.isFinite(command[key]) || command[key] <= 0)))) return null;
  }
  return { commands: value.commands, cursor: value.cursor };
}

/** 拖动只消费服务端已给出的许可区间，取成员交集后共同限位，不在浏览器重算物理边界。 */
export function limitTransient(context, command) {
  if (!command || command.kind !== 'transform') return command;
  const result = { ...command };
  const items = context.candidate.placements.filter((item) => command.ids.includes(item.instance_id));
  for (const [key, rangeKey] of [['height', 'height_delta_mm'], ['suspension', 'suspension_delta_mm']]) {
    if (command[key] === undefined) continue;
    const ranges = items.map((item) => item.adjustment_range?.[rangeKey]);
    if (!ranges.length || ranges.some((range) => !range)) return null;
    const lower = Math.max(...ranges.map((range) => range[0])), upper = Math.min(...ranges.map((range) => range[1]));
    if (lower > upper) return null;
    result[key] = Math.max(lower, Math.min(upper, command[key]));
  }
  return result;
}

/** 对点或方向应用世界 Z 旋转和平移；所有单位继承历史毫米坐标。 */
function point(value, cosine, sine, offset, direction = false) {
  if (!value) return value;
  return [cosine * value[0] - sine * value[1] + (direction ? 0 : offset[0]),
    sine * value[0] + cosine * value[1] + (direction ? 0 : offset[1]), value[2] + (direction ? 0 : offset[2])];
}

/** 将绕筒旋转、世界 XY 平移和法向退让应用到矩阵及质心；不计算碰撞或安全边界。 */
export function movePlacement(item, angle = 0, height = 0, suspension = 0, x = 0, y = 0) {
  const rad = angle * Math.PI / 180, cosine = Math.cos(rad), sine = Math.sin(rad);
  const normal = point(item.installation_face_normal, cosine, sine, [0, 0, 0], true);
  const length = Math.hypot(...normal);
  const offset = normal.map((value, axis) => -value / length * suspension + [x, y, height][axis]);
  const matrix = item.model_to_global_matrix;
  const updated = { ...item, model_to_global_matrix: [
    matrix[0].map((value, index) => cosine * value - sine * matrix[1][index] + (index === 3 ? offset[0] : 0)),
    matrix[1].map((value, index) => sine * matrix[0][index] + cosine * value + (index === 3 ? offset[1] : 0)),
    matrix[2].map((value, index) => value + (index === 3 ? offset[2] : 0)), [...matrix[3]]],
  rotation_z_deg: ((item.rotation_z_deg + angle) % 360 + 360) % 360,
  suspension_mm: item.suspension_mm + (item.mount === 'top' ? offset[2] : suspension), edit_height_mm: item.edit_height_mm + offset[2],
  bottom_mm: item.bottom_mm + offset[2], top_mm: item.top_mm + offset[2],
  installation_region_bottom_mm: item.installation_region_bottom_mm + offset[2],
  installation_region_top_mm: item.installation_region_top_mm + offset[2] };
  if (item.adjustment_range) updated.adjustment_range = {
    height_delta_mm: item.adjustment_range.height_delta_mm.map((value) => value - (item.mount === 'side' && !item.edit_locked ? offset[2] : 0)),
    suspension_delta_mm: item.adjustment_range.suspension_delta_mm.map((value) => value - (item.edit_locked ? 0 : suspension)),
  };
  for (const key of ['translation_mm', 'center_of_mass_mm', 'model_origin_global_mm', 'installation_face_center_mm', 'installation_point_mm']) {
    updated[key] = point(item[key], cosine, sine, offset);
  }
  for (const key of ['installation_face_normal', 'up_direction_global']) updated[key] = point(item[key], cosine, sine, offset, true);
  return updated;
}

/** 连续普通微调在等待验收时即时显示，逐次平移服务端许可区间；遇到尺寸或结构操作则等待正式结果。 */
export function previewPendingMotions(context, commands) {
  let current = context;
  for (const command of commands) {
    if (command.kind !== 'transform') break;
    const limited = limitTransient(current, command);
    if (!limited) break;
    current = previewCommands(current, [limited]);
  }
  return current;
}

/** 重放客户端显示状态；任意更改都标为待校核，不能用于批准保存。 */
export function previewCommands(context, commands) {
  let placements = context.candidate.placements.map((item) => ({ ...item }));
  let groups = structuredClone(context.groups), locked = new Set(context.locked);
  for (const command of commands) {
    if (command.kind === 'combine') {
      const children = groups.filter((group) => group.members.every((id) => command.ids.includes(id)));
      groups = [...groups.filter((group) => !children.includes(group)), { id: command.id, name: command.name,
        members: [...command.ids], system: false, ...(children.length ? { children } : {}) }];
    }
    if (command.kind === 'decompose') groups = groups.flatMap((group) => group.id === command.id ? group.children ?? [] : [group]);
    if (command.kind === 'lock') for (const id of command.ids) { if (command.locked) locked.add(id); else locked.delete(id); }
    if (command.kind === 'transform') placements = placements.map((item) => command.ids.includes(item.instance_id)
      ? movePlacement(item, command.angle, command.height, command.suspension, command.x, command.y) : item);
    if (command.kind === 'swap') {
      const objects = command.ids.map((id) => selectionFor(groups, id));
      const anchors = objects.map((ids) => placements.find((item) => item.instance_id === ids[0]));
      placements = placements.map((item) => {
        const index = objects.findIndex((ids) => ids.includes(item.instance_id));
        if (index < 0) return item;
        const current = anchors[index], other = anchors[1 - index];
        return movePlacement(item, other.rotation_z_deg - current.rotation_z_deg,
          other.installation_region_bottom_mm - current.installation_region_bottom_mm, other.suspension_mm - current.suspension_mm);
      });
    }
  }
  placements = placements.map((item) => ({ ...item, edit_locked: Boolean(item.fixed || locked.has(item.instance_id)) }));
  const mass = placements.reduce((sum, item) => sum + item.mass_kg, 0);
  const center = [0, 1, 2].map((axis) => placements.reduce((sum, item) => sum + item.mass_kg * item.center_of_mass_mm[axis], 0) / mass);
  return { ...context, groups, locked: [...locked], candidate: { ...context.candidate, placements,
    validation_pending: true, validation: { ...context.candidate.validation, valid: false, violations: [],
      center_of_mass_mm: center, total_mass_kg: mass, radial_com_mm: Math.hypot(center[0], center[1]) } } };
}

/** 从当前历史截断 redo 分支后追加一条完整动作，拖动释放只记一次。 */
export function appendCommand(history, command) {
  const commands = [...history.commands.slice(0, history.cursor), command];
  return { commands, cursor: commands.length };
}
