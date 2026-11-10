"""文件说明：提供罩体凸包边界与真实三角包络的筒体边界及连续下落扫掠，保留实际空隙和高度关系。

凸包仍包住完整安全网格，不缩小安全余量；按分段高度裁切棱边，检查锥面相交、
截面内部和轴线包含，避免把不同高度的径向极值拼成不存在的竖直棱柱。
"""

from dataclasses import dataclass
import math

import numpy as np
from scipy.spatial import ConvexHull
from shapely.geometry import MultiPoint, Point


@dataclass(frozen=True)
class BoundaryHull:
    """保存三维凸包支撑点、无向棱边与外侧半空间，全部坐标均为世界毫米。"""

    vertices: np.ndarray
    edges: np.ndarray
    equations: np.ndarray
    surface_vertices: np.ndarray | None = None
    surface_faces: np.ndarray | None = None


def envelope_hull(vertices, surface_faces=None):
    """建立罩体外包凸体并可选保留真实表面供内障碍检查；退化几何由 Qhull 抛错，不收缩或扰动。"""
    vertices = np.asarray(vertices, dtype=float)
    hull = ConvexHull(vertices)
    indices = np.unique(hull.simplices)
    mapping = np.empty(len(vertices), dtype=int)
    mapping[indices] = np.arange(len(indices))
    faces = mapping[hull.simplices]
    edges = np.concatenate((faces[:, [0, 1]], faces[:, [1, 2]], faces[:, [2, 0]]))
    edges = np.unique(np.sort(edges, axis=1), axis=0)
    return BoundaryHull(vertices[indices], edges, hull.equations,
                        vertices if surface_faces is not None else None, surface_faces)


def swept_hull(hull, drop):
    """返回整段竖直平移的扫掠凸体；包含从零到 drop 的每一个位置，禁止穿过中间障碍后落到空区。"""
    if drop == 0:
        return hull
    if hull.surface_faces is not None:
        vertices, faces = hull.surface_vertices, hull.surface_faces
        count = len(vertices)
        edges = np.concatenate((faces[:, [0, 1]], faces[:, [1, 2]], faces[:, [2, 0]]))
        edges = np.unique(np.sort(edges, axis=1), axis=0)
        left, right = edges.T
        sides = np.concatenate((np.column_stack((left, right, right + count)),
                                np.column_stack((left, right + count, left + count))))
        return envelope_hull(np.concatenate((vertices, vertices - [0.0, 0.0, drop])),
                             np.concatenate((faces, faces + count, sides)))
    return envelope_hull(np.concatenate((hull.vertices, hull.vertices - [0.0, 0.0, drop])))


def plane_points(hull, height):
    """返回凸体与水平面的交点，包含原有共面顶点及跨平面棱边交点。"""
    points = hull.vertices[hull.vertices[:, 2] == height]
    first, second = hull.vertices[hull.edges[:, 0]], hull.vertices[hull.edges[:, 1]]
    crosses = ((first[:, 2] < height) & (second[:, 2] > height)
               | (first[:, 2] > height) & (second[:, 2] < height))
    first, second = first[crosses], second[crosses]
    fraction = (height - first[:, 2]) / (second[:, 2] - first[:, 2])
    return np.concatenate((points, first + fraction[:, None] * (second - first)))


def outer_clearance(hull, sections):
    """按每段锥/柱裁切三维凸体，返回最小罩内径向余量；检查段连接处，负数表示越界。"""
    from app.domain.layout_space import section_radius
    from app.compute.cancellation import check_cancelled
    lower, upper = hull.vertices[:, 2].min(), hull.vertices[:, 2].max()
    margins = []
    for section in sections:
        check_cancelled()
        start, end = max(lower, section["bottom_mm"]), min(upper, section["top_mm"])
        if start > end:
            continue
        vertices = hull.vertices[(hull.vertices[:, 2] >= start) & (hull.vertices[:, 2] <= end)]
        points = np.concatenate((vertices, plane_points(hull, start), plane_points(hull, end)))
        radii = section_radius(section, points[:, 2])
        margins.append(float(np.min(radii - np.linalg.norm(points[:, :2], axis=1))))
    return min(margins, default=-math.inf)


