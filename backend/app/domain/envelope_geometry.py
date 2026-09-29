"""
文件说明：按六向包络增量放大模型，并在全局凸包上执行受限的全方位局部轮廓修正。
本模块只输出单体水密外表面；STEP 读取、姿态归一化和产物发布由模型包络服务负责。
"""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path

import numpy as np
from shapely import polygons as shapely_polygons, union_all
from shapely.errors import GEOSException
from shapely.geometry import Polygon
import trimesh


ENVELOPE_ALGORITHM = "axis_scaled_azimuthal_profile_outer_hull_v5"
ENVELOPE_PREVIEW_ALGORITHM = "axis_scaled_azimuthal_profile_outer_hull_preview_v5"
STORED_ENVELOPE_ROTATIONS = (0,)
_GEOMETRY_EPSILON = 1e-8


@dataclass(frozen=True)
class EnvelopeParameters:
    """描述六向毫米尺寸增量和局部轮廓修正参数。"""

    left_clearance_mm: float = 0.0
    right_clearance_mm: float = 0.0
    front_clearance_mm: float = 0.0
    back_clearance_mm: float = 0.0
    top_clearance_mm: float = 0.0
    bottom_clearance_mm: float = 0.0
    refinement_grid_size: int = 384
    refinement_direction_count: int = 20
    connectivity_core_inset_ratio: float = 0.12
    detail_smoothing_ratio: float = 0.008
    outline_simplify_ratio: float = 0.004
    gap_bridge_ratio: float = 0.06


@dataclass(frozen=True)
class EnvelopeVariant:
    """描述已物化的基础包络文件及其几何统计；列表结构保留用于兼容既有清单。"""

    rot_z: int
    file_name: str
    bbox_min: list[float]
    bbox_max: list[float]
    vertex_count: int
    triangle_count: int
    watertight: bool


def generate_envelope_variants(
    mesh: trimesh.Trimesh,
    output_dir: Path,
    parameters: EnvelopeParameters,
    source_is_outer_hull: bool = False,
) -> list[EnvelopeVariant]:
    """生成唯一的 0 度基础包络；同算法旧外壳可直接仿射复用。"""

    scaled = _axis_scaled_source_mesh(mesh, parameters)
    if source_is_outer_hull:
        _validate_outer_surface(scaled)
        base = scaled
    else:
        base = _locally_refined_outer_surface(scaled, parameters)
    output_dir.mkdir(parents=True, exist_ok=False)
    variants: list[EnvelopeVariant] = []
    for rot_z in STORED_ENVELOPE_ROTATIONS:
        envelope = _rotate_mesh_z(base, rot_z)
        file_name = f"rot_z_{rot_z}_envelope.npz"
        path = output_dir / file_name
        vertices = np.asarray(envelope.vertices, dtype=np.float64)
        faces = np.asarray(envelope.faces, dtype=np.int64)
        np.savez_compressed(
            path,
            vertices=vertices,
            faces=faces,
            face_part_ids=np.zeros(len(faces), dtype=np.int64),
            preview_vertices=vertices,
            preview_faces=faces,
            envelope_algorithm=np.asarray(ENVELOPE_ALGORITHM),
            preview_algorithm=np.asarray(ENVELOPE_PREVIEW_ALGORITHM),
        )
        bounds = np.asarray(envelope.bounds, dtype=float)
        variants.append(EnvelopeVariant(
            rot_z=rot_z,
            file_name=file_name,
            bbox_min=bounds[0].tolist(),
            bbox_max=bounds[1].tolist(),
            vertex_count=len(vertices),
            triangle_count=len(faces),
            watertight=bool(envelope.is_watertight),
        ))
    return variants


