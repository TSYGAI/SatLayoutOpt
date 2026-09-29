"""文件说明：只读加载固化 STEP、曲面安装基准、连续外层包络和模型向上轴，统一质量与毫米坐标。"""

from dataclasses import dataclass
import hashlib

import numpy as np
from shapely.geometry import MultiPoint

from app.core.config import runtime_config
from app.domain.model_envelope import envelope_source_transform, load_step_triangle_mesh
from app.domain.layout_mounts import source_up_axis
from app.domain.model_installation import read_installation_reference


@dataclass(frozen=True)
class LayoutSatellite:
    """保存一个卫星实例的毫米包络、真实质量与归一化质心；数组由加载器创建，求解器只读。"""

    instance_id: str
    record_id: str
    name: str
    mass: float
    center: np.ndarray
    vertices: np.ndarray
    faces: np.ndarray
    footprint: np.ndarray
    lower: np.ndarray
    upper: np.ndarray
    volume: float
    source_sha256: str
    envelope_sha256: str
    source_to_envelope: np.ndarray
    installation_face_id: str
    face_center: np.ndarray
    face_normal: np.ndarray
    body_vertices: np.ndarray | None = None
    up_orientation: str = runtime_config.model_settings_default_front_orientation


def load_satellites(store, selections, cancelled=lambda: False) -> list[LayoutSatellite]:
    """按请求数量展开固化模型；验证文件摘要并转换 STEP 质心，数据缺失/损坏抛出 ValueError 或 LookupError。"""
    satellites = []
    for selection in selections:
        if cancelled():
            raise InterruptedError("任务已取消")
        if not selection.count:
            continue
        record = store.get_record(selection.record_id)
        if record is None:
            raise LookupError(f"找不到固化模型 {selection.record_id}")
        settings = record["settings"]
        up_orientation = settings.get("front_orientation", runtime_config.model_settings_default_front_orientation)
        source_up_axis(up_orientation)
        mass = settings.get("mass")
        raw_center = None
        if settings.get("center_of_mass") is not None:
            raw_center = [settings["center_of_mass"][axis] for axis in "xyz"]
        if mass is None or not np.isfinite(mass) or mass <= 0 or raw_center is None:
            raise ValueError(f"{record['device_name']} 缺少正质量或完整质心，请在卫星设置中保存并重新固化")
        variant = next((item for item in record["envelope"]["variants"] if item["rot_z"] == 0), None)
        if variant is None or record["envelope"]["state"] != "ready":
            raise ValueError(f"{record['device_name']} 缺少正式零度安全包络")
        envelope_path = store.get_asset_path(record["record_id"], variant["asset_name"])
        source_path = store.get_asset_path(record["record_id"], record["source"]["asset_name"])
        for path, digest in ((envelope_path, variant["sha256"]), (source_path, record["source"]["sha256"])):
            with path.open("rb") as stream:
                actual = hashlib.file_digest(stream, "sha256").hexdigest()
            if actual != digest:
                raise ValueError(f"{record['device_name']} 的固化文件摘要不一致")
        with np.load(envelope_path, allow_pickle=False) as data:
            vertices = np.array(data["vertices"], dtype=float)
            faces = np.array(data["faces"], dtype=np.int64)
        if (vertices.ndim != 2 or vertices.shape[1] != 3 or not len(vertices)
                or not np.isfinite(vertices).all() or faces.ndim != 2 or faces.shape[1] != 3
                or not len(faces) or faces.min() < 0 or faces.max() >= len(vertices)):
            raise ValueError(f"{record['device_name']} 包络几何无效")
        lower, upper = vertices.min(axis=0), vertices.max(axis=0)
        extent = upper - lower
        if np.any(extent <= 0.0):
            raise ValueError(f"{record['device_name']} 包络不是有效三维网格")
        source_mesh = load_step_triangle_mesh(
            source_path,
            linear_ratio=runtime_config.model_envelope_step_linear_ratio,
            minimum_linear_tolerance_mm=runtime_config.model_envelope_step_min_linear_tolerance_mm,
            angular_degrees=runtime_config.model_envelope_step_angular_degrees,
        )
        transform = envelope_source_transform(source_mesh, settings)
        face_center, face_normal = read_installation_reference(
            source_path, settings.get("installation_face_id"), transform, settings.get("installation_point")
        )
        center = (transform @ np.array([*raw_center, 1.0]))[:3]
        if not np.isfinite(center).all():
            raise ValueError(f"{record['device_name']} 的变换质心无效")
        footprint = np.asarray(MultiPoint(vertices[:, :2]).convex_hull.exterior.coords)[:-1]
        for index in range(selection.count):
            satellites.append(LayoutSatellite(
                instance_id=f"{record['record_id']}:{index + 1}", record_id=record["record_id"],
                name=f"{record['device_name']} #{index + 1}", mass=float(mass), center=center,
                vertices=vertices, faces=faces, footprint=footprint, lower=lower, upper=upper,
                volume=float(np.prod(extent)), source_sha256=record["source"]["sha256"],
                envelope_sha256=variant["sha256"],
                source_to_envelope=transform,
                installation_face_id=settings["installation_face_id"], face_center=face_center, face_normal=face_normal,
                body_vertices=np.asarray(source_mesh.vertices, dtype=float),
                up_orientation=up_orientation,
            ))
    return satellites
