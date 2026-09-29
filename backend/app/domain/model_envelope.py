"""
文件说明：从完整 STEP 或可复用旧外壳按模型姿态和六向尺寸增量生成连续外层包络，并转换浏览资源。
本模块连接原始模型、可复用包络产物与纯几何模块；HTTP 路由、进程隔离和原子发布由上传服务负责。
"""

from __future__ import annotations

from datetime import datetime, timezone
import json
import math
from pathlib import Path

import numpy as np
import trimesh

from app.domain.envelope_geometry import (
    ENVELOPE_ALGORITHM,
    EnvelopeParameters,
    generate_envelope_variants,
)


MODEL_ENVELOPE_FORMAT_VERSION = 1
UNIT_TO_MILLIMETERS = {"mm": 1.0, "cm": 10.0, "m": 1000.0}
_REUSABLE_ENVELOPE_ALGORITHMS = frozenset({ENVELOPE_ALGORITHM})
_STEP_MESH_PARAMETER_KEYS = (
    "step_linear_ratio",
    "step_min_linear_tolerance_mm",
    "step_angular_degrees",
    "refinement_grid_size",
    "refinement_direction_count",
    "connectivity_core_inset_ratio",
    "detail_smoothing_ratio",
    "outline_simplify_ratio",
    "gap_bridge_ratio",
)


def geometry_settings_fingerprint(settings: dict) -> dict:
    """提取会改变包络几何的单位、比例和初始姿态设置。"""

    return {
        "model_scale": float(settings["model_scale"]),
        "model_unit": str(settings["model_unit"]),
        "rotation_x": int(settings["rotation_x"]),
        "rotation_y": int(settings["rotation_y"]),
        "rotation_z": int(settings["rotation_z"]),
    }


def envelope_parameters_from_dict(values: dict) -> EnvelopeParameters:
    """把隔离任务中的 JSON 参数恢复为严格的包络参数对象。"""

    return EnvelopeParameters(
        left_clearance_mm=float(values["left_clearance_mm"]),
        right_clearance_mm=float(values["right_clearance_mm"]),
        front_clearance_mm=float(values["front_clearance_mm"]),
        back_clearance_mm=float(values["back_clearance_mm"]),
        # 兼容尚未带上下字段的旧任务请求；新服务生成的任务始终会显式传入六向参数。
        top_clearance_mm=float(values.get("top_clearance_mm", 0.0)),
        bottom_clearance_mm=float(values.get("bottom_clearance_mm", 0.0)),
        refinement_grid_size=int(values["refinement_grid_size"]),
        refinement_direction_count=int(values.get("refinement_direction_count", 20)),
        connectivity_core_inset_ratio=float(values.get("connectivity_core_inset_ratio", 0.12)),
        detail_smoothing_ratio=float(values["detail_smoothing_ratio"]),
        outline_simplify_ratio=float(values["outline_simplify_ratio"]),
        gap_bridge_ratio=float(values.get("gap_bridge_ratio", 0.06)),
    )


def load_preview_triangle_mesh(path: Path) -> trimesh.Trimesh:
    """读取细节 GLB 中全部三角形节点，应用场景变换并忽略拓扑线节点。"""

    loaded = trimesh.load(path, force="scene", process=False)
    if isinstance(loaded, trimesh.Trimesh):
        meshes = [loaded]
    elif isinstance(loaded, trimesh.Scene):
        meshes = []
        for node_name in loaded.graph.nodes_geometry:
            transform, geometry_name = loaded.graph[node_name]
            geometry = loaded.geometry.get(geometry_name)
            if not isinstance(geometry, trimesh.Trimesh) or len(geometry.faces) == 0:
                continue
            transformed = geometry.copy()
            transformed.apply_transform(np.asarray(transform, dtype=float))
            meshes.append(transformed)
    else:
        meshes = []
    if not meshes:
        raise ValueError("细节预览中没有可用于生成包络的三角网格")
    return trimesh.util.concatenate(meshes)


