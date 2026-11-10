"""文件说明：搜索普通分层及高星旁分层，构造中直接落位，按开关放顶星后完整验收；A+B负责重排与配平。"""

from app.compute.monitoring import observed, stage, object_context


import itertools
import math
from copy import deepcopy
from dataclasses import replace

import numpy as np
from scipy.optimize import minimize
from shapely.geometry import MultiPoint

from app.domain.layout_candidates import (
    candidate_order_key, retain_candidate, rank_candidates,
)
from app.domain.layout_attempts import LayoutAttempt, serial_attempts, publish_candidate
from app.domain.layout_config import LAYOUT_CONFIG
from app.domain.installation_tube import validate_installation_bounds
from app.domain.layout_space import geometry_metadata, fairing_sections, allowed_height_intervals
from app.domain.layout_geometry import make_placement, rotation_z, validate_layout
from app.domain.layout_mounts import MountOrientationError, mounting_variants, orient_for_mount
from app.domain.layout_radial import side_mount_radial_limits
from app.domain.layout_contact import directional_suspension
from app.domain.fixed_placements import expand_fixed_groups, fixed_relation_violations
from app.domain.fixed_motion import fixed_boundary_residuals
from app.domain.fixed_policy import fixed_stage_parameters
from app.domain.fixed_pose import orient_fixed_model, orient_fixed_instance
from app.domain.installation_region import installation_region
from app.domain.layout_settlement import (
    installation_offsets, settle_installation_layers, assign_physical_layers, top_clearance_height,
)
from app.domain.layout_occlusion import local_angular_bounds, initialize_shadow_angles, initialize_column_angles
from app.domain.layout_bottom_up import construct_bottom_up
from app.domain.layout_cp import column_partition
from app.domain.layout_symmetry import (
    SymmetricCoordinates, initialize_pair_angles, placement_units, soft_symmetry_penalty, symmetry_pairs,
)


class LayoutSearchCancelled(InterruptedError):
    """表示布局搜索被协作取消，并携带取消前已通过完整验收的候选。"""

    def __init__(self, candidates):
        """保存已排序、已编号的候选，供任务服务持久化并展示。"""
        super().__init__("任务已取消")
        self.candidates = candidates


class LayoutInfeasibleError(ValueError):
    """表示输入在当前安装姿态和包络约束下不可行；增加同一搜索的时间不能修复。"""

    def __init__(self, message, summary=None):
        """保留完整诊断，并提供指出冲突参数的展示摘要；未单独指定时沿用完整原因。"""
        super().__init__(message)
        self.summary = summary or message


@observed("校验布局可行性")
def check_feasibility(satellites, parameters) -> None:
    """检查完整筒体范围、基座罩体边界及固定安装悬高；不改动参数，冲突抛 LayoutInfeasibleError。"""
    try:
        validate_installation_bounds(parameters.max_radius_mm, parameters.max_height_mm,
                                     parameters.installation_base.model_dump(), parameters.fairing_profile)
        symmetry_pairs(satellites, parameters)
        fixed = expand_fixed_groups(satellites, parameters, parameters.min_radius_mm, parameters.min_height_mm)
        violations = fixed_relation_violations(fixed, satellites, parameters)
        for placement in fixed.values():
            actual = placement["suspension_mm"]
            if (actual < parameters.min_suspension_mm - LAYOUT_CONFIG["geometry_tolerance_mm"]
                    or actual > parameters.max_suspension_mm + LAYOUT_CONFIG["geometry_tolerance_mm"]):
                violations.append(f"固定卫星 {placement['name']} 实际悬高 {actual:.3f} mm 不在优化悬高范围 "
                                  f"{parameters.min_suspension_mm:.3f}–{parameters.max_suspension_mm:.3f} mm 内，"
                                  "随筒尺寸变化仍须满足实际法向退让范围")
        if violations:
            raise ValueError("；".join(violations))
    except ValueError as error:
        raise LayoutInfeasibleError(str(error)) from error
    if parameters.top_enabled and len(satellites) == 1:
        raise LayoutInfeasibleError("当前 A+B 分层搜索至少需要一颗侧挂卫星，纯顶部布局不适用此搜索流程")
    top = next((item for item in satellites if parameters.top_enabled and item.record_id == parameters.top_record_id), None)
    for model in satellites:
        stage("校验模型安装姿态", model_id=model.record_id, model_name=model.name,
              face_id=model.installation_face_id)
        if model.instance_id in fixed:
            continue
        try:
            variants = mounting_variants(model, "top" if model is top else "side")
            tolerance = LAYOUT_CONFIG["geometry_tolerance_mm"]
            fairing_height = sum(section["height_mm"] for section in parameters.fairing_profile["segments"])
            possible = []
            for oriented in variants:
                low, high = installation_offsets(oriented)
                possible.append((model is top or high - low <= parameters.max_height_mm + tolerance)
                                and oriented.upper[2] - oriented.lower[2] <= fairing_height + tolerance)
            if not any(possible):
                raise ValueError(f"{model.name} 所有允许姿态的共面安装区域高度或包络高度超过筒体/整流罩上限")
        except ValueError as error:
            raise LayoutInfeasibleError(str(error)) from error


