"""文件说明：提供无 CAD 依赖的分段整流罩、筒体及基座空间边界，供固定预览和布局正式验收共用。

按高度关联罩半径并生成凸形罩体的线性许可；有正式面索引时按真实三角面检查筒体与基座，保留安装脚空隙。
世界原点在罩底，安装筒底为基座高度；本模块不修改模型、安装输入或历史矩阵。
"""

import math

import numpy as np
from shapely.geometry import MultiPoint, Point

from app.compute.cancellation import check_cancelled


def geometry_metadata(parameters):
    """从已解析参数提取独立几何元数据，供候选和前端展示复用，不写入派生连接半径。"""
    return {"installation_base": parameters.installation_base.model_dump(),
            "fairing_profile": parameters.fairing_profile}


def fairing_sections(profile):
    """将规范段列表转换为世界高度区间和两端半径；重新累计段高，不信任摘要。"""
    sections, bottom = [], 0.0
    for segment in profile["segments"]:
        top = bottom + segment["height_mm"]
        lower = segment.get("radius_mm", segment.get("lower_radius_mm"))
        upper = segment.get("radius_mm", segment.get("upper_radius_mm"))
        sections.append({"bottom_mm": bottom, "top_mm": top,
                         "lower_radius_mm": lower, "upper_radius_mm": upper})
        bottom = top
    return sections


def section_radius(section, height):
    """返回线性圆锥或圆柱段在给定世界高度的半径，调用方负责先夹取到段内。"""
    fraction = (height - section["bottom_mm"]) / (section["top_mm"] - section["bottom_mm"])
    return section["lower_radius_mm"] + fraction * (section["upper_radius_mm"] - section["lower_radius_mm"])


def radial_limit(sections, lower, upper):
    """返回覆盖高度内最窄罩半径；跨段时同时核对连接处，无交集返回负无穷。"""
    radii = []
    for section in sections:
        start, end = max(lower, section["bottom_mm"]), min(upper, section["top_mm"])
        if start <= end:
            radii.extend((section_radius(section, start), section_radius(section, end)))
    return min(radii, default=-math.inf)


def allowed_height_intervals(sections, radius):
    """解析罩体半径不小于给定值的连续高度区间，用于新固定组初放，不离散采样或收窄用户优化范围。"""
    intervals = []
    for section in sections:
        low, high = section["bottom_mm"], section["top_mm"]
        r0, r1 = section["lower_radius_mm"], section["upper_radius_mm"]
        if max(r0, r1) < radius:
            continue
        if min(r0, r1) < radius:
            crossing = low + (radius - r0) * (high - low) / (r1 - r0)
            if r1 > r0:
                low = crossing
            else:
                high = crossing
        if intervals and low <= intervals[-1][1]:
            intervals[-1][1] = high
        else:
            intervals.append([low, high])
    return intervals


def outer_radial_planes(sections):
    """将连续凸形罩体转换为 r <= slope*z + intercept 的许可；非凸轮廓返回 None，不能外推为凸形。

    半径随高度的斜率非递增时，各段直线的下包络恰好等于实际轮廓；客户端只需代入世界顶点。
    """
    planes = []
    for index, section in enumerate(sections):
        slope = (section["upper_radius_mm"] - section["lower_radius_mm"]) / (section["top_mm"] - section["bottom_mm"])
        if index:
            previous = sections[index - 1]
            if (previous["top_mm"] != section["bottom_mm"]
                    or previous["upper_radius_mm"] != section["lower_radius_mm"]
                    or slope > planes[-1]["slope"]):
                return None
        planes.append({"slope": slope, "intercept_mm": section["lower_radius_mm"] - slope * section["bottom_mm"]})
    return planes or None