def load_step_triangle_mesh(
    path: Path,
    *,
    linear_ratio: float,
    minimum_linear_tolerance_mm: float,
    angular_degrees: float,
) -> trimesh.Trimesh:
    """按包络专用公差离散完整 STEP 形状，保留所有可能影响外围轮廓的面。

    参数：
        path: STEP/STP 原始文件路径。
        linear_ratio: 线性公差占精确包围盒对角线的比例。
        minimum_linear_tolerance_mm: 线性公差下限，单位为毫米。
        angular_degrees: 角度公差，单位为度。
    返回：
        包含全部 STEP 组件的未简化三角网格。
    异常：
        ValueError: STEP 为空、参数无效或离散后没有有效三角形。
    """

    if linear_ratio <= 0 or minimum_linear_tolerance_mm <= 0 or angular_degrees <= 0:
        raise ValueError("STEP 包络离散参数必须大于 0")
    try:
        import cadquery as cq

        imported = cq.importers.importStep(str(path))
        values = list(imported.vals())
        if not values:
            raise ValueError("STEP 模型不包含可生成包络的形状")
        shape = values[0] if len(values) == 1 else cq.Compound.makeCompound(values)
        bounds = shape.BoundingBox()
        lower = np.asarray([bounds.xmin, bounds.ymin, bounds.zmin], dtype=float)
        upper = np.asarray([bounds.xmax, bounds.ymax, bounds.zmax], dtype=float)
        diagonal = float(np.linalg.norm(upper - lower))
        linear_tolerance = max(
            diagonal * float(linear_ratio),
            float(minimum_linear_tolerance_mm),
        )
        vertices, faces = shape.tessellate(
            linear_tolerance,
            math.radians(float(angular_degrees)),
        )
    except ValueError:
        raise
    except Exception as error:
        raise ValueError(f"STEP 包络网格离散失败：{error}") from error
    if not vertices or not faces:
        raise ValueError("STEP 模型没有产生可用于生成包络的三角形")
    mesh = trimesh.Trimesh(
        vertices=np.asarray([vertex.toTuple() for vertex in vertices], dtype=np.float64),
        faces=np.asarray(faces, dtype=np.int64),
        process=False,
    )
    if mesh.is_empty or not np.all(np.isfinite(mesh.vertices)):
        raise ValueError("STEP 包络网格包含无效几何")
    return mesh


def envelope_source_transform(mesh: trimesh.Trimesh, settings: dict) -> np.ndarray:
    """返回源模型到毫米包络坐标的仿射矩阵，供生成与预览还原共享。

    内禀 XYZ 与预览一致，对列向量对应 Rx·Ry·Rz，因此逐轴应用时先 Z、再 Y、最后 X。
    单位、比例或角度不合法时抛出 ValueError，不修改输入网格。
    """

    unit = str(settings["model_unit"])
    if unit not in UNIT_TO_MILLIMETERS:
        raise ValueError("模型单位必须是 mm、cm 或 m")
    scale = float(settings["model_scale"]) * UNIT_TO_MILLIMETERS[unit]
    if not np.isfinite(scale) or scale <= 0:
        raise ValueError("模型比例必须大于 0")
    basis = np.eye(3) * scale
    basis = _rotate_vertices_z(basis, int(settings["rotation_z"]))
    basis = _rotate_vertices_y(basis, int(settings["rotation_y"]))
    basis = _rotate_vertices_x(basis, int(settings["rotation_x"]))
    vertices = np.asarray(mesh.vertices, dtype=float) @ basis
    lower = vertices.min(axis=0)
    upper = vertices.max(axis=0)
    transform = np.eye(4)
    transform[:3, :3] = basis.T
    transform[:3, 3] = -np.asarray([(lower[0] + upper[0]) / 2.0, (lower[1] + upper[1]) / 2.0, lower[2]])
    return transform


def normalize_envelope_source_mesh(mesh: trimesh.Trimesh, settings: dict) -> trimesh.Trimesh:
    """返回应用单位、比例、内禀 XYZ 旋转及居中接地变换后的网格副本。"""

    normalized = mesh.copy()
    normalized.apply_transform(envelope_source_transform(mesh, settings))
    return normalized


def build_envelope_preview_glb(envelope_path: Path, source_preview_path: Path, settings: dict) -> bytes:
    """读取零度 NPZ 的连续外层显示网格并返回源模型局部坐标的 GLB，不重新计算包络。

    预览与源模型应用相同的显示变换即可重合；文件损坏时抛出 ValueError 或 OSError。
    原 NPZ 与源 GLB 均只读；历史包络没有独立显示网格时回退到正式碰撞网格。
    """

    try:
        with np.load(envelope_path, allow_pickle=False) as data:
            has_preview = "preview_vertices" in data and "preview_faces" in data
            vertices = np.asarray(
                data["preview_vertices"] if has_preview else data["vertices"],
                dtype=float,
            )
            faces = np.asarray(
                data["preview_faces"] if has_preview else data["faces"],
                dtype=np.int64,
            )
    except (KeyError, TypeError) as error:
        raise ValueError("包络文件缺少有效的顶点或三角形") from error
    if (
        vertices.ndim != 2 or vertices.shape[1] != 3 or not len(vertices)
        or not np.all(np.isfinite(vertices))
        or faces.ndim != 2 or faces.shape[1] != 3 or not len(faces)
        or faces.min() < 0 or faces.max() >= len(vertices)
    ):
        raise ValueError("包络网格数据无效，请重新生成")
    source_mesh = load_preview_triangle_mesh(source_preview_path)
    transform = envelope_source_transform(source_mesh, settings)
    envelope = trimesh.Trimesh(vertices=vertices, faces=faces, process=False)
    envelope.apply_transform(np.linalg.inv(transform))
    return envelope.export(file_type="glb")


