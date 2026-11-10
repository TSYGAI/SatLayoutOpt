"""文件说明：按低位优先构造侧挂布局，固定XY后用高度事件直接落位；不生成扫掠网格或发布局部解。

复用正式角投影、共面安装区域和筒罩边界；硬对称作为同高单元，固定星先占位。
环向试探共用轴对称边界计算，只有基座接触需要少量静态网格检查，最终由完整验收兜底。
"""

import math

import numpy as np
from shapely.geometry import MultiPoint

from app.domain.installation_region import installation_region
from app.domain.layout_config import LAYOUT_CONFIG
from app.domain.layout_contact import mesh_inner_clearance
from app.domain.layout_occlusion import angular_interval, angular_overlap
from app.domain.layout_space import envelope_height_intervals, fairing_sections, inner_obstacles
from app.domain.layout_symmetry import placement_units


def installation_offsets(model):
    """返回共面安装区域相对包络底部的上下界；无安装区域时由公共读取器报错。"""
    heights = installation_region(model, model.source_to_envelope)[:, 2] - model.lower[2]
    return float(heights.min()), float(heights.max())


def height_ranges(model, vertices, parameters, radius):
    """求固定水平位置的包络底高区间；vertices 的最低Z为零，不改变模型或调用方数组。

罩体直接代入顶点高度不等式，基座只在最低位置确有碰撞时二分静态接触；
基座从地面向上收窄，且底高非负，因此上移避让具有单调性。搜索保守地返回安全端点。
    """
    tolerance = LAYOUT_CONFIG["geometry_tolerance_mm"]
    base = parameters.installation_base
    low_offset, high_offset = installation_offsets(model)
    face_offset = float(model.face_center[2] - model.lower[2])
    floor = max(0.0, base.height_mm - min(low_offset, face_offset))
    ceiling = base.height_mm + parameters.max_height_mm - max(high_offset, face_offset)
    obstacle = inner_obstacles(radius, parameters.min_height_mm, base.model_dump())[0]
    if floor < base.height_mm:
        shifted = vertices.copy()
        shifted[:, 2] += floor
        if mesh_inner_clearance(shifted, model.faces, obstacle, tolerance) < -tolerance / 2:
            lower, upper = floor, base.height_mm
            while upper - lower > LAYOUT_CONFIG["vertical_contact_precision_mm"]:
                middle = (lower + upper) / 2
                shifted[:, 2] = vertices[:, 2] + middle
                if mesh_inner_clearance(shifted, model.faces, obstacle, tolerance) < -tolerance / 2:
                    lower = middle
                else:
                    upper = middle
            floor = upper
    sections = fairing_sections(parameters.fairing_profile)
    # 与正式验收共用容差，避免贴罩旋转后1个浮点末位把许可区间变成空集。
    for section in sections:
        section["lower_radius_mm"] += tolerance / 4
        section["upper_radius_mm"] += tolerance / 4
    return [(max(floor, low), min(ceiling, high))
            for low, high in envelope_height_intervals(sections, vertices)
            if max(floor, low) <= min(ceiling, high) + tolerance]


def world_vertices(model, center, angle, bottom=0.0):
    """将定向包络放到指定水平盒心及底高，返回新顶点数组，保持模型姿态和安装基准。"""
    cosine, sine = math.cos(angle), math.sin(angle)
    rotation = np.array([[cosine, -sine], [sine, cosine]])
    vertices = model.vertices.copy()
    vertices[:, :2] = (vertices[:, :2] - (model.lower[:2] + model.upper[:2]) / 2) @ rotation.T + center
    vertices[:, 2] += bottom - model.lower[2]
    return vertices


def projection(vertices):
    """返回水平凸包和角投影；两者在固定XY的竖直落位过程中只计算一次。"""
    shape = MultiPoint(vertices[:, :2]).convex_hull
    return shape, angular_interval(np.asarray(shape.exterior.coords))


