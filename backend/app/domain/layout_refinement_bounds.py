"""文件说明：集中管理微调硬操作边界与安装筒尺寸随动；依赖历史参数和正式接触几何，不替代碰撞等完整验收。"""

from copy import deepcopy
import math

import numpy as np

from app.domain.fixed_placements import expand_fixed_groups
from app.domain.fixed_policy import candidate_fixed_parameters
from app.domain.installation_tube import validate_installation_bounds
from app.domain.layout_config import LAYOUT_CONFIG
from app.domain.layout_refinement_pose import rigid_update
from app.compute.cancellation import check_cancelled


def clamp_interval(value, lower, upper, label):
    """将共同增量限制在交集内；区间为空时拒绝整个动作，不对成员逐颗截断。"""
    tolerance = LAYOUT_CONFIG["geometry_tolerance_mm"]
    if lower > upper + tolerance:
        raise ValueError(f"{label}没有共同合法区间（{lower:g} ～ {upper:g} mm），请先调整对象或安装筒尺寸")
    return max(lower, min(upper, value))


def clamp_motion(selected, dz, suspension, parameters, height):
    """按来源悬高及完整共面区域计算同一动作的许可增量，返回共同升降和共同悬高。"""
    suspension = clamp_interval(suspension,
        max(parameters.min_suspension_mm - p["suspension_mm"] for p in selected),
        min(parameters.max_suspension_mm - p["suspension_mm"] for p in selected), "悬高")
    side = [p for p in selected if p["mount"] == "side"]
    if side:
        base = parameters.installation_base.height_mm
        shifts = [-np.asarray(p["installation_face_normal"])[2]
                  / np.linalg.norm(p["installation_face_normal"]) * suspension for p in side]
        dz = clamp_interval(dz,
            max(base - p["installation_region_bottom_mm"] - shift for p, shift in zip(side, shifts)),
            min(base + height - p["installation_region_top_mm"] - shift for p, shift in zip(side, shifts)), "安装区域升降")
    return dz, suspension


def require_mount_bounds(placements, parameters, height):
    """拒绝安装区域或真实悬高越界；用于交换和尺寸修改的整次原子校验，几何违规另行保留红色草稿。"""
    base = parameters.installation_base.height_mm
    tolerance = LAYOUT_CONFIG["geometry_tolerance_mm"]
    side = [p for p in placements if p["mount"] == "side"]
    below = next((p for p in side if p["installation_region_bottom_mm"] < base - tolerance), None)
    if below is not None:
        label = below.get("name", below["instance_id"])
        raise ValueError(f"{label} 的完整安装区域低于直筒下沿，整次操作已拒绝")
    highest = max(side, key=lambda p: p["installation_region_top_mm"], default=None)
    if highest is not None and highest["installation_region_top_mm"] - base > height + tolerance:
        minimum = highest["installation_region_top_mm"] - base
        label = highest.get("name", highest["instance_id"])
        raise ValueError(f"{label} 的完整安装区域超过直筒上沿，安装筒高度至少需要 {minimum:g} mm；整次操作已拒绝")
    for p in placements:
        label = p.get("name", p["instance_id"])
        value = p["suspension_mm"]
        if not math.isfinite(value) or not parameters.min_suspension_mm - tolerance <= value <= parameters.max_suspension_mm + tolerance:
            raise ValueError(f"{label} 的实际悬高 {value:g} mm 不在来源范围 "
                             f"{parameters.min_suspension_mm:g} ～ {parameters.max_suspension_mm:g} mm 内，整次操作已拒绝")


def resize_candidate(candidate, models, parameters, radius, height):
    """返回筒尺寸及全部卫星随动后的新副本；锁定保留相对关系，来源固定组按原有随筒规则重新展开。"""
    for value, lower, upper, label in (
        (radius, parameters.min_radius_mm, parameters.max_radius_mm, "安装筒半径"),
        (height, parameters.min_height_mm, parameters.max_height_mm, "安装筒高度"),
    ):
        if not lower <= value <= upper:
            raise ValueError(f"{label}必须在来源任务范围 {lower:g} ～ {upper:g} mm 内")
    validate_installation_bounds(radius, height, parameters.installation_base.model_dump(), parameters.fairing_profile)
    result = deepcopy(candidate)
    top = parameters.installation_base.height_mm + height
    model_map = {model.instance_id: model for model in models}
    expected = expand_fixed_groups(models, candidate_fixed_parameters(candidate, parameters), radius, height)
    for p in result["placements"]:
        check_cancelled()
        model = model_map[p["instance_id"]]
        matrix = np.asarray(p["model_to_global_matrix"], dtype=float).copy()
        if p["instance_id"] in expected:
            p.update(expected[p["instance_id"]])
            matrix = np.asarray(p["model_to_global_matrix"], dtype=float)
        elif p["mount"] == "top":
            matrix[2, 3] += height - candidate["height_mm"]
        else:
            suspension = p["suspension_mm"]
            rigid_update(p, model, matrix, radius, top)
            outward = -np.asarray(p["installation_face_normal"])
            matrix[:3, 3] += outward / np.linalg.norm(outward) * (suspension - p["suspension_mm"])
        rigid_update(p, model, matrix, radius, top)
    require_mount_bounds(result["placements"], parameters, height)
    result.update(radius_mm=radius, height_mm=height)
    return result


def refinement_limits(candidate, parameters):
    """返回历史尺寸区间与当前完整安装区域需要的最低筒高；联合尺寸的最终合法性仍由 resize 校验。"""
    base = parameters.installation_base.height_mm
    required = max((p["installation_region_top_mm"] - base for p in candidate["placements"] if p["mount"] == "side"), default=0.0)
    return {"min_suspension_mm": parameters.min_suspension_mm, "max_suspension_mm": parameters.max_suspension_mm,
            "radius_mm": [parameters.min_radius_mm, parameters.max_radius_mm],
            "height_mm": [parameters.min_height_mm, parameters.max_height_mm],
            "required_height_mm": required, "radius_step_mm": parameters.radius_step_mm,
            "base_height_mm": base, "base_lower_radius_mm": parameters.installation_base.lower_radius_mm}
