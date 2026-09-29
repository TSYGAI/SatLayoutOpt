"""文件说明：从正式包络独立验收位姿、曲面安装基准、可选向上轴、质量和碰撞。"""

import math

import numpy as np
from shapely.geometry import MultiPoint, Point

from app.domain.layout_config import LAYOUT_CONFIG
from app.domain.layout_mounts import model_up_direction


def rotation_z(angle: float) -> np.ndarray:
    """返回弧度绕 Z 旋转的三维矩阵，不改变输入。"""
    cosine, sine = math.cos(angle), math.sin(angle)
    return np.array([[cosine, -sine, 0.0], [sine, cosine, 0.0], [0.0, 0.0, 1.0]])


def rectangle(satellite, angle: float, center_xy) -> np.ndarray:
    """返回正式包络外接矩形变换后的四角；中心为平面外接盒中心，单位毫米。"""
    half = (satellite.upper - satellite.lower)[:2] / 2.0
    corners = np.array([[-1, -1], [1, -1], [1, 1], [-1, 1]]) * half
    return corners @ rotation_z(angle)[:2, :2].T + center_xy


def make_placement(satellite, layer: int, angle: float, center_xy, bottom: float, mount: str) -> dict:
    """生成以正式包络原坐标为输入的旋转和平移、世界质心及保守碰撞棱柱；底高为包络最小 Z。"""
    rotation = rotation_z(angle)
    midpoint = (satellite.lower + satellite.upper) / 2.0
    origin = np.array([*center_xy, bottom]) - rotation @ np.array([midpoint[0], midpoint[1], satellite.lower[2]])
    envelope_to_global = np.eye(4)
    envelope_to_global[:3, :3] = rotation
    envelope_to_global[:3, 3] = origin
    model_to_global = envelope_to_global @ satellite.source_to_envelope
    up = model_up_direction(satellite)
    return {
        "instance_id": satellite.instance_id, "record_id": satellite.record_id, "name": satellite.name,
        "mass_kg": satellite.mass, "layer": layer, "mount": mount,
        "rotation_z_deg": math.degrees(angle) % 360.0, "translation_mm": origin.tolist(),
        "center_of_mass_mm": (rotation @ satellite.center + origin).tolist(),
        "footprint_mm": rectangle(satellite, angle, center_xy).tolist(),
        "bottom_mm": float(bottom), "top_mm": float(bottom + satellite.upper[2] - satellite.lower[2]),
        "source_sha256": satellite.source_sha256, "envelope_sha256": satellite.envelope_sha256,
        "model_to_global_matrix": model_to_global.tolist(),
        "model_origin_global_mm": model_to_global[:3, 3].tolist(),
        "installation_face_id": satellite.installation_face_id,
        "installation_face_center_mm": (rotation @ satellite.face_center + origin).tolist(),
        "installation_point_mm": (rotation @ satellite.face_center + origin).tolist(),
        "installation_face_normal": (rotation @ satellite.face_normal).tolist(),
        "up_orientation": satellite.up_orientation,
        "up_direction_global": (rotation @ up).tolist() if up is not None else None,
    }


