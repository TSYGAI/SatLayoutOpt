"""文件说明：固定卫星复用统一安装面自适应姿态、边界验收及世界轴微调；几何量共用刚性变换，不改固化设置或历史矩阵。"""

from dataclasses import replace
import math

import numpy as np
from scipy.spatial.transform import Rotation
from shapely.geometry import MultiPoint, Point
from shapely.ops import nearest_points

from app.domain.layout_config import LAYOUT_CONFIG
from app.domain.fixed_mounts import orient_fixed_mount
from app.domain.fixed_mirror import canonical_fixed_action, reflect_fixed_local_model
from app.domain.layout_space import fairing_sections, inner_obstacles, space_boundary_issues, outer_radial_planes
from app.domain.installation_region import installation_region


def orient_fixed_model(source, group):
    """侧挂和顶部统一优先适配指定安装面，再叠加用户姿态补偿；仅返回计算副本，不重置手动微调。"""
    model = orient_fixed_mount(source, group.mount, group.roll_quarters)
    rotation = Rotation.from_quat(group.attitude_quaternion).as_matrix()
    vertices = model.vertices @ rotation.T
    transform = np.eye(4); transform[:3, :3] = rotation
    return replace(model, vertices=vertices, lower=vertices.min(axis=0), upper=vertices.max(axis=0),
                   center=rotation @ model.center, face_center=rotation @ model.face_center,
                   face_normal=rotation @ model.face_normal, source_to_envelope=transform @ model.source_to_envelope,
                   footprint=np.asarray(MultiPoint(vertices[:, :2]).convex_hull.exterior.coords)[:-1])


def orient_fixed_instance(source, group, placement):
    """返回固定实例在自身环向框中的模型；基准正常定向，镜像副本反射局部切向坐标。"""
    model = orient_fixed_model(source, group)
    return reflect_fixed_local_model(model) if placement.get("fixed_mirrored") else model


def fixed_orientation_fields(model_to_global):
    """消除源比例后返回含手性的真实朝向矩阵；不再生成已移除的三轴姿态输入所用欧拉角。"""
    matrix = np.asarray(model_to_global)[:3, :3]
    matrix = matrix / np.linalg.norm(matrix, axis=0)
    handedness = -1 if np.linalg.det(matrix) < 0 else 1
    return {"orientation_matrix": matrix.tolist(), "orientation_handedness": handedness}


def fixed_boundary_validation(candidate, satellites):
    """按世界包络验收分段外罩、抬升筒体及基座，同时下发仅供客户端代入矩阵的保守显示许可。"""
    models = {model.instance_id: model for model in satellites}
    errors = []
    instances = {}
    tolerance = LAYOUT_CONFIG["geometry_tolerance_mm"]
    base, profile = candidate["installation_base"], candidate["fairing_profile"]
    sections = fairing_sections(profile)
    radial_planes = outer_radial_planes(sections)
    tube_bottom, tube_top = base["height_mm"], base["height_mm"] + candidate["height_mm"]
    for placement in candidate["placements"]:
        instance_errors = []
        instance_codes = []
        model = models[placement["instance_id"]]
        transform = np.asarray(placement["model_to_global_matrix"]) @ np.linalg.inv(model.source_to_envelope)
        vertices = model.vertices @ transform[:3, :3].T + transform[:3, 3]
        polygon = MultiPoint(vertices[:, :2]).convex_hull
        # 提供保守显示许可：分离平面保证整个包络在筒外，客户端只代入新矩阵验证，不执行星间碰撞。
        closest = nearest_points(polygon, Point(0, 0))[0]
        normal = np.array([closest.x, closest.y, 0.0])
        length = np.linalg.norm(normal)
        normal = normal / length if length > tolerance else np.array([1.0, 0.0, 0.0])
        matrix = np.asarray(placement["model_to_global_matrix"])
        region = installation_region(model, matrix)
        placement["installation_region_bottom_mm"] = float(region[:, 2].min())
        placement["installation_region_top_mm"] = float(region[:, 2].max())
        phase = math.radians(placement["rotation_z_deg"])
        placement["space_preview_limits"] = {
            "tolerance_mm": tolerance,
            "outer_sections": sections,
            "outer_radial_planes": radial_planes,
            "inner_obstacles": inner_obstacles(candidate["radius_mm"], candidate["height_mm"], base),
            "height_min_mm": tube_top if placement["mount"] == "top" else 0.0,
            "height_max_mm": sections[-1]["top_mm"],
            "installation_vertices": model.installation_plane_vertices.tolist(),
            "installation_height_min_mm": tube_bottom,
            "installation_height_max_mm": tube_top if placement["mount"] == "side" else None,
            "installation_radius_max_mm": None,
            "inner_normal_local": np.linalg.solve(matrix[:3, :3], normal).tolist() if placement["mount"] == "side" else None,
            "inner_normal_ring": [math.cos(phase) * normal[0] + math.sin(phase) * normal[1],
                                  -math.sin(phase) * normal[0] + math.cos(phase) * normal[1]] if placement["mount"] == "side" else None,
        }
        for message, code in space_boundary_issues(vertices, placement["mount"], placement["installation_point_mm"],
                                                  candidate["radius_mm"], candidate["height_mm"], base, profile, tolerance, region, model.faces):
            instance_errors.append(f"{model.name} {message}")
            instance_codes.append(code)
        placement["boundary_valid"] = not instance_errors
        placement["boundary_violations"] = instance_errors
        placement["boundary_violation_codes"] = instance_codes
        instances[placement["instance_id"]] = {"valid": not instance_errors, "violations": instance_errors, "codes": instance_codes}
        errors.extend(instance_errors)
    return {"valid": not errors, "violations": list(dict.fromkeys(errors)), "instances": instances,
            "violation_codes": sorted({code for item in instances.values() for code in item["codes"]})}


