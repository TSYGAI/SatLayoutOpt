"""
文件说明：校验包络参数，调用三维外部占据重建并物化唯一零度包络。
允许真实分离的水密外部构件；STEP 读取、归一化、资源隔离和发布由服务负责。
"""

from __future__ import annotations

from dataclasses import dataclass
import json
from pathlib import Path

import numpy as np
from shapely import polygons as shapely_polygons, union_all
from shapely.affinity import translate
from shapely.geometry import Polygon
import trimesh


ENVELOPE_ALGORITHM = "exterior_occupancy_directional_sweep_v9"
ENVELOPE_PREVIEW_ALGORITHM = "exterior_occupancy_directional_sweep_preview_v9"
STORED_ENVELOPE_ROTATIONS = (0,)
_GEOMETRY_EPSILON = 1e-8


class EnvelopeGenerationError(ValueError):
    """描述严格精细包络失败的阶段和每次重试结果，不允许退回凸包。"""

    def __init__(self, message: str, *, stage: str, attempts: list[dict] | None = None) -> None:
        """保存失败阶段和诊断记录，供隔离计算入口生成独立报告。"""
        super().__init__(message)
        self.stage = stage
        self.attempts = list(attempts or [])


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
    gap_bridge_limit_mm: float = 3.0
    voxel_max_cells: int = 8388608
    surface_batch_cells: int = 262144
    raster_triangle_batch: int = 4096
    raster_batch_cells: int = 131072
    workspace_memory_bytes: int = 268435456
    process_memory_limit_bytes: int = 3221225472
    memory_reserve_bytes: int = 4294967296


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
    quality: dict


def generate_envelope_variants(
    mesh: trimesh.Trimesh,
    output_dir: Path,
    parameters: EnvelopeParameters,
    source_is_envelope: bool = False,
) -> list[EnvelopeVariant]:
    """生成唯一的 0 度基础包络；仅参数完全相同的有效旧包络可原样复用。"""

    if source_is_envelope:
        _validate_outer_surface(mesh)
        base = mesh
    else:
        base = _locally_refined_outer_surface(mesh, parameters)
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
            envelope_quality=np.asarray(json.dumps(base.metadata.get("envelope_quality", {}), ensure_ascii=False)),
            source_transform=np.asarray(mesh.metadata.get("source_transform", np.eye(4)), dtype=np.float64),
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
            quality=dict(base.metadata.get("envelope_quality", {})),
        ))
    return variants


def _directional_clearance_bounds(
    mesh: trimesh.Trimesh,
    parameters: EnvelopeParameters,
) -> tuple[np.ndarray, np.ndarray]:
    """校验源三角网格和六向增量，返回各轴负向与正向扩张距离；非法输入抛出 ValueError。"""

    if mesh.is_empty or len(mesh.vertices) == 0 or len(mesh.faces) == 0:
        raise ValueError("模型没有可用于生成包络的三角面")
    vertices = np.asarray(mesh.vertices, dtype=np.float64)
    faces = np.asarray(mesh.faces)
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
    return negative, positive


def _outer_convex_surface(mesh: trimesh.Trimesh) -> trimesh.Trimesh:
    """用全部源顶点重建单一闭合凸外壳，移除内部零件、孔洞和内侧面片。

    返回值只描述最外层包络，不保留源三角面的数量或索引；各轴极值点仍属于凸包，
    因而六向增量确定的目标包围盒不会改变。
    """

    if mesh.is_empty or len(mesh.vertices) < 4:
        raise ValueError("源模型没有足够顶点用于重建外层包络")
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
    """使用有界三维占据区域重建精细外部包络，失败即报错，不返回凸包。"""

    from app.domain.envelope_voxel import build_outer_voxel_envelope
    from app.domain.envelope_resources import envelope_stage

    try:
        with envelope_stage("parameter_validation"):
            _validate_refinement_parameters(parameters)
            negative, positive = _directional_clearance_bounds(mesh, parameters)
        refined = build_outer_voxel_envelope(mesh, negative, positive, parameters)
        _validate_outer_surface(refined)
        return refined
    except Exception as error:
        raise EnvelopeGenerationError(
            f"精细包络生成失败；已拒绝使用凸包替代结果：{error}",
            stage=getattr(error, "envelope_stage", "exterior_occupancy_reconstruction"),
            attempts=[{"error_type": type(error).__name__, "error": str(error)}],
        ) from error


def _sweep_outline_axis(outline: Polygon, axis: int, lower: float, upper: float) -> Polygon:
    """沿二维轴连续扫掠去孔轮廓，返回两端轮廓与边界连接带的并集；失败时抛出 ValueError。"""

    if upper - lower <= _GEOMETRY_EPSILON:
        return translate(outline, xoff=lower if axis == 0 else 0.0,
                         yoff=lower if axis == 1 else 0.0)
    start, end = np.zeros(2), np.zeros(2)
    start[axis], end[axis] = lower, upper
    points = np.asarray(outline.exterior.coords, dtype=np.float64)
    first, second = points[:-1], points[1:]
    # 与扫掠方向平行的边退化为线，不应提交给多边形布尔运算。
    keep = np.abs(second[:, 1 - axis] - first[:, 1 - axis]) > _GEOMETRY_EPSILON
    strips = np.stack((first[keep] + start, second[keep] + start,
                       second[keep] + end, first[keep] + end), axis=1)
    parts = [translate(outline, xoff=start[0], yoff=start[1]),
             translate(outline, xoff=end[0], yoff=end[1])]
    parts.extend(shapely_polygons(strips))
    expanded = union_all(parts).buffer(0)
    # 边界连接带的并集会留下近重合/近共线点；拉伸前去除数值噪声，避免退回粗凸包。
    bounds = expanded.bounds
    tolerance = min(bounds[2] - bounds[0], bounds[3] - bounds[1]) * _GEOMETRY_EPSILON
    expanded = expanded.simplify(tolerance, preserve_topology=True)
    if not isinstance(expanded, Polygon) or expanded.is_empty or not expanded.is_valid:
        raise ValueError("六向增量扫掠未形成有效连续轮廓")
    return Polygon(expanded.exterior)


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
    if not np.isfinite(parameters.gap_bridge_limit_mm) or parameters.gap_bridge_limit_mm < 0:
        raise ValueError("包络封缝毫米上限必须为非负有限数值")
    for name in ("voxel_max_cells", "raster_triangle_batch", "raster_batch_cells", "workspace_memory_bytes", "process_memory_limit_bytes", "memory_reserve_bytes"):
        value = getattr(parameters, name)
        if isinstance(value, bool) or not isinstance(value, int) or value <= 0:
            raise ValueError(f"包络资源参数 {name} 必须为正整数")


def _remove_negligible_components(
    mesh: trimesh.Trimesh,
    target_bounds: np.ndarray,
) -> trimesh.Trimesh:
    """清除布尔交产生的极小孤立数值碎片；真实分离实体或边界变化会明确报错。"""

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


def _validate_outer_surface(mesh: trimesh.Trimesh) -> None:
    """确认候选包络顶点有限、绕序一致且水密，允许真实分离的外部构件。"""

    if (
        mesh.is_empty
        or len(mesh.vertices) < 4
        or len(mesh.faces) < 4
        or mesh.body_count < 1
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