def _axis_scaled_source_mesh(
    mesh: trimesh.Trimesh,
    parameters: EnvelopeParameters,
) -> trimesh.Trimesh:
    """把源包围盒映射到六向扩张后的边界，同时原样保留网格拓扑和面顺序。

    每个轴独立缩放。相对两侧距离不相等时，目标包围盒中心随之偏移，因此允许生成
    非对称包络；所有源顶点仍通过同一个轴向仿射映射得到一一对应的包络顶点。
    """

    if mesh.is_empty or len(mesh.vertices) == 0 or len(mesh.faces) == 0:
        raise ValueError("模型没有可用于生成包络的三角面")
    vertices = np.asarray(mesh.vertices, dtype=np.float64)
    faces = np.asarray(mesh.faces, dtype=np.int64)
    if (
        vertices.ndim != 2
        or vertices.shape[1] != 3
        or not np.all(np.isfinite(vertices))
        or faces.ndim != 2
        or faces.shape[1] != 3
        or faces.min() < 0
        or faces.max() >= len(vertices)
    ):
        raise ValueError("模型包含无效的顶点或三角面")

    negative = np.asarray([
        parameters.left_clearance_mm,
        parameters.front_clearance_mm,
        parameters.bottom_clearance_mm,
    ], dtype=np.float64)
    positive = np.asarray([
        parameters.right_clearance_mm,
        parameters.back_clearance_mm,
        parameters.top_clearance_mm,
    ], dtype=np.float64)
    if not np.all(np.isfinite(negative)) or not np.all(np.isfinite(positive)):
        raise ValueError("六向包络增量必须是有限数值")
    if np.any(negative < 0.0) or np.any(positive < 0.0):
        raise ValueError("六向包络增量不能小于 0")

    source_lower = vertices.min(axis=0)
    source_upper = vertices.max(axis=0)
    source_extent = source_upper - source_lower
    if np.any(source_extent <= _GEOMETRY_EPSILON):
        raise ValueError("无法从平面或线性模型生成三维包络")
    target_lower = source_lower - negative
    target_upper = source_upper + positive
    scale = (target_upper - target_lower) / source_extent
    scaled_vertices = target_lower + (vertices - source_lower) * scale
    return trimesh.Trimesh(
        vertices=scaled_vertices,
        faces=faces.copy(),
        process=False,
    )


def _outer_convex_surface(mesh: trimesh.Trimesh) -> trimesh.Trimesh:
    """用全部放大顶点重建单一闭合凸外壳，彻底移除内部零件、孔洞和内侧面片。

    返回值只描述最外层包络，不保留源三角面的数量或索引；各轴极值点仍属于凸包，
    因而六向增量确定的目标包围盒不会改变。
    """

    if mesh.is_empty or len(mesh.vertices) < 4:
        raise ValueError("放大后的模型没有足够顶点用于重建外层包络")
    source_bounds = np.asarray(mesh.bounds, dtype=np.float64)
    try:
        outer = trimesh.convex.convex_hull(np.asarray(mesh.vertices, dtype=np.float64))
    except Exception as error:
        raise ValueError(f"最外层包络重建失败：{error}") from error
    _validate_outer_surface(outer)
    tolerance = max(float(np.max(source_bounds[1] - source_bounds[0])) * 1e-8, _GEOMETRY_EPSILON)
    if not np.allclose(np.asarray(outer.bounds, dtype=float), source_bounds, rtol=0.0, atol=tolerance):
        raise ValueError("最外层包络重建后未保持六向目标边界")
    return outer


def _locally_refined_outer_surface(
    mesh: trimesh.Trimesh,
    parameters: EnvelopeParameters,
) -> trimesh.Trimesh:
    """在全局凸包内按绕 Z 轴均布的竖向投影重建主要外轮廓，并保留原六向边界。

    每个方位使用去孔后的真实最外轮廓，经向外平滑和简化忽略小凸起，再封连窄缝；深层凸包核心
    只负责连接主体，不再覆盖圆筒、支架和底座间的大尺度收缩。顶视 XY 轮廓不参与
    切削。任一投影或布尔运算无法形成可靠单体时返回原全局凸包。
    """

    _validate_refinement_parameters(parameters)
    global_hull = _outer_convex_surface(mesh)
    try:
        vertices = np.asarray(mesh.vertices, dtype=np.float64)
        directions = _refinement_directions(parameters.refinement_direction_count)
        prisms = []
        for direction in directions:
            outline = _locally_refined_projection(mesh, direction, parameters)
            outline_hull_area = float(outline.convex_hull.area)
            if outline_hull_area - float(outline.area) <= outline_hull_area * 1e-8:
                continue
            prisms.append(_extrude_projection_prism(outline, direction, vertices))
        if not prisms:
            return global_hull
        refined = trimesh.boolean.intersection(
            [global_hull, *prisms],
            engine="manifold",
            check_volume=True,
        )
        if not isinstance(refined, trimesh.Trimesh):
            return global_hull
        refined = _remove_negligible_components(
            refined,
            np.asarray(global_hull.bounds, dtype=np.float64),
        )
        _validate_outer_surface(refined)
        restored = _restore_mesh_bounds(refined, np.asarray(global_hull.bounds, dtype=np.float64))
        _validate_outer_surface(restored)
        return restored
    except (GEOSException, RuntimeError, TypeError, ValueError):
        return global_hull