def layer_partitions(satellites, layer_count, beam, cancelled, can_fit=None, symmetric_pairs=()):
    """兼容旧诊断的有界分组器；对称单元不可拆，层质量不再作为硬筛选，正式结构由 CP-SAT 生成。"""
    ordered = sorted(range(len(satellites)), key=lambda index: (-satellites[index].mass, -satellites[index].volume))
    units = placement_units(ordered, symmetric_pairs)
    states = [((),) * layer_count]
    for offset, unit in enumerate(units):
        if cancelled():
            raise InterruptedError("任务已取消")
        expanded = set()
        for state in states:
            for layer in range(layer_count):
                if layer > 0 and not state[layer - 1]:
                    break
                groups = list(state)
                groups[layer] = (*groups[layer], *unit)
                if can_fit is not None and not can_fit(groups[layer]):
                    continue
                if sum(not group for group in groups) <= len(units) - offset - 1:
                    expanded.add(tuple(groups))
        states = sorted(expanded, key=lambda state: partition_rank(state, satellites))[:beam]
    canonical = {tuple(sorted(state, key=lambda group: (-sum(satellites[index].mass for index in group), group))) for state in states}
    for state in sorted(canonical, key=lambda groups: partition_rank(groups, satellites)):
        if all(group for group in state):
            yield state
            if len(state) > 1:
                yield tuple(reversed(state))


def partition_rank(state, satellites):
    """返回优先重载底层组合的排序键，同质量时优先降低侧挂层总高度。"""
    masses = tuple(sorted(-sum(satellites[index].mass for index in group) for group in state))
    heights = sum(max((satellites[index].upper[2] - satellites[index].lower[2] for index in group), default=0)
                  for group in state)
    return masses, heights, state


def radial_limits(model, parameters):
    """按统一勾股截面返回最大舱半径和最小有效悬高；保持安装面为 -X 的输入约定。"""
    limits = side_mount_radial_limits(model, parameters)
    return limits.max_radius_mm, limits.min_suspension_mm


def maximum_side_radius(side, parameters, satellites=None):
    """按各星的安装姿态和悬高计算筒半径交集；固定星随筒径向移动，不以旧世界位置限制上限。"""
    tolerance = LAYOUT_CONFIG["geometry_tolerance_mm"]
    best = []
    fixed = expand_fixed_groups(satellites if satellites is not None else side, parameters,
                                parameters.min_radius_mm, parameters.min_height_mm,
                                groups=None if satellites is not None else
                                [group for group in parameters.fixed_groups if group.mount == "side"])
    for model in side:
        placement = fixed.get(model.instance_id)
        if placement:
            group = next(group for group in parameters.fixed_groups if group.group_id == placement["fixed_group_id"])
            limits = replace(side_mount_radial_limits(orient_fixed_instance(model, group, placement), parameters),
                             min_suspension_mm=placement["suspension_mm"], max_suspension_mm=placement["suspension_mm"])
            if group.manual_suspension_mm is not None:
                limits = replace(limits, min_suspension_mm=placement["radial_offset_mm"],
                                 max_suspension_mm=placement["radial_offset_mm"], mesh_faces=None, contact_segments=None)
            best.append((model, limits))
            continue
        variants = mounting_variants(model, "side")
        limits = max((side_mount_radial_limits(variant, parameters) for variant in variants),
                     key=lambda item: (item.max_radius_mm, -item.min_suspension_mm))
        best.append((model, limits))
    model, limits = min(best, key=lambda item: item[1].max_radius_mm)
    if limits.max_radius_mm < parameters.min_radius_mm - tolerance:
        if model.instance_id in fixed:
            raise LayoutInfeasibleError(f"固定卫星 {model.name} 的正式包络与整流罩范围不相容：实际悬高 "
                                        f"{fixed[model.instance_id]['suspension_mm']:.3f} mm，允许筒半径上限 "
                                        f"{limits.max_radius_mm:.3f} mm 小于输入下限；须保持固定安装姿态和悬高")
        orientation = ("向上轴自由，检查安装面滚转 0/90/180/270 度" if model.up_orientation == "free"
                       else f"向上轴 {model.up_orientation} 对齐全局 +Z")
        prefix = f"侧挂半径不可行：{model.name}（安装面 {model.installation_face_id}；{orientation}）。"
        if limits.min_suspension_mm > parameters.max_suspension_mm + tolerance:
            summary = (f"卫星悬高最大值不足：{parameters.max_suspension_mm:.3f} mm，"
                       f"小于所需 {limits.min_suspension_mm:.3f} mm")
            reason = (f"包络及悬高下限要求 s 至少 {limits.min_suspension_mm:.3f} mm，"
                      f"超过悬高上限 {parameters.max_suspension_mm:.3f} mm")
        elif not math.isfinite(limits.max_face_radius_mm):
            summary = (f"整流罩半径不足：{parameters.fairing_radius_mm:.3f} mm，"
                       f"小于包络最大切向偏距 {limits.tangential_extent_mm:.3f} mm")
            reason = (f"最大切向偏距 b={limits.tangential_extent_mm:.3f} mm 超过整流罩半径 "
                      f"R={parameters.fairing_radius_mm:.3f} mm，sqrt(R²-b²) 无实数解")
        else:
            summary = (f"安装筒半径最小值过大：{parameters.min_radius_mm:.3f} mm，"
                       f"超过允许上限 {limits.max_radius_mm:.3f} mm")
            reason = (f"允许姿态的最佳截面：R={parameters.fairing_radius_mm:.3f} mm，"
                      f"b={limits.tangential_extent_mm:.3f} mm（相对共面基准的最大切向偏距），t={limits.outward_depth_mm:.3f} mm，"
                      f"s={limits.min_suspension_mm:.3f} mm；按真实包络首次接触位置及罩内逐点边界计算，"
                      f"最大舱半径 {limits.max_radius_mm:.3f} mm 小于锁定下限 {parameters.min_radius_mm:.3f} mm；"
                      f"取该下限需要整流罩半径至少 {limits.required_fairing_radius(parameters.min_radius_mm):.3f} mm")
        raise LayoutInfeasibleError(f"{prefix}{reason}；未修改锁定参数或安全包络", summary)
    return min(parameters.max_radius_mm, max(parameters.min_radius_mm, limits.max_radius_mm))


