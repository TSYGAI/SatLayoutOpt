"""文件说明：从正式包络验收安装、碰撞和质心；自动布局顶部居中，人工微调可显式开放水平位置，其他约束共用。"""

import math

import numpy as np
from shapely.geometry import MultiPoint

from app.domain.layout_config import LAYOUT_CONFIG
from app.domain.layout_mounts import model_up_direction
from app.domain.layout_symmetry import soft_symmetry_metrics, symmetry_violations
from app.domain.fixed_policy import candidate_fixed_parameters
from app.domain.installation_tube import validate_installation_bounds
from app.domain.layout_space import space_boundary_issues
from app.domain.installation_region import installation_region
from app.domain.layout_occlusion import angular_interval, radial_shadow_overlap
from app.domain.layout_vertical import vertical_relations
from app.domain.layout_contact import directional_suspension


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
    """生成以当前模型到包络矩阵为输入的旋转和平移、世界质心及保守碰撞棱柱；底高为包络最小 Z。"""
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
        "model_coordinate_space": "current_model_v1",
        "model_origin_global_mm": model_to_global[:3, 3].tolist(),
        "installation_face_id": satellite.installation_face_id,
        "installation_face_center_mm": (rotation @ satellite.face_center + origin).tolist(),
        "installation_point_mm": (rotation @ satellite.face_center + origin).tolist(),
        "installation_face_normal": (rotation @ satellite.face_normal).tolist(),
        "up_orientation": satellite.up_orientation,
        "up_direction_global": (rotation @ up).tolist() if up is not None else None,
    }


