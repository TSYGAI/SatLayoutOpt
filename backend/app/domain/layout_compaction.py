"""文件说明：提供竖直压紧入口及共用几何路径、坐标更新工具，保留旧整体下落供历史回归对比。

复用罩体凸包、真实包络表面、安装区域和固定关系验收，检查整个连续下落路径；
不调整环向、分层或质心配平，不改变传入候选，返回完整复验后的副本及限制原因。
"""

from copy import deepcopy

import numpy as np

from app.domain.fixed_placements import expand_fixed_groups
from app.domain.fixed_policy import candidate_fixed_parameters
from app.domain.installation_region import installation_region
from app.domain.layout_config import LAYOUT_CONFIG
from app.domain.layout_boundary import envelope_hull, swept_hull, inner_clearance, outer_clearance
from app.domain.layout_geometry import validate_layout
from app.domain.layout_space import fairing_sections, inner_obstacles


def _drop_limits(candidate, satellites, parameters):
    """求安装及罩底的下落上界、安装最高点和三维包络；锥面余量另由完整路径检查确定。"""
    base, radius = parameters.installation_base, candidate["radius_mm"]
    models = {item.instance_id: item for item in satellites}
    fixed = expand_fixed_groups(satellites, parameters, radius, candidate["height_mm"])
    limits, installation_tops, hulls = [], [], []

    def add(placement, code, message, distance):
        """记录有限下落余量，消除已经合法的边界点所产生的微小负误差。"""
        limits.append({"instance_id": placement["instance_id"], "name": placement["name"],
                       "code": code, "message": message, "drop_limit_mm": max(0.0, float(distance))})

    for placement in candidate["placements"]:
        model = models[placement["instance_id"]]
        matrix = np.asarray(placement["model_to_global_matrix"])
        transform = matrix @ np.linalg.inv(model.source_to_envelope)
        vertices = model.vertices @ transform[:3, :3].T + transform[:3, 3]
        hulls.append((placement, envelope_hull(vertices, model.faces)))
        add(placement, "fairing_floor", "整流罩底面（正式包络）", vertices[:, 2].min())
        if placement["mount"] == "top":
            # 保持顶部安装悬高和整组相对位置，筒高必须与整体下落量同步减少。
            add(placement, "minimum_tube_height", "筒高下限及顶部安装关系",
                candidate["height_mm"] - parameters.min_height_mm)
            continue
        region = installation_region(model, matrix)
        installation_tops.append(float(region[:, 2].max()))
        add(placement, "installation", "完整安装区域下缘", region[:, 2].min() - base.height_mm)
        face = transform[:3, :3] @ model.face_center + transform[:3, 3]
        add(placement, "installation_point", "安装基准点下缘", face[2] - base.height_mm)
        if model.instance_id in fixed:
            add(placement, "fixed_side", "侧挂固定高度关系", 0.0)
    return limits, installation_tops, hulls


def _path_blockers(hulls, drop, candidate, parameters):
    """返回连续下落路径中的筒罩碰撞；筒体同步缩短，只需额外检查不可缩的最小筒高。

    初始布局已验收。缩筒达到下限前筒顶下降不慢于卫星，故不会新增筒顶相交；
    到达下限后固定最小筒体与扫掠凸体检查覆盖剩余运动。星间相对位姿保持不变。
    """
    tolerance = LAYOUT_CONFIG["geometry_tolerance_mm"]
    sections = fairing_sections(parameters.fairing_profile)
    obstacles = inner_obstacles(candidate["radius_mm"], parameters.min_height_mm,
                                parameters.installation_base.model_dump())
    blockers = []
    for placement, hull in hulls:
        swept = swept_hull(hull, drop)
        margins = [("fairing", "整流罩边界（三维包络）", outer_clearance(swept, sections))]
        for obstacle in obstacles:
            code = obstacle["kind"]
            message = "安装筒基座边界（三维包络）" if code == "base" else "安装筒最小高度边界（三维包络）"
            margins.append((code, message, inner_clearance(swept, obstacle, tolerance)))
        for code, message, margin in margins:
            if margin < -tolerance / 2:
                blockers.append({"instance_id": placement["instance_id"], "name": placement["name"],
                                 "code": code, "message": message, "drop_limit_mm": float(drop)})
    return blockers


