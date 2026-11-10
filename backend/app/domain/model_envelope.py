"""
文件说明：从完整 STEP 按模型姿态和六向毫米增量向外扩张轮廓，复用同参数包络并转换浏览资源。
本模块连接原始模型、可复用包络产物与纯几何模块并标记读取和保存进度；HTTP 路由、进程隔离和原子发布由上传服务负责。
"""

from __future__ import annotations

from app.compute.monitoring import observed, stage, object_context


from datetime import datetime, timezone
import json
import math
import os
import platform
import shutil
import sys
from pathlib import Path
import traceback
from uuid import uuid4

import numpy as np
import trimesh

from app.domain.coordinate_frame import initial_to_current_matrix, normalize_coordinate_frame
from app.domain.envelope_geometry import (
    ENVELOPE_ALGORITHM,
    EnvelopeGenerationError,
    EnvelopeParameters,
    generate_envelope_variants,
)


MODEL_ENVELOPE_FORMAT_VERSION = 1
UNIT_TO_MILLIMETERS = {"mm": 1.0, "cm": 10.0, "m": 1000.0}


def geometry_settings_fingerprint(settings: dict) -> dict:
    """提取会改变包络几何的单位、比例和初始姿态设置。"""

    return {
        "model_scale": float(settings["model_scale"]),
        "model_unit": str(settings["model_unit"]),
        "rotation_x": int(settings["rotation_x"]),
        "rotation_y": int(settings["rotation_y"]),
        "rotation_z": int(settings["rotation_z"]),
        "coordinate_frame": normalize_coordinate_frame(settings.get("coordinate_frame")),
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
        **{key: values[key] for key in (
            "gap_bridge_limit_mm", "voxel_max_cells", "surface_batch_cells", "raster_triangle_batch", "raster_batch_cells",
            "workspace_memory_bytes", "process_memory_limit_bytes", "memory_reserve_bytes",
        ) if key in values},
    )


@observed("读取预览网格")
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


@observed("读取 STEP 并三角化")
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

        stage("导入 STEP", file=str(path))
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
        stage("STEP 本体三角化", file=str(path))
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
        faces=np.asarray(faces, dtype=np.int32),
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

    frame_transform = initial_to_current_matrix(settings.get("coordinate_frame"))
    current_mesh = mesh.copy()
    current_mesh.apply_transform(frame_transform)
    current_transform = envelope_current_transform(current_mesh, settings)
    return current_transform @ frame_transform


def envelope_current_transform(mesh: trimesh.Trimesh, settings: dict) -> np.ndarray:
    """返回当前模型坐标到毫米包络内部坐标的仿射矩阵。"""

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
    transform[:3, 3] = -np.asarray(
        [(lower[0] + upper[0]) / 2.0, (lower[1] + upper[1]) / 2.0, lower[2]]
    )
    return transform


def normalize_envelope_source_mesh(mesh: trimesh.Trimesh, settings: dict) -> trimesh.Trimesh:
    """返回应用单位、比例、内禀 XYZ 旋转及居中接地变换后的网格副本。"""

    normalized = mesh.copy()
    transform = envelope_source_transform(mesh, settings)
    normalized.apply_transform(transform)
    normalized.metadata["source_transform"] = transform.tolist()
    return normalized