def validate_layout(candidate: dict, satellites: list, parameters, *, partial=False, report_instances=False,
                    allow_top_translation=False) -> dict:
    """重算全部几何与质心；仅人工微调显式允许顶部偏心，partial 为部分预览，report_instances 报告逐星违规。"""
    from app.compute.cancellation import check_cancelled
    check_cancelled()
    instance_report = partial or report_instances
    if not partial:
        parameters = candidate_fixed_parameters(candidate, parameters)
    tolerance = LAYOUT_CONFIG["geometry_tolerance_mm"]
    margin = LAYOUT_CONFIG["layer_mass_margin_kg"]
    errors = []
    if not partial:
        errors.extend(symmetry_violations(candidate["placements"], satellites, parameters))
        from app.domain.fixed_placements import fixed_matrix_violations
        errors.extend(fixed_matrix_violations(candidate, satellites, parameters))
    models = {item.instance_id: item for item in satellites}
    placements = candidate["placements"]
    ids = [item["instance_id"] for item in placements]
    if len(ids) != len(set(ids)) or (not partial and set(ids) != set(models)):
        errors.append("必须完整装载每个请求实例且不能重复")
    radius, height = candidate["radius_mm"], candidate["height_mm"]
    base = parameters.installation_base.model_dump()
    tube_bottom, tube_top = base["height_mm"], base["height_mm"] + height
    try:
        validate_installation_bounds(radius, height, parameters.installation_base.model_dump(), parameters.fairing_profile)
    except ValueError as error:
        errors.append(str(error))
    from app.domain.fixed_placements import expand_fixed_groups
    expected_fixed = expand_fixed_groups(satellites, parameters, radius, height)
    fixed_ids = set(expected_fixed)
    if not parameters.min_radius_mm - tolerance <= radius <= parameters.max_radius_mm + tolerance:
        errors.append("圆柱半径超出输入区间")
    if not parameters.min_height_mm - tolerance <= height <= parameters.max_height_mm + tolerance:
        errors.append("圆柱高度超出输入区间")
    geometry = []
    shadows = {}
    instance_violations = {item["instance_id"]: [] for item in placements} if instance_report else {}

    def add_instance_error(placement, message):
        """记录同时属于总体校验和具体卫星的约束违规，供前端逐实例标红。"""
        errors.append(message)
        if instance_report:
            instance_violations.setdefault(placement["instance_id"], []).append(message)

    weighted = np.zeros(3)
    total_mass = 0.0
    layer_masses = {}
    top_ids = [item["instance_id"] for item in placements if item["mount"] == "top"]
    expected_top = next((item.instance_id for item in satellites if parameters.top_enabled and item.record_id == parameters.top_record_id), None)
    if (top_ids or not partial) and top_ids != ([expected_top] if expected_top else []):
        errors.append("顶部装载必须严格遵循用户开关与指定卫星，禁止自动添加或替换")
    for placement in placements:
        check_cancelled()
        model = models.get(placement["instance_id"])
        if model is None:
            continue
        from app.compute.monitoring import stage
        stage("验收模型位姿、边界与质心", model_id=model.record_id, model_name=model.name,
              candidate=candidate.get("candidate_id", "未编号"))
        manually_fixed = model.instance_id in fixed_ids
        transform = np.asarray(placement["model_to_global_matrix"]) @ np.linalg.inv(model.source_to_envelope)
        rotation, origin = transform[:3, :3], transform[:3, 3]
        expected_determinant = -1 if expected_fixed.get(model.instance_id, {}).get("fixed_mirrored") else 1
        if not np.allclose(rotation.T @ rotation, np.eye(3), atol=tolerance) or abs(np.linalg.det(rotation) - expected_determinant) > tolerance:
            add_instance_error(placement, f"{model.name} 布局不得缩放或镜像固化模型")
        vertices = model.vertices @ rotation.T + origin
        polygon = MultiPoint(vertices[:, :2]).convex_hull
        check_cancelled()
        bottom, top = float(vertices[:, 2].min()), float(vertices[:, 2].max())
        center = rotation @ model.center + origin
        face_center = rotation @ model.face_center + origin
        face_normal = rotation @ model.face_normal
        up = model_up_direction(model)
        if up is not None and not manually_fixed:
            up = rotation @ up
            if not np.isfinite(up).all() or np.linalg.norm(up - [0, 0, 1]) > LAYOUT_CONFIG["orientation_tolerance"]:
                add_instance_error(placement, f"{model.name} 向上轴 {model.up_orientation} 必须朝全局 +Z")
        if placement.get("installation_face_id") != model.installation_face_id:
            add_instance_error(placement, f"{model.name} 必须使用已设置的安装面")
        if placement["mount"] == "top":
            if not manually_fixed and np.linalg.norm(face_normal - [0, 0, -1]) > tolerance:
                add_instance_error(placement, f"{model.name} 顶部安装面必须朝下")
            suspension = face_center[2] - tube_top
        else:
            face_radius = float(np.linalg.norm(face_center[:2]))
            desired = np.array([-face_center[0], -face_center[1], 0.0]) / max(face_radius, tolerance)
            if not manually_fixed and np.linalg.norm(face_normal - desired) > tolerance:
                add_instance_error(placement, f"{model.name} 指定安装面未朝向舱体")
            if not manually_fixed and not tube_bottom - tolerance <= face_center[2] <= tube_top + tolerance:
                add_instance_error(placement, f"{model.name} 安装中心不在圆柱侧面高度范围")
            try:
                suspension = directional_suspension(vertices, model.faces, face_normal, radius)
            except ValueError as error:
                add_instance_error(placement, f"{model.name} {error}")
                suspension = -math.inf
        if not partial and not parameters.min_suspension_mm - tolerance <= suspension <= parameters.max_suspension_mm + tolerance:
            add_instance_error(placement, f"{model.name} 悬高 {suspension:.3f} mm 超出用户设定范围")
        weighted += model.mass * center
        total_mass += model.mass
        region = installation_region(model, placement["model_to_global_matrix"])
        check_cancelled()
        if placement["mount"] == "side":
            shadows[model.instance_id] = (angular_interval(np.asarray(polygon.exterior.coords)), bottom, top)
        for message, _ in space_boundary_issues(vertices, placement["mount"], face_center, radius, height,
                                                base, parameters.fairing_profile, tolerance,
                                                region, model.faces):
            add_instance_error(placement, f"{model.name} {message}")
        if placement["mount"] == "top":
            # 居中以正式包络外接盒中心为准，旋转后的盒中心由世界包络极值重新计算。
            world_midpoint = (vertices.min(axis=0) + vertices.max(axis=0)) / 2
            if not allow_top_translation and np.linalg.norm(world_midpoint[:2]) > tolerance:
                add_instance_error(placement, "顶部卫星必须居中位于圆柱顶面上方，悬高按指定安装面计算")
        else:
            if placement["layer"] < 0:
                add_instance_error(placement, f"{model.name} 不在有效侧挂层内")
            layer_masses.setdefault(placement["layer"], 0.0)
            layer_masses[placement["layer"]] += model.mass
        geometry.append((placement, polygon, bottom, top))
    minimum_separation = math.inf
    for index, (left, left_shape, left_bottom, left_top) in enumerate(geometry):
        for right, right_shape, right_bottom, right_top in geometry[index + 1:]:
            check_cancelled()
            from app.compute.monitoring import stage
            stage("验收模型对包络间距", model_id=left["instance_id"], model_name=left["name"], other_model=right["instance_id"])
            dz = max(left_bottom - right_top, right_bottom - left_top, 0.0)
            distance = math.hypot(left_shape.distance(right_shape), dz)
            minimum_separation = min(minimum_separation, distance)
            overlap_z = min(left_top, right_top) - max(left_bottom, right_bottom)
            planar_intersection = left_shape.intersection(right_shape)
            if (left["instance_id"] in shadows and right["instance_id"] in shadows
                    and radial_shadow_overlap(shadows[left["instance_id"]], shadows[right["instance_id"]], tolerance, radius)):
                message = f"{left['name']} 与 {right['name']} 存在径向前后遮挡"
                add_instance_error(left, message)
                if instance_report:
                    instance_violations.setdefault(right["instance_id"], []).append(message)
            if overlap_z > tolerance and not planar_intersection.buffer(-tolerance).is_empty:
                message = f"{left['name']} 与 {right['name']} 安全包络间距不足"
                errors.append(message)
                if instance_report:
                    instance_violations.setdefault(left["instance_id"], []).append(message)
                    instance_violations.setdefault(right["instance_id"], []).append(message)
    layers = sorted(layer_masses)
    check_cancelled()
    if not partial and layers != list(range(len(layers))):
        errors.append("侧挂层编号必须从底层起连续")
    # 层号表达上下避让层次，不要求同层下缘齐平，也不能用同层标签掩盖实际堆叠。
    if not partial:
        by_id = {p["instance_id"]: p for p in placements}
        for relation in vertical_relations(geometry, radius):
            lower, upper = by_id[relation["lower"]], by_id[relation["upper"]]
            if lower["mount"] == upper["mount"] == "side" and lower["layer"] >= upper["layer"]:
                errors.append("侧挂层必须按实际上下遮挡关系编号")
    masses = [mass for _, mass in sorted(layer_masses.items())]
    mass_inversions = sum(lower - upper < margin for lower, upper in zip(masses, masses[1:]))
    mass_excess = sum(max(0.0, upper + margin - lower) for lower, upper in zip(masses, masses[1:]))
    center = weighted / total_mass if total_mass else np.zeros(3)
    radial = float(np.linalg.norm(center[:2]))
    if not partial and radial > parameters.axis_radius_mm + tolerance:
        errors.append("整体卫星水平质心偏移超过设定范围")
    return {
        **soft_symmetry_metrics(placements, satellites, parameters),
        "valid": not errors, "violations": list(dict.fromkeys(errors)), "loaded_count": len(ids),
        "total_mass_kg": total_mass, "center_of_mass_mm": center.tolist(), "radial_com_mm": radial,
        "layer_masses_kg": masses, "layer_mass_inversions": mass_inversions, "layer_mass_excess_kg": mass_excess,
        "radial_occlusion_method": "formal_envelope_angular_prisms",
        "minimum_envelope_separation_mm": (
            minimum_separation if math.isfinite(minimum_separation) else None),
        "collision_method": "formal_envelope_convex_prisms", "axis_height_mm": height,
        "boundary_method": "formal_envelope_mesh_inner_convex_outer",
        "axis_bottom_mm": tube_bottom,
        "assembly_height_mm": max((entry[3] for entry in geometry), default=0.0),
        **({"instance_violations": {key: list(dict.fromkeys(value)) for key, value in instance_violations.items()}} if instance_report else {}),
    }