def interferes(left, right, radius):
    """判断两侧星是否必须上下避让，与正式凸棱柱和径向遮挡规则一致。"""
    tolerance = LAYOUT_CONFIG["geometry_tolerance_mm"]
    overlap = angular_overlap(left[1], right[1])
    if overlap <= 0:
        return False
    return (overlap > tolerance / max(radius, tolerance)
            or not left[0].intersection(right[0]).buffer(-tolerance).is_empty)


def ordered_units(side, partition, pairs, priority=()):
    """先放贯穿高星，再按CP分组和组内质量排序；分组不强制同高，priority不改变固定星或硬对称单元。"""
    result = []
    for group in partition:
        units = placement_units(group, pairs)
        units.sort(key=lambda unit: (-sum(side[i].mass for i in unit),
                                    -max(side[i].upper[2] - side[i].lower[2] for i in unit),
                                    tuple(side[i].instance_id for i in unit)))
        result.extend(units)
    return sorted(result, key=lambda unit: not any(i in priority for i in unit))


def lowest_bottom(unit, projections, ranges, heights, placed, bottoms, radius):
    """按许可区间下界和阻挡顶面跳转，返回单颗或硬对称组的最低底高；无位置返回None。

只比较可能相挡的投影，不按微小距离逐步移动，不让其他方位的高星抬高整个名义层。
    """
    tolerance = LAYOUT_CONFIG["geometry_tolerance_mm"]
    if any(interferes(projections[a], projections[b], radius)
           for offset, a in enumerate(unit) for b in unit[offset + 1:]):
        return None
    conflicts = {i: [j for j in placed if j not in unit and interferes(projections[i], projections[j], radius)]
                 for i in unit}
    bottom = 0.0
    while True:
        previous = bottom
        for index in unit:
            available = [max(bottom, low) for low, high in ranges[index] if max(bottom, low) <= high + tolerance]
            if not available:
                return None
            bottom = max(bottom, min(available))
            for other in conflicts[index]:
                if (bottom + heights[index] > bottoms[other] + tolerance
                        and bottom < bottoms[other] + heights[other] - tolerance):
                    bottom = bottoms[other] + heights[other]
        if bottom <= previous + tolerance:
            return bottom


def settle_sides(side, partition, centers, angles, parameters, radius, fixed, pairs=(), *, priority=()):
    """在给定XY和姿态下逐颗直接落到最低可用高度；固定星不动，硬对称共同落位，返回底高数组或None。"""
    rows, ranges, bottoms = {}, {}, np.zeros(len(side))
    heights = np.array([item.upper[2] - item.lower[2] for item in side])
    placed = []
    for i, model in enumerate(side):
        vertices = world_vertices(model, centers[i], angles[i])
        if model.instance_id in fixed:
            placement = fixed[model.instance_id]
            transform = np.asarray(placement["model_to_global_matrix"]) @ np.linalg.inv(model.source_to_envelope)
            vertices = model.vertices @ transform[:3, :3].T + transform[:3, 3]
            bottoms[i] = placement["bottom_mm"]
            ranges[i] = [(bottoms[i], bottoms[i])]
            placed.append(i)
        else:
            ranges[i] = height_ranges(model, vertices, parameters, radius)
        rows[i] = projection(vertices)
    for unit in ordered_units(side, partition, pairs, priority):
        if all(i in placed for i in unit):
            continue
        bottom = lowest_bottom(unit, rows, ranges, heights, placed, bottoms, radius)
        if bottom is None:
            return None
        for i in unit:
            bottoms[i] = bottom
            if i not in placed:
                placed.append(i)
    return bottoms