def _validate_refinement_parameters(parameters: EnvelopeParameters) -> None:
    """校验局部修正参数，避免异常网格规模或过深内缩改变主体形状。"""

    ratios = np.asarray([
        parameters.connectivity_core_inset_ratio,
        parameters.detail_smoothing_ratio,
        parameters.outline_simplify_ratio,
        parameters.gap_bridge_ratio,
    ], dtype=np.float64)
    if parameters.refinement_grid_size < 32:
        raise ValueError("局部包络投影格数不能小于 32")
    if parameters.refinement_direction_count < 2 or parameters.refinement_direction_count > 64:
        raise ValueError("局部包络投影方向数量必须在 2 到 64 之间")
    if not np.all(np.isfinite(ratios)) or np.any(ratios < 0.0):
        raise ValueError("局部包络比例必须是非负有限数值")
    if parameters.connectivity_core_inset_ratio > 0.5:
        raise ValueError("局部包络连接核心内缩比例不能大于 0.5")


def _refinement_directions(direction_count: int) -> tuple[np.ndarray, ...]:
    """返回半圆内均匀分布的水平投影方向；相反方向表示同一个竖向投影平面。"""

    return tuple(
        np.asarray([np.cos(angle), np.sin(angle)], dtype=np.float64)
        for angle in np.linspace(0.0, np.pi, direction_count, endpoint=False)
    )


def _locally_refined_projection(
    mesh: trimesh.Trimesh,
    horizontal_direction: np.ndarray,
    parameters: EnvelopeParameters,
) -> Polygon:
    """返回平滑且封连窄槽的二维外边界；宽凹陷保留，闭运算不得削掉已有轮廓。"""

    projected = _quantized_projection_union(
        mesh,
        horizontal_direction,
        parameters.refinement_grid_size,
    )
    hull = projected.convex_hull
    if not isinstance(hull, Polygon) or hull.is_empty or hull.area <= _GEOMETRY_EPSILON:
        raise ValueError("模型侧投影无法形成有效外轮廓")
    min_x, min_y, max_x, max_y = hull.bounds
    short_span = min(max_x - min_x, max_y - min_y)
    if short_span <= _GEOMETRY_EPSILON:
        raise ValueError("模型侧投影缺少二维跨度")

    inset = parameters.connectivity_core_inset_ratio * short_span
    smoothing = parameters.detail_smoothing_ratio * short_span
    simplify = parameters.outline_simplify_ratio * short_span
    core = hull.buffer(-inset, join_style="mitre") if inset > 0.0 else hull
    if core.is_empty:
        return hull
    if not isinstance(projected, Polygon):
        return hull
    detail = Polygon(projected.exterior).buffer(smoothing, quad_segs=2)
    if simplify > 0.0:
        detail = detail.simplify(simplify, preserve_topology=True).buffer(simplify, quad_segs=2)
    bridge_radius = parameters.gap_bridge_ratio * short_span * 0.5
    if bridge_radius > 0.0:
        closed = detail.buffer(bridge_radius, quad_segs=4).buffer(-bridge_radius, quad_segs=4)
        # 闭运算按槽宽连接，即使窄槽很深也能封住；并回原轮廓以抵消离散圆弧的收缩误差。
        detail = union_all((detail, closed))
    refined = union_all((core, detail)).intersection(hull).buffer(0)
    # 清理闭运算并集产生的近重合点，避免拉伸后出现零面积侧面；容差仅用于数值去噪。
    refined = refined.simplify(short_span * _GEOMETRY_EPSILON, preserve_topology=True)
    if not isinstance(refined, Polygon) or refined.is_empty or refined.area <= _GEOMETRY_EPSILON:
        return hull
    outer = Polygon(refined.exterior)
    if not outer.is_valid or outer.area <= _GEOMETRY_EPSILON:
        return hull
    return outer


