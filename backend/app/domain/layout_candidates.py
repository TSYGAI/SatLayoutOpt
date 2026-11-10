"""文件说明：保存高度/半径Pareto折中，同尺寸优先下重上轻，再比较质心与其他软偏好；不放宽硬约束。"""

import math

import numpy as np

from app.domain.layout_config import LAYOUT_CONFIG
from app.domain.layout_geometry import rotation_z


def mounting_orientation(placement):
    """返回去除环向方位和单位比例的安装轴向签名；正反翻转归入同结构，实际位姿及质量差异仍由验收和目标处理。"""
    matrix = np.asarray(placement["model_to_global_matrix"], dtype=float)[:3, :3]
    rotation = matrix / np.linalg.norm(matrix, axis=0)
    if placement["mount"] == "side":
        x, y = placement["installation_face_center_mm"][:2]
        angle = math.atan2(y, x)
    else:
        # 顶部绕竖轴旋转不改变安装姿态；固定选择首个具有水平投影的源轴，避免等长轴切换。
        axis = next(index for index in range(3)
                    if np.linalg.norm(rotation[:2, index]) > LAYOUT_CONFIG["geometry_tolerance_mm"])
        angle = math.atan2(rotation[1, axis], rotation[0, axis])
    normalized = rotation_z(-angle) @ rotation
    return tuple(np.round(np.abs(normalized), LAYOUT_CONFIG["candidate_orientation_decimals"]).flat)


def canonical_ring(placements):
    """按安装面方位返回循环顺序的最小表示；忽略起始方位与实例编号，保留不同类型和安装轴向的邻接顺序。"""
    ordered = []
    for placement in placements:
        x, y = placement["installation_face_center_mm"][:2]
        token = (placement["record_id"], mounting_orientation(placement))
        ordered.append((math.atan2(y, x), token))
    ring = tuple(token for _, token in sorted(ordered))
    return min(ring[index:] + ring[:index] for index in range(len(ring)))


def candidate_signature(candidate):
    """按实际底高分组和每组环向类型/姿态顺序生成结构签名；不将尺寸微调、标签改动或相位扰动计为新布局。

    底高仅用于确定从低到高的顺序及齐平关系，不编码绝对数值；相同结构交由目标排序保留更优尺寸。
    """
    tolerance = LAYOUT_CONFIG["geometry_tolerance_mm"]
    side = sorted((item for item in candidate["placements"] if item["mount"] == "side"),
                  key=lambda item: item["bottom_mm"])
    levels = []
    for placement in side:
        if not levels or placement["bottom_mm"] - levels[-1][0]["bottom_mm"] > tolerance:
            levels.append([])
        levels[-1].append(placement)
    top = tuple(sorted((item["record_id"], mounting_orientation(item))
                       for item in candidate["placements"] if item["mount"] == "top"))
    return tuple(canonical_ring(level) for level in levels), top


def candidate_rank(candidate):
    """返回原始目标值：高度、负半径、质心高度、质心径向距离；前两项用于同级 Pareto 判断。"""
    validation = candidate["validation"]
    center = validation["center_of_mass_mm"]
    radial = validation.get("radial_com_mm", math.hypot(center[0], center[1]))
    return candidate["height_mm"], -candidate["radius_mm"], center[2], radial


def compare_candidates(left, right):
    """用严格排序键比较；仅用于确定性展示/等尺寸局部择优，不能用来丢弃尺寸折中。"""
    a, b = candidate_order_key(left), candidate_order_key(right)
    return (a > b) - (a < b)


def candidate_order_key(candidate):
    """返回稳定排序键；尺寸相同时明确比较层质量反序数量和程度，再比较质心及其他软偏好。"""
    validation = candidate["validation"]
    rank = candidate_rank(candidate)
    return (*rank[:2], validation.get("layer_mass_inversions", 0), validation.get("layer_mass_excess_kg", 0.0), *rank[2:],
            candidate.get("fixed_constraint_stage") == "released",
            validation.get("soft_symmetry_penalty", 0.0))


def size_dominates(left, right):
    """判断高度不高且半径不小并至少一项严格改善，不用两两容差制造循环比较。"""
    a, b = candidate_rank(left)[:2], candidate_rank(right)[:2]
    return all(x <= y for x, y in zip(a, b)) and any(x < y for x, y in zip(a, b))


def rank_candidates(candidates):
    """按尺寸非支配层排序；每层先展示最低和最粗两端，再交错展示中间折中，等尺寸按次级目标。"""
    remaining = sorted(candidates, key=candidate_order_key)
    result, rank = [], 0
    while remaining:
        front = [item for item in remaining if not any(size_dominates(other, item) for other in remaining)]
        ordered = sorted(front, key=candidate_order_key)
        # 最粗端同尺寸时仍选质心较优的第一项，不能简单倒序颠倒次级目标。
        widest = min(ordered, key=lambda item: (-item["radius_mm"], candidate_order_key(item)))
        display = [ordered[0]] + ([widest] if widest is not ordered[0] else [])
        display.extend(item for item in ordered if all(item is not chosen for chosen in display))
        for item in display:
            item["pareto_rank"] = rank
        result.extend(display)
        front_ids = {id(item) for item in front}
        remaining = [item for item in remaining if id(item) not in front_ids]
        rank += 1
    return result


def retain_candidate(candidates, candidate):
    """原位更新有界候选档案；同结构允许多个尺寸折中，返回是否接受本次结果。"""
    signature = candidate_signature(candidate)
    related = [(key, item) for key, item in candidates.items() if key[0] == signature]
    for _, previous in related:
        if size_dominates(previous, candidate):
            return False
        if candidate_rank(previous)[:2] == candidate_rank(candidate)[:2] and compare_candidates(previous, candidate) <= 0:
            return False
    for key, previous in related:
        if size_dominates(candidate, previous) or candidate_rank(previous)[:2] == candidate_rank(candidate)[:2]:
            del candidates[key]
    key = (signature, candidate["height_mm"], candidate["radius_mm"])
    candidates[key] = candidate
    selected = rank_candidates(list(candidates.values()))[:LAYOUT_CONFIG["candidate_archive_limit"]]
    selected_ids = {id(item) for item in selected}
    for old_key in list(candidates):
        if id(candidates[old_key]) not in selected_ids:
            del candidates[old_key]
    return key in candidates