def _continuous_drop(hulls, upper, candidate, parameters):
    """二分扫掠路径首次受阻的位置，精度沿用集中几何容差；返回安全下落量与实际阻挡信息。"""
    tolerance = LAYOUT_CONFIG["geometry_tolerance_mm"]
    blockers = _path_blockers(hulls, upper, candidate, parameters) if upper > tolerance else []
    if not blockers:
        return (upper if upper > tolerance * 2 else 0.0), []
    lower = 0.0
    while upper - lower > tolerance:
        middle = (lower + upper) / 2
        trial = _path_blockers(hulls, middle, candidate, parameters)
        if trial:
            upper, blockers = middle, trial
        else:
            lower = middle
    drop = max(0.0, lower - tolerance)
    if drop <= tolerance * 2:
        drop = 0.0
    for item in blockers:
        item["drop_limit_mm"] = drop
    return drop, blockers


def _translated_candidate(candidate, drop, height):
    """按统一下落量或实例到下落量映射同步所有Z字段；返回副本，XY、旋转及悬高保持原值。"""
    result = deepcopy(candidate)
    result["height_mm"] = float(height)
    for placement in result["placements"]:
        distance = drop.get(placement["instance_id"], 0.0) if isinstance(drop, dict) else drop
        matrix = np.asarray(placement["model_to_global_matrix"], dtype=float).copy()
        matrix[2, 3] -= distance
        placement["model_to_global_matrix"] = matrix.tolist()
        for key in ("translation_mm", "center_of_mass_mm", "model_origin_global_mm",
                    "installation_face_center_mm", "installation_point_mm"):
            if key in placement:
                placement[key] = list(placement[key])
                placement[key][2] -= distance
        for key in ("bottom_mm", "top_mm", "body_bottom_mm"):
            if placement.get(key) is not None:
                placement[key] -= distance
    return result


def compact_rigid_layout(candidate, satellites, parameters):
    """返回合法布局整体下落并缩筒后的副本，附毫米级前后指标；非法输入或复验失败抛 ValueError。

    全部卫星使用同一下落量，已保留的软固定关系也不主动释放；无顶部时筒高下限
    只限制缩筒，不阻止卫星继续合法下移。重复调用的几何结果不再改变。
    """
    validation = validate_layout(candidate, satellites, parameters)
    if not validation["valid"]:
        raise ValueError("几何压紧仅接受合法布局：" + "；".join(validation["violations"]))
    current = candidate_fixed_parameters(candidate, parameters)
    tolerance = LAYOUT_CONFIG["geometry_tolerance_mm"]
    limits, tops, hulls = _drop_limits(candidate, satellites, current)
    minimum = min(item["drop_limit_mm"] for item in limits)
    drop, blockers = _continuous_drop(hulls, minimum, candidate, current)
    before_height = candidate["height_mm"]
    has_top = any(item["mount"] == "top" for item in candidate["placements"])
    height = (before_height - drop if has_top else
              max(current.min_height_mm, max(tops) - current.installation_base.height_mm - drop))
    height = min(before_height, height)
    if before_height - height <= tolerance:
        height = before_height
    result = _translated_candidate(candidate, drop, height)
    result["validation"] = validate_layout(result, satellites, parameters)
    if not result["validation"]["valid"]:
        raise ValueError("几何压紧复验失败：" + "；".join(result["validation"]["violations"]))
    result["geometric_compaction"] = {
        "method": "rigid_vertical_v2", "drop_mm": drop,
        "height_before_mm": before_height, "height_after_mm": height,
        "height_reduction_mm": before_height - height,
        "assembly_height_before_mm": validation["assembly_height_mm"],
        "assembly_height_after_mm": result["validation"]["assembly_height_mm"],
        "radial_com_before_mm": validation["radial_com_mm"],
        "radial_com_after_mm": result["validation"]["radial_com_mm"],
        "limiting_constraints": blockers + [item for item in limits if item["drop_limit_mm"] <= drop + tolerance],
    }
    return result


def compact_layout(candidate, satellites, parameters):
    """默认执行各颗独立下落；仅明确硬关系耦合位移，完整验证后返回新候选，不修改输入。"""
    from app.domain.layout_individual_compaction import compact_individual_layout
    return compact_individual_layout(candidate, satellites, parameters)