def _load_reusable_normalized_envelope(
    directory: Path | None,
    source: dict,
    settings: dict,
    parameters: dict,
) -> tuple[trimesh.Trimesh, dict, bool] | None:
    """从同一 STEP 和姿态的旧包络反算标准化外壳，避免重复执行 STEP 离散。

    旧包络必须来自轴向仿射算法，并且 STEP 指纹、姿态及离散参数全部相同。任何缺失、
    损坏或边界不一致都返回空值，由调用方自动回退到完整 STEP 读取。
    """

    if directory is None:
        return None
    try:
        manifest = json.loads((directory / "manifest.json").read_text(encoding="utf-8"))
        previous_algorithm = manifest.get("algorithm")
        if previous_algorithm not in _REUSABLE_ENVELOPE_ALGORITHMS:
            return None
        if manifest.get("source") != source:
            return None
        if manifest.get("geometry_settings") != geometry_settings_fingerprint(settings):
            return None
        previous_parameters = manifest["parameters"]
        if any(
            float(previous_parameters[key]) != float(parameters[key])
            for key in _STEP_MESH_PARAMETER_KEYS
        ):
            return None
        variant = next(item for item in manifest["variants"] if int(item["rot_z"]) == 0)
        file_name = str(variant["file_name"])
        if Path(file_name).name != file_name:
            return None
        source_summary = manifest["source_mesh"]
        source_bounds = np.asarray(
            [source_summary["bbox_min"], source_summary["bbox_max"]],
            dtype=np.float64,
        )
        target_bounds = np.asarray(
            [variant["bbox_min"], variant["bbox_max"]],
            dtype=np.float64,
        )
        with np.load(directory / file_name, allow_pickle=False) as data:
            vertices = np.asarray(data["vertices"], dtype=np.float64)
            faces = np.asarray(data["faces"], dtype=np.int64)
        vertex_count = int(source_summary["vertex_count"])
        triangle_count = int(source_summary["triangle_count"])
    except (OSError, ValueError, TypeError, KeyError, StopIteration, json.JSONDecodeError):
        return None
    if (
        source_bounds.shape != (2, 3)
        or target_bounds.shape != (2, 3)
        or not np.all(np.isfinite(source_bounds))
        or not np.all(np.isfinite(target_bounds))
        or vertices.ndim != 2
        or vertices.shape[1] != 3
        or len(vertices) < 4
        or not np.all(np.isfinite(vertices))
        or faces.ndim != 2
        or faces.shape[1] != 3
        or len(faces) < 4
        or faces.min() < 0
        or faces.max() >= len(vertices)
        or vertex_count < 4
        or triangle_count < 4
    ):
        return None
    source_extent = source_bounds[1] - source_bounds[0]
    target_extent = target_bounds[1] - target_bounds[0]
    if np.any(source_extent <= 0.0) or np.any(target_extent <= 0.0):
        return None
    tolerance = max(float(np.max(target_extent)) * 1e-8, 1e-8)
    actual_target_bounds = np.vstack((vertices.min(axis=0), vertices.max(axis=0)))
    if not np.allclose(actual_target_bounds, target_bounds, rtol=0.0, atol=tolerance):
        return None
    normalized_vertices = source_bounds[0] + (
        (vertices - target_bounds[0]) * (source_extent / target_extent)
    )
    reusable = trimesh.Trimesh(vertices=normalized_vertices, faces=faces, process=False)
    source_tolerance = max(float(np.max(source_extent)) * 1e-8, 1e-8)
    if not np.allclose(np.asarray(reusable.bounds), source_bounds, rtol=0.0, atol=source_tolerance):
        return None
    is_outer_hull = previous_algorithm == ENVELOPE_ALGORITHM
    if is_outer_hull and (
        reusable.body_count != 1
        or not reusable.is_watertight
        or not reusable.is_winding_consistent
    ):
        return None
    return reusable, {
        "bbox_min": source_bounds[0].tolist(),
        "bbox_max": source_bounds[1].tolist(),
        "vertex_count": vertex_count,
        "triangle_count": triangle_count,
    }, is_outer_hull


