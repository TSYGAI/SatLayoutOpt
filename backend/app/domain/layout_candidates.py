"""文件说明：按下沉后的高低布置、安装轴向和环向顺序归并布局候选；依赖统一配置，不执行求解或写入。

尺寸和环向间距属于同一结构内的优化变量；整体旋转、同型实例交换及原分组标签不产生新结构。
"""

import math
from functools import cmp_to_key

import numpy as np

from app.domain.layout_config import LAYOUT_CONFIG
from app.domain.layout_geometry import rotation_z


# 用户要求的“基本相同”比较阈值为 1 mm。
OBJECTIVE_TOLERANCE_MM = 1.0


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
    """返回候选的原始目标值，顺序为高度、半径、质心径向距离和质心高度。"""
    validation = candidate["validation"]
    center = validation["center_of_mass_mm"]
    radial = validation.get("radial_com_mm", math.hypot(center[0], center[1]))
    return candidate["height_mm"], -candidate["radius_mm"], radial, center[2]


def compare_candidates(left, right):
    """按用户指定的优先级比较两个候选，返回适用于 sorted 的三态结果。"""
    left_height, left_radius, left_radial, left_center_z = candidate_rank(left)
    right_height, right_radius, right_radial, right_center_z = candidate_rank(right)

    height_delta = right_height - left_height
    if abs(height_delta) >= OBJECTIVE_TOLERANCE_MM:
        return -1 if height_delta > 0 else 1
    radius_delta = right_radius - left_radius
    if abs(radius_delta) >= OBJECTIVE_TOLERANCE_MM:
        return -1 if radius_delta > 0 else 1
    radial_delta = right_radial - left_radial
    if abs(radial_delta) >= OBJECTIVE_TOLERANCE_MM:
        return -1 if radial_delta > 0 else 1
    if left_center_z != right_center_z:
        return -1 if left_center_z < right_center_z else 1
    return 0


candidate_order_key = cmp_to_key(compare_candidates)


def retain_candidate(candidates, candidate):
    """将已验收候选归入结构集合；原位更新字典，同结构只保留目标更优的一组，返回是否新增结构。"""
    signature = candidate_signature(candidate)
    previous = candidates.get(signature)
    if previous is None or compare_candidates(candidate, previous) < 0:
        candidates[signature] = candidate
    return previous is None
