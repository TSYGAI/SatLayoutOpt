"""文件说明：按正式三角包络计算侧挂方向的首次接触及有限筒体碰撞，保留安装脚之间的真实空隙。

侧挂悬高是沿安装面外法向反方向、相对圆柱侧壁首次接触位置的退让量。
径向接触采用完整侧挂投影；有限筒体的实体碰撞另按实际高度裁切三角面，不生成整体凸包。
"""

import math

import numpy as np

from app.compute.cancellation import check_cancelled


def surface_segments(vertices, faces, lower=-math.inf, upper=math.inf):
    """返回三角面在指定高度带内的边及裁切线段；只连接同一实际三角面的点，不填补面间空隙。"""
    check_cancelled()
    triangles = np.asarray(vertices, dtype=float)[faces]
    triangles = triangles[(triangles[:, :, 2].max(axis=1) >= lower)
                          & (triangles[:, :, 2].min(axis=1) <= upper)]
    first = triangles[:, [0, 1, 2]].reshape(-1, 3)
    second = triangles[:, [1, 2, 0]].reshape(-1, 3)
    delta = second - first
    low, high = np.zeros(len(first)), np.ones(len(first))
    vertical = delta[:, 2] != 0
    intervals = np.column_stack(((lower - first[vertical, 2]) / delta[vertical, 2],
                                 (upper - first[vertical, 2]) / delta[vertical, 2]))
    low[vertical] = np.maximum(0, intervals.min(axis=1))
    high[vertical] = np.minimum(1, intervals.max(axis=1))
    valid = (low <= high) & (vertical | ((first[:, 2] >= lower) & (first[:, 2] <= upper)))
    starts = [first[valid] + low[valid, None] * delta[valid]]
    ends = [first[valid] + high[valid, None] * delta[valid]]
    for height in (lower, upper):
        check_cancelled()
        if not math.isfinite(height):
            continue
        fractions = np.zeros(len(first))
        fractions[vertical] = (height - first[vertical, 2]) / delta[vertical, 2]
        crosses = (vertical & (fractions >= 0) & (fractions <= 1)).reshape(-1, 3)
        points = (first + fractions[:, None] * delta).reshape(-1, 3, 3)
        for left, right in ((0, 1), (1, 2), (2, 0)):
            keep = crosses[:, left] & crosses[:, right]
            starts.append(points[keep, left])
            ends.append(points[keep, right])
    return np.concatenate(starts), np.concatenate(ends)


def contact_offset(first, second, radius):
    """返回沿 +X 从筒外靠近时首次接触所需的平移；解析每条真实边内部的圆弧极值，无交会返回负无穷。"""
    check_cancelled()
    delta = second - first
    varying = delta[:, 1] != 0
    low, high = np.zeros(len(first)), np.ones(len(first))
    cuts = np.column_stack(((-radius - first[varying, 1]) / delta[varying, 1],
                            (radius - first[varying, 1]) / delta[varying, 1]))
    low[varying] = np.maximum(0, cuts.min(axis=1))
    high[varying] = np.minimum(1, cuts.max(axis=1))
    valid = (low <= high) & (varying | (np.abs(first[:, 1]) <= radius))
    if not np.any(valid):
        return -math.inf
    first, delta, low, high = first[valid], delta[valid], low[valid], high[valid]
    varying = delta[:, 1] != 0
    best = low.copy()
    stationary_y = (-radius * delta[varying, 0] * np.sign(delta[varying, 1])
                    / np.linalg.norm(delta[varying, :2], axis=1))
    best[varying] = np.clip((stationary_y - first[varying, 1]) / delta[varying, 1],
                            low[varying], high[varying])
    points = np.concatenate([first + fraction[:, None] * delta for fraction in (low, high, best)])
    return float(np.max(np.sqrt(np.maximum(radius * radius - points[:, 1] ** 2, 0)) - points[:, 0]))


def side_contact_offset(model, radius):
    """返回已侧挂定向模型的共面基准在首次接触时的径向坐标；不要求该基准落在筒壁。"""
    first, second = surface_segments(model.vertices - model.face_center, model.faces)
    return contact_offset(first, second, radius)