def construct_bottom_up(side, partition, radii, angles, parameters, radius, fixed, pairs, cancelled, *, preserve_angles=False, priority=()):
    """逐个安装单元试探环向空位并立即落位，返回角度、底高；失败返回None，取消抛InterruptedError。

同半径的环向旋转不改变轴对称筒罩余量，因此每颗只预计算一次高度区间。
先比较安装高度与底高，再比较部分质量矩；部分布局不套用完整布局的质心硬限。
preserve_angles保留CP提供的环向顺序和间距，只求最低底高，防止所有试次退化到同一紧贴排列。
priority指定先落位的贯穿高星，最终配平后落位必须使用相同顺序。
    """
    angles = np.array(angles, dtype=float, copy=True)
    tangent = np.array([(m.lower[1] + m.upper[1]) / 2 - m.face_center[1] for m in side])
    heights = np.array([m.upper[2] - m.lower[2] for m in side])
    offsets = [installation_offsets(m)[1] for m in side]
    local, ranges, rows, bottoms = {}, {}, {}, np.zeros(len(side))
    placed, moment = [], np.zeros(2)
    for i, model in enumerate(side):
        if cancelled():
            raise InterruptedError("任务已取消")
        local[i] = world_vertices(model, [radii[i], tangent[i]], 0.0)
        ranges[i] = height_ranges(model, local[i], parameters, radius) if model.instance_id not in fixed else []
        if model.instance_id in fixed:
            placement = fixed[model.instance_id]
            transform = np.asarray(placement["model_to_global_matrix"]) @ np.linalg.inv(model.source_to_envelope)
            rows[i] = projection(model.vertices @ transform[:3, :3].T + transform[:3, 3])
            bottoms[i] = placement["bottom_mm"]
            ranges[i] = [(bottoms[i], bottoms[i])]
            placed.append(i)
            moment += model.mass * np.asarray(placement["center_of_mass_mm"])[:2]
    for unit in ordered_units(side, partition, pairs, priority):
        if cancelled():
            raise InterruptedError("任务已取消")
        if all(i in placed for i in unit):
            continue
        leader = unit[0]
        locked = next((i for i in unit if side[i].instance_id in fixed), None)
        local_rows = {i: projection(local[i]) for i in unit}
        candidates = [angles[leader]]
        if locked is None and not preserve_angles:
            candidates.extend(angles[leader] + np.linspace(0, 2 * math.pi, LAYOUT_CONFIG["bottom_up_angle_samples"], endpoint=False))
            for i in unit:
                phase = 0 if i == leader else math.pi
                start, end = local_rows[i][1]
                for other in placed:
                    candidates.extend((rows[other][1][1] - start - phase, rows[other][1][0] - end - phase))
            # 配平只影响同等低位选择，不提前否决尚未装满的候选。
            if np.linalg.norm(moment) > 0:
                candidates.append(math.atan2(-moment[1], -moment[0]))
        elif locked is not None:
            candidates = [angles[locked] - (0 if locked == leader else math.pi)]
        best = None
        for angle in candidates:
            trial_rows = dict(rows)
            trial_moment = np.zeros(2)
            for i in unit:
                if i in placed:
                    continue
                phase = angle + (0 if i == leader else math.pi)
                cosine, sine = math.cos(phase), math.sin(phase)
                rotation = np.array([[cosine, -sine], [sine, cosine]])
                vertices = np.asarray(local_rows[i][0].exterior.coords) @ rotation.T
                trial_rows[i] = projection(vertices)
                center = side[i].center[:2] - (side[i].lower[:2] + side[i].upper[:2]) / 2 + [radii[i], tangent[i]]
                trial_moment += side[i].mass * (rotation @ center)
            bottom = lowest_bottom(unit, trial_rows, ranges, heights, placed, bottoms, radius)
            if bottom is None:
                continue
            score = (bottom + max(offsets[i] for i in unit), bottom, float(np.linalg.norm(moment + trial_moment)))
            if best is None or score < best[0]:
                best = (score, angle, bottom, trial_rows, trial_moment)
        if best is None:
            return None
        _, angle, bottom, rows, added_moment = best
        moment += added_moment
        for i in unit:
            angles[i] = angle + (0 if i == leader else math.pi)
            bottoms[i] = bottom
            if i not in placed:
                placed.append(i)
    return angles, bottoms
