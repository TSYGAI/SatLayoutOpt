"""
文件说明：把已上传模型及其唯一 0 度基础包络固化为可长期查阅的存储记录。
本模块编排模型服务与 SQLite 固化存储，负责校验包络有效性、组装元数据、暂存资源并提交记录，不处理 HTTP。
固化是单向快照：只读取模型与包络产物，不回写、迁移或删除它们的任何内容。
"""

from __future__ import annotations

from contextlib import ExitStack
import hashlib
from pathlib import Path
import shutil
from threading import RLock
import numpy as np

from app.domain.model_store import ModelStore, ModelStoreError, current_timestamp
from app.domain.model_upload_service import ModelUploadService


SOURCE_ASSET_NAME = "source.step"
ENVELOPE_PREVIEW_ASSET_NAME = "envelope-preview.glb"
_CHUNK_SIZE = 1024 * 1024


class ModelMissingError(LookupError):
    """表示要固化的来源模型不存在或已被删除。"""


class EnvelopeNotReadyError(RuntimeError):
    """表示来源模型尚未生成包络或包络已失效，无法固化。"""


class ModelStoreService:
    """提供模型快照固化、固化记录查询和固化资源读取能力。"""

    def __init__(self, model_service: ModelUploadService, store: ModelStore | None = None) -> None:
        """绑定模型服务与固化存储，并复用模型服务的内部锁保证快照一致性。

        参数：
            model_service: 提供模型、设置与包络产物的模型服务。
            store: 可选固化存储，测试时用于隔离真实数据库。
        """

        self.model_service = model_service
        self.store = store or ModelStore()
        self._lock = RLock()

    def save_model_snapshot(self, model_id: str, record_name: str | None = None) -> dict:
        """把指定模型当前的设置、STEP 原件和正式包络固化为一条存储记录。

        参数：
            model_id: 已上传模型标识。
            record_name: 可选记录名称，缺省使用模型设置的设备名称。
        返回：
            新建的固化记录结构。
        异常：
            ModelMissingError: 模型不存在。
            EnvelopeNotReadyError: 包络尚未生成或已失效。
            ModelStoreError: 包络缺少可固化的 0 度基础包络或数量异常。
            OSError: 资源暂存或数据库写入失败。
        副作用：
            在固化目录内新增记录目录与资源文件，并向 SQLite 写入记录行。
        """

        with self._lock:
            try:
                with self.model_service.hold_artifacts(model_id) as snapshot:
                    return self._persist_snapshot(snapshot, record_name)
            except LookupError as error:
                if not self.model_service.has_model(model_id):
                    raise ModelMissingError("找不到指定模型") from error
                current = self.model_service.get_model_envelope_status(model_id)
                if current.get("state") != "ready":
                    raise EnvelopeNotReadyError(str(error)) from error
                raise ValueError(f"包络产物无法读取，请重新生成包络：{error}") from error

    def _persist_snapshot(self, snapshot: dict, record_name: str | None) -> dict:
        """在模型与包络均未变化的前提下，暂存资源并提交固化记录。"""

        staged_dir = self.store.asset_dir / f".staging-{timestamp_suffix()}"
        staged_dir.mkdir(parents=True, exist_ok=False)
        try:
            source_asset_name = SOURCE_ASSET_NAME
            source_size, source_digest = _copy_to_staging(staged_dir / source_asset_name, snapshot["source_path"])

            variants: list[dict] = []
            for variant in snapshot["variants"]:
                asset_name = f"envelope-{int(variant['rot_z']):03d}.npz"
                size, digest = _copy_to_staging(staged_dir / asset_name, variant["path"])
                vertices, faces = _read_variant_shape(variant["path"])
                variants.append({
                    "rot_z": int(variant["rot_z"]),
                    "file_name": variant["file_name"],
                    "asset_name": asset_name,
                    "size": size,
                    "sha256": digest,
                    "vertex_count": vertices,
                    "face_count": faces,
                    "watertight": bool(variant.get("watertight")),
                    "bounds": variant.get("bounds"),
                })

            preview_asset_name = None
            preview_digest = None
            preview_size = 0
            preview_bytes = snapshot.get("preview_bytes")
            if preview_bytes:
                preview_asset_name = ENVELOPE_PREVIEW_ASSET_NAME
                preview_path = staged_dir / preview_asset_name
                preview_path.write_bytes(preview_bytes)
                preview_size = len(preview_bytes)
                preview_digest = _hash_bytes(preview_bytes)

            settings = snapshot["settings"]
            payload = {
                "source_model_id": snapshot["model_id"],
                "device_name": (record_name or settings["device_name"]).strip() or settings["device_name"],
                "source_filename": snapshot["filename"],
                "source_format": "STEP",
                "source_size": source_size,
                "source_asset_name": source_asset_name,
                "source_sha256": source_digest,
                "settings": settings,
                "envelope_state": "ready",
                "envelope_algorithm": snapshot["algorithm"],
                "envelope_generated_at": snapshot["generated_at"],
                "envelope_mesh_sha256": snapshot["mesh_sha256"],
                "envelope_preview_asset_name": preview_asset_name,
                "envelope_preview_sha256": preview_digest,
                "variants": variants,
                "created_at": current_timestamp(),
            }
            record = self.store.save_record(payload, staged_dir)
            return {**record, "envelope": {**record["envelope"], "preview_size": preview_size}}
        finally:
            shutil.rmtree(staged_dir, ignore_errors=True)

    def list_records(self, limit: int, offset: int, keyword: str | None = None) -> dict:
        """分页返回固化记录摘要。"""

        return self.store.list_records(limit=limit, offset=offset, keyword=keyword)

    def get_record(self, record_id: str) -> dict:
        """返回一条固化记录的完整结构，不存在时抛出 LookupError。"""

        record = self.store.get_record(record_id)
        if record is None:
            raise LookupError("找不到指定的固化记录")
        return record

    def get_asset_path(self, record_id: str, asset_name: str) -> Path:
        """返回固化资源路径，记录或资源缺失时抛出 LookupError。"""

        return self.store.get_asset_path(record_id, asset_name)

    def get_envelope_preview_path(self, record_id: str) -> Path:
        """返回固化包络的浏览 GLB 路径；未固化浏览网格时抛出 LookupError。"""

        record = self.get_record(record_id)
        asset_name = record["envelope"]["preview_asset_name"]
        if not asset_name:
            raise LookupError("该固化记录未保存包络浏览网格")
        return self.store.get_asset_path(record_id, asset_name)

    def get_source_path(self, record_id: str) -> Path:
        """返回固化记录的 STEP 原件路径。"""

        record = self.get_record(record_id)
        return self.store.get_asset_path(record_id, record["source"]["asset_name"])

    def get_variant_path(self, record_id: str, rot_z: int) -> Path:
        """按方向角返回固化包络变体路径，方向不存在时抛出 LookupError。"""

        record = self.get_record(record_id)
        variant = next((item for item in record["envelope"]["variants"] if item["rot_z"] == int(rot_z)), None)
        if variant is None:
            raise LookupError("固化记录中没有该方向的包络变体")
        return self.store.get_asset_path(record_id, variant["asset_name"])

    def delete_record(self, record_id: str) -> None:
        """删除一条固化记录及其资源，不存在时抛出 LookupError。"""

        if self.store.get_record(record_id) is None:
            raise LookupError("找不到指定的固化记录")
        self.store.delete_record(record_id)

    def delete_records(self, record_ids: list[str]) -> int:
        """批量删除固化记录及其资源，忽略重复或已不存在的标识并返回实际删除数量。"""

        return self.store.delete_records(record_ids)

    def get_summary(self) -> dict:
        """返回固化存储的条目统计与数据库位置描述。"""

        return self.store.summary()

    def model_storage_state(self, model_id: str) -> dict:
        """返回单个模型是否已固化以及最近一次固化的摘要。"""

        latest = self.store.get_latest_record_for_model(model_id)
        return {
            "stored": latest is not None,
            "record_count": self.store.has_records_for_model(model_id),
            "latest": latest,
        }

    def storage_states(self, model_ids: list[str]) -> dict:
        """批量返回多个模型的固化状态，键为模型标识。"""

        return {model_id: self.model_storage_state(model_id) for model_id in model_ids}


