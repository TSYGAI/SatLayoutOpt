"""文件说明：按已解析的 STEP 安装基准构造受局部法向约束的侧挂或顶部姿态；禁止自动改选其他面。

平面旧记录可沿用面中心；曲面必须提供点击点。侧挂局部外法向指向舱体，顶部局部外法向朝下。
"""

from dataclasses import replace

import numpy as np
import trimesh
from shapely.geometry import MultiPoint

from app.domain.layout_config import LAYOUT_CONFIG


class MountOrientationError(ValueError):
    """表示安装面与模型向上轴不能同时满足指定安装方式，继续搜索也不能消除该冲突。"""


def source_up_axis(orientation):
    """将固定模型轴转为单位向量，自由（free）返回 None；缺失或非法值抛 ValueError，不猜测方向。"""
    if not isinstance(orientation, str) or orientation not in ("+X", "-X", "+Y", "-Y", "+Z", "-Z", "free"):
        raise ValueError("向上轴向必须是 +X、-X、+Y、-Y、+Z、-Z 或自由（free），请检查卫星设置并重新固化")
    if orientation == "free":
        return None
    vector = np.zeros(3)
    vector["XYZ".index(orientation[1])] = 1.0 if orientation[0] == "+" else -1.0
    return vector


def model_up_direction(model):
    """返回当前包络坐标中的向上单位向量，自由轴返回 None；应用初始旋转并消除单位/比例，不应用平移。"""
    axis = source_up_axis(model.up_orientation)
    if axis is None:
        return None
    direction = model.source_to_envelope[:3, :3] @ axis
    norm = np.linalg.norm(direction)
    if not np.isfinite(norm) or norm <= 0:
        raise ValueError(f"{model.name} 的向上轴变换无效")
    return direction / norm


def orient_for_mount(model, mount, roll_quarters=0):
    """返回满足安装面与可选向上轴的刚性副本；自由模式只对齐安装面，再按 roll_quarters 滚转。

    固定轴侧挂姿态唯一，非零滚转或方向冲突抛 MountOrientationError；顶部和自由模式支持四种转角。
    所有几何量使用同一矩阵变换，不修改原模型、缩小包络或覆盖用户轴向。
    """
    if mount not in {"side", "top"}:
        raise ValueError("未知安装方式")
    target = np.array([-1.0, 0.0, 0.0] if mount == "side" else [0.0, 0.0, -1.0])
    up = model_up_direction(model)
    normal = model.face_normal / np.linalg.norm(model.face_normal)
    tolerance = LAYOUT_CONFIG["orientation_tolerance"]
    if up is None:
        alignment = trimesh.geometry.align_vectors(normal, target)
        roll = trimesh.transformations.rotation_matrix(roll_quarters * np.pi / 2, target)
        transform = roll @ alignment
    elif mount == "side":
        if abs(float(normal @ up)) > tolerance or roll_quarters != 0:
            raise MountOrientationError(
                f"{model.name} 侧挂姿态冲突：安装面 {model.installation_face_id} 与向上轴 {model.up_orientation} "
                "必须满足面法向垂直于向上轴，且不能绕安装面滚转使向上轴偏离全局 +Z")
        up = up - (normal @ up) * normal
        up /= np.linalg.norm(up)
        source_frame = np.column_stack((normal, np.cross(up, normal), up))
        target_up = np.array([0.0, 0.0, 1.0])
        target_frame = np.column_stack((target, np.cross(target_up, target), target_up))
        transform = np.eye(4)
        transform[:3, :3] = target_frame @ source_frame.T
    else:
        if np.linalg.norm(normal + up) > tolerance:
            raise MountOrientationError(
                f"{model.name} 顶部姿态冲突：安装面 {model.installation_face_id} 的外法向必须与向上轴 "
                f"{model.up_orientation} 反向，才能同时实现安装面朝下和指定轴朝全局 +Z")
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


def mounting_variants(model, mount):
    """返回符合安装及轴向约束的姿态；固定轴侧挂一组，自由侧挂及顶部四组，方向冲突向调用方传播。"""
    count = 1 if mount == "side" and model.up_orientation != "free" else 4
    return [orient_for_mount(model, mount, roll) for roll in range(count)]
