"""文件说明：按当前安装筒尺寸展开固定环向/镜像组，保持相对安装关系；正式包络、预览与优化共用安全悬高和位姿规则。

依赖正式包络按各高度的罩内截面计算初放；空间不足仍展开模型并标红，共面安装区域在直筒上下沿
双向限位。预览违规交由正式验收报告，保存和优化继续遵守约束，不改历史矩阵。
"""

import math

import numpy as np
from shapely.geometry import MultiPoint, Point

from app.domain.layout_config import LAYOUT_CONFIG
from app.domain.layout_geometry import make_placement, rotation_z, validate_layout
from app.domain.layout_symmetry import symmetry_pairs
from app.domain.fixed_mirror import reflect_placement
from app.domain.fixed_motion import fixed_motion_violations
from app.domain.fixed_policy import candidate_fixed_parameters
from app.domain.fixed_pose import orient_fixed_model, fixed_orientation_fields, fixed_boundary_validation, apply_fixed_action
from app.domain.fixed_mounts import mount_requires_adjustment
from app.domain.layout_space import geometry_metadata, envelope_height_intervals, fairing_sections, space_boundary_issues
from app.domain.installation_region import relative_installation_heights, installation_region
from app.domain.layout_contact import directional_suspension, side_contact_offset, projected_clearance


def required_suspension(model, mount, radius=None):
    """返回零悬高接触所需的基准径向偏移；侧挂允许负值，顶部保持原有朝下安装规则。"""
    if mount == "side" and radius is not None:
        return side_contact_offset(model, radius) - radius
    axis = 0 if mount == "side" else 2
    return max(0.0, float(model.face_center[axis] - model.lower[axis]))


def fixed_radial_offset(model, radius, suspension):
    """将沿法向退让量转换为固定组径向坐标偏移；手动姿态可倾斜，使用真实接触反算而非安装点距离。"""
    contact = required_suspension(model, "side", radius)
    normal = model.face_normal / np.linalg.norm(model.face_normal)
    if normal[0] >= -LAYOUT_CONFIG["orientation_tolerance"]:
        raise ValueError("侧挂自动留距要求安装面法向朝向安装筒，请调整姿态或使用手动位置")
    if not math.isfinite(contact):
        raise ValueError("正式包络沿当前侧挂方向与筒壁没有接触基准")
    if suspension == 0:
        return contact
    if abs(normal[1]) <= LAYOUT_CONFIG["orientation_tolerance"] and normal[0] < 0:
        return contact + suspension * abs(normal[0])
    vertices = model.vertices - model.face_center
    lower, upper = contact, contact + suspension
    while directional_suspension(vertices + [radius + upper, 0, 0], model.faces, model.face_normal, radius) < suspension:
        upper = contact + 2 * (upper - contact)
    while upper - lower > LAYOUT_CONFIG["geometry_tolerance_mm"] / 4:
        middle = (lower + upper) / 2
        if directional_suspension(vertices + [radius + middle, 0, 0], model.faces, model.face_normal, radius) < suspension:
            lower = middle
        else:
            upper = middle
    return upper