def _clipped_edges(hull, lower, upper):
    """把凸体棱边裁切到高度区间，返回端点数组；水平边只在所属高度有效。"""
    first, second = hull.vertices[hull.edges[:, 0]], hull.vertices[hull.edges[:, 1]]
    direction = second - first
    vertical = direction[:, 2] != 0
    low, high = np.zeros(len(first)), np.ones(len(first))
    crossings = np.column_stack(((lower - first[vertical, 2]) / direction[vertical, 2],
                                 (upper - first[vertical, 2]) / direction[vertical, 2]))
    low[vertical] = np.maximum(0, crossings.min(axis=1))
    high[vertical] = np.minimum(1, crossings.max(axis=1))
    valid = (low <= high) & (vertical | ((first[:, 2] >= lower) & (first[:, 2] <= upper)))
    return first[valid] + low[valid, None] * direction[valid], first[valid] + high[valid, None] * direction[valid]


def _edge_radial_minimum(first, second, slope, intercept):
    """解析棱边上 norm(x,y)+slope*z-intercept 的最小值，包含内部极值，不能仅检查端点。"""
    if not len(first):
        return math.inf
    direction = second - first
    a = np.sum(direction[:, :2] ** 2, axis=1)
    b = np.sum(first[:, :2] * direction[:, :2], axis=1)
    m = slope * direction[:, 2]
    possible = (a > 0) & (a > m * m)
    points = [first, second]
    if np.any(possible):
        # 二维叉积写法避免近共线时 c-b²/a 的灾难性消减。
        cross = first[possible, 0] * direction[possible, 1] - first[possible, 1] * direction[possible, 0]
        squared = cross * cross / a[possible]
        t = (-b[possible] / a[possible]
             - m[possible] * np.sqrt(squared / (a[possible] * (a[possible] - m[possible] ** 2))))
        points.append(first[possible] + np.clip(t, 0, 1)[:, None] * direction[possible])
    values = np.concatenate(points)
    return float(np.min(np.linalg.norm(values[:, :2], axis=1) + slope * values[:, 2] - intercept))


def inner_clearance(hull, obstacle, tolerance):
    """返回凸体在有限锥/柱内部的最小径向余量；同时检查棱边、裁切面和轴线包含，穿透为负。"""
    if hull.surface_faces is not None:
        from app.domain.layout_contact import mesh_inner_clearance
        return mesh_inner_clearance(hull.surface_vertices, hull.surface_faces, obstacle, tolerance)
    from app.domain.layout_space import section_radius
    lower = max(float(hull.vertices[:, 2].min()), obstacle["bottom_mm"])
    upper = min(float(hull.vertices[:, 2].max()), obstacle["top_mm"])
    if upper - lower <= tolerance:
        return math.inf
    slope = -(obstacle["upper_radius_mm"] - obstacle["lower_radius_mm"]) / (obstacle["top_mm"] - obstacle["bottom_mm"])
    intercept = obstacle["lower_radius_mm"] + slope * obstacle["bottom_mm"]
    first, second = _clipped_edges(hull, lower, upper)
    margins = [_edge_radial_minimum(first, second, slope, intercept)]
    for height in (lower, upper):
        points = plane_points(hull, height)
        if len(points):
            distance = MultiPoint(points[:, :2]).convex_hull.distance(Point(0, 0))
            margins.append(distance - section_radius(obstacle, height))
    # norm 在轴线上不可微：单独求轴线在凸体中的区间，覆盖障碍被整个包住等情况。
    normal, offset = hull.equations[:, 2], hull.equations[:, 3]
    horizontal = np.abs(normal) <= np.finfo(float).eps
    if not np.any(offset[horizontal] > tolerance):
        positive, negative = normal > np.finfo(float).eps, normal < -np.finfo(float).eps
        low = max(lower, np.max(-offset[negative] / normal[negative], initial=-math.inf))
        high = min(upper, np.min(-offset[positive] / normal[positive], initial=math.inf))
        if low <= high:
            margins.append(slope * (low if slope >= 0 else high) - intercept)
    return float(min(margins))
