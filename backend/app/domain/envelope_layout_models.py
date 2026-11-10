"""文件说明：读取正式包络、全部共面安装区域及本体支撑点，并重建与点击位置无关的定位基准；不加载 CAD。"""

from app.compute.monitoring import observed, stage, object_context


import hashlib
import json

import numpy as np
from shapely.geometry import MultiPoint

from app.core.config import runtime_config
from app.domain.layout_mounts import source_up_axis
from app.domain.layout_types import LayoutSatellite
from app.domain.installation_region import with_region_reference


REFERENCE_ASSET = "envelope-installation.json"


@observed("校验固化包络与安装基准")
def load_envelope_satellites(store, selections, cancelled=lambda: False):
    """验证包络和配套安装基准后按数量展开只读模型；旧固化记录缺少基准时明确要求补齐，不回退读取 STEP。"""
    satellites = []
    for selection in selections:
        if cancelled():
            raise InterruptedError("任务已取消")
        if not selection.count:
            continue
        object_context(model_id=selection.record_id, model_name="尚未读取")
        stage("读取模型记录")
        record = store.get_record(selection.record_id)
        object_context(model_name=record.get("device_name", ""))
        object_context(face_id=record["settings"].get("installation_face_id"))
        stage("校验质量、质心和模型设置")
        settings = record["settings"]
        variant = next((item for item in record["envelope"]["variants"] if item["rot_z"] == 0), None)
        if variant is None or record["envelope"]["state"] != "ready":
            raise ValueError(f"{record['device_name']} 缺少正式零度安全包络")
        try:
            path = store.get_asset_path(record["record_id"], REFERENCE_ASSET)
            stage("读取安装基准缓存", file=str(path))
            reference = json.loads(path.read_text(encoding="utf-8"))
        except (KeyError, OSError, LookupError) as error:
            raise ValueError(f"{record['device_name']} 的旧包络缺少安装基准缓存，请补齐缓存或重新固化") from error
        if (reference.get("version") != 3 or reference.get("model_coordinate_space") != "current_model_v1" or reference.get("settings") != settings
                or reference.get("region_rule") != "all_geometric_planes_v1"
                or reference.get("source_sha256") != record["source"]["sha256"]
                or reference.get("envelope_sha256") != variant["sha256"]):
            raise ValueError(f"{record['device_name']} 的包络安装基准缓存已失效，请重新固化")
        envelope_path = store.get_asset_path(record["record_id"], variant["asset_name"])
        stage("核对包络摘要", file=str(envelope_path))
        with envelope_path.open("rb") as stream:
            if hashlib.file_digest(stream, "sha256").hexdigest() != variant["sha256"]:
                raise ValueError(f"{record['device_name']} 的固化包络摘要不一致")
        stage("读取并解码包络 NPZ", file=str(envelope_path))
        with np.load(envelope_path, allow_pickle=False) as data:
            vertices = np.array(data["vertices"], dtype=float)
            faces = np.array(data["faces"], dtype=np.int64)
        if (vertices.ndim != 2 or vertices.shape[1] != 3 or not len(vertices) or not np.isfinite(vertices).all()
                or faces.ndim != 2 or faces.shape[1] != 3 or not len(faces)
                or faces.min() < 0 or faces.max() >= len(vertices)):
            raise ValueError("固化包络数组无效")
        lower, upper = vertices.min(axis=0), vertices.max(axis=0)
        if np.any(upper <= lower):
            raise ValueError("固化包络必须为有效三维网格")
        stage("校验安装基准、变换和本体凸包")
        transform = np.asarray(reference["source_to_envelope"], dtype=float)
        face_center = np.asarray(reference["face_center"], dtype=float)
        face_normal = np.asarray(reference["face_normal"], dtype=float)
        if (transform.shape != (4, 4) or face_center.shape != (3,) or face_normal.shape != (3,)
                or not all(np.isfinite(array).all() for array in (transform, face_center, face_normal))
                or not np.isclose(np.linalg.norm(face_normal), 1) or not np.allclose(transform[3], [0, 0, 0, 1])
                or np.linalg.det(transform[:3, :3]) == 0):
            raise ValueError("包络安装基准数组无效")
        raw_center, mass = settings.get("center_of_mass"), settings.get("mass")
        if raw_center is None or mass is None or not np.isfinite(mass) or mass <= 0:
            raise ValueError(f"{record['device_name']} 缺少正质量或完整质心")
        center = (transform @ np.array([*[raw_center[axis] for axis in "xyz"], 1.0]))[:3]
        if not np.isfinite(center).all():
            raise ValueError("固化质心无效")
        up = settings.get("front_orientation", runtime_config.model_settings_default_front_orientation)
        source_up_axis(up)
        region = np.asarray(reference.get("installation_plane_vertices"), dtype=float)
        if region.ndim != 2 or region.shape[1] != 3 or len(region) < 3 or not np.isfinite(region).all():
            raise ValueError("共面安装区域缓存无效，请补齐缓存或重新固化")
        body_hull = reference.get("body_hull_vertices")
        if body_hull is not None:
            body_hull = np.asarray(body_hull, dtype=float)
            if (body_hull.ndim != 2 or body_hull.shape[1] != 3 or len(body_hull) < 4
                    or not np.isfinite(body_hull).all()):
                raise ValueError("模型本体底部基准无效，请补齐缓存或重新固化")
        stage("构建包络投影凸包")
        footprint = np.asarray(MultiPoint(vertices[:, :2]).convex_hull.exterior.coords)[:-1]
        stage("展开卫星实例", instances=selection.count)
        for index in range(selection.count):
            satellites.append(with_region_reference(LayoutSatellite(
                instance_id=f"{record['record_id']}:{index + 1}", record_id=record["record_id"],
                name=f"{record['device_name']} #{index + 1}", mass=float(mass), center=center,
                vertices=vertices, faces=faces, footprint=footprint, lower=lower, upper=upper,
                volume=float(np.prod(upper - lower)), source_sha256=record["source"]["sha256"],
                envelope_sha256=variant["sha256"], source_to_envelope=transform,
                installation_face_id=settings["installation_face_id"], face_center=face_center,
                face_normal=face_normal, up_orientation=up, body_hull_vertices=body_hull,
                installation_plane_vertices=region)))
    return satellites