def _remove_negligible_components(
    mesh: trimesh.Trimesh,
    target_bounds: np.ndarray,
) -> trimesh.Trimesh:
    """清除布尔交产生的极小孤立数值碎片；真实分离实体或边界变化会触发回退。"""

    if mesh.body_count == 1:
        return mesh
    components = list(mesh.split(only_watertight=False))
    if not components:
        raise ValueError("局部包络布尔结果没有有效主体")
    main = max(components, key=lambda component: abs(float(component.volume)))
    main_volume = abs(float(main.volume))
    discarded_volume = sum(
        abs(float(component.volume))
        for component in components
        if component is not main
    )
    tolerance = max(float(np.max(target_bounds[1] - target_bounds[0])) * 1e-8, _GEOMETRY_EPSILON)
    if (
        main_volume <= _GEOMETRY_EPSILON
        or discarded_volume > main_volume * 1e-5
        or not np.allclose(np.asarray(main.bounds), target_bounds, rtol=0.0, atol=tolerance)
    ):
        raise ValueError("局部包络产生了不可忽略的分离实体")
    return main


def _quantized_projection_union(
    mesh: trimesh.Trimesh,
    horizontal_direction: np.ndarray,
    grid_size: int,
):
    """把任意水平视向与 Z 组成侧投影，并在固定网格上合并重复三角形。"""

    direction = np.asarray(horizontal_direction, dtype=np.float64)
    if direction.shape != (2,) or not np.all(np.isfinite(direction)):
        raise ValueError("水平投影方向必须是二维有限向量")
    norm = float(np.linalg.norm(direction))
    if norm <= _GEOMETRY_EPSILON:
        raise ValueError("水平投影方向不能为零向量")
    direction = direction / norm
    source_vertices = np.asarray(mesh.vertices, dtype=np.float64)
    vertices = np.column_stack((source_vertices[:, :2] @ direction, source_vertices[:, 2]))
    faces = np.asarray(mesh.faces, dtype=np.int64)
    lower = vertices.min(axis=0)
    upper = vertices.max(axis=0)
    span = upper - lower
    if np.any(span <= _GEOMETRY_EPSILON):
        raise ValueError("模型侧投影缺少有效跨度")
    step = span / float(grid_size - 1)
    quantized = np.rint((vertices - lower) / step).astype(np.int32)
    point_codes = quantized[:, 0] * grid_size + quantized[:, 1]
    triangle_codes = np.sort(point_codes[faces], axis=1)
    triangle_codes = triangle_codes[
        (triangle_codes[:, 0] != triangle_codes[:, 1])
        & (triangle_codes[:, 1] != triangle_codes[:, 2])
    ]
    if len(triangle_codes) == 0:
        raise ValueError("模型侧投影没有有效三角形")
    triangle_codes = np.unique(triangle_codes, axis=0)
    grid_points = np.empty((len(triangle_codes), 3, 2), dtype=np.int64)
    grid_points[:, :, 0] = triangle_codes // grid_size
    grid_points[:, :, 1] = triangle_codes % grid_size
    first = grid_points[:, 1] - grid_points[:, 0]
    second = grid_points[:, 2] - grid_points[:, 0]
    non_collinear = first[:, 0] * second[:, 1] != first[:, 1] * second[:, 0]
    grid_points = grid_points[non_collinear]
    if len(grid_points) == 0:
        raise ValueError("模型侧投影三角形全部退化")
    coordinates = lower + grid_points.astype(np.float64) * step
    projected = union_all(shapely_polygons(coordinates)).buffer(0)
    if projected.is_empty or projected.area <= _GEOMETRY_EPSILON:
        raise ValueError("模型侧投影合并后为空")
    return projected


