"""文件说明：固定约束专用安装面自适应姿态；复用当前坐标基准，只变换计算副本，不改变普通优化的向上轴规则。"""

from dataclasses import replace

import numpy as np
import trimesh
from shapely.geometry import MultiPoint

from app.domain.layout_config import LAYOUT_CONFIG
from app.domain.layout_mounts import MountOrientationError, model_up_direction


def mount_requires_adjustment(model, mount):
    """判断原安装法向和向上轴能否同时满足目标；自由轴无需解除朝上约束，未知安装方式抛 ValueError。"""
    if mount not in {"side", "top"}:
        raise ValueError("未知安装方式")
    up = model_up_direction(model)
    if up is None:
        return False
    normal = np.asarray(model.face_normal, dtype=float)
    norm = np.linalg.norm(normal)
    if not np.isfinite(normal).all() or not np.isfinite(norm) or norm <= 0:
        raise MountOrientationError(f"{model.name} 安装面 {model.installation_face_id} 的法向无效")
    normal = normal / norm
    tolerance = LAYOUT_CONFIG["orientation_tolerance"]
    return bool(abs(normal @ up) > tolerance if mount == "side" else np.linalg.norm(normal + up) > tolerance)


def orient_fixed_mount(model, mount, roll_quarters=0):
    """返回优先对齐安装面的刚性副本；朝向兼容时保持既有矩阵，冲突时自动适配，不改原模型。

    侧挂将向上轴的切向分量尽量对齐+Z；平行退化及顶部冲突时采用安装法向的最小旋转。
    所有几何量使用同一矩阵变换，不修改原模型、缩小包络或覆盖用户轴向。
    """
    if mount not in {"side", "top"}:
        raise ValueError("未知安装方式")
    target = np.array([-1.0, 0.0, 0.0] if mount == "side" else [0.0, 0.0, -1.0])
    up = model_up_direction(model)
    normal_norm = np.linalg.norm(model.face_normal)
    if not np.isfinite(model.face_normal).all() or not np.isfinite(normal_norm) or normal_norm <= 0:
        raise MountOrientationError(f"{model.name} 安装面 {model.installation_face_id} 的法向无效")
    normal = model.face_normal / normal_norm
    tolerance = LAYOUT_CONFIG["orientation_tolerance"]
    if up is None:
        alignment = trimesh.geometry.align_vectors(normal, target)
        roll = trimesh.transformations.rotation_matrix(roll_quarters * np.pi / 2, target)
        transform = roll @ alignment
    elif mount == "side":
        up = up - (normal @ up) * normal
        if np.linalg.norm(up) > tolerance:
            up /= np.linalg.norm(up)
            source_frame = np.column_stack((normal, np.cross(up, normal), up))
            target_up = np.array([0.0, 0.0, 1.0])
            target_frame = np.column_stack((target, np.cross(target_up, target), target_up))
            transform = np.eye(4)
            transform[:3, :3] = target_frame @ source_frame.T
        else:
            transform = trimesh.geometry.align_vectors(normal, target)
        if roll_quarters:
            transform = trimesh.transformations.rotation_matrix(roll_quarters * np.pi / 2, target) @ transform
    else:
        if np.linalg.norm(normal + up) > tolerance:
            alignment = trimesh.geometry.align_vectors(normal, target)
        else:
            alignment = trimesh.geometry.align_vectors(up, [0.0, 0.0, 1.0])
        roll = trimesh.transformations.rotation_matrix(roll_quarters * np.pi / 2, target)
        transform = roll @ alignment
    rotation = transform[:3, :3]
    vertices = model.vertices @ rotation.T
    return replace(
        model, vertices=vertices, lower=vertices.min(axis=0), upper=vertices.max(axis=0),
        footprint=np.asarray(MultiPoint(vertices[:, :2]).convex_hull.exterior.coords)[:-1],
        center=rotation @ model.center, face_center=rotation @ model.face_center,
        face_normal=rotation @ model.face_normal, source_to_envelope=transform @ model.source_to_envelope,
    )
