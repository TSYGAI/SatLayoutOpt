"""文件说明：硬对称采用原子分组和共享变量，软对称计算位姿偏差；独立验收最终刚性位姿。

依赖布局配置中的几何容差；仅处理绕安装筒 Z 轴的半周旋转，不读写模型、HTTP 或持久化数据。
奇数类型留一颗自由；指定顶部卫星时优先让其作为该类型的自由单颗。
"""

import numpy as np

from app.domain.layout_config import LAYOUT_CONFIG


def symmetry_pairs(satellites, parameters, *, include_top=True, mode="hard"):
    """按模式和实例顺序返回同类侧挂索引对；仅硬对称拒绝偶数类型取单颗顶部。

    satellites 含完整实例时默认识别顶部自由单颗；已剔除顶部的侧挂列表必须传 include_top=False。
    """
    enabled = {item.record_id for item in parameters.satellites
               if item.symmetry_enabled and item.symmetry_mode == mode}
    groups = {}
    top_index = next((i for i, item in enumerate(satellites)
                      if include_top and parameters.top_enabled and item.record_id == parameters.top_record_id), None)
    for index, item in enumerate(satellites):
        if item.record_id in enabled:
            groups.setdefault(item.record_id, []).append(index)
    pairs = []
    for indices in groups.values():
        if top_index in indices:
            if mode == "hard" and len(indices) % 2 == 0:
                raise ValueError("启用两两对称的偶数数量类型不能单独取一颗放在顶部；请更换顶部类型或关闭该类型对称")
            indices = [index for index in indices if index != top_index]
        pairs.extend(zip(indices[::2], indices[1::2]))
    return pairs


def soft_symmetry_penalty(points, rotations, pairs, scale):
    """返回平均软对称偏差；安装点半周位置差按罩半径归一化，姿态差为 sin²(转角差/2)。

    points 为毫米安装点，rotations 为单位旋转矩阵；同高、等距、半周对应时为零，缺少配对时为零。
    函数仅计算偏差，不决定可行性，不修改输入；连续搜索和独立验收共用同一度量。
    """
    if not pairs:
        return 0.0
    indices = np.asarray(pairs, dtype=int)
    first, second = indices[:, 0], indices[:, 1]
    half_turn = np.diag([-1.0, -1.0, 1.0])
    displacement = (points[second] - points[first] @ half_turn) / scale
    attitude = rotations[second] - half_turn @ rotations[first]
    return float(np.mean(np.sum(displacement ** 2, axis=1) + np.sum(attitude ** 2, axis=(1, 2)) / 8.0))


def soft_symmetry_metrics(placements, satellites, parameters):
    """从最终模型矩阵重算软对称偏差及配对数；不把偏差作为违规，不信任缓存展示坐标。"""
    pairs = symmetry_pairs(satellites, parameters, mode="soft")
    if not pairs:
        return {"soft_symmetry_pair_count": 0, "soft_symmetry_penalty": 0.0}
    by_id = {item["instance_id"]: item for item in placements}
    points, rotations = [], []
    for model in satellites:
        placement = by_id.get(model.instance_id)
        if placement is None:
            return {"soft_symmetry_pair_count": len(pairs), "soft_symmetry_penalty": 0.0}
        matrix = np.asarray(placement["model_to_global_matrix"], dtype=float)
        transform = matrix @ np.linalg.inv(model.source_to_envelope)
        points.append(transform[:3, :3] @ model.face_center + transform[:3, 3])
        rotations.append(matrix[:3, :3] / np.linalg.norm(matrix[:3, :3], axis=0))
    return {"soft_symmetry_pair_count": len(pairs), "soft_symmetry_penalty": soft_symmetry_penalty(
        np.asarray(points), np.asarray(rotations), pairs, parameters.fairing_radius_mm)}