def directional_suspension(vertices, faces, normal, radius):
    """重算当前位姿沿安装面法向的侧挂退让量；水平法向缺失时抛 ValueError，不使用点击点代替。"""
    outward = -np.asarray(normal, dtype=float)
    outward /= np.linalg.norm(outward)
    horizontal = float(np.linalg.norm(outward[:2]))
    if horizontal <= np.finfo(float).eps:
        raise ValueError("侧挂安装方向没有水平分量，无法定义沿法向的筒壁悬高")
    axis = outward[:2] / horizontal
    rotation = np.array([[axis[0], axis[1], 0], [-axis[1], axis[0], 0], [0, 0, 1]])
    first, second = surface_segments(np.asarray(vertices) @ rotation.T, faces)
    check_cancelled()
    offset = contact_offset(first, second, radius)
    if not math.isfinite(offset):
        raise ValueError("正式包络沿安装方向与筒壁没有接触基准")
    return -offset / horizontal


def projected_axis_heights(vertices, faces):
    """返回实际三角面与Z轴的交点高度；退化投影由边距离覆盖，不构造跨空隙的投影面。"""
    check_cancelled()
    triangles = np.asarray(vertices)[faces]
    first = triangles[:, 0]
    a, b = triangles[:, 1] - first, triangles[:, 2] - first
    det = a[:, 0] * b[:, 1] - a[:, 1] * b[:, 0]
    usable = np.abs(det) > np.finfo(float).eps
    first, a, b, det = first[usable], a[usable], b[usable], det[usable]
    u = (first[:, 1] * b[:, 0] - first[:, 0] * b[:, 1]) / det
    v = (first[:, 0] * a[:, 1] - first[:, 1] * a[:, 0]) / det
    inside = (u >= 0) & (v >= 0) & (u + v <= 1)
    return (first[:, 2] + u * a[:, 2] + v * b[:, 2])[inside]


def mesh_inner_clearance(vertices, faces, obstacle, tolerance):
    """检查有限圆柱/圆锥与真实封闭网格；边内部极值、面穿轴及障碍被包住均计入，接触余量为零。"""
    from app.domain.layout_boundary import _edge_radial_minimum
    lower = max(float(vertices[:, 2].min()), obstacle["bottom_mm"])
    upper = min(float(vertices[:, 2].max()), obstacle["top_mm"])
    if upper - lower <= tolerance:
        return math.inf
    slope = -(obstacle["upper_radius_mm"] - obstacle["lower_radius_mm"]) / (obstacle["top_mm"] - obstacle["bottom_mm"])
    intercept = obstacle["lower_radius_mm"] + slope * obstacle["bottom_mm"]
    first, second = surface_segments(vertices, faces, lower, upper)
    margin = _edge_radial_minimum(first, second, slope, intercept)
    if np.all(vertices[:, :2].min(axis=0) <= 0) and np.all(vertices[:, :2].max(axis=0) >= 0):
        heights = projected_axis_heights(vertices, faces)
        heights = heights[(heights >= lower) & (heights <= upper)]
        if len(heights):
            margin = min(margin, float(np.min(slope * heights - intercept)))
        elif margin >= -tolerance:
            # 表面全在障碍外仍可能整个包住筒体，独立射线判内补齐该情况。
            import trimesh
            mesh = trimesh.Trimesh(vertices=vertices, faces=faces, process=False)
            if mesh.contains([[0.0, 0.0, (lower + upper) / 2]])[0]:
                margin = min(margin, slope * ((lower + upper) / 2) - intercept)
    return float(margin)


def projected_clearance(vertices, faces):
    """返回原点到真实包络投影的距离；用于径向必要条件，不以整体投影凸包封住凹槽。"""
    from app.domain.layout_boundary import _edge_radial_minimum
    if len(projected_axis_heights(vertices, faces)):
        return 0.0
    first, second = surface_segments(vertices, faces)
    return _edge_radial_minimum(first, second, 0.0, 0.0)
