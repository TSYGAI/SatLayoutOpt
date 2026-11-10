"""文件说明：从真实包络投影建立竖直避让关系和侧挂层次，供独立下落与最终验收共享；不要求同层齐平。"""

import numpy as np

from app.compute.cancellation import check_cancelled
from app.domain.layout_config import LAYOUT_CONFIG
from app.domain.layout_occlusion import angular_interval, angular_overlap


def vertical_relations(geometry, radius):
    """返回已分离模型的上下依赖及可消耗间隙；geometry 为位姿、XY凸包、底高、顶高四元组。

    星间碰撞继续沿用正式凸棱柱，侧挂另检查角投影遮挡。已重叠的输入由正式验收拒绝，
    此处只生成已有上下顺序的约束，禁止下落穿过另一颗后落到其下方。
    """
    tolerance = LAYOUT_CONFIG["geometry_tolerance_mm"]
    shadows = {p["instance_id"]: angular_interval(np.asarray(shape.exterior.coords))
               for p, shape, _, _ in geometry if p["mount"] == "side"}
    relations = []
    for index, left in enumerate(geometry):
        for right in geometry[index + 1:]:
            check_cancelled()
            a, b = left[0], right[0]
            shadow = (a["instance_id"] in shadows and b["instance_id"] in shadows
                      and angular_overlap(shadows[a["instance_id"]], shadows[b["instance_id"]])
                      > tolerance / max(radius, tolerance))
            collision = not left[1].intersection(right[1]).buffer(-tolerance).is_empty
            if not (shadow or collision):
                continue
            lower, upper = sorted((left, right), key=lambda entry: (entry[2], entry[0]["instance_id"]))
            gap = upper[2] - lower[3]
            if gap >= -tolerance:
                relations.append({"lower": lower[0]["instance_id"], "upper": upper[0]["instance_id"],
                                  "gap_mm": max(0.0, float(gap)),
                                  "code": "radial_occlusion" if shadow else "satellite_collision"})
    return relations


def assign_vertical_layers(placements, relations, pairs=()):
    """按实际上下依赖的最长链重编侧挂层，硬对称配对同层；原位更新位姿标签并返回层数。"""
    side = {p["instance_id"]: p for p in placements if p["mount"] == "side"}
    parent = {identifier: identifier for identifier in side}

    def root(identifier):
        """返回硬对称合组代表，压缩路径以保持编号确定。"""
        while parent[identifier] != identifier:
            parent[identifier] = parent[parent[identifier]]
            identifier = parent[identifier]
        return identifier

    for first, second in pairs:
        if first in side and second in side:
            parent[root(second)] = root(first)
    levels = {root(identifier): 0 for identifier in side}
    edges = [(root(item["lower"]), root(item["upper"])) for item in relations
             if item["lower"] in side and item["upper"] in side]
    for _ in range(len(levels)):
        changed = False
        for lower, upper in edges:
            if levels[upper] <= levels[lower]:
                levels[upper] = levels[lower] + 1
                changed = True
        if not changed:
            break
    else:
        if edges:
            raise ValueError("侧挂上下关系存在循环，无法定义实际层次")
    for identifier, placement in side.items():
        placement["layer"] = levels[root(identifier)]
    count = max(levels.values(), default=-1) + 1
    for placement in placements:
        if placement["mount"] == "top":
            placement["layer"] = count
    return count


def greatest_feasible_drops(bounds, edges):
    """求所有下落量同时最大的可行解：d[target] <= d[source] + gap，边权非负。

    从各自几何上界向下传播约束，等价于带超级源的最短路；包含零权硬对称循环，
    结果与遍历顺序无关，不用逐颗移动造成后处理顺序偏差。返回每个节点的最大下落量。
    """
    drops = np.asarray(bounds, dtype=float).copy()
    for _ in range(len(drops)):
        changed = False
        for source, target, gap in edges:
            if gap < 0:
                raise ValueError("竖直避让边权不能为负；输入必须已合法")
            limit = drops[source] + gap
            if drops[target] > limit:
                drops[target] = limit
                changed = True
        if not changed:
            return drops
    raise ValueError("独立下落约束传播未收敛")