def placement_units(indices, pairs):
    """把索引序列中的完整对称对合为原子单元，保留首成员出现顺序；落单实例保持独立。"""
    members = set(indices)
    partners = {index: partner for first, second in pairs
                for index, partner in ((first, second), (second, first))}
    visited = set()
    units = []
    for index in indices:
        if index in visited:
            continue
        partner = partners.get(index)
        unit = (index, partner) if partner in members else (index,)
        units.append(unit)
        visited.update(unit)
    return units


def initialize_pair_angles(angles, partition, pairs, trial, rng):
    """在每层半圆内分散对称组，再生成相对侧成员的角度；只调整配对实例，返回新初值。"""
    result = np.array(angles, copy=True)
    for group in partition:
        layer_pairs = [(first, second) for first, second in pairs if first in group]
        if trial:
            rng.shuffle(layer_pairs)
        phase = rng.uniform(0, 2 * np.pi) if trial else 0.0
        for offset, (first, second) in enumerate(layer_pairs):
            result[first] = phase + offset * np.pi / len(layer_pairs)
            result[second] = result[first] + np.pi
    return result


class SymmetricCoordinates:
    """以每对共享一个角度和半径的方式消除对称自由度；非配对实例仍独立优化。"""

    def __init__(self, count, pairs):
        """根据实例数和互不重复的索引对创建展开映射，不修改输入。"""
        followers = {second: first for first, second in pairs}
        self.count = count
        self.leaders = [index for index in range(count) if index not in followers]
        columns = {index: column for column, index in enumerate(self.leaders)}
        self.mapping = np.array([columns[followers.get(index, index)] for index in range(count)], dtype=int)
        self.offsets = np.array([np.pi if index in followers else 0.0 for index in range(count)])

    def expand(self, values):
        """将独立变量展开为每颗卫星的角度和半径，成对角差始终精确为 π。"""
        size = len(self.leaders)
        return np.concatenate((values[:size][self.mapping] + self.offsets, values[size:][self.mapping]))

    def reduce(self, values):
        """从全实例初值提取独立变量；配对第二颗的值由展开过程决定。"""
        return np.concatenate((values[:self.count][self.leaders], values[self.count:][self.leaders]))

    def bounds(self, minimum, maximum):
        """返回共享半径区间的交集与无界角度；配对模型须已选择相同安装姿态。"""
        return ([(None, None)] * len(self.leaders)
                + [(float(np.max(minimum[self.mapping == column])), float(np.min(maximum[self.mapping == column])))
                   for column in range(len(self.leaders))])


def symmetry_violations(placements, satellites, parameters):
    """由最终模型变换独立核对同类配对的半周刚性旋转，拒绝错高、不同径向距离或不同姿态。"""
    pairs = symmetry_pairs(satellites, parameters)
    by_id = {item["instance_id"]: item for item in placements}
    half_turn = np.diag([-1.0, -1.0, 1.0, 1.0])
    errors = []
    for first, second in pairs:
        left_model, right_model = satellites[first], satellites[second]
        left, right = by_id.get(left_model.instance_id), by_id.get(right_model.instance_id)
        if left is None or right is None:
            errors.append("对称卫星未完整装载")
            continue
        left_matrix = np.asarray(left["model_to_global_matrix"]) @ np.linalg.inv(left_model.source_to_envelope)
        right_matrix = np.asarray(right["model_to_global_matrix"]) @ np.linalg.inv(right_model.source_to_envelope)
        expected = half_turn @ left_matrix
        if (left["mount"] != "side" or right["mount"] != "side"
                or np.linalg.norm(right_matrix[:3, 3] - expected[:3, 3]) > LAYOUT_CONFIG["geometry_tolerance_mm"]
                or np.linalg.norm(right_matrix[:3, :3] - expected[:3, :3]) > LAYOUT_CONFIG["orientation_tolerance"]):
            errors.append(f"{left_model.name} 与 {right_model.name} 必须绕安装筒两两对称（同高、等距、相隔 180°）")
    return errors
