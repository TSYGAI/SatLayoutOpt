"""文件说明：计算正式包络角投影及普通/高星贯穿的环向初值；仅依赖NumPy和Shapely，不验收或读写。"""

import math

import numpy as np
from shapely.geometry import MultiPoint, Point


def angular_interval(points):
    """返回平面凸包投影的最小连续角区间（弧度）；包含原点时占满整周，区间允许越过 π。"""
    polygon = MultiPoint(np.asarray(points)[:, :2]).convex_hull
    if polygon.covers(Point(0, 0)):
        return -math.pi, math.pi
    coordinates = np.asarray(polygon.exterior.coords if polygon.geom_type == "Polygon" else polygon.coords)
    angles = np.unique(np.mod(np.arctan2(coordinates[:, 1], coordinates[:, 0]), 2 * math.pi))
    gaps = np.diff(np.r_[angles, angles[0] + 2 * math.pi])
    cut = int(np.argmax(gaps))
    start = float(angles[(cut + 1) % len(angles)])
    return start, start + 2 * math.pi - float(gaps[cut])


def angular_overlap(left, right):
    """返回周期角区间最大重叠长度；相接为零，分离为负，正确处理 0°/360° 接缝。"""
    middle = (left[0] + left[1] - right[0] - right[1]) / 2
    shift = round(middle / (2 * math.pi))
    return max(min(left[1], right[1] + k * 2 * math.pi)
               - max(left[0], right[0] + k * 2 * math.pi) for k in (shift - 1, shift, shift + 1))


def radial_shadow_overlap(left, right, tolerance, radius):
    """判断两个 (角区间,底高,顶高) 是否径向相挡；上下分层接触允许，长度容差换算为角容差。"""
    return (min(left[2], right[2]) - max(left[1], right[1]) > tolerance
            and angular_overlap(left[0], right[0]) > tolerance / max(radius, tolerance))


def local_angular_bounds(footprints, radii):
    """返回各定向凸包在给定盒心径向分量下的局部角区间；footprints 已扣除盒心 X 和安装点 Y。"""
    bounds = []
    for points, radius in zip(footprints, radii):
        angles = np.arctan2(points[:, 1], points[:, 0] + radius)
        bounds.append((float(angles.min()), float(angles.max())))
    return np.asarray(bounds)


def initialize_shadow_angles(partition, footprints, radii, trial, rng):
    """根据真实凸棱柱角宽分配同层环向间距；容量不足返回空，随后连续优化负责配平。"""
    bounds = local_angular_bounds(footprints, radii)
    widths = bounds[:, 1] - bounds[:, 0]
    angles = np.zeros(len(radii))
    for group in partition:
        order = list(group)
        if trial:
            rng.shuffle(order)
        slack = 2 * math.pi - sum(widths[index] for index in group)
        if slack < 0:
            return None
        cursor = rng.uniform(0, 2 * math.pi) if trial else 0.0
        for index in order:
            angles[index] = cursor - bounds[index, 0]
            cursor += widths[index] + slack / len(group)
    return angles


def initialize_column_angles(partition, footprints, radii, column, trial, rng):
    """让单颗高星占据共同方位，各小星组排在余下圆周；角宽不足返回None，随后仍需配平和正式验收。"""
    bounds = local_angular_bounds(footprints, radii)
    widths = bounds[:, 1] - bounds[:, 0]
    angles = np.zeros(len(radii))
    phase = rng.uniform(0, 2 * math.pi) if trial else 0.0
    angles[column] = phase - bounds[column].mean()
    for group in partition:
        order = [i for i in group if i != column]
        if not order:
            return None
        if trial:
            rng.shuffle(order)
        slack = 2 * math.pi - widths[column] - sum(widths[i] for i in order)
        if slack < 0:
            return None
        gap = slack / (len(order) + 1)
        cursor = phase + widths[column] / 2 + gap
        for index in order:
            angles[index] = cursor - bounds[index, 0]
            cursor += widths[index] + gap
    return angles