def envelope_height_intervals(sections, vertices):
    """返回包络可整体沿 Z 平移的偏移区间；凸形罩精确关联各顶点高度与半径，非凸罩保守筛选。

    固定 XY 和姿态，不缩放模型；返回空列表表示该姿态无可用区间，不能据此中断预览显示。
    """
    lower_z, upper_z = float(vertices[:, 2].min()), float(vertices[:, 2].max())
    radii = np.linalg.norm(vertices[:, :2], axis=1)
    planes = outer_radial_planes(sections)
    if planes is None:
        return [(start - lower_z, end - upper_z) for start, end in allowed_height_intervals(sections, float(radii.max()))
                if start - lower_z <= end - upper_z]
    low, high = sections[0]["bottom_mm"] - lower_z, sections[-1]["top_mm"] - upper_z
    for plane in planes:
        slope = plane["slope"]
        required = float(np.max(radii - slope * vertices[:, 2] - plane["intercept_mm"]))
        if slope > 0:
            low = max(low, required / slope)
        elif slope < 0:
            high = min(high, required / slope)
        elif required > 0:
            return []
    return [(low, high)] if low <= high else []


def inner_obstacles(radius, height, base):
    """生成基座和筒体的独立世界高度区间；基座上半径始终等于当前筒半径。"""
    bottom = base["height_mm"]
    return [{"kind": "base", "bottom_mm": 0.0, "top_mm": bottom,
             "lower_radius_mm": base["lower_radius_mm"], "upper_radius_mm": radius},
            {"kind": "cylinder", "bottom_mm": bottom, "top_mm": bottom + height,
             "lower_radius_mm": radius, "upper_radius_mm": radius}]


def space_boundary_issues(vertices, mount, point, radius, height, base, profile, tolerance, installation_vertices=None, faces=None):
    """验收世界包络与筒罩基座边界，返回不带模型名称的中文违规及稳定代码；接触允许、穿透拒绝。"""
    check_cancelled()
    lower, upper = float(vertices[:, 2].min()), float(vertices[:, 2].max())
    sections = fairing_sections(profile)
    tube_bottom, tube_top = base["height_mm"], base["height_mm"] + height
    issues = []
    from app.domain.layout_boundary import envelope_hull, inner_clearance, outer_clearance
    hull = None
    if float(np.linalg.norm(vertices[:, :2], axis=1).max()) > radial_limit(sections, lower, upper) + tolerance:
        hull = envelope_hull(vertices)
        if outer_clearance(hull, sections) < -tolerance:
            issues.append(("安全包络超出整流罩径向范围", "fairing_radius"))
    minimum = tube_top if mount == "top" else (0.0 if installation_vertices is not None else tube_bottom)
    maximum = sections[-1]["top_mm"] if installation_vertices is not None or mount == "top" else min(tube_top, sections[-1]["top_mm"])
    if lower < minimum - tolerance or upper > maximum + tolerance:
        issues.append(("安全包络超出允许高度", "height"))
    if mount == "side" and installation_vertices is not None:
        if installation_vertices[:, 2].min() < tube_bottom - tolerance or installation_vertices[:, 2].max() > tube_top + tolerance:
            issues.append(("共面安装区域超出直筒高度范围", "installation_height"))
    distance = MultiPoint(vertices[:, :2]).convex_hull.distance(Point(0, 0))
    for obstacle in inner_obstacles(radius, height, base):
        check_cancelled()
        start, end = max(lower, obstacle["bottom_mm"]), min(upper, obstacle["top_mm"])
        if end - start > tolerance and distance < max(section_radius(obstacle, start), section_radius(obstacle, end)) - tolerance:
            if faces is not None:
                from app.domain.layout_contact import mesh_inner_clearance
                clearance = mesh_inner_clearance(vertices, faces, obstacle, tolerance)
            else:
                hull = envelope_hull(vertices) if hull is None else hull
                clearance = inner_clearance(hull, obstacle, tolerance)
            if clearance < -tolerance:
                is_base = obstacle["kind"] == "base"
                issues.append(("安全包络进入安装筒基座" if is_base else "安全包络进入安装筒", "base" if is_base else "cylinder"))
    return issues
