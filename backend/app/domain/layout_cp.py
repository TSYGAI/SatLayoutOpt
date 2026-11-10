"""文件说明：用 CP-SAT 生成低位构造的顺序分组，约束容量与硬关系并显式偏好层质量递减；实际高度由逐星落位决定。"""

import math
from dataclasses import replace

import numpy as np
from ortools.sat.python import cp_model

from app.domain.fixed_placements import expand_fixed_groups
from app.domain.fixed_pose import orient_fixed_instance
from app.domain.installation_region import installation_region
from app.domain.layout_config import LAYOUT_CONFIG
from app.domain.layout_mounts import mounting_variants
from app.domain.layout_radial import side_mount_radial_limits
from app.domain.layout_symmetry import symmetry_pairs


def model_capacity(model, radius, parameters, placement=None):
    """返回允许姿态中最小角宽和最小包络高度；这是结构构造的保守棱柱近似，不证明真实几何不可行。"""
    if placement:
        group = next(item for item in parameters.fixed_groups if item.group_id == placement["fixed_group_id"])
        variants = [orient_fixed_instance(model, group, placement)]
    else:
        variants = mounting_variants(model, "side")
    capacities = []
    for variant in variants:
        limits = side_mount_radial_limits(variant, parameters)
        if placement:
            # 手动姿态用已验收的实际悬高；自动悬高参考可能比真实筒/包络距离更保守。
            limits = replace(limits, min_suspension_mm=placement["suspension_mm"],
                             max_suspension_mm=placement["suspension_mm"])
            if group.manual_suspension_mm is not None:
                limits = replace(limits, min_suspension_mm=placement["radial_offset_mm"],
                                 max_suspension_mm=placement["radial_offset_mm"], mesh_faces=None, contact_segments=None)
        if limits.max_radius_mm < radius - LAYOUT_CONFIG["geometry_tolerance_mm"]:
            continue
        _, outer = limits.center_radius_bounds(radius)
        if placement:
            outer = radius + placement["radial_offset_mm"] + (variant.lower[0] + variant.upper[0]) / 2 - variant.face_center[0]
        corners = variant.footprint - [(variant.upper[0] + variant.lower[0]) / 2, variant.face_center[1]] + [outer, 0]
        angles = np.arctan2(corners[:, 1], corners[:, 0])
        capacities.append((float(np.ptp(angles)), float(variant.upper[2] - variant.lower[2])))
    if not capacities:
        return None
    return min(item[0] for item in capacities), min(item[1] for item in capacities)