def _extrude_projection_prism(
    outline: Polygon,
    horizontal_direction: np.ndarray,
    source_vertices: np.ndarray,
) -> trimesh.Trimesh:
    """把任意方位的二维侧轮廓沿其水平法向拉伸为完全覆盖模型的水密棱柱。"""

    direction = np.asarray(horizontal_direction, dtype=np.float64)
    direction = direction / float(np.linalg.norm(direction))
    extrusion_direction = np.asarray([-direction[1], direction[0]], dtype=np.float64)
    vertices_3d = np.asarray(source_vertices, dtype=np.float64)
    extrusion_coordinates = vertices_3d[:, :2] @ extrusion_direction
    extrusion_min = float(extrusion_coordinates.min())
    extrusion_max = float(extrusion_coordinates.max())
    extent = vertices_3d.max(axis=0) - vertices_3d.min(axis=0)
    padding = max(float(np.max(extent)) * 0.01, _GEOMETRY_EPSILON)
    height = extrusion_max - extrusion_min + 2.0 * padding
    raw = trimesh.creation.extrude_polygon(outline, height)
    prism_vertices = np.asarray(raw.vertices, dtype=np.float64)
    extrusion_values = prism_vertices[:, 2] + extrusion_min - padding
    vertices = np.empty_like(prism_vertices)
    vertices[:, :2] = (
        prism_vertices[:, 0, np.newaxis] * direction
        + extrusion_values[:, np.newaxis] * extrusion_direction
    )
    vertices[:, 2] = prism_vertices[:, 1]
    prism = trimesh.Trimesh(
        vertices=vertices,
        faces=np.asarray(raw.faces, dtype=np.int64),
        process=False,
    )
    prism.fix_normals()
    if not prism.is_volume:
        raise ValueError("局部包络投影棱柱不是有效实体")
    return prism


def _restore_mesh_bounds(mesh: trimesh.Trimesh, target_bounds: np.ndarray) -> trimesh.Trimesh:
    """通过极小轴向仿射校正恢复量化或布尔运算前的精确六向边界。"""

    source_bounds = np.asarray(mesh.bounds, dtype=np.float64)
    source_extent = source_bounds[1] - source_bounds[0]
    target_extent = target_bounds[1] - target_bounds[0]
    if np.any(source_extent <= _GEOMETRY_EPSILON) or np.any(target_extent <= _GEOMETRY_EPSILON):
        raise ValueError("局部包络无法恢复六向边界")
    vertices = target_bounds[0] + (
        (np.asarray(mesh.vertices, dtype=np.float64) - source_bounds[0])
        * (target_extent / source_extent)
    )
    return trimesh.Trimesh(
        vertices=vertices,
        faces=np.asarray(mesh.faces, dtype=np.int64),
        process=False,
    )


def _validate_outer_surface(mesh: trimesh.Trimesh) -> None:
    """确认候选包络是顶点有限、绕序一致的单一水密三角外壳。"""

    if (
        mesh.is_empty
        or len(mesh.vertices) < 4
        or len(mesh.faces) < 4
        or mesh.body_count != 1
        or not mesh.is_watertight
        or not mesh.is_winding_consistent
        or not np.all(np.isfinite(mesh.vertices))
    ):
        raise ValueError("最外层包络重建后不是有效的单一闭合外壳")


def _rotate_mesh_z(mesh: trimesh.Trimesh, degrees: int) -> trimesh.Trimesh:
    """绕 Z 轴旋转包络副本；当前正式产物只调用零度路径。"""

    rotated = mesh.copy()
    if degrees % 360 == 0:
        return rotated
    angle = np.radians(float(degrees))
    cosine, sine = np.cos(angle), np.sin(angle)
    transform = np.asarray([
        [cosine, -sine, 0.0, 0.0],
        [sine, cosine, 0.0, 0.0],
        [0.0, 0.0, 1.0, 0.0],
        [0.0, 0.0, 0.0, 1.0],
    ])
    rotated.apply_transform(transform)
    return rotated
