"""文件说明：在固定XY和姿态下求各星最大合法下落量，并同步缩筒；通过上下依赖传播避免逐颗遍历顺序影响。

筒罩边界复用三维安全包络连续扫掠；星间沿用正式凸棱柱和径向遮挡规则。
硬对称配对、固定高度与顶部安装关系显式约束，其余卫星不因同层标签而绑在一起。
压紧开始、逐星路径检查和完成共用一条动态记录；内部二分检查只更新诊断状态。
"""

import math

import numpy as np
from shapely.geometry import MultiPoint, Point

from app.compute.monitoring import stage
from app.domain.fixed_policy import candidate_fixed_parameters
from app.domain.installation_region import installation_region
from app.domain.layout_boundary import inner_clearance
from app.domain.layout_compaction import _drop_limits, _continuous_drop, _translated_candidate
from app.domain.layout_config import LAYOUT_CONFIG
from app.domain.layout_geometry import validate_layout
from app.domain.layout_symmetry import symmetry_pairs
from app.domain.layout_vertical import vertical_relations, assign_vertical_layers, greatest_feasible_drops


def _tube_headroom(hull, radius, tube_bottom, tube_top):
    """求模型内伸部分相对当前筒顶的竖直余量；不存在内伸返回无穷，有内伸时不允许降入筒体。

    对筒顶向上扩展作单调二分。新布局须满足星体下落量不超过缩筒量加此余量，
    因而其他星要求的高筒顶不会被误当作已同步下降；接触允许，精度取集中容差。
    """
    tolerance = LAYOUT_CONFIG["geometry_tolerance_mm"]
    if MultiPoint(hull.vertices[:, :2]).convex_hull.distance(Point(0, 0)) >= radius - tolerance / 2:
        return math.inf
    lower, upper = tube_top, max(tube_top, float(hull.vertices[:, 2].max()))
    obstacle = dict(bottom_mm=tube_bottom, top_mm=upper, lower_radius_mm=radius, upper_radius_mm=radius)
    if inner_clearance(hull, obstacle, tolerance) >= -tolerance / 2:
        return math.inf
    while upper - lower > tolerance:
        middle = (lower + upper) / 2
        obstacle["top_mm"] = middle
        if inner_clearance(hull, obstacle, tolerance) < -tolerance / 2:
            upper = middle
        else:
            lower = middle
    return max(0.0, lower - tube_top - tolerance)


