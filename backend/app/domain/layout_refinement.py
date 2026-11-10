"""文件说明：在请求专属取消作用域中重放微调日志并完整验收；顶部可绕筒旋转和平移，安装边界及尺寸随动保持独立约束。"""

from copy import deepcopy
import math

import numpy as np
from shapely.geometry import MultiPoint

from app.compute.cancellation import cancellation_scope, check_cancelled
from app.domain.fixed_policy import candidate_fixed_parameters
from app.domain.layout_refinement_pose import rigid_motion, rigid_update
from app.domain.layout_refinement_bounds import clamp_motion, require_mount_bounds, resize_candidate, refinement_limits
from app.domain.layout_geometry import validate_layout
from app.domain.layout_space import geometry_metadata
from app.domain.layout_symmetry import symmetry_pairs
from app.domain.layout_vertical import assign_vertical_layers, vertical_relations


def initial_groups(candidate, models, parameters):
    """恢复组合层级；首次将硬对称配对作为可拆编辑组，正式对称约束仍独立验收。"""
    saved = candidate.get("refinement")
    if saved:
        return deepcopy(saved["groups"])
    effective = candidate_fixed_parameters(candidate, parameters)
    return [{"id": f"symmetry-{index}", "name": f"硬对称组 {index + 1}",
             "members": [models[a].instance_id, models[b].instance_id], "system": True}
            for index, (a, b) in enumerate(symmetry_pairs(models, effective))]


def group_identifiers(groups):
    """收集各层组合标识，禁止新组合占用仍保存在子层级中的身份。"""
    pending, identifiers = list(groups), set()
    while pending:
        group = pending.pop()
        identifiers.add(group["id"])
        pending.extend(group.get("children", []))
    return identifiers


def strict_fields(value, required, optional=()):
    """拒绝未知或缺少的命令字段，以保证前后端操作契约明确。"""
    if not isinstance(value, dict) or not set(required) <= set(value) or set(value) - set(required) - set(optional):
        raise ValueError("微调命令字段无效")


def finite(value):
    """只接受有限数值，布尔、字符串与非有限值均拒绝。"""
    if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value):
        raise ValueError("微调增量必须为有限数值")
    return float(value)


def evaluate_refinement(source, models, parameters, commands, command_limit, cancelled=lambda: False):
    """在独立取消作用域中重放草稿并完整验收；中断不返回部分结果，复用进程的下次请求不受影响。"""
    with cancellation_scope(cancelled):
        return _evaluate_refinement(source, models, parameters, commands, command_limit, cancelled)