def validate_layout(candidate: dict, satellites: list, parameters) -> dict:
    """从原始模型重新计算所有放置并逐一验收；返回违规信息和指标，不信任候选内缓存的质心或外接盒。"""
    tolerance = LAYOUT_CONFIG["geometry_tolerance_mm"]
    margin = LAYOUT_CONFIG["layer_mass_margin_kg"]
    gap = 0.0
    errors = []
    models = {item.instance_id: item for item in satellites}
    placements = candidate["placements"]
    ids = [item["instance_id"] for item in placements]
    if len(ids) != len(set(ids)) or set(ids) != set(models):
        errors.append("必须完整装载每个请求实例且不能重复")
    radius, height = candidate["radius_mm"], candidate["height_mm"]
    if not parameters.min_radius_mm - tolerance <= radius <= parameters.max_radius_mm + tolerance:
        errors.append("圆柱半径超出输入区间")
    if not parameters.min_height_mm - tolerance <= height <= parameters.max_height_mm + tolerance:
        errors.append("圆柱高度超出输入区间")
    geometry = []
    weighted = np.zeros(3)
    total_mass = 0.0
    layer_masses = {}
    top_ids = [item["instance_id"] for item in placements if item["mount"] == "top"]
    expected_top = next((item.instance_id for item in satellites if parameters.top_enabled and item.record_id == parameters.top_record_id), None)
    if top_ids != ([expected_top] if expected_top else []):
        errors.append("顶部装载必须严格遵循用户开关与指定卫星，禁止自动添加或替换")
    for placement in placements:
        model = models.get(placement["instance_id"])
        if model is None:
            continue
        transform = np.asarray(placement["model_to_global_matrix"]) @ np.linalg.inv(model.source_to_envelope)
        rotation, origin = transform[:3, :3], transform[:3, 3]
        if not np.allclose(rotation.T @ rotation, np.eye(3), atol=tolerance) or abs(np.linalg.det(rotation) - 1) > tolerance:
            errors.append(f"{model.name} 布局不得缩放或镜像固化模型")
        vertices = model.vertices @ rotation.T + origin
        polygon = MultiPoint(vertices[:, :2]).convex_hull
        bottom, top = float(vertices[:, 2].min()), float(vertices[:, 2].max())
        center = rotation @ model.center + origin
        face_center = rotation @ model.face_center + origin
        face_normal = rotation @ model.face_normal
        up = model_up_direction(model)
        if up is not None:
            up = rotation @ up
            if not np.isfinite(up).all() or np.linalg.norm(up - [0, 0, 1]) > LAYOUT_CONFIG["orientation_tolerance"]:
                errors.append(f"{model.name} 向上轴 {model.up_orientation} 必须朝全局 +Z")
        if placement.get("installation_face_id") != model.installation_face_id:
            errors.append(f"{model.name} 必须使用已设置的安装面")
        if placement["mount"] == "top":
            if np.linalg.norm(face_normal - [0, 0, -1]) > tolerance or np.linalg.norm(face_center[:2]) > radius + tolerance:
                errors.append(f"{model.name} 顶部安装面方向或安装中心不在顶面范围")
            suspension = face_center[2] - height
        else:
            face_radius = float(np.linalg.norm(face_center[:2]))
            desired = np.array([-face_center[0], -face_center[1], 0.0]) / max(face_radius, tolerance)
            if np.linalg.norm(face_normal - desired) > tolerance or face_radius < radius - tolerance:
                errors.append(f"{model.name} 指定安装面未朝向舱体")
            if not -tolerance <= face_center[2] <= height + tolerance:
                errors.append(f"{model.name} 安装中心不在圆柱侧面高度范围")
            suspension = face_radius - radius
        if not parameters.min_suspension_mm - tolerance <= suspension <= parameters.max_suspension_mm + tolerance:
            errors.append(f"{model.name} 悬高 {suspension:.3f} mm 超出用户设定范围")
        weighted += model.mass * center
        total_mass += model.mass
        if bottom < gap - tolerance:
            errors.append(f"{model.name} 超出整流罩可用高度")
        maximum_radial = float(np.linalg.norm(vertices[:, :2], axis=1).max())
        minimum_radial = polygon.distance(Point(0, 0))
        if placement["mount"] == "side":
            if top > height + tolerance:
                errors.append(f"{model.name} 侧挂包络超出当前整流罩高度")
            if maximum_radial > parameters.fairing_radius_mm - gap + tolerance:
                errors.append(f"{model.name} 与整流罩径向边界冲突")
        else:
            # 当前罩段与舱段同高，无额外罩高参数；顶部包络在舱顶以上时不受假想延长壁限制。
            if bottom < height - tolerance and maximum_radial > parameters.fairing_radius_mm + tolerance and minimum_radial < parameters.fairing_radius_mm - tolerance:
                errors.append(f"{model.name} 顶部包络与当前有限整流罩壁冲突")
        if bottom < height + gap - tolerance and polygon.distance(Point(0, 0)) < radius + gap - tolerance:
            errors.append(f"{model.name} 与实体舱体冲突")
        if placement["mount"] == "top":
            # 居中以正式包络外接盒中心为准，旋转后的盒中心由世界包络极值重新计算。
            world_midpoint = (vertices.min(axis=0) + vertices.max(axis=0)) / 2
            if bottom < height - tolerance or np.linalg.norm(world_midpoint[:2]) > tolerance:
                errors.append("顶部卫星必须居中位于圆柱顶面上方，悬高按指定安装面计算")
        else:
            if top > height + tolerance or placement["layer"] < 0:
                errors.append(f"{model.name} 不在有效侧挂层内")
            layer_masses.setdefault(placement["layer"], 0.0)
            layer_masses[placement["layer"]] += model.mass
        geometry.append((placement, polygon, bottom, top))
    minimum_separation = math.inf
    for index, (left, left_shape, left_bottom, left_top) in enumerate(geometry):
        for right, right_shape, right_bottom, right_top in geometry[index + 1:]:
            dz = max(left_bottom - right_top, right_bottom - left_top, 0.0)
            distance = math.hypot(left_shape.distance(right_shape), dz)
            minimum_separation = min(minimum_separation, distance)
            overlap_z = min(left_top, right_top) - max(left_bottom, right_bottom)
            planar_intersection = left_shape.intersection(right_shape)
            if overlap_z > tolerance and not planar_intersection.buffer(-tolerance).is_empty:
                errors.append(f"{left['name']} 与 {right['name']} 安全包络间距不足")
    layers = sorted(layer_masses)
    if layers != list(range(len(layers))):
        errors.append("侧挂层编号必须从底层起连续")
    # layer 保留搜索时的质量分组；逐颗下沉可使同组错高、不同组落到同一底面。
    # 真实高度合法性由包络/安装面边界和逐对碰撞检查保证，不再用整层齐平限制位置。
    masses = [mass for _, mass in sorted(layer_masses.items())]
    if any(lower - upper < margin - tolerance * margin for lower, upper in zip(masses, masses[1:])):
        errors.append("侧挂层总质量必须自下而上严格递减")
    center = weighted / total_mass if total_mass else np.full(3, math.inf)
    radial = float(np.linalg.norm(center[:2]))
    if radial > parameters.axis_radius_mm + tolerance or not -tolerance <= center[2] <= height + tolerance:
        errors.append("整体卫星质心不在有限中轴柱内")
    return {
        "valid": not errors, "violations": list(dict.fromkeys(errors)), "loaded_count": len(ids),
        "total_mass_kg": total_mass, "center_of_mass_mm": center.tolist(), "radial_com_mm": radial,
        "layer_masses_kg": masses, "minimum_envelope_separation_mm": (
            minimum_separation if math.isfinite(minimum_separation) else None),
        "collision_method": "formal_envelope_convex_prisms", "axis_height_mm": height,
        "top_height_exempt": bool(top_ids),
        "assembly_height_mm": max((entry[3] for entry in geometry), default=0.0),
    }