def mount_variants(model, radius, parameters):
    """按罩半径和悬高筛选允许的侧挂姿态；自由轴可滚转，固定轴不得横放或倒置。"""
    variants = mounting_variants(model, "side")
    return sorted((item for item in variants if radial_limits(item, parameters)[0] >= radius - LAYOUT_CONFIG["geometry_tolerance_mm"]),
                  key=lambda item: (item.upper[2] - item.lower[2], item.center[2] - item.lower[2]))


def initialize_ring_angles(partition, dimensions, radii, tangent_offset, trial, rng):
    """用相邻矩形分离角构造各层无穿透初值；环周不够时返回空，避免对明显塞不下的重载组合反复配平。"""
    half = dimensions[:, :2] / 2
    angles = np.zeros(len(radii))

    def separation(first, second, angle):
        """计算两径向矩形在给定相对角度的最大分离轴余量。"""
        ca, sa = math.cos(angle), math.sin(angle)
        left_axes = np.eye(2)
        right_axes = np.array([[ca, sa], [-sa, ca]])
        axes = np.concatenate([left_axes, right_axes])
        left = np.array([radii[first], tangent_offset[first]])
        right = np.array([ca * radii[second] - sa * tangent_offset[second], sa * radii[second] + ca * tangent_offset[second]])
        return float(np.max(np.abs(axes @ (right - left)) - np.abs(axes @ left_axes.T) @ half[first]
                            - np.abs(axes @ right_axes.T) @ half[second]))

    for group in partition:
        if len(group) == 1:
            angles[group[0]] = rng.uniform(0, 2 * math.pi) if trial else 0
            continue
        order = list(group)
        if trial:
            rng.shuffle(order)
        required = []
        for first, second in zip(order, [*order[1:], order[0]]):
            low, high = 0.0, math.pi
            if separation(first, second, high) < 0:
                return None
            for _ in range(32):
                midpoint = (low + high) / 2
                if separation(first, second, midpoint) >= 0:
                    high = midpoint
                else:
                    low = midpoint
            required.append(high)
        if sum(required) > 2 * math.pi:
            return None
        slack = (2 * math.pi - sum(required)) / len(group)
        cursor = rng.uniform(0, 2 * math.pi) if trial else 0.0
        for index, item in enumerate(order):
            angles[item] = cursor
            cursor += required[index] + slack
    return angles


def lower_layers(side, partition, centers, angles, symmetric_pairs=(), fixed_bottoms=None, *, floor_height=0.0, height_ranges=None):
    """在平面布局完成后按单颗或对称对共同下沉，返回各包络底高；不改水平位置、姿态或原分组。

    按原分组由下到上处理，单颗或一对落至最高阻挡顶面、给定筒底或罩体许可区间下界。
    height_ranges 按实例提供可放置的包络底高区间，无合法支撑时返回 None；不提供时仅按 floor_height 下沉。
    使用与独立验收相同的保守凸包棱柱和接触容差；同组平面冲突仍交由验收拒绝。
    """
    tolerance = LAYOUT_CONFIG["geometry_tolerance_mm"]
    polygons = []
    for index, item in enumerate(side):
        midpoint = (item.lower[:2] + item.upper[:2]) / 2
        vertices = (item.vertices[:, :2] - midpoint) @ rotation_z(angles[index])[:2, :2].T + centers[index]
        polygons.append(MultiPoint(vertices).convex_hull)
    fixed_bottoms = fixed_bottoms or {}
    bottoms = np.array([fixed_bottoms.get(index, floor_height) for index in range(len(side))])
    heights = np.array([item.upper[2] - item.lower[2] for item in side])
    placed = list(fixed_bottoms)
    for group in partition:
        for unit in placement_units(group, symmetric_pairs):
            if any(index in fixed_bottoms for index in unit):
                continue
            floor = floor_height
            while True:
                previous_floor = floor
                for index in unit:
                    if height_ranges is not None:
                        available = [max(floor, low) for low, high in height_ranges[index] if max(floor, low) <= high + tolerance]
                        if not available:
                            return None
                        floor = max(floor, min(available))
                    for lower in placed:
                        if polygons[index].intersection(polygons[lower]).buffer(-tolerance).is_empty:
                            continue
                        if lower in fixed_bottoms and (floor + heights[index] <= bottoms[lower] + tolerance
                                                      or floor >= bottoms[lower] + heights[lower] - tolerance):
                            continue
                        floor = max(floor, bottoms[lower] + heights[lower])
                if floor == previous_floor:
                    break
            for index in unit:
                bottoms[index] = floor
        placed.extend(index for index in group if index not in fixed_bottoms)
    return bottoms


