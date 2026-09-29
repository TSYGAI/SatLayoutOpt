"""文件说明：解析用户指定的 STEP 安装面和曲面点击点，提供可由模型设置与布局共同复用的精确安装基准。

本模块只负责源几何点/法向校验与坐标变换，不决定侧挂、顶部姿态，也不读取布局业务参数。
"""

import re

import cadquery as cq
import numpy as np

from app.core.config import runtime_config


def _point_coordinates(value):
    """把字典或三元序列安装点转换为有限源坐标；结构或数值无效时抛 ValueError。"""

    if isinstance(value, dict) and set(value) == {"x", "y", "z"}:
        coordinates = [value[axis] for axis in "xyz"]
    else:
        coordinates = value
    try:
        point = np.asarray(coordinates, dtype=float)
    except (TypeError, ValueError, OverflowError) as error:
        raise ValueError("安装点必须包含有限的 X、Y、Z 源坐标") from error
    if point.shape != (3,) or not np.isfinite(point).all():
        raise ValueError("安装点必须包含有限的 X、Y、Z 源坐标")
    return point


def _preview_projection_tolerance(shapes):
    """按高清预览离散精度返回点击点投影容差，允许三角网格与精确 STEP 曲面的正常弦差。"""

    bounds = [shape.BoundingBox() for shape in shapes]
    lower = np.min([[item.xmin, item.ymin, item.zmin] for item in bounds], axis=0)
    upper = np.max([[item.xmax, item.ymax, item.zmax] for item in bounds], axis=0)
    maximum_size = float(np.max(upper - lower))
    return max(maximum_size * runtime_config.model_preview_detail_linear_ratio * 2.0, 1e-6)


def read_installation_reference(path, face_id, transform=None, source_point=None):
    """读取 STEP 安装基准并返回变换后的点和局部外法向。

    平面兼容没有点击点的旧记录并使用面中心；曲面必须提供源坐标点击点。点击点会先校验属于
    当前裁剪面，再投影到精确 STEP 曲面，避免直接使用浏览三角网格法向。
    """

    if not isinstance(face_id, str) or re.fullmatch(r"FACE_\d{5}", face_id) is None:
        raise ValueError("请在卫星设置中指定安装面并重新固化模型")
    shapes = list(cq.importers.importStep(str(path)).vals())
    faces = [face for shape in shapes for face in shape.Faces()]
    index = int(face_id.split("_")[1]) - 1
    if index < 0 or index >= len(faces):
        raise ValueError(f"指定安装面 {face_id} 在固化 STEP 中不存在")
    face = faces[index]
    surface_type = face.geomType()
    if source_point is None:
        if surface_type != "PLANE":
            raise ValueError(f"指定安装面 {face_id} 为 {surface_type}，曲面安装必须重新点击并保存安装点")
        reference = np.asarray(face.Center().toTuple(), dtype=float)
    else:
        requested = _point_coordinates(source_point)
        distance = float(face.distance(cq.Vertex.makeVertex(*requested)))
        tolerance = _preview_projection_tolerance(shapes)
        if not np.isfinite(distance) or distance > tolerance:
            raise ValueError(
                f"安装点不在指定安装面 {face_id} 上：距精确 STEP 面 {distance:.6f}，允许误差 {tolerance:.6f}"
            )
        try:
            reference = np.asarray(face.positionAt(*face.paramAt(tuple(requested))).toTuple(), dtype=float)
        except Exception as error:
            raise ValueError(f"指定安装面 {face_id} 无法解析点击点，请重新选择") from error
    try:
        source_normal = np.asarray(face.normalAt(cq.Vector(*reference)).toTuple(), dtype=float)
    except Exception as error:
        raise ValueError(f"指定安装面 {face_id} 在点击点处无法计算局部法向，请重新选择") from error
    transform = np.eye(4) if transform is None else np.asarray(transform, dtype=float)
    reference = (transform @ np.array([*reference, 1.0]))[:3]
    normal = np.linalg.inv(transform[:3, :3]).T @ source_normal
    normal /= np.linalg.norm(normal)
    return reference, normal
