"""文件说明：衔接逐星低位构造及顶星避让；固定星沿用已展开位姿，实际层次按上下依赖计算。"""

import numpy as np
from shapely.geometry import MultiPoint

from app.domain.installation_region import installation_region
from app.domain.layout_config import LAYOUT_CONFIG
from app.domain.layout_bottom_up import installation_offsets


def settle_installation_layers(side, partition, centers, angles, parameters, radius, fixed, symmetric_pairs=(), *, priority=()):
    """按构造时的高星优先/CP顺序落位；硬对称共同落位，失败返回None，固定星保持原位。"""
    from app.domain.layout_bottom_up import settle_sides
    return settle_sides(side, partition, centers, angles, parameters, radius, fixed, symmetric_pairs, priority=priority)


def assign_physical_layers(placements, originals, radius, symmetric_pairs=()):
    """按真实上下避让链确定层次并原位编号；同层可错高，硬对称同层，返回实际侧挂层数。"""
    from app.domain.layout_vertical import vertical_relations, assign_vertical_layers
    geometry = []
    for placement in placements:
        model = originals[placement["instance_id"]]
        transform = np.asarray(placement["model_to_global_matrix"]) @ np.linalg.inv(model.source_to_envelope)
        vertices = model.vertices @ transform[:3, :3].T + transform[:3, 3]
        geometry.append((placement, MultiPoint(vertices[:, :2]).convex_hull,
                         float(vertices[:, 2].min()), float(vertices[:, 2].max())))
    return assign_vertical_layers(placements, vertical_relations(geometry, radius), symmetric_pairs)


def top_clearance_height(side, top, centers, angles, bottoms, suspension, base_height):
    """返回居中顶星避让侧星所需的最小筒高；仅对真实投影凸包内部相交的星对施加上下间隔。

    与正式星间凸棱柱验收共用几何定义，顶部可伸出筒顶；不改变XY、姿态或侧星高度。
    无顶部返回0，调用方仍须检查筒高区间、罩体及固定关系。
    """
    if top is None:
        return 0.0
    tolerance = LAYOUT_CONFIG["geometry_tolerance_mm"]
    midpoint = (top.lower[:2] + top.upper[:2]) / 2
    top_shape = MultiPoint(top.footprint - midpoint).convex_hull
    height = 0.0
    bottom_offset = suspension - (top.face_center[2] - top.lower[2])
    for index, item in enumerate(side):
        cosine, sine = np.cos(angles[index]), np.sin(angles[index])
        rotation = np.array([[cosine, -sine], [sine, cosine]])
        midpoint = (item.lower[:2] + item.upper[:2]) / 2
        shape = MultiPoint((item.footprint - midpoint) @ rotation.T + centers[index]).convex_hull
        if not top_shape.intersection(shape).buffer(-tolerance).is_empty:
            height = max(height, float(bottoms[index] + item.upper[2] - item.lower[2] - base_height - bottom_offset))
    return height