def solve_ring_arrangement(side, top, partition, radius, parameters, trial, rng, cancelled, seed=None):
    """轮换高星旁分层、逐星填空和普通环向排列；最多两种初值，返回完整合法方案或None。

偶数无种子试次优先预留高星贯穿空间，失败保留普通CP初值作为回退；
其他试次沿用逐星填空/保留环向重启。两次使用相同离散姿态和随机输入，不改变硬阈值。
    """
    fallback_rng = deepcopy(rng)
    preserve_angles = seed is not None or trial % 2 == 0
    column = column_partition(side, [*side, *([top] if top else [])], parameters, radius, len(partition),
                              parameters.random_seed + trial // 2, cancelled) if seed is None and trial % 2 == 0 else None
    planned_partition, spanning = column if column is not None else (partition, ())
    candidate = _solve_ring_arrangement(side, top, planned_partition, radius, parameters, trial, rng, cancelled,
                                        seed, preserve_angles=preserve_angles, spanning=spanning)
    if candidate is not None:
        return candidate
    if cancelled():
        raise InterruptedError("任务已取消")
    stage("低位构造重启：保留另一环向排列", trial=trial, radius=radius)
    return _solve_ring_arrangement(side, top, partition, radius, parameters, trial, fallback_rng, cancelled,
                                  seed, preserve_angles=True if column is not None else not preserve_angles)


def _solve_ring_arrangement(side, top, partition, radius, parameters, trial, rng, cancelled, seed=None, *, preserve_angles=False, spanning=()):
    """在层组合和半径内配平；spanning高星先落位并贯穿预留方位，失败返回None，取消抛InterruptedError。"""
    original_models = [*([top] if top else []), *side]
    base_height = parameters.installation_base.height_mm
    fixed = expand_fixed_groups(original_models, parameters, radius, parameters.min_height_mm)
    fixed_residuals = fixed_boundary_residuals(fixed, original_models, parameters, radius)
    symmetric_pairs = symmetry_pairs(side, parameters, include_top=False)
    soft_pairs = symmetry_pairs(side, parameters, include_top=False, mode="soft")
    if any(not any(first in group and second in group for group in partition) for first, second in symmetric_pairs):
        return None
    choices = [[] if item.instance_id in fixed else mount_variants(item, radius, parameters) for item in side]
    for index, model in enumerate(side):
        if model.instance_id in fixed:
            group = next(group for group in parameters.fixed_groups
                         if group.group_id == fixed[model.instance_id]["fixed_group_id"])
            variant = orient_fixed_instance(model, group, fixed[model.instance_id])
            choices[index] = [variant]
    if any(not variants for variants in choices):
        return None
    seed_placements = {item["instance_id"]: item for item in seed["placements"]} if seed else {}
    if seed:
        side = [min(variants, key=lambda item: np.linalg.norm(
            rotation_z(-math.radians(seed_placements[item.instance_id]["rotation_z_deg"]))
            @ np.asarray(seed_placements[item.instance_id]["model_to_global_matrix"])[:3, :3] - item.source_to_envelope[:3, :3]))
            for variants in choices]
        if top and top.instance_id not in fixed:
            top = min(mounting_variants(top, "top"), key=lambda item: np.linalg.norm(
                np.asarray(seed_placements[item.instance_id]["model_to_global_matrix"])[:3, :3] - item.source_to_envelope[:3, :3]))
    else:
        side = [(min(variants, key=lambda item: item.upper[1] - item.lower[1]) if trial % 4 == 1 else variants[0])
            if trial < 4 else variants[int(rng.integers(0, len(variants)))] for variants in choices]
        top = orient_for_mount(top, "top", trial % 4) if top and top.instance_id not in fixed else top
    if top and top.instance_id in fixed:
        group = next(group for group in parameters.fixed_groups if group.group_id == fixed[top.instance_id]["fixed_group_id"])
        top = orient_fixed_model(original_models[0], group)
    # 同类型配对必须采用相同的安装姿态，随后绕安装筒中心轴旋转半周。
    for first, second in symmetric_pairs:
        side[second] = min(choices[second], key=lambda item: np.linalg.norm(
            item.source_to_envelope - side[first].source_to_envelope))
    count = len(side)
    coordinates = SymmetricCoordinates(count, symmetric_pairs)
    coordinate_size = 2 * len(coordinates.leaders)
    gap = 0.0
    scale = parameters.fairing_radius_mm
    dimensions = np.array([item.upper - item.lower for item in side])
    # 安装面径向朝内；离散姿态已遵循各颗的固定或自由轴设置，连续搜索只调整环向位置与悬高。
    yaw = np.zeros(count)
    tangent_offset = np.array([(item.lower[1] + item.upper[1]) / 2 - item.face_center[1] for item in side])
    minimum, maximum = np.array([side_mount_radial_limits(item, parameters).center_radius_bounds(radius)
                                 for item in side]).T
    fixed_indices = {index: fixed[item.instance_id] for index, item in enumerate(side) if item.instance_id in fixed}
    for index, placement in fixed_indices.items():
        actual_radius = radius + placement["radial_offset_mm"] + (side[index].lower[0] + side[index].upper[0]) / 2 - side[index].face_center[0]
        minimum[index] = maximum[index] = actual_radius
    if np.any(maximum < minimum - LAYOUT_CONFIG["geometry_tolerance_mm"]):
        return None
    maximum = np.maximum(maximum, minimum)
    radii_mm = maximum.copy()
    local_footprints = [item.footprint - [(item.lower[0] + item.upper[0]) / 2, item.face_center[1]] for item in side]
    ring_angles = (initialize_column_angles(partition, local_footprints, radii_mm, spanning[0], trial, rng)
                   if spanning else initialize_shadow_angles(partition, local_footprints, radii_mm, trial, rng))
    if spanning and ring_angles is None:
        return None
    if seed:
        ring_angles = np.array([math.radians(seed_placements[item.instance_id]["rotation_z_deg"]) for item in side])
        ring_angles += rng.normal(0, np.pi / LAYOUT_CONFIG["ordering_trials"], count)
    if ring_angles is None:
        ring_angles = rng.uniform(0, 2 * math.pi, count)
    if symmetric_pairs:
        ring_angles = initialize_pair_angles(ring_angles, partition, symmetric_pairs, trial, rng)
    for index, placement in fixed_indices.items():
        ring_angles[index] = math.radians(placement["rotation_z_deg"])
    stage("低位优先构造：环向试探与竖直落位", trial=trial, radius=radius)
    constructed = construct_bottom_up(side, partition, radii_mm, ring_angles, parameters,
                                      radius, fixed, symmetric_pairs, cancelled, preserve_angles=preserve_angles, priority=spanning)
    if constructed is None:
        return None
    angles, bottoms = constructed
    # 只有实际高度交叠的星对需要水平分离；名义层号不限制其他方位的低处空隙。
    pairs = [pair for pair in itertools.combinations(range(count), 2)
             if min(bottoms[pair[0]] + dimensions[pair[0], 2], bottoms[pair[1]] + dimensions[pair[1], 2])
             > max(bottoms[pair[0]], bottoms[pair[1]]) + LAYOUT_CONFIG["geometry_tolerance_mm"]]
    # 筒高由完整安装区域决定，质心 Z 不作为硬约束抬高筒体。
    top_suspension = max(parameters.min_suspension_mm, top.face_center[2] - top.lower[2]) if top else 0.0
    if top and top.instance_id in fixed:
        top_suspension = fixed[top.instance_id]["suspension_mm"]
    if top_suspension > parameters.max_suspension_mm and (not top or top.instance_id not in fixed):
        return None
    required_tops = [float(installation_region(original, fixed[original.instance_id]["model_to_global_matrix"])[:, 2].max())
                     if original.instance_id in fixed else bottoms[index] + installation_offsets(original)[1]
                     for index, original in enumerate(side)]
    height = float(max(parameters.min_height_mm, max(required_tops) - base_height))
    top_angle = 0.0
    top_bottom = base_height + height + top_suspension - (top.face_center[2] - top.lower[2]) if top else base_height + height
    top_placement = make_placement(top, len(partition), top_angle, [0, 0], top_bottom, "top") if top else None
    if top and top.instance_id in fixed:
        top_placement = fixed[top.instance_id]
    top_moment = top.mass * np.asarray(top_placement["center_of_mass_mm"])[:2] if top else np.zeros(2)
    masses = np.array([item.mass for item in side])
    total_mass = masses.sum() + (top.mass if top else 0.0)
    offsets = np.array([item.center[:2] - (item.lower[:2] + item.upper[:2]) / 2 for item in side])
    radii = radii_mm / scale
    half = dimensions[:, :2] / 2 / scale
    pair_indices = np.array(pairs, dtype=int).reshape(-1, 2)
    ring_pairs = np.array(pairs, dtype=int).reshape(-1, 2)

    # 安装面均径向朝内：以实际矩形的环向顺序构造不碰撞初值，再交给整体配平连续优化。
    # 先为每层单独求可行位置，避免重叠初值让带 max 的分离轴约束停在不可行局部点。

    def unpack(values):
        """将优化向量转换为归一化矩形中心、朝向单位向量及质量加权平面质心。"""
        full = coordinates.expand(values[:coordinate_size])
        theta, radial = full[:count], full[count:]
        rotation = theta + yaw
        cosine, sine = np.cos(rotation), np.sin(rotation)
        axes = np.stack([np.column_stack([cosine, sine]), np.column_stack([-sine, cosine])], axis=1)
        centers = radial[:, None] * np.column_stack([np.cos(theta), np.sin(theta)]) + tangent_offset[:, None] / scale * axes[:, 1]
        centers_of_mass = centers + (offsets[:, 0, None] * axes[:, 0] + offsets[:, 1, None] * axes[:, 1]) / scale
        center = ((masses[:, None] * centers_of_mass).sum(axis=0) + top_moment / scale) / total_mass
        return centers, axes, center

    def constraints(values):
        """返回每对矩形分离轴间隙及整体中轴半径余量，全部非负才满足约束。"""
        if cancelled():
            raise InterruptedError("任务已取消")
        centers, axes, center = unpack(values)
        residuals = [parameters.axis_radius_mm / scale - np.linalg.norm(center)]
        residuals.extend(fixed_residuals / scale)
        if len(ring_pairs):
            full = coordinates.expand(values[:coordinate_size])
            local = local_angular_bounds(local_footprints, full[count:] * scale)
            middle = full[:count] + local.mean(axis=1)
            widths = (local[:, 1] - local[:, 0]) / 2
            first, second = ring_pairs.T
            separation = np.abs((middle[first] - middle[second] + math.pi) % (2 * math.pi) - math.pi)
            residuals.extend((separation - widths[first] - widths[second]) * radius / scale)
        if len(pair_indices) and fixed_indices:
            first, second = pair_indices[:, 0], pair_indices[:, 1]
            directions = np.concatenate([axes[first], axes[second]], axis=1)
            difference = centers[second] - centers[first]
            projected = np.abs(np.einsum("pi,pki->pk", difference, directions))
            first_extent = np.sum(np.abs(np.einsum("pji,pki->pkj", axes[first], directions)) * half[first, None, :], axis=2)
            second_extent = np.sum(np.abs(np.einsum("pji,pki->pkj", axes[second], directions)) * half[second, None, :], axis=2)
            planar = np.max(projected - first_extent - second_extent, axis=1) - gap / scale
            residuals.extend(planar)
        return np.asarray(residuals)

    def objective(values):
        """最小化圆截面内质心偏离并轻度鼓励径向靠舱，返回无量纲目标。"""
        _, _, center = unpack(values)
        return float(center @ center + 1e-8 * np.sum(coordinates.expand(values[:coordinate_size])[count:] ** 2))

    def balance_constraints(values):
        """贯穿初值先在无碰撞区域内最小化质心误差，避开重复硬质心限导致的不可行起点；最终仍按原阈值验收。"""
        residuals = constraints(values)
        return residuals[1:] if spanning else residuals

    initial = coordinates.reduce(np.concatenate([angles, radii]))
    variable_bounds = coordinates.bounds(minimum / scale, maximum / scale)
    for index, placement in fixed_indices.items():
        column = coordinates.mapping[index]
        angle = math.radians(placement["rotation_z_deg"]) - coordinates.offsets[index]
        # 用初始共享相位的等价角，避免 0°/360° 对置配对误判不同锁定值。
        angle += round((initial[column] - angle) / (2 * math.pi)) * 2 * math.pi
        initial[column] = angle
        variable_bounds[column] = (angle, angle)
    initial_residuals = constraints(initial)
    if len(initial_residuals) > 1 and np.min(initial_residuals[1:]) < 0:
        def separate_objective(values):
            """先消除同层几何穿透，保持本层安装面/悬高边界，为整体配平提供无碰撞起点。"""
            residuals = constraints(values)[1:]
            return float(np.sum(np.minimum(residuals, 0.0) ** 2))

        stage("数值优化：消除包络重叠", trial=trial, radius=radius)
        separated = minimize(separate_objective, initial, method="L-BFGS-B",
                             bounds=variable_bounds,
                             options={"maxiter": LAYOUT_CONFIG["local_iterations"], "ftol": 1e-12})
        initial = separated.x
        if np.min(constraints(initial)[1:]) < -LAYOUT_CONFIG["geometry_tolerance_mm"] / scale:
            return None

    # 保留已经可行的低位构造，避免后续配平微调破坏紧凑排列后把原解一起丢掉。
    initial_candidate = None
    initial_centers, _, initial_com = unpack(initial)
    if np.linalg.norm(initial_com) * scale <= parameters.axis_radius_mm + LAYOUT_CONFIG["geometry_tolerance_mm"]:
        initial_candidate = settled_candidate(side, top, partition, radius, parameters, initial_centers * scale,
            coordinates.expand(initial[:coordinate_size])[:count], original_models, symmetric_pairs,
            fixed_override=fixed, priority=spanning)
        if (initial_candidate is not None and not soft_pairs
                and initial_candidate["validation"]["radial_com_mm"] <= LAYOUT_CONFIG["geometry_tolerance_mm"]):
            return initial_candidate
    stage("数值优化：求解布局约束", trial=trial, radius=radius)
    solution = minimize(
        objective, initial, method="SLSQP",
        bounds=variable_bounds,
        constraints={"type": "ineq", "fun": balance_constraints},
        options={"maxiter": LAYOUT_CONFIG["local_iterations"], "ftol": 1e-12},
    )
    centers, _, _ = unpack(solution.x)
    solution_values = coordinates.expand(solution.x[:coordinate_size])
    candidate = settled_candidate(side, top, partition, radius, parameters, centers * scale,
                                  solution_values[:count], original_models, symmetric_pairs,
                                  fixed_override=fixed, priority=spanning)
    best_values = solution.x
    if initial_candidate is not None and (candidate is None or candidate_order_key(initial_candidate) <= candidate_order_key(candidate)):
        candidate, best_values = initial_candidate, initial
    if not soft_pairs:
        return candidate

    # 软约束不锁定分组、姿态或共同下沉；保留原结果，以真实下沉后的主要指标决定是否接受改善。
    source_rotations = np.array([item.source_to_envelope[:3, :3]
                                / np.linalg.norm(item.source_to_envelope[:3, :3], axis=0) for item in side])
    face_offsets = np.array([item.face_center[:2] - (item.lower[:2] + item.upper[:2]) / 2 for item in side])

    def symmetry_objective(values):
        """最小化安装点及姿态的半周偏差；本次固定底高，最终高度差仍由下沉后完整评分处理。"""
        xy, axes, _ = unpack(values)
        full = coordinates.expand(values[:coordinate_size])
        positions = np.column_stack((xy * scale + face_offsets[:, 0, None] * axes[:, 0]
                                     + face_offsets[:, 1, None] * axes[:, 1],
                                     [bottoms[index] + item.face_center[2] - item.lower[2]
                                      for index, item in enumerate(side)]))
        rotations = np.array([rotation_z(angle) for angle in full[:count]]) @ source_rotations
        return soft_symmetry_penalty(positions, rotations, soft_pairs, scale)

    com_limit = min(parameters.axis_radius_mm / scale,
                    np.linalg.norm(unpack(best_values)[2])
                    + (LAYOUT_CONFIG["objective_tolerance_mm"] - LAYOUT_CONFIG["geometry_tolerance_mm"]) / scale)

    def refinement_constraints(values):
        """保留碰撞及中轴硬约束，并将水平质心恶化限制在主要指标接近阈值内。"""
        return np.append(constraints(values), com_limit - np.linalg.norm(unpack(values)[2]))

    stage("数值优化：对称性精调", trial=trial, radius=radius)
    refined = minimize(symmetry_objective, best_values, method="SLSQP", bounds=variable_bounds,
                       constraints={"type": "ineq", "fun": refinement_constraints},
                       options={"maxiter": LAYOUT_CONFIG["local_iterations"], "ftol": 1e-12})
    refined_centers, _, _ = unpack(refined.x)
    improved = settled_candidate(side, top, partition, radius, parameters, refined_centers * scale,
                                 coordinates.expand(refined.x[:coordinate_size])[:count], original_models, symmetric_pairs,
                                 fixed_override=fixed, priority=spanning)
    valid = [item for item in (candidate, improved) if item is not None]
    return min(valid, key=candidate_order_key) if valid else None


def settled_candidate(side, top, partition, radius, parameters, centers, angles, original_models, symmetric_pairs, fixed_override=None, *, priority=()):
    """沿用构造的priority落位顺序，确定筒高/顶星后完整验收并发布；失败返回None，不发布局部解。"""
    dimensions = np.array([item.upper - item.lower for item in side])
    base_height = parameters.installation_base.height_mm
    fixed = fixed_override if fixed_override is not None else expand_fixed_groups(original_models, parameters, radius, parameters.min_height_mm)
    layer_ids = {index: level for level, group in enumerate(partition) for index in group}
    top_suspension = max(parameters.min_suspension_mm, top.face_center[2] - top.lower[2]) if top else 0.0
    if top and top.instance_id in fixed:
        top_suspension = fixed[top.instance_id]["suspension_mm"]
    stage("构造中逐星竖直落位", message_key="layout-compaction",
          message=f"{len(side)}颗侧星逐一落至低位，"
                  + ("再放置顶星并完整验收" if top is not None else "再进行完整验收"))
    bottoms = settle_installation_layers(side, partition, centers, angles, parameters, radius, fixed, symmetric_pairs, priority=priority)
    if bottoms is None:
        return None
    originals = {item.instance_id: item for item in original_models}
    required_tops = [float(installation_region(originals[item.instance_id], fixed[item.instance_id]["model_to_global_matrix"])[:, 2].max())
                     if item.instance_id in fixed else bottoms[index] + installation_offsets(item)[1]
                     for index, item in enumerate(side)]
    height = float(max(parameters.min_height_mm, max(required_tops) - base_height))
    if height > parameters.max_height_mm + LAYOUT_CONFIG["geometry_tolerance_mm"]:
        return None
    height = min(height, parameters.max_height_mm)
    placements = [make_placement(item, int(layer_ids[index]), angles[index],
                                 centers[index], float(bottoms[index]), "side")
                  for index, item in enumerate(side)]
    final_fixed = expand_fixed_groups(original_models, parameters, radius, height)
    for index, placement in enumerate(placements):
        if placement["instance_id"] in final_fixed:
            placements[index] = {**final_fixed[placement["instance_id"]], "layer": placement["layer"]}
    for placement in placements:
        point = placement["installation_face_center_mm"]
        if placement["mount"] == "top":
            placement["suspension_mm"] = float(point[2] - base_height - height)
        else:
            model = originals[placement["instance_id"]]
            transform = np.asarray(placement["model_to_global_matrix"]) @ np.linalg.inv(model.source_to_envelope)
            vertices = model.vertices @ transform[:3, :3].T + transform[:3, 3]
            placement["suspension_mm"] = directional_suspension(vertices, model.faces, placement["installation_face_normal"], radius)
            placement["radial_offset_mm"] = float(np.linalg.norm(point[:2]) - radius)
            placement["suspension_reference"] = "envelope_contact_normal"
    physical_layers = assign_physical_layers(placements, originals, radius,
        [(side[a].instance_id, side[b].instance_id) for a, b in symmetric_pairs])
    if physical_layers > len(partition):
        return None
    candidate = {"radius_mm": radius, "height_mm": height, "placements": placements,
                 "fairing_radius_mm": parameters.fairing_radius_mm,
                 "axis_radius_mm": parameters.axis_radius_mm,
                 "side_layer_count": physical_layers, "algorithm": "cp-sat-alns-v2",
                 "packing_method": "bottom_up_vertical_v1", **geometry_metadata(parameters)}
    if any(not group.hard_constraint for group in parameters.fixed_groups):
        candidate["fixed_constraint_stage"] = "released" if parameters._release_soft_fixed else "preferred"
    if top:
        # 顶星使用侧星实际落位后的投影与高度；不以尚未下降的名义层高提前淘汰。
        height = float(max(candidate["height_mm"],
                           top_clearance_height(side, top, centers, angles, bottoms, top_suspension, base_height)))
        if height > parameters.max_height_mm + LAYOUT_CONFIG["geometry_tolerance_mm"]:
            return None
        height = min(height, parameters.max_height_mm)
        top_bottom = base_height + height + top_suspension - (top.face_center[2] - top.lower[2])
        top_placement = make_placement(top, candidate["side_layer_count"], 0.0, [0, 0], top_bottom, "top")
        final_fixed = expand_fixed_groups(original_models, parameters, radius, height)
        top_placement = {**final_fixed.get(top.instance_id, top_placement), "layer": candidate["side_layer_count"]}
        top_placement["suspension_mm"] = float(top_placement["installation_face_center_mm"][2] - base_height - height)
        placements.append(top_placement)
        candidate["height_mm"] = height
    candidate["validation"] = validate_layout(candidate, original_models, parameters)
    if not candidate["validation"]["valid"]:
        return None
    stage("低位布局完整验收完成", message_key="layout-compaction",
          message=("侧星落位、顶星安装及完整验收通过" if top is not None else "侧星落位及完整验收通过")
                  + f"，筒高 {height:.3f} mm")
    publish_candidate(candidate)
    return candidate


def finalize_candidates(candidates, target):
    """按分层目标排序候选、限制返回数量并分配稳定的布局标识。"""
    result = rank_candidates(list(candidates.values()))[:target]
    for index, item in enumerate(result):
        item["candidate_id"] = f"layout-{index + 1}"
    return result


def attempt_rng(radius, layer_count, partition, trial, purpose=0, *, random_seed):
    """用任务种子和尝试标识创建独立随机源；同一输入可复现，不读取或修改全局随机状态。"""
    tokens = [
        int(random_seed),
        int(purpose),
        int(round(float(radius) * 1_000_000)),
        int(layer_count),
        int(trial),
    ]
    for group in partition:
        tokens.extend([len(group), *map(int, group)])
    return np.random.default_rng(np.random.SeedSequence(tokens))


def radius_scan_values(maximum_radius, minimum_radius, step):
    """按固定步长返回降序半径网格，并始终包含可行上限和用户下限。"""
    tolerance = LAYOUT_CONFIG["geometry_tolerance_mm"]
    maximum = float(maximum_radius)
    minimum = float(minimum_radius)
    interval = maximum - minimum
    if interval <= tolerance:
        return np.array([minimum], dtype=float)
    count = int(math.floor(interval / float(step) + tolerance))
    values = maximum - np.arange(count + 1, dtype=float) * float(step)
    values = values[values >= minimum - tolerance]
    values = np.append(values, minimum)
    return np.unique(np.clip(values, minimum, maximum))[::-1]


@observed("求解固定策略阶段")
def optimize_fixed_stage(satellites, parameters, report, cancelled, *, attempt_runner=None, candidate_report=None):
    """兼容领域调用入口；统一委托 A+B 调度，保留取消结果和有序执行器协议。"""
    from app.domain.layout_hybrid import optimize_hybrid
    return optimize_hybrid(satellites, parameters, report, cancelled,
                           attempt_runner=attempt_runner, candidate_report=candidate_report)


@observed("规划布局搜索")
def optimize_layout(satellites, parameters, report, cancelled, *, attempt_runner=None, candidate_report=None):
    """执行 CP-SAT + 连续修复 + ALNS；软固定策略共享预算并比较最终 Pareto 结果。"""
    return optimize_fixed_stage(satellites, parameters, report, cancelled,
                                attempt_runner=attempt_runner, candidate_report=candidate_report)
