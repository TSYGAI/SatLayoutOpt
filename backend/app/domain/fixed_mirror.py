"""文件说明：固定镜像组的世界平面反射、微调映射和求解局部模型；本体/包络/安装点/真实质心共用源矩阵，不改固化模型。"""

from dataclasses import replace
import math

import numpy as np
from shapely.geometry import MultiPoint


def mirror_matrix(mode):
    """返回xOz或yOz世界平面的齐次反射矩阵；环向模式无反射，未知模式抛ValueError。"""
    if mode == "ring":
        return None
    if mode not in {"mirror_xoz", "mirror_yoz"}:
        raise ValueError("未知固定组对称模式")
    return np.diag([1.0, -1.0, 1.0, 1.0] if mode == "mirror_xoz" else [-1.0, 1.0, 1.0, 1.0])


def reflect_placement(primary, source, mode):
    """把基准实例完整反射到世界平面另一侧；占用第二个实例并保留其身份，不以刚性旋转代替实体反射。"""
    reflection = mirror_matrix(mode)
    signs = np.diag(reflection)[:3]
    result = {**primary, "instance_id": source.instance_id, "record_id": source.record_id, "name": source.name,
              "mass_kg": source.mass, "fixed_mirrored": True, "mirror_plane": mode,
              "model_to_global_matrix": (reflection @ np.asarray(primary["model_to_global_matrix"])).tolist()}
    for key in ("translation_mm", "model_origin_global_mm", "installation_point_mm", "installation_face_center_mm",
                "center_of_mass_mm", "installation_face_normal", "up_direction_global"):
        if primary.get(key) is not None:
            result[key] = (signs * primary[key]).tolist()
    result["footprint_mm"] = (np.asarray(primary["footprint_mm"]) * signs[:2]).tolist()
    point = result["installation_point_mm"]
    result["rotation_z_deg"] = math.degrees(math.atan2(point[1], point[0])) % 360
    return result


def canonical_fixed_action(group, candidate, placement, action):
    """将镜像副本的世界平移映射回基准实例；原子动作仅支持位置微调。"""
    if not placement.get("fixed_mirrored"):
        return placement, action
    primary = next(item for item in candidate["placements"] if item["fixed_group_id"] == group.group_id
                   and not item.get("fixed_mirrored"))
    sign = mirror_matrix(group.symmetry_mode)["xyz".index(action.axis), "xyz".index(action.axis)]
    return primary, action.model_copy(update={"instance_id": primary["instance_id"], "delta": float(action.delta * sign)})


def reflect_fixed_local_model(model):
    """求解器镜像副本在自身环向框中反射切向坐标；保留形状尺度、质量和源几何供独立验收。"""
    reflection = np.diag([1.0, -1.0, 1.0, 1.0])
    transform = reflection[:3, :3]
    vertices = model.vertices @ transform.T
    return replace(model, vertices=vertices, lower=vertices.min(axis=0), upper=vertices.max(axis=0),
                   center=transform @ model.center, face_center=transform @ model.face_center,
                   face_normal=transform @ model.face_normal, source_to_envelope=reflection @ model.source_to_envelope,
                   footprint=np.asarray(MultiPoint(vertices[:, :2]).convex_hull.exterior.coords)[:-1])