def prepare_initial_groups(satellites, parameters, groups):
    """返回完成初放的新组副本；优先适配空间，无可用范围时保留请求高度，随后统一限位并验收。

    只处理 auto_place 新组并清除一次性标记；空间不足不能阻止显示，缺失固化模型仍抛 ValueError。
    """
    tolerance = LAYOUT_CONFIG["geometry_tolerance_mm"]
    result = []
    for group in groups:
        if not group.auto_place:
            result.append(group)
            continue
        source = next((item for item in satellites if item.record_id == group.record_id), None)
        if source is None:
            raise ValueError(f"固定组 {group.group_id} 找不到固化模型")
        if group.mount == "top":
            result.append(group.model_copy(update={"reference_height_mm": parameters.min_height_mm, "auto_place": False}))
            continue
        model = orient_fixed_model(source, group)
        base = parameters.installation_base.model_dump()
        actual = fixed_radial_offset(model, parameters.min_radius_mm, group.suspension_mm)
        relative = model.vertices - model.face_center
        radial_vertices = relative + [parameters.min_radius_mm + actual, 0, 0]
        intervals = envelope_height_intervals(fairing_sections(parameters.fairing_profile), radial_vertices)
        plane_lower, plane_upper = relative_installation_heights(model)
        distance = projected_clearance(relative + [parameters.min_radius_mm + actual, 0, 0], model.faces)
        base_floor = (base["height_mm"] * (base["lower_radius_mm"] - distance) / (base["lower_radius_mm"] - parameters.min_radius_mm)
                      if base["lower_radius_mm"] > distance and base["lower_radius_mm"] > parameters.min_radius_mm else 0.0)
        ranges = [(max(-plane_lower, start - base["height_mm"], base_floor - base["height_mm"] - float(relative[:, 2].min())),
                   min(parameters.min_height_mm - plane_upper, end - base["height_mm"])) for start, end in intervals]
        ranges = [(low, high) for low, high in ranges if low <= high + tolerance]
        height = min((min(max(group.height_mm, low), high) for low, high in ranges),
                     default=group.height_mm, key=lambda value: abs(value - group.height_mm))
        if height != group.height_mm:
            # 非凸罩和基座的保守筛选不能挪走实际合法的请求位姿。
            target = np.array([parameters.min_radius_mm + actual, 0, base["height_mm"] + group.height_mm])
            region = installation_region(model, model.source_to_envelope) - model.face_center + target
            if not space_boundary_issues(relative + target, "side", target, parameters.min_radius_mm,
                                         parameters.min_height_mm, base, parameters.fairing_profile, tolerance, region, model.faces):
                height = group.height_mm
        result.append(group.model_copy(update={"height_mm": height,
                                               "manual_suspension_mm": None, "reference_radius_mm": parameters.min_radius_mm,
                                               "reference_height_mm": parameters.min_height_mm, "auto_place": False}))
    return result


def limit_installation_height(satellites, parameters, groups):
    """按当前安装区域两端规范化侧挂高度；区域高于直筒时贴下沿并保留上沿违规供验收拒绝。"""
    models = {model.record_id: model for model in satellites}
    result = []
    for group in groups:
        if group.mount == "side" and group.record_id in models:
            lower, upper = relative_installation_heights(orient_fixed_model(models[group.record_id], group))
            group = group.model_copy(update={"height_mm": max(-lower, min(group.height_mm, parameters.min_height_mm - upper))})
        result.append(group)
    return result


