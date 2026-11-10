"""文件说明：只读加载固化 STEP、全部共面区域和连续包络，重建方向定位基准；数值类型从 layout_types 兼容导出。

只有模型准备阶段依赖 CAD；独立求解进程直接读取数值快照，不导入本加载器。
"""

from app.compute.monitoring import observed, stage, object_context


import hashlib

import numpy as np
from shapely.geometry import MultiPoint

from app.core.config import runtime_config
from app.domain.model_envelope import envelope_current_transform, load_step_triangle_mesh
from app.domain.coordinate_frame import initial_to_current_matrix
from app.domain.layout_mounts import source_up_axis
from app.domain.model_installation import read_installation_reference
from app.domain.layout_types import LayoutSatellite
from app.domain.layout_config import LAYOUT_CONFIG
from app.domain.installation_region import with_region_reference


@observed("校验源模型与安装基准")
def load_satellites(store, selections, cancelled=lambda: False) -> list[LayoutSatellite]:
    """展开固化模型并准备当前坐标本体、质心及安装基准；缺失或损坏时抛出 ValueError 或 LookupError。"""
    satellites = []
    for selection in selections:
        if cancelled():
            raise InterruptedError("任务已取消")
        if not selection.count:
            continue
        object_context(model_id=selection.record_id, model_name="尚未读取")
        stage("读取模型记录")
        record = store.get_record(selection.record_id)
        if record is None:
            raise LookupError(f"找不到固化模型 {selection.record_id}")
        object_context(model_name=record.get("device_name", ""))
        object_context(face_id=record["settings"].get("installation_face_id"))
        stage("校验质量、质心和模型设置")
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
            stage("核对源模型/包络摘要", file=str(path))
            with path.open("rb") as stream:
                actual = hashlib.file_digest(stream, "sha256").hexdigest()
            if actual != digest:
                raise ValueError(f"{record['device_name']} 的固化文件摘要不一致")
        stage("读取并解码包络 NPZ", file=str(envelope_path))
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
        stage("转换本体坐标与质心")
        frame_transform = initial_to_current_matrix(settings.get("coordinate_frame"))
        current_mesh = source_mesh.copy()
        current_mesh.apply_transform(frame_transform)
        transform = envelope_current_transform(current_mesh, settings)
        face_center, face_normal, region = read_installation_reference(
            source_path, settings.get("installation_face_id"), transform @ frame_transform, settings.get("installation_point"),
            include_region=True, plane_tolerance=LAYOUT_CONFIG["geometry_tolerance_mm"]
        )
        inverse = np.linalg.inv(transform)
        region = region @ inverse[:3, :3].T + inverse[:3, 3]
        center = (transform @ np.array([*raw_center, 1.0]))[:3]
        if not np.isfinite(center).all():
            raise ValueError(f"{record['device_name']} 的变换质心无效")
        stage("构建包络投影凸包")
        footprint = np.asarray(MultiPoint(vertices[:, :2]).convex_hull.exterior.coords)[:-1]
        stage("展开卫星实例", instances=selection.count)
        for index in range(selection.count):
            satellites.append(with_region_reference(LayoutSatellite(
                instance_id=f"{record['record_id']}:{index + 1}", record_id=record["record_id"],
                name=f"{record['device_name']} #{index + 1}", mass=float(mass), center=center,
                vertices=vertices, faces=faces, footprint=footprint, lower=lower, upper=upper,
                volume=float(np.prod(extent)), source_sha256=record["source"]["sha256"],
                envelope_sha256=variant["sha256"],
                source_to_envelope=transform,
                installation_face_id=settings["installation_face_id"], face_center=face_center, face_normal=face_normal,
                body_vertices=np.asarray(current_mesh.vertices, dtype=float),
                body_faces=np.asarray(current_mesh.faces, dtype=np.int64),
                installation_plane_vertices=region,
                up_orientation=up_orientation,
            )))
    return satellites