def _evaluate_refinement(source, models, parameters, commands, command_limit, cancelled):
    """重放完整草稿并执行正式验收；非法命令抛 ValueError，几何违规保留位姿并返回原因。"""
    if not isinstance(commands, list) or len(commands) > command_limit:
        raise ValueError("微调操作数量超限，请先保存新版本再继续")
    candidate = deepcopy(source)
    candidate.pop("geometric_compaction", None)
    candidate.update(geometry_metadata(parameters))
    candidate["axis_radius_mm"] = parameters.axis_radius_mm
    candidate["fairing_radius_mm"] = parameters.fairing_radius_mm
    by_id = {p["instance_id"]: p for p in candidate["placements"]}
    model_map = {model.instance_id: model for model in models}
    if len(by_id) != len(candidate["placements"]) or set(by_id) != set(model_map):
        raise ValueError("历史实例与数值快照不一致，无法微调")
    groups = initial_groups(source, models, parameters)
    locked = set(source.get("refinement", {}).get("locked", []))
    fixed = {p["instance_id"] for p in source["placements"] if p.get("fixed")}
    base, radius, height = parameters.installation_base.height_mm, source["radius_mm"], source["height_mm"]
    applied = []
    for p in by_id.values():
        check_cancelled()
        rigid_update(p, model_map[p["instance_id"]], np.asarray(p["model_to_global_matrix"], dtype=float), radius, base + height)

    def members(ids, *, movable=True):
        """校验操作包含完整组合；固定和锁定任一成员时阻止整次移动。"""
        if (not isinstance(ids, list) or not ids or any(not isinstance(i, str) for i in ids)
                or len(set(ids)) != len(ids) or not set(ids) <= set(by_id)):
            raise ValueError("微调对象无效")
        for group in groups:
            if set(ids) & set(group["members"]) and not set(group["members"]) <= set(ids):
                raise ValueError("组合必须整体操作，请先拆解后单独调整")
        if movable and set(ids) & (fixed | locked):
            raise ValueError("包含固定或锁定成员，整次操作已阻止")
        return [by_id[i] for i in ids]

    def move(selected, angle, dz, suspension, x=0.0, y=0.0):
        """绕筒轴施加共同旋转和世界平移，悬高沿各自法向改变；调用方负责安装类型与范围校验。"""
        for p in selected:
            check_cancelled()
            rigid_motion(p, angle, dz, suspension, x, y)

    for command in commands:
        if cancelled():
            raise InterruptedError("微调校核已取消")
        if not isinstance(command, dict):
            raise ValueError("微调命令无效")
        kind = command.get("kind")
        if kind == "combine":
            strict_fields(command, ("kind", "id", "name", "ids"))
            selected = members(command["ids"], movable=False)
            children = [g for g in groups if set(g["members"]) <= set(command["ids"])]
            object_count = len(selected) - sum(len(g["members"]) - 1 for g in children)
            if (object_count < 2 or not isinstance(command["id"], str) or not 1 <= len(command["id"]) <= 80
                    or command["id"] in group_identifiers(groups)
                    or not isinstance(command["name"], str) or not 1 <= len(command["name"].strip()) <= 32):
                raise ValueError("组合无效，请选择至少两个完整对象并使用新的组合标识")
            combined = {"id": command["id"], "name": command["name"].strip(), "members": list(command["ids"]), "system": False}
            if children:
                combined["children"] = children
            groups = [g for g in groups if g not in children] + [combined]
        elif kind == "decompose":
            strict_fields(command, ("kind", "id"))
            group = next((g for g in groups if g["id"] == command["id"]), None)
            if group is None:
                raise ValueError("找不到当前组合；子组合请先拆解外层组合")
            index = groups.index(group)
            groups[index:index + 1] = group.get("children", [])
        elif kind == "lock":
            strict_fields(command, ("kind", "ids", "locked"))
            members(command["ids"], movable=False)
            if type(command["locked"]) is not bool:
                raise ValueError("锁定值必须为布尔值")
            locked.update(command["ids"]) if command["locked"] else locked.difference_update(command["ids"])
        elif kind == "transform":
            strict_fields(command, ("kind", "ids"), ("angle", "height", "suspension", "x", "y"))
            selected = members(command["ids"])
            angle, dz, suspension = (finite(command.get(key, 0)) for key in ("angle", "height", "suspension"))
            x, y = (finite(command.get(key, 0)) for key in ("x", "y"))
            if any(key in command for key in ("x", "y")) and any(p["mount"] != "top" for p in selected):
                raise ValueError("水平 X/Y 平移仅适用于完整顶部对象；包含侧挂成员时请先拆解组合")
            if any(p["mount"] == "top" for p in selected) and dz:
                raise ValueError("顶部安装高度随筒顶保持，请通过悬高调整竖直距离")
            dz, suspension = clamp_motion(selected, dz, suspension, parameters, height)
            move(selected, angle, dz, suspension, x, y)
            require_mount_bounds(selected, parameters, height)
            applied.append({"angle": angle, "height": dz, "suspension": suspension,
                            **({"x": x, "y": y} if "x" in command or "y" in command else {})})
        elif kind == "resize":
            strict_fields(command, ("kind",), ("radius_mm", "height_mm"))
            if not any(key in command for key in ("radius_mm", "height_mm")):
                raise ValueError("安装筒尺寸操作至少需要半径或高度")
            next_radius = finite(command.get("radius_mm", radius))
            next_height = finite(command.get("height_mm", height))
            candidate = resize_candidate(candidate, models, parameters, next_radius, next_height)
            radius, height = next_radius, next_height
            by_id = {p["instance_id"]: p for p in candidate["placements"]}
        elif kind == "swap":
            strict_fields(command, ("kind", "ids"))
            ids = command["ids"]
            if not isinstance(ids, list) or len(ids) != 2 or any(not isinstance(i, str) or i not in by_id for i in ids):
                raise ValueError("交换必须选择两个完整对象")
            objects = [members(next((g["members"] for g in groups if i in g["members"]), [i])) for i in ids]
            if {p["instance_id"] for p in objects[0]} & {p["instance_id"] for p in objects[1]}:
                raise ValueError("交换双方不能是同一个对象")
            if any(p["mount"] != "side" for obj in objects for p in obj):
                raise ValueError("包含顶部卫星的对象不能参与位置交换")
            anchors = [(obj[0]["rotation_z_deg"], obj[0]["installation_region_bottom_mm"], obj[0]["suspension_mm"]) for obj in objects]
            for index, obj in enumerate(objects):
                delta = [target - current for target, current in zip(anchors[1 - index], anchors[index])]
                move(obj, *delta)
            require_mount_bounds([p for obj in objects for p in obj], parameters, height)
        else:
            raise ValueError("未知微调操作")
    # 每个最终实例仅从正式网格重建一次，历史动作多时不反复计算同一接触截面与凸包。
    for p in by_id.values():
        check_cancelled()
        rigid_update(p, model_map[p["instance_id"]], np.asarray(p["model_to_global_matrix"], dtype=float), radius, base + height)
    geometry = [(p, MultiPoint(p["footprint_mm"]).convex_hull, p["bottom_mm"], p["top_mm"]) for p in by_id.values()]
    effective = candidate_fixed_parameters(candidate, parameters)
    pairs = [(models[a].instance_id, models[b].instance_id) for a, b in symmetry_pairs(models, effective)]
    layer_error = None
    try:
        candidate["side_layer_count"] = assign_vertical_layers(candidate["placements"], vertical_relations(geometry, radius), pairs)
    except ValueError as error:
        layer_error = str(error)
    candidate["validation"] = validate_layout(candidate, models, parameters, report_instances=True, allow_top_translation=True)
    check_cancelled()
    if layer_error:
        candidate["validation"]["valid"] = False
        candidate["validation"]["violations"].append(layer_error)
    for p in candidate["placements"]:
        p["edit_height_mm"] = p["installation_region_bottom_mm"] - base
        p["edit_locked"] = p["instance_id"] in fixed | locked
        p["constraint_violations"] = candidate["validation"]["instance_violations"].get(p["instance_id"], [])
        p["adjustment_range"] = {
            "height_delta_mm": [base - p["installation_region_bottom_mm"], base + height - p["installation_region_top_mm"]]
                if p["mount"] == "side" and not p["edit_locked"] else [0.0, 0.0],
            "suspension_delta_mm": [parameters.min_suspension_mm - p["suspension_mm"], parameters.max_suspension_mm - p["suspension_mm"]]
                if not p["edit_locked"] else [0.0, 0.0],
        }
    candidate["refinement"] = {"groups": groups, "locked": sorted(locked)}
    return {"candidate": candidate, "groups": groups, "locked": sorted(locked), "applied": applied,
            "limits": refinement_limits(candidate, parameters)}
