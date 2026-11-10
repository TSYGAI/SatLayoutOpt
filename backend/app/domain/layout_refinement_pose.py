"""文件说明：由唯一矩阵维护微调刚体位姿，支持绕筒旋转和顶部水平平移；派生量快速更新后仍从正式模型重建验收。"""

import math

import numpy as np
from shapely.geometry import MultiPoint

from app.compute.cancellation import check_cancelled
from app.domain.installation_region import installation_region
from app.domain.layout_contact import directional_suspension


def rigid_motion(placement, angle, height, suspension, x=0.0, y=0.0):
    """原位施加绕安装筒 Z 轴旋转、世界水平平移和法向退让；所有平移单位为毫米。

    仅用于已经校验的微调操作类型，尺寸变化仍必须调用 rigid_update；最终结果同样由模型矩阵重算。
    """
    radians = math.radians(angle)
    cosine, sine = math.cos(radians), math.sin(radians)
    rotation = np.array([[cosine, -sine, 0.0], [sine, cosine, 0.0], [0.0, 0.0, 1.0]])
    normal = rotation @ np.asarray(placement["installation_face_normal"])
    offset = -normal / np.linalg.norm(normal) * suspension + np.array([x, y, height])
    matrix = np.asarray(placement["model_to_global_matrix"])
    matrix[:3, :] = rotation @ matrix[:3, :]
    matrix[:3, 3] += offset
    placement["model_to_global_matrix"] = matrix.tolist()
    for key in ("translation_mm", "center_of_mass_mm", "model_origin_global_mm", "installation_face_center_mm", "installation_point_mm"):
        placement[key] = (rotation @ np.asarray(placement[key]) + offset).tolist()
    for key in ("installation_face_normal", "up_direction_global"):
        if placement.get(key) is not None:
            placement[key] = (rotation @ np.asarray(placement[key])).tolist()
    for key in ("bottom_mm", "top_mm", "installation_region_bottom_mm", "installation_region_top_mm"):
        placement[key] += float(offset[2])
    footprint = np.asarray(placement["footprint_mm"])
    placement["footprint_mm"] = (footprint @ rotation[:2, :2].T + offset[:2]).tolist()
    if placement["mount"] == "side":
        face = placement["installation_face_center_mm"]
        placement["rotation_z_deg"] = math.degrees(math.atan2(face[1], face[0])) % 360
        placement["suspension_mm"] += suspension
    else:
        placement["rotation_z_deg"] = (placement["rotation_z_deg"] + angle) % 360
        placement["suspension_mm"] += float(offset[2])


def rigid_update(placement, model, matrix, radius, tube_top):
    """从唯一模型矩阵重新计算接触悬高、安装区域、真实质心与包络；原位修改草稿副本。"""
    check_cancelled()
    transform = matrix @ np.linalg.inv(model.source_to_envelope)
    rotation, offset = transform[:3, :3], transform[:3, 3]
    vertices = model.vertices @ rotation.T + offset
    face, normal = rotation @ model.face_center + offset, rotation @ model.face_normal
    region = installation_region(model, matrix)
    check_cancelled()
    angle = math.degrees(math.atan2(face[1], face[0])) % 360 if placement["mount"] == "side" else placement["rotation_z_deg"]
    suspension = (directional_suspension(vertices, model.faces, normal, radius)
                  if placement["mount"] == "side" else float(face[2] - tube_top))
    check_cancelled()
    placement.update(model_to_global_matrix=matrix.tolist(), translation_mm=offset.tolist(),
                     model_origin_global_mm=matrix[:3, 3].tolist(), center_of_mass_mm=(rotation @ model.center + offset).tolist(),
                     mass_kg=model.mass, installation_face_center_mm=face.tolist(), installation_point_mm=face.tolist(),
                     installation_face_normal=normal.tolist(), bottom_mm=float(vertices[:, 2].min()),
                     top_mm=float(vertices[:, 2].max()), rotation_z_deg=angle, suspension_mm=suspension,
                     suspension_reference="envelope_contact_normal" if placement["mount"] == "side" else "top_installation_plane",
                     installation_region_bottom_mm=float(region[:, 2].min()), installation_region_top_mm=float(region[:, 2].max()),
                     footprint_mm=np.asarray(MultiPoint(vertices[:, :2]).convex_hull.exterior.coords)[:-1].tolist())
    if placement.get("up_direction_global") is not None:
        from app.domain.layout_mounts import model_up_direction
        direction = model_up_direction(model)
        placement["up_direction_global"] = (rotation @ direction).tolist() if direction is not None else None