def generate_model_envelope(
    source_step_path: Path,
    output_dir: Path,
    model: dict,
    source: dict,
    parameters: dict,
    reusable_envelope_dir: Path | None = None,
) -> dict:
    """优先复用旧外壳，否则从完整 STEP 生成唯一连续外层包络和 UTF-8 清单。"""

    reusable = _load_reusable_normalized_envelope(
        reusable_envelope_dir,
        source,
        model["settings"],
        parameters,
    )
    if reusable is None:
        mesh = normalize_envelope_source_mesh(
            load_step_triangle_mesh(
                source_step_path,
                linear_ratio=float(parameters["step_linear_ratio"]),
                minimum_linear_tolerance_mm=float(parameters["step_min_linear_tolerance_mm"]),
                angular_degrees=float(parameters["step_angular_degrees"]),
            ),
            model["settings"],
        )
        bounds = np.asarray(mesh.bounds, dtype=float)
        source_mesh = {
            "bbox_min": bounds[0].tolist(),
            "bbox_max": bounds[1].tolist(),
            "vertex_count": int(len(mesh.vertices)),
            "triangle_count": int(len(mesh.faces)),
        }
        input_mode = "step_tessellation"
        source_is_outer_hull = False
    else:
        mesh, source_mesh, source_is_outer_hull = reusable
        input_mode = "reused_envelope"
    geometry_parameters = envelope_parameters_from_dict(parameters)
    variants = generate_envelope_variants(
        mesh,
        output_dir,
        geometry_parameters,
        source_is_outer_hull=source_is_outer_hull,
    )
    manifest = {
        "format_version": MODEL_ENVELOPE_FORMAT_VERSION,
        "generator": "SatLayoutOpt axis-scaled azimuthally refined outer hull envelope pipeline",
        "algorithm": ENVELOPE_ALGORITHM,
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "model_id": model["id"],
        "source": source,
        "geometry_settings": geometry_settings_fingerprint(model["settings"]),
        "parameters": dict(parameters),
        "input_mode": input_mode,
        "normalization": {
            "unit": "mm",
            "center_xy": True,
            "ground_min_z": True,
        },
        "source_mesh": source_mesh,
        "variants": [
            {
                "rot_z": variant.rot_z,
                "file_name": variant.file_name,
                "bbox_min": variant.bbox_min,
                "bbox_max": variant.bbox_max,
                "vertex_count": variant.vertex_count,
                "triangle_count": variant.triangle_count,
                "watertight": variant.watertight,
            }
            for variant in variants
        ],
    }
    (output_dir / "manifest.json").write_text(
        json.dumps(manifest, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )
    return manifest


def _rotate_vertices_x(vertices: np.ndarray, degrees: int) -> np.ndarray:
    """以四分之一圆整数角度绕 X 轴旋转顶点。"""

    rotated = vertices.copy()
    y, z = vertices[:, 1].copy(), vertices[:, 2].copy()
    if degrees == 0:
        return rotated
    if degrees == 90:
        rotated[:, 1], rotated[:, 2] = -z, y
    elif degrees == 180:
        rotated[:, 1], rotated[:, 2] = -y, -z
    elif degrees == 270:
        rotated[:, 1], rotated[:, 2] = z, -y
    else:
        raise ValueError("X 轴旋转必须是 0、90、180 或 270 度")
    return rotated


def _rotate_vertices_y(vertices: np.ndarray, degrees: int) -> np.ndarray:
    """以四分之一圆整数角度绕 Y 轴旋转顶点。"""

    rotated = vertices.copy()
    x, z = vertices[:, 0].copy(), vertices[:, 2].copy()
    if degrees == 0:
        return rotated
    if degrees == 90:
        rotated[:, 0], rotated[:, 2] = z, -x
    elif degrees == 180:
        rotated[:, 0], rotated[:, 2] = -x, -z
    elif degrees == 270:
        rotated[:, 0], rotated[:, 2] = -z, x
    else:
        raise ValueError("Y 轴旋转必须是 0、90、180 或 270 度")
    return rotated


def _rotate_vertices_z(vertices: np.ndarray, degrees: int) -> np.ndarray:
    """以四分之一圆整数角度绕 Z 轴旋转顶点。"""

    rotated = vertices.copy()
    x, y = vertices[:, 0].copy(), vertices[:, 1].copy()
    if degrees == 0:
        return rotated
    if degrees == 90:
        rotated[:, 0], rotated[:, 1] = -y, x
    elif degrees == 180:
        rotated[:, 0], rotated[:, 1] = -x, -y
    elif degrees == 270:
        rotated[:, 0], rotated[:, 1] = y, -x
    else:
        raise ValueError("Z 轴旋转必须是 0、90、180 或 270 度")
    return rotated