def fixed_boundary_blocks_edit(candidate):
    """供显式严格诊断请求使用；普通手动编辑不调用本门禁，只返回违规状态。"""
    return any(code != "fairing_radius" for code in candidate["boundary_validation"]["violation_codes"])


def apply_fixed_action(groups, candidate, action):
    """生成保持世界朝向的平移参数副本；拒绝已移除的旋转动作，边界由正式预览统一验收。"""
    if action.kind != "translate":
        raise ValueError("原子微调仅支持世界轴平移")
    placement = next((item for item in candidate["placements"] if item["instance_id"] == action.instance_id
                      and item["fixed_group_id"] == action.group_id), None)
    if placement is None:
        raise ValueError("微调目标不属于当前固定组")
    index = next(index for index, group in enumerate(groups) if group.group_id == action.group_id)
    group = groups[index]
    placement, action = canonical_fixed_action(group, candidate, placement, action)
    phase = math.radians(placement["rotation_z_deg"])
    attitude = Rotation.from_quat(group.attitude_quaternion)
    values = {"manual_suspension_mm": placement.get("radial_offset_mm", placement["suspension_mm"]),
              "reference_radius_mm": candidate["radius_mm"], "reference_height_mm": candidate["height_mm"]}
    if group.mount == "top" and action.axis != "z":
        raise ValueError("顶部只能居中放置，禁止横向平移")
    target = np.array(placement["installation_point_mm"])
    target["xyz".index(action.axis)] += action.delta
    if group.mount == "side":
        new_phase = math.atan2(target[1], target[0])
        delta_phase = new_phase - phase
        values.update(angle_deg=(group.angle_deg + math.degrees(delta_phase)) % 360,
                      height_mm=float(target[2] - candidate["installation_base"]["height_mm"]), manual_suspension_mm=float(np.linalg.norm(target[:2]) - candidate["radius_mm"]),
                      suspension_mm=max(0.0, float(np.linalg.norm(target[:2]) - candidate["radius_mm"])),
                      attitude_quaternion=(Rotation.from_rotvec([0, 0, -delta_phase]) * attitude).as_quat().tolist())
    else:
        values["manual_suspension_mm"] = float(target[2] - candidate["installation_base"]["height_mm"] - candidate["height_mm"])
        values["suspension_mm"] = max(0.0, values["manual_suspension_mm"])
    if placement.get("suspension_reference") == "envelope_contact_normal":
        values["suspension_mm"] = group.suspension_mm
    updated = list(groups); updated[index] = type(group).model_validate(group.model_dump() | values)
    return updated, placement
