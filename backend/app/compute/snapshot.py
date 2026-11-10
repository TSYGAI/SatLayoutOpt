"""文件说明：将 CAD 准备结果固化为带摘要的数值快照；只读 NPY 映射供独立求解进程复用，不含 CAD 指针。"""

from app.compute.monitoring import observed, stage, object_context


from dataclasses import fields
import json
from pathlib import Path

import numpy as np

from app.compute.files import file_ref, within, write_json
from app.domain.layout_config import LAYOUT_CONFIG
from app.domain.layout_types import LayoutSatellite
from app.schemas.layout_optimization import ResolvedLayoutParameters


ARRAY_SHAPES = {
    "center": (3,), "vertices": (None, 3), "faces": (None, 3), "footprint": (None, 2),
    "lower": (3,), "upper": (3,), "source_to_envelope": (4, 4), "face_center": (3,),
    "face_normal": (3,), "body_vertices": (None, 3),
    "body_faces": (None, 3), "body_hull_vertices": (None, 3),
    "installation_plane_vertices": (None, 3),
}


@observed("写数值快照")
def write_snapshot(root, satellites, parameters):
    """写入毫米数值输入、算法参数及数组摘要；同一个只读数组仅保存一次，返回清单路径。"""
    root = Path(root)
    root.mkdir(parents=True, exist_ok=True)
    arrays, identities, models = {}, {}, []
    for satellite in satellites:
        record = {}
        for field in fields(satellite):
            value = getattr(satellite, field.name)
            if isinstance(value, np.ndarray):
                identity = id(value)
                if identity not in identities:
                    key = f"array_{len(arrays):04d}"
                    path = root / f"{key}.npy"
                    np.save(path, value, allow_pickle=False)
                    arrays[key] = file_ref(root, path)
                    identities[identity] = key
                record[field.name] = {"array": identities[identity]}
            else:
                record[field.name] = value
        models.append(record)
    path = root / "snapshot.json"
    write_json(path, {"format_version": 1, "unit": "mm", "algorithm": "layout-v1",
                      "solver_config": dict(LAYOUT_CONFIG), "parameters": parameters.model_dump(),
                      "arrays": arrays, "satellites": models})
    return path


@observed("读数值快照")
def read_snapshot(path, verified_paths=None, *, require_current_config=True):
    """校验快照与数组；历史微调允许旧求解设置，仍严格使用历史模型和参数并核对摘要。"""
    path = Path(path)
    data = json.loads(path.read_text(encoding="utf-8"))
    if data["format_version"] != 1 or data["unit"] != "mm" or data["algorithm"] != "layout-v1":
        raise ValueError("不支持的计算快照格式或单位")
    if require_current_config and data["solver_config"] != LAYOUT_CONFIG:
        raise ValueError("快照算法配置已失效，请重新准备模型")
    arrays = {}
    for key, reference in data["arrays"].items():
        resource = within(path.parent, reference["path"])
        if verified_paths is not None and verified_paths.get(resource) != reference:
            raise ValueError("快照引用了未声明或摘要不一致的数组")
        array = np.load(resource, mmap_mode="r", allow_pickle=False)
        if array.dtype.kind not in "fi" or not np.isfinite(array).all():
            raise ValueError("快照数组必须为有限实数或整数")
        arrays[key] = array
    satellites = []
    for record in data["satellites"]:
        values = dict(record)
        for name, shape in ARRAY_SHAPES.items():
            reference = values.get(name)
            if reference is None and name in {"body_vertices", "body_faces", "body_hull_vertices", "installation_plane_vertices"}:
                continue
            array = arrays[reference["array"]]
            if array.ndim != len(shape) or any(expected is not None and actual != expected
                    for actual, expected in zip(array.shape, shape)) or array.size == 0:
                raise ValueError(f"快照数组维度无效：{name}")
            values[name] = array
        model = LayoutSatellite(**values)
        if not np.isfinite([model.mass, model.volume]).all() or model.mass <= 0 or model.volume <= 0:
            raise ValueError("快照质量和体积必须为正数")
        if model.faces.dtype.kind != "i" or model.faces.min() < 0 or model.faces.max() >= len(model.vertices):
            raise ValueError("快照三角面索引无效")
        if not np.allclose(model.lower, model.vertices.min(axis=0)) or not np.allclose(model.upper, model.vertices.max(axis=0)):
            raise ValueError("快照包络边界与顶点不一致")
        if np.any(model.upper <= model.lower) or not np.isclose(np.linalg.norm(model.face_normal), 1):
            raise ValueError("快照包络或安装法向无效")
        satellites.append(model)
    parameters = ResolvedLayoutParameters.model_validate(data["parameters"])
    expected_ids = [f"{selection.record_id}:{index + 1}" for selection in parameters.satellites
                    for index in range(selection.count)]
    if [item.instance_id for item in satellites] != expected_ids or not satellites:
        raise ValueError("快照实例与锁定的输入选择不一致")
    return satellites, parameters


class SnapshotStore:
    """将已声明的固化元数据和资源适配给旧模型加载器，只提供读取能力，不依赖数据库。"""

    def __init__(self, metadata, resources):
        """保存输入副本的记录与资源映射；metadata 的 assets 将业务资源名映射到协议资源名。"""
        self.records = {item["record_id"]: item for item in metadata["records"]}
        self.assets = metadata["assets"]
        self.resources = resources

    def get_record(self, record_id):
        """按固化标识读取元数据；不存在时返回空，交给领域加载器报告。"""
        return self.records.get(record_id)

    def get_asset_path(self, record_id, asset_name):
        """仅返回经过入口验证的资源路径；元数据不能自行引入其他文件。"""
        return self.resources[self.assets[record_id][asset_name]]