@observed("编码包络 GLB")
def build_envelope_preview_glb(envelope_path: Path, source_preview_path: Path, settings: dict) -> bytes:
    """读取零度 NPZ 并返回当前模型局部坐标的 GLB；默认坐标兼容旧源坐标产物。

    包络预览仅应用单位、比例及姿态即可与已转换至当前坐标的本体重合；损坏时抛出 ValueError 或 OSError。
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
            stored_transform = np.asarray(data["source_transform"], dtype=float) if "source_transform" in data else None
    except (KeyError, TypeError) as error:
        raise ValueError("包络文件缺少有效的顶点或三角形") from error
    if (
        vertices.ndim != 2 or vertices.shape[1] != 3 or not len(vertices)
        or not np.all(np.isfinite(vertices))
        or faces.ndim != 2 or faces.shape[1] != 3 or not len(faces)
        or faces.min() < 0 or faces.max() >= len(vertices)
    ):
        raise ValueError("包络网格数据无效，请重新生成")
    if stored_transform is None:
        source_mesh = load_preview_triangle_mesh(source_preview_path)
        transform = envelope_source_transform(source_mesh, settings)
    else:
        if stored_transform.shape != (4, 4) or not np.all(np.isfinite(stored_transform)):
            raise ValueError("包络生成坐标变换无效，请重新生成")
        transform = stored_transform
    envelope = trimesh.Trimesh(vertices=vertices, faces=faces, process=False)
    envelope.apply_transform(initial_to_current_matrix(settings.get("coordinate_frame")) @ np.linalg.inv(transform))
    return envelope.export(file_type="glb")


def _load_reusable_envelope(
    directory: Path | None,
    source: dict,
    settings: dict,
    parameters: dict,
) -> tuple[trimesh.Trimesh, dict] | None:
    """读取同一 STEP、姿态及全部生成参数的有效包络，避免完全相同请求重复计算。

    方向扫掠不可逆，修改任意增量都必须重新读取原模型；不能把旧包络缩小充当原模型。
    任何版本不符、缺失、损坏或边界不一致都返回空值，由调用方回退到完整 STEP 读取。
    """

    if directory is None:
        return None
    try:
        manifest = json.loads((directory / "manifest.json").read_text(encoding="utf-8"))
        previous_algorithm = manifest.get("algorithm")
        if previous_algorithm != ENVELOPE_ALGORITHM:
            return None
        if manifest.get("source") != source:
            return None
        if manifest.get("geometry_settings") != geometry_settings_fingerprint(settings):
            return None
        if manifest["parameters"] != parameters:
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
            quality = json.loads(str(data["envelope_quality"].item())) if "envelope_quality" in data else {}
            transform = data["source_transform"].tolist() if "source_transform" in data else None
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
    reusable = trimesh.Trimesh(vertices=vertices, faces=faces, process=False)
    reusable.metadata["envelope_quality"] = quality
    if transform is not None:
        reusable.metadata["source_transform"] = transform
    if (
        reusable.body_count < 1
        or not reusable.is_watertight
        or not reusable.is_winding_consistent
    ):
        return None
    return reusable, {
        "bbox_min": source_bounds[0].tolist(),
        "bbox_max": source_bounds[1].tolist(),
        "vertex_count": vertex_count,
        "triangle_count": triangle_count,
    }


def _load_reusable_source_mesh(
    directory: Path | None,
    source: dict,
    settings: dict,
    parameters: dict,
) -> tuple[trimesh.Trimesh, dict] | None:
    """读取同一源文件、姿态和 STEP 离散参数的标准化网格，避免六向修改重复读取 STEP。"""

    if directory is None:
        return None
    step_keys = {
        "step_linear_ratio",
        "step_min_linear_tolerance_mm",
        "step_angular_degrees",
    }
    try:
        manifest = json.loads((directory / "manifest.json").read_text(encoding="utf-8"))
        if (
            manifest.get("algorithm") != ENVELOPE_ALGORITHM
            or manifest.get("source") != source
            or manifest.get("geometry_settings") != geometry_settings_fingerprint(settings)
            or any(manifest.get("parameters", {}).get(key) != parameters.get(key) for key in step_keys)
        ):
            return None
        file_name = str(manifest.get("source_mesh_file", "source_mesh.npz"))
        if Path(file_name).name != file_name:
            return None
        summary = manifest["source_mesh"]
        with np.load(directory / file_name, allow_pickle=False) as data:
            vertices = np.asarray(data["vertices"], dtype=np.float64)
            faces = np.asarray(data["faces"], dtype=np.int64)
            transform = data["source_transform"].tolist() if "source_transform" in data else None
    except (OSError, ValueError, TypeError, KeyError, json.JSONDecodeError):
        return None
    if (
        vertices.ndim != 2
        or vertices.shape[1] != 3
        or len(vertices) < 4
        or not np.all(np.isfinite(vertices))
        or faces.ndim != 2
        or faces.shape[1] != 3
        or len(faces) < 4
        or faces.min() < 0
        or faces.max() >= len(vertices)
    ):
        return None
    try:
        expected_bounds = np.asarray([summary["bbox_min"], summary["bbox_max"]], dtype=np.float64)
    except (KeyError, TypeError, ValueError):
        return None
    actual_bounds = np.vstack((vertices.min(axis=0), vertices.max(axis=0)))
    if expected_bounds.shape != (2, 3) or not np.all(np.isfinite(expected_bounds)):
        return None
    tolerance = max(float(np.max(expected_bounds[1] - expected_bounds[0])) * 1e-8, 1e-8)
    if expected_bounds.shape != (2, 3) or not np.allclose(actual_bounds, expected_bounds, rtol=0.0, atol=tolerance):
        return None
    mesh = trimesh.Trimesh(vertices=vertices, faces=faces, process=False)
    if transform is not None:
        mesh.metadata["source_transform"] = transform
    return mesh, {
        "bbox_min": actual_bounds[0].tolist(),
        "bbox_max": actual_bounds[1].tolist(),
        "vertex_count": int(len(vertices)),
        "triangle_count": int(len(faces)),
    }


def _generate_model_envelope(
    source_step_path: Path,
    output_dir: Path,
    model: dict,
    source: dict,
    parameters: dict,
    reusable_envelope_dir: Path | None = None,
) -> dict:
    """优先复用旧外壳，否则从完整 STEP 生成唯一连续外层包络和 UTF-8 清单。"""

    from app.domain.envelope_progress import report_envelope_progress
    report_envelope_progress("source_loading")
    reusable = _load_reusable_envelope(
        reusable_envelope_dir,
        source,
        model["settings"],
        parameters,
    )
    source_reuse = None if reusable is not None else _load_reusable_source_mesh(
        reusable_envelope_dir,
        source,
        model["settings"],
        parameters,
    )
    report_envelope_progress("source_loading", 1, 1)
    if reusable is None and source_reuse is None:
        from app.domain.envelope_resources import envelope_stage
        with envelope_stage("step_tessellation"):
            raw = load_step_triangle_mesh(
                source_step_path,
                linear_ratio=float(parameters["step_linear_ratio"]),
                minimum_linear_tolerance_mm=float(parameters["step_min_linear_tolerance_mm"]),
                angular_degrees=float(parameters["step_angular_degrees"]),
            )
        with envelope_stage("source_normalization"):
            mesh = normalize_envelope_source_mesh(raw, model["settings"])
        del raw
        bounds = np.asarray(mesh.bounds, dtype=float)
        source_mesh = {
            "bbox_min": bounds[0].tolist(),
            "bbox_max": bounds[1].tolist(),
            "vertex_count": int(len(mesh.vertices)),
            "triangle_count": int(len(mesh.faces)),
        }
        input_mode = "step_tessellation"
    elif reusable is None:
        mesh, source_mesh = source_reuse
        input_mode = "reused_source_mesh"
    else:
        mesh, source_mesh = reusable
        input_mode = "reused_envelope"
    geometry_parameters = envelope_parameters_from_dict(parameters)
    variants = generate_envelope_variants(
        mesh,
        output_dir,
        geometry_parameters,
        source_is_envelope=reusable is not None,
    )
    report_envelope_progress("artifact_write")
    source_mesh_file = None
    if reusable_envelope_dir is not None and (source_reuse is not None or reusable is not None) and (reusable_envelope_dir / "source_mesh.npz").is_file():
        shutil.copy2(reusable_envelope_dir / "source_mesh.npz", output_dir / "source_mesh.npz")
        source_mesh_file = "source_mesh.npz"
    elif reusable is None:
        # 此时 mesh 一定是 STEP 离散网格或其标准化缓存，不能把正式包络写成源网格。
        np.savez_compressed(
            output_dir / "source_mesh.npz",
            vertices=np.asarray(mesh.vertices, dtype=np.float64),
            faces=np.asarray(mesh.faces, dtype=np.int64),
            source_transform=np.asarray(mesh.metadata.get("source_transform", np.eye(4))),
        )
        source_mesh_file = "source_mesh.npz"
    manifest = {
        "format_version": MODEL_ENVELOPE_FORMAT_VERSION,
        "generator": "SatLayoutOpt exterior occupancy directional sweep pipeline",
        "algorithm": ENVELOPE_ALGORITHM,
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "model_id": model["id"],
        "source": source,
        "geometry_settings": geometry_settings_fingerprint(model["settings"]),
        "parameters": dict(parameters),
        "input_mode": input_mode,
        "generation_mode": "strict_refined",
        "fallback_used": False,
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
                "quality": variant.quality,
            }
            for variant in variants
        ],
    }
    if source_mesh_file is not None:
        manifest["source_mesh_file"] = source_mesh_file
    (output_dir / "manifest.json").write_text(
        json.dumps(manifest, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )
    report_envelope_progress("artifact_write", 1, 1)
    return manifest


def _failure_report_path(source_step_path: Path, model: dict, explicit: Path | None) -> Path:
    """返回独立包络失败报告路径；报告不写入会被清理的任务暂存目录。"""

    if explicit is not None:
        return explicit
    if os.environ.get("SAT_LAYOUT_ENVELOPE_DIAGNOSTIC_PATH"):
        return Path(os.environ["SAT_LAYOUT_ENVELOPE_DIAGNOSTIC_PATH"])
    try:
        from app.core.config import runtime_config
        from app.core.paths import data_root

        directory = data_root() / runtime_config.model_envelope_failure_log_dir
    except Exception:
        directory = source_step_path.resolve().parents[3] / "data/logs/envelope"
    return directory / f"{model.get('id', 'unknown')}-{uuid4().hex}.json"


def _write_failure_report(
    path: Path,
    error: Exception,
    source_step_path: Path,
    model: dict,
    parameters: dict,
) -> None:
    """写入包含硬件、软件、阶段和重试记录的独立 JSON 失败报告。"""

    hardware: dict = {"cpu_count": os.cpu_count()}
    try:
        import psutil

        memory = psutil.virtual_memory()
        hardware.update({
            "memory_total_bytes": int(memory.total),
            "memory_available_bytes": int(memory.available),
            "process_rss_bytes": int(psutil.Process().memory_info().rss),
        })
    except Exception as memory_error:
        hardware["memory_probe_error"] = f"{type(memory_error).__name__}: {memory_error}"
    versions = {}
    from importlib.metadata import PackageNotFoundError, version
    for module_name in ("numpy", "scipy", "scikit-image", "manifold3d", "shapely", "trimesh", "cadquery", "cadquery-ocp", "psutil"):
        try:
            versions[module_name] = version(module_name)
        except PackageNotFoundError:
            versions[module_name] = "unavailable"
        except Exception as version_error:
            versions[module_name] = f"unavailable: {type(version_error).__name__}"
    payload = {
        "report_version": 1,
        "status": "failed",
        "reported_at": datetime.now(timezone.utc).isoformat(),
        "operation": "envelope.generate",
        "model_id": model.get("id"),
        "source_filename": source_step_path.name,
        "source_size_bytes": source_step_path.stat().st_size if source_step_path.exists() else None,
        "stage": getattr(error, "stage", getattr(error, "envelope_stage", "cache_or_artifact_write")),
        "error_type": type(error).__name__,
        "error": str(error),
        "attempts": getattr(error, "attempts", []),
        "hardware": hardware,
        "software": {
            "python": platform.python_version(),
            "platform": platform.platform(),
            "modules": versions,
        },
        "parameters": dict(parameters),
        "traceback": traceback.format_exc(),
    }
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(f"{path.name}.{uuid4().hex}.tmp")
    try:
        temporary.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
        os.replace(temporary, path)
    finally:
        temporary.unlink(missing_ok=True)


@observed("生成安全包络")
def generate_model_envelope(
    source_step_path: Path,
    output_dir: Path,
    model: dict,
    source: dict,
    parameters: dict,
    reusable_envelope_dir: Path | None = None,
    failure_report_path: Path | None = None,
) -> dict:
    """生成严格精细包络；任何失败先写独立诊断报告，再向调用方抛出异常。"""

    report_path = _failure_report_path(source_step_path, model, failure_report_path)
    isolated = os.environ.get("SAT_LAYOUT_ENVELOPE_ISOLATED") == "1"
    def report_progress(stage):
        """保存运行阶段快照，原生崩溃时仍有资源与软件证据；成功后删除快照。"""
        error = EnvelopeGenerationError("任务尚未完成；若工作进程异常退出，本文件记录最后执行阶段", stage=stage)
        _write_failure_report(report_path, error, source_step_path, model, parameters)
        snapshot = json.loads(report_path.read_text(encoding="utf-8"))
        snapshot["status"] = "running"
        report_path.write_text(json.dumps(snapshot, ensure_ascii=False, indent=2), encoding="utf-8")
    try:
        from app.domain.envelope_resources import EnvelopeResourceGuard
        def report_failure(error):
            """资源监控线程通过同一诊断入口保存当前模型的失败报告。"""
            _write_failure_report(report_path, error, source_step_path, model, parameters)
        if isolated:
            report_progress("initialization")
        with EnvelopeResourceGuard(envelope_parameters_from_dict(parameters), report_failure, report_progress if isolated else None) as guard:
            manifest = _generate_model_envelope(source_step_path, output_dir, model, source, parameters, reusable_envelope_dir)
            manifest["resources_observed"] = guard.observed
            (output_dir / "manifest.json").write_text(json.dumps(manifest, ensure_ascii=False, indent=2), encoding="utf-8")
            if isolated:
                report_path.unlink(missing_ok=True)
            return manifest
    except Exception as error:
        try:
            _write_failure_report(report_path, error, source_step_path, model, parameters)
        except Exception as report_error:
            error.add_note(f"独立失败报告写入失败：{report_path}；{report_error}")
            print(f"独立包络失败报告写入失败：{report_path}；{report_error}", file=sys.stderr, flush=True)
        raise


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