def cp_partitions(side, all_models, parameters, radius, layer_count, seed, cancelled, *, limit=None, locked=None, spanning=()):
    """生成有限个容量可行的结构；spanning高星归底层且在每层预留角宽，locked锁定层号，UNKNOWN不证明无解。"""
    if cancelled():
        raise InterruptedError("任务已取消")
    fixed = expand_fixed_groups(all_models, parameters, radius, parameters.min_height_mm)
    capacities = [model_capacity(item, radius, parameters, fixed.get(item.instance_id)) for item in side]
    if any(value is None for value in capacities) or not 1 <= layer_count <= len(side):
        return []
    model = cp_model.CpModel()
    assignment = [model.new_int_var(0, layer_count - 1, f"layer_{i}") for i in range(len(side))]
    choices = [[model.new_bool_var(f"at_{i}_{level}") for level in range(layer_count)] for i in range(len(side))]
    angle_scale = LAYOUT_CONFIG["cp_angle_scale"]
    widths = [math.ceil(value[0] * angle_scale) for value in capacities]
    heights = [math.ceil(value[1]) for value in capacities]
    for i, row in enumerate(choices):
        model.add_exactly_one(row)
        for level, flag in enumerate(row):
            model.add(assignment[i] == level).only_enforce_if(flag)
        if locked and i in locked:
            model.add(assignment[i] == locked[i])
        if i in spanning:
            model.add(assignment[i] == 0)
    layer_heights = []
    for level in range(layer_count):
        model.add(sum(row[level] for i, row in enumerate(choices) if i not in spanning) >= 1)
        model.add(sum(widths[i] if i in spanning else widths[i] * row[level]
                      for i, row in enumerate(choices)) <= math.floor(2 * math.pi * angle_scale))
        height = model.new_int_var(0, max(heights), f"height_{level}")
        for i, row in enumerate(choices):
            if i not in spanning:
                model.add(height >= heights[i]).only_enforce_if(row[level])
        layer_heights.append(height)
    for first, second in symmetry_pairs(side, parameters, include_top=False):
        model.add(assignment[first] == assignment[second])
    fixed_levels = [(i, float(installation_region(item, fixed[item.instance_id]["model_to_global_matrix"])[:, 2].min()))
                    for i, item in enumerate(side) if item.instance_id in fixed]
    for i, a in fixed_levels:
        for j, b in fixed_levels:
            if a + LAYOUT_CONFIG["geometry_tolerance_mm"] < b:
                model.add(assignment[i] < assignment[j])
            elif abs(a - b) <= LAYOUT_CONFIG["geometry_tolerance_mm"]:
                model.add(assignment[i] == assignment[j])
    # 高度代理优先，随后同时减少上重下轻的质量差和重星层号；二者均不作可行性筛选。
    masses = [max(1, round(item.mass * LAYOUT_CONFIG["layer_mass_scale"])) for item in side]
    total_mass = sum(masses)
    layer_masses = [sum(masses[i] * row[level] for i, row in enumerate(choices)) for level in range(layer_count)]
    excesses = []
    for level in range(layer_count - 1):
        excess = model.new_int_var(0, total_mass, f"upper_mass_excess_{level}")
        model.add(excess >= layer_masses[level + 1] - layer_masses[level])
        excesses.append(excess)
    soft_bound = 2 * total_mass * layer_count + 1
    height_proxy = sum(layer_heights)
    if spanning:
        height_proxy = model.new_int_var(0, sum(heights), "column_packed_height")
        model.add(height_proxy >= sum(layer_heights))
        model.add(height_proxy >= max(heights[i] for i in spanning))
    model.minimize(height_proxy * soft_bound + sum(excesses)
                   + sum(mass * layer for mass, layer in zip(masses, assignment)))
    solver = cp_model.CpSolver()
    solver.parameters.num_search_workers = 1
    solver.parameters.random_seed = int(seed) % (2**31 - 1)
    solver.parameters.max_deterministic_time = LAYOUT_CONFIG["cp_deterministic_time"]
    result = []
    for _ in range(limit if limit is not None else LAYOUT_CONFIG["cp_partition_limit"]):
        if cancelled():
            raise InterruptedError("任务已取消")
        status = solver.solve(model)
        if status not in (cp_model.OPTIMAL, cp_model.FEASIBLE):
            break
        values = [solver.value(item) for item in assignment]
        result.append(tuple(tuple(i for i, value in enumerate(values) if value == level) for level in range(layer_count)))
        model.add_forbidden_assignments(assignment, [values])
    return result


def column_partition(side, all_models, parameters, radius, layer_count, seed, cancelled):
    """为单颗高星生成侧旁分层初值，返回(分组,高星索引)或None；硬对称高星及固定高星沿用普通路径。"""
    if layer_count < 2 or len(side) <= layer_count:
        return None
    capacities = [model_capacity(item, radius, parameters) for item in side]
    if any(value is None for value in capacities):
        return None
    tallest = max(range(len(side)), key=lambda i: (capacities[i][1], side[i].mass, side[i].instance_id))
    if capacities[tallest][1] <= min(value[1] for value in capacities) + LAYOUT_CONFIG["geometry_tolerance_mm"]:
        return None
    if any(tallest in pair for pair in symmetry_pairs(side, parameters, include_top=False)):
        return None
    fixed = expand_fixed_groups(all_models, parameters, radius, parameters.min_height_mm)
    if side[tallest].instance_id in fixed:
        return None
    partitions = cp_partitions(side, all_models, parameters, radius, layer_count, seed, cancelled, spanning=(tallest,))
    return (partitions[int(seed) % len(partitions)], (tallest,)) if partitions else None