def timestamp_suffix() -> str:
    """返回适合作为暂存目录后缀的时间戳片段。"""

    return current_timestamp().replace(":", "").replace("-", "").replace("+", "").replace(".", "")


def _copy_to_staging(destination: Path, source: Path) -> tuple[int, str]:
    """把源文件复制到暂存目录，同时返回字节数与 SHA-256 摘要。"""

    digest = hashlib.sha256()
    written = 0
    with source.open("rb") as reader, destination.open("xb") as writer:
        while chunk := reader.read(_CHUNK_SIZE):
            writer.write(chunk)
            digest.update(chunk)
            written += len(chunk)
    if written == 0:
        destination.unlink(missing_ok=True)
        raise OSError(f"固化资源为空：{source.name}")
    return written, digest.hexdigest()


def _hash_bytes(content: bytes) -> str:
    """返回字节内容的 SHA-256 摘要。"""

    return hashlib.sha256(content).hexdigest()


def _read_variant_shape(path: Path) -> tuple[int, int]:
    """在不加载完整数组的前提下读取包络变体的顶点数与面数。

    参数：
        path: 包络变体 NPZ 文件路径。
    返回：
        顶点数与面数组成的二元组。
    异常:
        LookupError: 文件缺失、损坏或缺少必需的数组，按资源不可用处理。
    """

    try:
        with np.load(path, allow_pickle=False) as data:
            return int(data["vertices"].shape[0]), int(data["faces"].shape[0])
    except (OSError, KeyError, ValueError) as error:
        raise LookupError(f"包络变体文件无法解析：{path.name}") from error
