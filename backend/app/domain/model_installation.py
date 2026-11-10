"""文件说明：解析用户指定的 STEP 安装面和曲面点击点，提供可由模型设置与布局共同复用的精确安装基准。

依赖 CadQuery 解析源几何、NumPy/SciPy 按点集实际维度提取安装区域；只负责点/法向校验
与坐标变换，不决定侧挂或顶部姿态。区域筛选沿用统一布局容差，不改变源几何。
"""

from app.compute.monitoring import observed, stage, object_context


import re
from pathlib import Path

import cadquery as cq
import numpy as np

from app.core.config import runtime_config
from app.domain.model_installation_plane import is_geometric_plane


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


def _preview_projection_tolerance(shapes, linear_ratio=None):
    """按实际预览离散精度返回投影容差，省略比例时沿用高清档标准。"""

    bounds = [shape.BoundingBox() for shape in shapes]
    lower = np.min([[item.xmin, item.ymin, item.zmin] for item in bounds], axis=0)
    upper = np.max([[item.xmax, item.ymax, item.zmax] for item in bounds], axis=0)
    maximum_size = float(np.max(upper - lower))
    ratio = runtime_config.model_preview_detail_linear_ratio if linear_ratio is None else float(linear_ratio)
    return max(maximum_size * ratio * 2.0, 1e-6)


def _region_support_points(points, face_id):
    """按采样点仿射维度返回原始凸包支撑点；无有效面积或凸包计算失败时抛含面 ID 的 ValueError。

    STEP 的 BSPLINE 等类型也可能表示平面，因此仅按机器精度判断秩，不按曲面标签判断维度。
    投影只用于选择顶点索引，返回值保留源坐标；不以毫米共面容差抹平真实曲率或随机扰动点集。
    """
    from scipy.spatial import ConvexHull, QhullError

    region = np.unique(np.asarray(points, dtype=float), axis=0)
    if region.ndim != 2 or region.shape[1] != 3 or len(region) < 3 or not np.isfinite(region).all():
        raise ValueError(f"指定安装面 {face_id} 缺少有效安装区域")
    centered = region - region[0]
    _, singular_values, axes = np.linalg.svd(centered, full_matrices=False)
    rank_tolerance = singular_values[0] * max(centered.shape) * np.finfo(float).eps
    dimension = int(np.count_nonzero(singular_values > rank_tolerance))
    if dimension < 2:
        raise ValueError(f"指定安装面 {face_id} 的安装区域退化为点或直线，无法确定有效面积")
    coordinates = centered @ axes[:2].T if dimension == 2 else centered
    try:
        indices = ConvexHull(coordinates).vertices
    except QhullError as error:
        raise ValueError(f"指定安装面 {face_id} 的安装区域无法构建稳定凸包，请检查源几何") from error
    return region[indices]


@observed("解析精确安装基准")
def read_installation_reference(path, face_id, transform=None, source_point=None, preview_linear_ratio=None,
                                cached_faces_path=None, preview_tolerance=None, include_region=False, plane_tolerance=None):
    """读取 STEP 安装基准并返回变换后的点和局部外法向。

    平面兼容没有点击点的旧记录并使用面中心；曲面必须提供源坐标点击点。点击点会先校验属于
    当前裁剪面，再投影到精确 STEP 曲面，避免直接使用浏览三角网格法向。
    preview_linear_ratio 只由后端当前预览清单提供，控制粗网格点击点的弦差容许值。
    cached_faces_path 是经源文件指纹校验的标准导入 BRep 缓存；其直接子节点顺序与 STEP 面 ID 一致。
    include_region 同时返回变换后的共面安装区域支撑点，plane_tolerance 为世界毫米共面容差；曲面只使用所选面。
    """

    if not isinstance(face_id, str) or re.fullmatch(r"FACE_\d{5}", face_id) is None:
        raise ValueError("请在卫星设置中指定安装面并重新固化模型")
    stage("读取安装面几何", face_id=face_id, file=str(path))
    if cached_faces_path is not None and Path(cached_faces_path).is_file():
        compound = cq.Shape.importBin(str(cached_faces_path))
        faces = list(compound)
        shapes = [compound]
    else:
        shapes = list(cq.importers.importStep(str(path)).vals())
        faces = [face for shape in shapes for face in shape.Faces()]
    index = int(face_id.split("_")[1]) - 1
    if index < 0 or index >= len(faces):
        raise ValueError(f"指定安装面 {face_id} 在固化 STEP 中不存在")
    stage("校验点击点并计算安装面法向", face_id=face_id)
    face = faces[index]
    surface_type = face.geomType()
    if source_point is None:
        if surface_type != "PLANE":
            raise ValueError(f"指定安装面 {face_id} 为 {surface_type}，曲面安装必须重新点击并保存安装点")
        reference = np.asarray(face.Center().toTuple(), dtype=float)
    else:
        requested = _point_coordinates(source_point)
        distance = float(face.distance(cq.Vertex.makeVertex(*requested)))
        tolerance = float(preview_tolerance) if preview_tolerance is not None else _preview_projection_tolerance(shapes, preview_linear_ratio)
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
    if include_region:
        from app.domain.layout_config import LAYOUT_CONFIG
        planar = is_geometric_plane(face)
        if plane_tolerance is None or plane_tolerance <= 0:
            raise ValueError("提取共面安装区域必须提供正毫米容差")
        points = []
        tessellation_tolerance = plane_tolerance / np.linalg.norm(transform[:3, :3], axis=0).max()
        for face_index, candidate in enumerate(faces):
            stage("检索共面安装区域", face_index=face_index, face_count=len(faces))
            if planar:
                if not is_geometric_plane(candidate):
                    continue
                candidate_normal = np.linalg.inv(transform[:3, :3]).T @ np.asarray(candidate.normalAt().toTuple())
                candidate_normal /= np.linalg.norm(candidate_normal)
                if np.linalg.norm(np.cross(candidate_normal, normal)) > LAYOUT_CONFIG["orientation_tolerance"]:
                    continue
                center = (transform @ [*candidate.Center().toTuple(), 1.0])[:3]
                if abs(float((center - reference) @ normal)) > plane_tolerance:
                    continue
            elif not candidate.isSame(face):
                continue
            vertices, _ = candidate.tessellate(float(tessellation_tolerance))
            points.extend(vertex.toTuple() for vertex in vertices)
        if not points:
            raise ValueError(f"指定安装面 {face_id} 缺少有效安装区域")
        stage("构建安装区域凸包")
        region = _region_support_points(points, face_id)
        return reference, normal, region @ transform[:3, :3].T + transform[:3, 3]
    return reference, normal