def expand_fixed_groups(satellites, parameters, radius, height, groups=None):
    """按实例顺序占用数量并展开环向或完整镜像位姿；环向偶数按对置编号，镜像一对使用同一世界反射矩阵。

    侧挂随 radius 径向移动，顶部随 height 升降；保存参考尺寸只记录来源，不锁定世界坐标。
    返回实例位姿字典；未知类型、重复组、数量不足或顶部重复抛 ValueError，不修改输入。
    """
    groups = parameters.fixed_groups if groups is None else groups
    base_height = float(parameters.installation_base.height_mm)
    pool, result, seen = {}, {}, set()
    for model in satellites:
        pool.setdefault(model.record_id, []).append(model)
    for models in pool.values():
        models.sort(key=lambda item: (int(item.instance_id.rsplit(":", 1)[-1])
                                     if item.instance_id.rsplit(":", 1)[-1].isdigit() else 0, item.instance_id))
    top_count = 0
    for group in sorted(groups, key=lambda item: item.mount != "top"):
        if group.group_id in seen:
            raise ValueError("固定组标识不能重复")
        seen.add(group.group_id)
        models = pool.get(group.record_id, [])
        if group.copies > len(models):
            raise ValueError(f"固定组 {group.group_id} 数量占用超过已保存装载数量，或固化类型已删除")
        top_count += group.mount == "top"
        if top_count > 1:
            raise ValueError("顶部只能固定一颗居中卫星")
        indices = list(range(group.copies))
        if group.copies % 2 == 0:
            indices = [index for first in range(group.copies // 2)
                       for index in (first, first + group.copies // 2)]
        selection = next(item for item in parameters.satellites if item.record_id == group.record_id)
        chosen = models[:group.copies]
        # 奇数硬配对类型留一颗自由；单颗侧挂优先占用它，避免无故占用已有配对的一边。
        if (group.copies == 1 and group.mount == "side" and selection.symmetry_enabled
                and selection.symmetry_mode == "hard" and selection.count % 2
                and not ((parameters.top_enabled and parameters.top_record_id == group.record_id)
                         or any(item.mount == "top" and item.record_id == group.record_id for item in groups))):
            free = next((item for item in models if item.instance_id == f"{group.record_id}:{selection.count}"), None)
            if free is not None:
                chosen = [free]
        # 释放软组仍预留其原实例身份，防止后续硬组被重新分配到别的卫星。
        occupied = {item.instance_id for item in chosen}
        pool[group.record_id] = [item for item in models if item.instance_id not in occupied]
        if parameters._release_soft_fixed and not group.hard_constraint:
            continue
        for offset, index in enumerate(indices):
            source = chosen[offset]
            if group.symmetry_mode != "ring" and offset == 1:
                placement = reflect_placement(result[chosen[0].instance_id], source, group.symmetry_mode)
                placement.update(fixed_orientation_fields(placement["model_to_global_matrix"]))
                result[source.instance_id] = placement
                continue
            model = orient_fixed_model(source, group)
            required = required_suspension(model, group.mount, radius)
            actual = (fixed_radial_offset(model, radius, group.suspension_mm) if group.mount == "side"
                      else max(group.suspension_mm, required)) if group.manual_suspension_mm is None else group.manual_suspension_mm
            if group.mount == "side" and radius + actual < 0:
                raise ValueError("手动安装基准点不能越过圆柱中轴后继续使用负半径")
            angle = math.radians(group.angle_deg + 360 * index / group.copies) if group.mount == "side" else 0.0
            midpoint = (model.lower + model.upper) / 2
            if group.mount == "side":
                target = np.array([radius + actual, 0.0, base_height + group.height_mm])
                xy = (rotation_z(angle) @ (midpoint - model.face_center + target))[:2]
                bottom = base_height + group.height_mm + model.lower[2] - model.face_center[2]
            else:
                xy = [0.0, 0.0]
                bottom = base_height + height + actual + model.lower[2] - model.face_center[2]
            placement = make_placement(model, 0, angle, xy, bottom, group.mount)
            suspension = (directional_suspension(model.vertices - model.face_center + [radius + actual, 0, 0],
                                                 model.faces, model.face_normal, radius)
                          if group.mount == "side" else actual)
            placement.update(fixed=True, fixed_group_id=group.group_id,
                             fixed_mirrored=False, mirror_plane=group.symmetry_mode,
                             mount_auto_adjusted=mount_requires_adjustment(source, group.mount),
                             suspension_lower_mm=group.suspension_mm,
                             hard_constraint=group.hard_constraint,
                             required_suspension_mm=required,
                             suspension_mm=suspension, radial_offset_mm=actual,
                             suspension_reference="envelope_contact_normal" if group.mount == "side" else "installation_plane")
            placement.update(fixed_orientation_fields(placement["model_to_global_matrix"]))
            result[source.instance_id] = placement
    return result


def fixed_relation_violations(placements, satellites, parameters, instance_violations=None):
    """核验已占用实例与硬两两对称关系；可向实例违规字典追加关系错误，仍返回总体错误列表。"""
    errors = []
    half_turn = np.diag([-1.0, -1.0, 1.0, 1.0])
    for first, second in symmetry_pairs(satellites, parameters):
        left, right = (placements.get(satellites[index].instance_id) for index in (first, second))
        if left is None and right is None:
            continue
        message = None
        if left is None or right is None:
            message = "固定组占用了硬两两对称关系中的单边，请将配对卫星一起固定"
        elif not np.allclose(np.asarray(right["model_to_global_matrix"]),
                             half_turn @ np.asarray(left["model_to_global_matrix"]),
                             atol=LAYOUT_CONFIG["geometry_tolerance_mm"], rtol=0):
            message = "固定组与既有硬两两对称关系冲突，请检查数量、同高、等距和相隔180°的朝向"
        if message:
            errors.append(message)
            if instance_violations is not None:
                for placement in (left, right):
                    if placement is not None:
                        instance_violations.setdefault(placement["instance_id"], []).append(message)
    return errors


def fixed_matrix_violations(candidate, satellites, parameters):
    """按候选阶段及当前筒尺寸重算固定矩阵；核对相对安装关系，允许筒尺寸带来的同步平移。"""
    parameters = candidate_fixed_parameters(candidate, parameters)
    expected = expand_fixed_groups(satellites, parameters, candidate["radius_mm"], candidate["height_mm"])
    actual = {item["instance_id"]: item for item in candidate["placements"]}
    return fixed_motion_violations(expected, actual)


def preview_fixed(satellites, parameters, groups, *, include_meshes=False, on_display=None):
    """统一生成位姿和正式违规；可先回调待验收显示快照，回调不代表可行或可保存，不改优化历史字段。"""
    groups = prepare_initial_groups(satellites, parameters, groups)
    groups = limit_installation_height(satellites, parameters, groups)
    groups = [group.model_copy(update={
        "reference_radius_mm": group.reference_radius_mm if group.reference_radius_mm is not None else parameters.min_radius_mm,
        "reference_height_mm": group.reference_height_mm if group.reference_height_mm is not None else parameters.min_height_mm,
    }) for group in groups]
    parameters = parameters.model_copy(update={"fixed_groups": groups})
    top = next((group.record_id for group in groups if group.mount == "top"), None)
    parameters = parameters.model_copy(update={"top_enabled": top is not None, "top_record_id": top})
    placements = expand_fixed_groups(satellites, parameters, parameters.min_radius_mm, parameters.min_height_mm)
    models = {source.instance_id: source for source in satellites}
    for placement in placements.values():
        source = models[placement["instance_id"]]
        support = source.body_hull_vertices if source.body_hull_vertices is not None else source.body_vertices
        matrix = np.asarray(placement["model_to_global_matrix"])
        placement["body_bottom_mm"] = (float(np.min(support @ matrix[2, :3]) + matrix[2, 3])
                                        if support is not None else None)
    candidate = {"radius_mm": parameters.min_radius_mm, "height_mm": parameters.min_height_mm,
                 "axis_radius_mm": parameters.axis_radius_mm, "fairing_radius_mm": parameters.fairing_radius_mm,
                 **geometry_metadata(parameters), "placements": list(placements.values())}
    if on_display is not None:
        mass = sum(item['mass_kg'] for item in candidate['placements'])
        center = sum((np.asarray(item['center_of_mass_mm']) * item['mass_kg'] for item in candidate['placements']), np.zeros(3))
        on_display({'groups': [group.model_dump() for group in groups], 'meshes': {},
                    'candidate': {**candidate, 'validation_pending': True,
                        'validation': {'valid': False, 'violations': [], 'complete': False,
                            'loaded_count': len(placements), 'total_mass_kg': mass,
                            'center_of_mass_mm': (center / mass if mass else center).tolist(),
                            'center_label': '已放置卫星质心'},
                        'boundary_validation': {'valid': False, 'violations': [], 'violation_codes': [], 'instances': {}}}})
    validation = validate_layout(candidate, satellites, parameters, partial=True)
    instance_violations = validation["instance_violations"]
    validation["violations"].extend(fixed_relation_violations(placements, satellites, parameters, instance_violations))
    validation["valid"] = not validation["violations"]
    validation["complete"] = len(placements) == len(satellites)
    validation["center_label"] = "全部卫星质心" if validation["complete"] else "已放置卫星质心"
    candidate["validation"] = validation
    candidate["boundary_validation"] = fixed_boundary_validation(candidate, satellites)
    validation["violations"] = list(dict.fromkeys([*validation["violations"], *candidate["boundary_validation"]["violations"]]))
    validation["valid"] = not validation["violations"]
    for placement in candidate["placements"]:
        instance_violations[placement["instance_id"]].extend(placement["boundary_violations"])
    attributed = {message for messages in instance_violations.values() for message in messages}
    global_errors = [message for message in validation["violations"] if message not in attributed]
    for placement in candidate["placements"]:
        messages = list(dict.fromkeys([*instance_violations[placement["instance_id"]], *global_errors]))
        instance_violations[placement["instance_id"]] = messages
        placement["constraint_valid"] = not messages
        placement["constraint_violations"] = messages
    meshes = {}
    if include_meshes:
        for model in {item.record_id: item for item in satellites}.values():
            inverse = np.linalg.inv(model.source_to_envelope)
            vertices = model.vertices @ inverse[:3, :3].T + inverse[:3, 3]
            meshes[model.record_id] = {"vertices": vertices.tolist(), "faces": model.faces.tolist()}
    return {"groups": [group.model_dump() for group in groups], "candidate": candidate, "meshes": meshes}


def preview_fixed_action(satellites, parameters, groups, action):
    """执行微调，共面安装区域在直筒上下沿限位；其余空间及碰撞违规标红且不能保存。"""
    current = preview_fixed(satellites, parameters, groups)
    try:
        from app.schemas.fixed_constraints import FixedPlacementGroup
        normalized = [FixedPlacementGroup.model_validate(item) for item in current["groups"]]
        updated, _ = apply_fixed_action(normalized, current["candidate"], action)
        proposed = preview_fixed(satellites, parameters, updated)
        proposed.update(action_applied=True, action_error="")
        return proposed
    except ValueError as error:
        current.update(action_applied=False, action_error=str(error))
        return current