def compact_individual_layout(candidate, satellites, parameters):
    """返回逐星压紧和缩筒后的完整合法副本；不改变水平坐标、姿态、半径、悬高或原始输入。

    每颗先求独立筒罩下落上界，再把星间避让、硬对称、固定高度和筒顶关系写成
    d上 <= d下 + 原始间隙，求全部下落量的共同最大可行解；连续路径由几何扫掠和线性不等式覆盖。
    仅接受包含全部选定卫星且完整验收通过的布局，不为尚未放入顶星的侧星局部解压紧。
    """
    before = validate_layout(candidate, satellites, parameters)
    if not before["valid"]:
        raise ValueError("几何压紧仅接受合法布局：" + "；".join(before["violations"]))
    current = candidate_fixed_parameters(candidate, parameters)
    tolerance = LAYOUT_CONFIG["geometry_tolerance_mm"]
    placements = candidate["placements"]
    stage("逐星下落压紧：准备边界",
          message_key="layout-compaction",
          message=f"完整布局已通过几何验收，开始逐星下落压紧（共 {len(placements)} 颗）")
    models = {item.instance_id: item for item in satellites}
    indices = {item["instance_id"]: index for index, item in enumerate(placements)}
    limits, _, hulls = _drop_limits(candidate, satellites, current)
    tube = len(placements)
    bounds, reasons, geometry = [], [], []
    for index, (placement, hull) in enumerate(hulls, start=1):
        applicable = [item for item in limits if item["instance_id"] == placement["instance_id"]]
        upper = min(item["drop_limit_mm"] for item in applicable)
        stage("逐星下落压紧：检查连续路径", model_id=placement["record_id"],
              message_key="layout-compaction",
              model_name=placement["name"],
              message=f"逐星下落压紧 {index}/{len(placements)}：{placement['name']}，正在检查连续下落路径")
        drop, blockers = _continuous_drop([(placement, hull)], upper, candidate, current)
        bounds.append(drop)
        reasons.append(blockers + [item for item in applicable if item["drop_limit_mm"] <= drop + tolerance])
        geometry.append((placement, MultiPoint(hull.vertices[:, :2]).convex_hull,
                         float(hull.vertices[:, 2].min()), float(hull.vertices[:, 2].max())))
    bounds.append(max(0.0, candidate["height_mm"] - current.min_height_mm))
    edges, edge_reasons = [], []

    def connect(source, target, gap, code, message):
        """记录下落量之间的上界及可解释原因，初始合法边界的舍入负间隙按零处理。"""
        edges.append((source, target, max(0.0, float(gap))))
        edge_reasons.append(dict(code=code, message=message,
                                 other_instance_id=placements[source]["instance_id"] if source < tube else None))

    relations = vertical_relations(geometry, candidate["radius_mm"])
    for relation in relations:
        lower, upper = indices[relation["lower"]], indices[relation["upper"]]
        message = ("径向上下避让" if relation["code"] == "radial_occlusion" else "星间安全包络")
        connect(lower, upper, relation["gap_mm"], relation["code"], f"{placements[lower]['name']}：{message}")
    pairs = [(satellites[a].instance_id, satellites[b].instance_id) for a, b in symmetry_pairs(satellites, current)
             if satellites[a].instance_id in indices and satellites[b].instance_id in indices]
    for first, second in pairs:
        a, b = indices[first], indices[second]
        connect(a, b, 0, "hard_symmetry", f"与 {placements[a]['name']} 保持硬对称同高")
        connect(b, a, 0, "hard_symmetry", f"与 {placements[b]['name']} 保持硬对称同高")
    base = current.installation_base.height_mm
    tube_top = base + candidate["height_mm"]
    for index, (placement, hull) in enumerate(hulls):
        if placement["mount"] == "top":
            connect(tube, index, 0, "top_mount", "顶部安装随筒顶同步下移")
            connect(index, tube, 0, "top_mount", "顶部安装随筒顶同步下移")
            continue
        model = models[placement["instance_id"]]
        matrix = np.asarray(placement["model_to_global_matrix"])
        region = installation_region(model, matrix)
        transform = matrix @ np.linalg.inv(model.source_to_envelope)
        face = transform[:3, :3] @ model.face_center + transform[:3, 3]
        highest = max(float(region[:, 2].max()), float(face[2]))
        connect(index, tube, tube_top - highest, "installation_top", "安装筒覆盖完整安装区域")
        headroom = _tube_headroom(hull, candidate["radius_mm"], base, tube_top)
        if math.isfinite(headroom):
            connect(tube, index, headroom, "cylinder", "内伸结构不能降入安装筒，受当前筒顶限位")
    drops = greatest_feasible_drops(bounds, edges)
    # 不累计利用容差反复微移；传播一次保证归零后的上游不会让下游越界。
    drops[drops <= tolerance * 2] = 0.0
    drops = greatest_feasible_drops(drops, edges)
    shifts = {placement["instance_id"]: float(drops[index]) for index, placement in enumerate(placements)}
    height = candidate["height_mm"] - float(drops[tube])
    result = _translated_candidate(candidate, shifts, height)
    result["side_layer_count"] = assign_vertical_layers(result["placements"], relations, pairs)
    result["validation"] = validate_layout(result, satellites, parameters)
    if not result["validation"]["valid"]:
        raise ValueError("独立下落复验失败：" + "；".join(result["validation"]["violations"]))
    instances = []
    for index, placement in enumerate(placements):
        active = list(reasons[index]) if abs(drops[index] - bounds[index]) <= tolerance * 2 else []
        for (source, target, gap), reason in zip(edges, edge_reasons):
            if target == index and abs(drops[target] - drops[source] - gap) <= tolerance * 2:
                active.append({**reason, "instance_id": placement["instance_id"], "name": placement["name"],
                               "drop_limit_mm": float(drops[index])})
        instances.append(dict(instance_id=placement["instance_id"], name=placement["name"],
                              drop_mm=float(drops[index]), limiting_constraints=active))
    result["geometric_compaction"] = {
        "method": "individual_vertical_v3", "instances": instances,
        "min_drop_mm": float(min(drops[:tube])), "max_drop_mm": float(max(drops[:tube])),
        "height_before_mm": candidate["height_mm"], "height_after_mm": height,
        "height_reduction_mm": float(drops[tube]),
        "assembly_height_before_mm": before["assembly_height_mm"],
        "assembly_height_after_mm": result["validation"]["assembly_height_mm"],
        "radial_com_before_mm": before["radial_com_mm"], "radial_com_after_mm": result["validation"]["radial_com_mm"],
        "limiting_constraints": [limit for item in instances for limit in item["limiting_constraints"]],
    }
    stage("逐星下落压紧完成",
          message_key="layout-compaction",
          message=f"完整布局逐星下落压紧完成并通过复验，筒高 {candidate['height_mm']:.3f} → {height:.3f} mm")
    return result
