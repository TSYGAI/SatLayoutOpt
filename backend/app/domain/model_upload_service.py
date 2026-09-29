"""
文件说明：管理 STEP/STP、曲面安装基准、固定或自由向上轴及六向包络增量设置、双 LOD 预览和包络生命周期。
本服务不处理 HTTP；源文件始终是最终数据源，预览与包络产物可删除并从源文件重建。
"""

from __future__ import annotations

from contextlib import contextmanager
from datetime import datetime, timezone
from functools import partial
import hashlib
import json
import math
import os
from pathlib import Path
import re
from threading import Lock, RLock
from typing import BinaryIO
from uuid import uuid4
import shutil
import subprocess
import sys

from app.core.config import runtime_config
from app.domain.envelope_geometry import ENVELOPE_ALGORITHM, STORED_ENVELOPE_ROTATIONS
from app.domain.latest_background_task import LatestBackgroundTask
from app.domain.model_artifacts import SHELL_POLICY
from app.domain.model_envelope import MODEL_ENVELOPE_FORMAT_VERSION, build_envelope_preview_glb, geometry_settings_fingerprint
from app.domain.model_installation import read_installation_reference
from app.domain.model_safety_clearance import default_safety_clearance, normalize_safety_clearance


PREVIEW_RUNTIME_CACHE_NAME = "runtime-preview.bin"
PREVIEW_RUNTIME_CACHE_MAGIC = b"SATPREV1\x00"
PREVIEW_RUNTIME_CACHE_MEDIA_TYPE = "application/vnd.sat-layout-opt.runtime-preview"
MODEL_SETTING_ROTATIONS = frozenset({0, 90, 180, 270})
MODEL_SETTING_UNITS = frozenset({"mm", "cm", "m"})
MODEL_SETTING_UP_ORIENTATIONS = frozenset({"+X", "-X", "+Y", "-Y", "+Z", "-Z", "free"})
STEP_FACE_ID_PATTERN = re.compile(r"^FACE_\d{5}$")
_HASH_CHUNK_SIZE = 1024 * 1024
_LEGACY_ENVELOPE_ROTATIONS = frozenset({0, 90, 180, 270})


def _hash_files(paths: list[Path]) -> str:
    """按给定顺序对多个文件的内容计算一个 SHA-256 摘要。"""

    digest = hashlib.sha256()
    for path in paths:
        with path.open("rb") as source:
            while chunk := source.read(_HASH_CHUNK_SIZE):
                digest.update(chunk)
    return digest.hexdigest()


class ModelUploadService:
    """提供模型上传校验、文件存储、预览与包络生成、列表和删除能力。"""

    allowed_extensions = frozenset({".stp", ".step"})

    def __init__(self, storage_dir: Path | None = None, artifact_dir: Path | None = None) -> None:
        """创建模型服务并初始化源文件、派生产物目录和模型索引。

        参数：
            storage_dir: 可选原始模型目录，测试时用于隔离真实数据。
            artifact_dir: 可选派生产物目录，测试时用于隔离真实数据。
        """

        project_root = Path(__file__).resolve().parents[3]
        self.storage_dir = Path(storage_dir or (project_root / runtime_config.model_storage_dir))
        self.artifact_dir = Path(artifact_dir or (project_root / runtime_config.model_artifact_dir))
        self.storage_dir.mkdir(parents=True, exist_ok=True)
        self.artifact_dir.mkdir(parents=True, exist_ok=True)
        self.metadata_path = self.storage_dir / "index.json"
        self._lock = RLock()
        self._artifact_locks: dict[str, Lock] = {}
        self._envelope_tasks = LatestBackgroundTask("model-envelope")
        loaded_models = self._load_metadata()
        self.models, metadata_changed = self._migrate_legacy_device_names(loaded_models)
        if metadata_changed:
            self._save_metadata()

    @staticmethod
    def _safe_filename(filename: str | None) -> str:
        """移除上传路径信息并拒绝空文件名。"""

        name = Path(filename or "").name.strip()
        if not name:
            raise ValueError("模型文件名不能为空")
        return name

    def _load_metadata(self) -> list[dict]:
        """从 UTF-8 JSON 索引读取模型元数据，损坏时保守地返回空列表。"""

        if not self.metadata_path.exists():
            return []
        try:
            value = json.loads(self.metadata_path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            return []
        return value if isinstance(value, list) else []

    @staticmethod
    def _migrate_legacy_device_names(models: list[dict]) -> tuple[list[dict], bool]:
        """补全历史模型的初始设备名称，同时保留已手动修改过的名称。

        旧索引可能未保存设置，或在设备名称改为文件名主干前保存了统一默认值。
        仅对缺失名称或仍等于该旧默认值的记录迁移，其他名称视为用户设置并原样保留。
        """

        migrated_models: list[dict] = []
        changed = False
        for model in models:
            if not isinstance(model, dict):
                migrated_models.append(model)
                continue
            filename = model.get("filename")
            device_name = Path(filename).stem if isinstance(filename, str) else ""
            settings = model.get("settings")
            current_name = settings.get("device_name") if isinstance(settings, dict) else None
            requires_migration = (
                not isinstance(current_name, str)
                or not current_name.strip()
                or current_name.strip() == runtime_config.model_settings_default_device_name
            )
            if not requires_migration or not device_name or len(device_name) > 200:
                migrated_models.append(model)
                continue
            migrated_models.append({
                **model,
                "settings": {**(settings if isinstance(settings, dict) else {}), "device_name": device_name},
            })
            changed = True
        return migrated_models, changed

    def _save_metadata(self, models: list[dict] | None = None) -> None:
        """通过同目录临时文件原子保存指定或当前模型元数据索引。"""

        temporary_path = self.metadata_path.with_name(f"{self.metadata_path.name}.{uuid4().hex}.tmp")
        try:
            temporary_path.write_text(
                json.dumps(self.models if models is None else models, ensure_ascii=False, indent=2),
                encoding="utf-8",
            )
            temporary_path.replace(self.metadata_path)
        finally:
            temporary_path.unlink(missing_ok=True)

    def _find(self, model_id: str) -> dict:
        """查找仍有原始文件的内部模型记录，不存在时抛出 LookupError。"""

        model = next((item for item in self.models if item.get("id") == model_id), None)
        if model is None or not (self.storage_dir / model.get("stored_name", "")).is_file():
            raise LookupError("找不到指定模型")
        return model

    @staticmethod
    def _default_model_settings() -> dict:
        """补全旧模型基础默认设置；未设置包络增量时六向均为零，不读取全局增量配置。"""

        return {
            "device_name": runtime_config.model_settings_default_device_name,
            "mass": None,
            "model_scale": runtime_config.model_settings_default_scale,
            "model_unit": runtime_config.model_settings_default_unit,
            "rotation_x": runtime_config.model_settings_default_rotation_x,
            "rotation_y": runtime_config.model_settings_default_rotation_y,
            "rotation_z": runtime_config.model_settings_default_rotation_z,
            "front_orientation": runtime_config.model_settings_default_front_orientation,
            "center_of_mass": None,
            "installation_face_id": None,
            "installation_point": None,
            "safety_clearance_mm": default_safety_clearance(),
        }

    @staticmethod
    def _normalize_center_of_mass(value: object) -> dict | None:
        """校验可空的 STEP 局部质心，保证三个坐标完整且均为有限数值。"""

        if value is None:
            return None
        if not isinstance(value, dict) or set(value) != {"x", "y", "z"}:
            raise ValueError("质心 X、Y、Z 坐标必须同时填写或全部留空")
        normalized: dict[str, float] = {}
        for axis in ("x", "y", "z"):
            coordinate = value.get(axis)
            if isinstance(coordinate, bool) or not isinstance(coordinate, (int, float)) or not math.isfinite(float(coordinate)):
                raise ValueError(f"质心 {axis.upper()} 坐标必须是有限数值")
            normalized[axis] = float(coordinate)
        return normalized

    @staticmethod
    def _normalize_installation_point(value: object) -> dict | None:
        """校验可空的 STEP 源坐标安装点，保证三轴完整且均为有限数值。"""

        if value is None:
            return None
        if not isinstance(value, dict) or set(value) != {"x", "y", "z"}:
            raise ValueError("安装点 X、Y、Z 坐标必须同时填写或全部留空")
        normalized: dict[str, float] = {}
        for axis in ("x", "y", "z"):
            coordinate = value.get(axis)
            if isinstance(coordinate, bool) or not isinstance(coordinate, (int, float)) or not math.isfinite(float(coordinate)):
                raise ValueError(f"安装点 {axis.upper()} 坐标必须是有限数值")
            normalized[axis] = float(coordinate)
        return normalized

    @classmethod
    def _normalize_model_settings(cls, values: dict | None) -> dict:
        """补全并校验模型设置，兼容尚未包含设置字段的旧模型索引。"""

        candidate = {**cls._default_model_settings(), **(values if isinstance(values, dict) else {})}
        device_name = candidate.get("device_name")
        if not isinstance(device_name, str) or not device_name.strip() or len(device_name.strip()) > 200:
            raise ValueError("设备名称必须为 1 至 200 个字符")
        mass = candidate.get("mass")
        if mass is not None and (
            isinstance(mass, bool)
            or not isinstance(mass, (int, float))
            or not math.isfinite(float(mass))
            or not 0 <= float(mass) <= 1_000_000_000_000
        ):
            raise ValueError("质量必须是 0 至 1000000000000 kg 的有限数值")
        model_scale = candidate.get("model_scale")
        if (
            isinstance(model_scale, bool)
            or not isinstance(model_scale, (int, float))
            or not math.isfinite(float(model_scale))
            or not 0.0001 <= float(model_scale) <= 1_000_000
        ):
            raise ValueError("模型比例必须是 0.0001 至 1000000 之间的有限数值")
        if candidate.get("model_unit") not in MODEL_SETTING_UNITS:
            raise ValueError("模型单位必须是 mm、cm 或 m")
        for field_name in ("rotation_x", "rotation_y", "rotation_z"):
            if candidate.get(field_name) not in MODEL_SETTING_ROTATIONS:
                raise ValueError("模型旋转角度必须是 0、90、180 或 270 度")
        up_orientation = candidate.get("front_orientation")
        if not isinstance(up_orientation, str) or up_orientation not in MODEL_SETTING_UP_ORIENTATIONS:
            raise ValueError("向上轴向必须是 +X、-X、+Y、-Y、+Z、-Z 或自由（free）")
        center_of_mass = cls._normalize_center_of_mass(candidate.get("center_of_mass"))
        installation_face_id = candidate.get("installation_face_id")
        if installation_face_id is not None and (
            not isinstance(installation_face_id, str)
            or STEP_FACE_ID_PATTERN.fullmatch(installation_face_id) is None
        ):
            raise ValueError("安装面 ID 格式无效")
        installation_point = cls._normalize_installation_point(candidate.get("installation_point"))
        if installation_face_id is None and installation_point is not None:
            raise ValueError("未选择安装面时不能设置安装点")
        return {
            "device_name": device_name.strip(),
            "mass": None if mass is None else float(mass),
            "model_scale": float(model_scale),
            "model_unit": candidate["model_unit"],
            "rotation_x": int(candidate["rotation_x"]),
            "rotation_y": int(candidate["rotation_y"]),
            "rotation_z": int(candidate["rotation_z"]),
            "front_orientation": candidate["front_orientation"],
            "center_of_mass": center_of_mass,
            "installation_face_id": installation_face_id,
            "installation_point": installation_point,
            "safety_clearance_mm": normalize_safety_clearance(candidate["safety_clearance_mm"]),
        }

    def _validate_installation_reference(self, model_id: str, face_id: str | None, point: dict | None) -> dict | None:
        """确认安装面属于可见外壳，并把浏览点击点投影回精确 STEP 面后返回规范坐标。"""

        if face_id is None:
            return None
        mapping_path = self.get_artifact_path(model_id, "mapping")
        try:
            mapping = json.loads(mapping_path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError) as error:
            raise ValueError("安装面映射不可用，请重新生成高清预览") from error
        entries = mapping.get("entries") if isinstance(mapping, dict) else None
        if not isinstance(entries, list) or any(not isinstance(item, dict) for item in entries):
            raise ValueError("安装面映射不可用，请重新生成高清预览")
        entry = next(
            (item for item in entries if item.get("step_face_id") == face_id),
            None,
        )
        if entry is None:
            raise ValueError("安装面不属于当前模型的可见外壳")
        if entry.get("surface_type") != "PLANE" and point is None:
            raise ValueError("曲面安装必须在预览中点击并保存安装点")
        if point is None:
            return None
        source_path = self.get_file_path(model_id)
        reference, _ = read_installation_reference(source_path, face_id, source_point=point)
        return {axis: float(reference[index]) for index, axis in enumerate("xyz")}

    def _artifact_path(self, model_id: str) -> Path:
        """返回指定模型的派生产物目录。"""

        return self.artifact_dir / model_id

    def _artifact_tier_path(self, model_id: str, quality: str) -> Path:
        """返回指定模型与质量档的派生产物目录。"""

        return self._artifact_path(model_id) / quality

    def _shell_map_path(self, model_id: str) -> Path:
        """返回指定模型可由两档网格复用的外壳面清单路径。"""

        return self._artifact_path(model_id) / "common" / "shell-map.json"

    def _preview_runtime_cache_path(self, model_id: str) -> Path:
        """返回指定模型浏览器合并预览二进制缓存的固定路径。"""

        return self._artifact_path(model_id) / PREVIEW_RUNTIME_CACHE_NAME

    def _envelope_path(self, model_id: str) -> Path:
        """返回指定模型基础正式包络的派生产物目录。"""

        return self._artifact_path(model_id) / "envelope"

    def _artifact_lock(self, model_id: str) -> Lock:
        """返回指定模型的进程内转换锁，防止并发首次预览重复发布产物。"""

        with self._lock:
            return self._artifact_locks.setdefault(model_id, Lock())

    @staticmethod
    def _artifact_parameters() -> dict:
        """汇总影响外壳筛选和两档离散结果的配置参数。"""

        return {
            "shell_policy": SHELL_POLICY,
            "detail_linear_ratio": runtime_config.model_preview_detail_linear_ratio,
            "detail_angular_degrees": runtime_config.model_preview_detail_angular_degrees,
            "interaction_linear_ratio": runtime_config.model_preview_interaction_linear_ratio,
            "interaction_max_linear_ratio": runtime_config.model_preview_interaction_max_linear_ratio,
            "interaction_angular_degrees": runtime_config.model_preview_interaction_angular_degrees,
            "interaction_max_angular_degrees": runtime_config.model_preview_interaction_max_angular_degrees,
            "interaction_triangle_target": runtime_config.model_preview_interaction_triangle_target,
            "shell_samples_per_face": runtime_config.model_preview_shell_samples_per_face,
            "shell_ray_epsilon_ratio": runtime_config.model_preview_shell_ray_epsilon_ratio,
            "preview_artifact_version": runtime_config.model_preview_artifact_version,
        }

    @staticmethod
    def _envelope_parameters(settings: dict) -> dict:
        """组合 STEP 离散参数和当前模型的六向毫米增量，供生成、失效及并发发布校验共享。"""

        return {
            "step_linear_ratio": runtime_config.model_envelope_step_linear_ratio,
            "step_min_linear_tolerance_mm": runtime_config.model_envelope_step_min_linear_tolerance_mm,
            "step_angular_degrees": runtime_config.model_envelope_step_angular_degrees,
            "refinement_grid_size": runtime_config.model_envelope_refinement_grid_size,
            "refinement_direction_count": runtime_config.model_envelope_refinement_direction_count,
            "connectivity_core_inset_ratio": runtime_config.model_envelope_connectivity_core_inset_ratio,
            "detail_smoothing_ratio": runtime_config.model_envelope_detail_smoothing_ratio,
            "outline_simplify_ratio": runtime_config.model_envelope_outline_simplify_ratio,
            "gap_bridge_ratio": runtime_config.model_envelope_gap_bridge_ratio,
            **{f"{direction}_clearance_mm": value for direction, value in settings["safety_clearance_mm"].items()},
            "artifact_version": runtime_config.model_envelope_artifact_version,
        }

    def _source_metadata(self, model: dict) -> dict:
        """读取 STEP 原件的稳定文件指纹，用于判断包络是否仍匹配源模型。"""

        source_stat = (self.storage_dir / model["stored_name"]).stat()
        return {
            "format": "STEP",
            "role": "authoritative",
            "size": source_stat.st_size,
            "modified_ns": source_stat.st_mtime_ns,
        }

    @staticmethod
    def _shell_parameters(parameters: dict) -> dict:
        """从完整产物参数中提取公共外壳表使用的参数指纹。"""

        return {
            "policy": parameters["shell_policy"],
            "samples_per_face": int(parameters["shell_samples_per_face"]),
            "ray_epsilon_ratio": float(parameters["shell_ray_epsilon_ratio"]),
            "direction_set": "cube_26",
            "preview_artifact_version": int(parameters["preview_artifact_version"]),
        }

    def _load_current_manifest(self, model: dict, quality: str = "detail") -> dict | None:
        """读取与当前源文件、版本和质量参数匹配的派生产物清单。"""

        artifact_path = self._artifact_tier_path(model["id"], quality)
        manifest_path = artifact_path / "manifest.json"
        try:
            manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            return None
        source_path = self.storage_dir / model["stored_name"]
        source_stat = source_path.stat()
        expected_source = {
            "format": "STEP",
            "role": "authoritative",
            "size": source_stat.st_size,
            "modified_ns": source_stat.st_mtime_ns,
        }
        if manifest.get("source") != expected_source:
            return None
        if manifest.get("quality") != quality:
            return None
        actual_parameters = manifest.get("parameters", {})
        if any(actual_parameters.get(key) != value for key, value in self._artifact_parameters().items()):
            return None
        try:
            shell_map = json.loads(self._shell_map_path(model["id"]).read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            return None
        if shell_map.get("source") != expected_source:
            return None
        if shell_map.get("parameters") != self._shell_parameters(actual_parameters):
            return None
        source_face_count = int(manifest.get("stats", {}).get("source_face_count", -1))
        expected_face_ids = {f"FACE_{index:05d}" for index in range(1, source_face_count + 1)}
        retained_face_ids = shell_map.get("retained_face_ids", [])
        culled_face_ids = shell_map.get("culled_face_ids", [])
        if (
            len(retained_face_ids) != len(set(retained_face_ids))
            or len(culled_face_ids) != len(set(culled_face_ids))
        ):
            return None
        retained = set(retained_face_ids)
        culled = set(culled_face_ids)
        if retained | culled != expected_face_ids or retained & culled:
            return None
        if len(retained) != manifest.get("stats", {}).get("retained_face_count"):
            return None
        if len(culled) != manifest.get("stats", {}).get("culled_face_count"):
            return None
        browser_asset = manifest.get("browser_asset", {})
        if not (artifact_path / browser_asset.get("file_name", "")).is_file():
            return None
        if quality == "detail":
            face_mapping = manifest.get("face_mapping", {})
            if not (artifact_path / face_mapping.get("file_name", "")).is_file():
                return None
        return manifest

    def _artifact_status(self, model: dict) -> dict:
        """生成模型列表所需的派生产物状态与轻量统计。"""

        detail_manifest = self._load_current_manifest(model, "detail")
        interaction_manifest = self._load_current_manifest(model, "interaction")
        return {
            "state": "ready" if detail_manifest is not None else "pending",
            "interaction_state": "ready" if interaction_manifest is not None else "pending",
            "stats": (detail_manifest or interaction_manifest or {}).get("stats"),
            "envelope": self._envelope_status(model),
        }

    def _load_current_envelope_manifest(self, model: dict) -> dict | None:
        """读取匹配当前 STEP 与配置的包络清单；兼容旧四向产物，新产物只含 0 度。"""

        envelope_path = self._envelope_path(model["id"])
        try:
            manifest = json.loads((envelope_path / "manifest.json").read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            return None
        if manifest.get("format_version") != MODEL_ENVELOPE_FORMAT_VERSION:
            return None
        if manifest.get("algorithm") != ENVELOPE_ALGORITHM:
            return None
        if manifest.get("source") != self._source_metadata(model):
            return None
        settings = self._normalize_model_settings(model.get("settings"))
        if manifest.get("geometry_settings") != geometry_settings_fingerprint(settings):
            return None
        if manifest.get("parameters") != self._envelope_parameters(settings):
            return None
        variants = manifest.get("variants")
        rotations = frozenset(item.get("rot_z") for item in variants if isinstance(item, dict)) if isinstance(variants, list) else frozenset()
        if rotations not in {frozenset(STORED_ENVELOPE_ROTATIONS), _LEGACY_ENVELOPE_ROTATIONS}:
            return None
        if any(
            not isinstance(item, dict)
            or not isinstance(item.get("file_name"), str)
            or not (envelope_path / item["file_name"]).is_file()
            or not isinstance(item.get("watertight"), bool)
            for item in variants
        ):
            return None
        return manifest

    def _envelope_status(self, model: dict) -> dict:
        """返回前端列表所需的当前包络状态和轻量生成信息。"""

        manifest = self._load_current_envelope_manifest(model)
        if manifest is None:
            return {"state": "pending"}
        return {
            "state": "ready",
            "generated_at": manifest["generated_at"],
            "algorithm": manifest["algorithm"],
            "variant_count": len(manifest["variants"]),
        }

    def get_model_envelope_status(self, model_id: str) -> dict:
        """返回指定模型由后端统一判定的当前包络有效状态。"""

        with self._lock:
            return self._envelope_status(self._find(model_id))

    def has_model(self, model_id: str) -> bool:
        """判断指定模型是否仍存在于模型库且源文件可读。"""

        with self._lock:
            try:
                self._find(model_id)
            except LookupError:
                return False
            return True

    @contextmanager
    def hold_artifacts(self, model_id: str):
        """持有模型产物锁并输出源文件与当前有效包络的一致快照。

        参数：
            model_id: 已上传模型标识。
        生成：
            含 `model_id`、`filename`、`source_path`、`settings`、`source_metadata`、
            `algorithm`、`generated_at`、`mesh_sha256`、`variants` 和 `preview_bytes` 的字典；
            `variants` 每项含方向角、文件名、路径、字节数、摘要、水密标记与包围范围。
        异常：
            LookupError: 模型不存在，或包络尚未生成、已失效。
            OSError: 包络变体文件不可读。
        副作用：
            在上下文存活期间阻止该模型重新生成或删除包络；只读取文件，不修改产物。
        """

        with self._artifact_lock(model_id):
            with self._lock:
                model = self._find(model_id)
                manifest = self._load_current_envelope_manifest(model)
                if manifest is None:
                    raise LookupError("包络尚未生成或已失效，请先生成包络再固化存储")
                settings = self._normalize_model_settings(model.get("settings"))
                directory = self._envelope_path(model_id)
                source_path = self.storage_dir / model["stored_name"]
                filename = model["filename"]
                source_metadata = self._source_metadata(model)
                variants = [
                    {
                        "rot_z": int(item["rot_z"]),
                        "file_name": str(item["file_name"]),
                        "path": directory / item["file_name"],
                        "size": (directory / item["file_name"]).stat().st_size,
                        "watertight": bool(item.get("watertight")),
                        "bounds": item.get("bounds"),
                    }
                    for item in manifest["variants"]
                    if item["rot_z"] == 0
                ]
            preview_bytes = self._envelope_preview_bytes(model_id, manifest)
            snapshot = {
                "model_id": model_id,
                "filename": filename,
                "source_path": source_path,
                "source_metadata": source_metadata,
                "settings": settings,
                "algorithm": manifest["algorithm"],
                "generated_at": manifest["generated_at"],
                "mesh_sha256": _hash_files([variant["path"] for variant in variants]),
                "variants": variants,
                "preview_bytes": preview_bytes,
            }
        yield snapshot

    def get_model_envelope_preview(self, model_id: str) -> bytes:
        """返回当前有效包络的 GLB 字节，首次读取时缓存已有 NPZ 的浏览转换。

        包络未生成、失效或模型不存在时抛出 LookupError；转换失败抛出 ValueError/OSError。
        与生成和删除共用模型锁，返回字节快照以避免发送期间目录被替换。
        """

        with self._artifact_lock(model_id):
            with self._lock:
                model = self._find(model_id)
                manifest = self._load_current_envelope_manifest(model)
                if manifest is None:
                    raise LookupError("包络尚未生成或已失效，请先生成包络")
            return self._envelope_preview_bytes(model_id, manifest)

    def _envelope_preview_bytes(self, model_id: str, manifest: dict) -> bytes:
        """读取或按需生成正式包络的浏览 GLB，并校验生成期间包络未失效。

        参数：
            model_id: 已上传模型标识。
            manifest: 调用方已校验为当前有效的包络清单。
        返回：
            与源模型共用局部坐标的 GLB 字节。
        异常：
            LookupError: 生成期间包络失效，或细节网格不可用。
            ValueError/OSError: 浏览网格转换失败。
        副作用：
            首次调用把生成的 GLB 写入包络产物目录。
        """

        directory = self._envelope_path(model_id)
        preview_path = directory / "preview.glb"
        if preview_path.is_file():
            return preview_path.read_bytes()
        with self._lock:
            model = self._find(model_id)
            detail = self._load_current_manifest(model, "detail")
            if detail is None:
                raise LookupError("模型细节网格已失效，请重新生成包络")
            source_path = self._artifact_tier_path(model_id, "detail") / detail["browser_asset"]["file_name"]
            variant = next(item for item in manifest["variants"] if item["rot_z"] == 0)
            settings = self._normalize_model_settings(model.get("settings"))
        content = build_envelope_preview_glb(directory / variant["file_name"], source_path, settings)
        with self._lock:
            if self._load_current_envelope_manifest(self._find(model_id)) is None:
                raise LookupError("包络在加载期间已失效，请重新生成")
            temporary_path = directory / f".preview.{uuid4().hex}.tmp"
            try:
                temporary_path.write_bytes(content)
                temporary_path.replace(preview_path)
            finally:
                temporary_path.unlink(missing_ok=True)
        return content

    def _current_preview_cache_signature(self, model: dict) -> tuple[str, str] | None:
        """返回两档当前派生产物的生成标识；任一档失效时返回空。"""

        interaction = self._load_current_manifest(model, "interaction")
        detail = self._load_current_manifest(model, "detail")
        if interaction is None or detail is None:
            return None
        interaction_generated_at = interaction.get("generated_at")
        detail_generated_at = detail.get("generated_at")
        if not isinstance(interaction_generated_at, str) or not isinstance(detail_generated_at, str):
            return None
        return interaction_generated_at, detail_generated_at

    def get_preview_runtime_cache_path(self, model_id: str) -> Path | None:
        """返回仍与当前双 LOD 匹配的运行时预览缓存路径，不可用时清理并返回空。"""

        with self._artifact_lock(model_id):
            with self._lock:
                model = self._find(model_id)
                cache_path = self._preview_runtime_cache_path(model_id)
                if not cache_path.is_file():
                    return None
                if self._current_preview_cache_signature(model) is not None:
                    return cache_path
                cache_path.unlink(missing_ok=True)
                return None

    def prepare_preview_runtime_cache_write(self, model_id: str) -> tuple[Path, tuple[str, str]]:
        """确认双 LOD 有效并返回缓存写入目标及当前生成标识。"""

        with self._artifact_lock(model_id):
            with self._lock:
                model = self._find(model_id)
                signature = self._current_preview_cache_signature(model)
                if signature is None:
                    raise ValueError("模型双 LOD 尚未就绪，不能保存预览缓存")
                path = self._preview_runtime_cache_path(model_id)
                path.parent.mkdir(parents=True, exist_ok=True)
                return path, signature

    def publish_preview_runtime_cache(
        self,
        model_id: str,
        temporary_path: Path,
        expected_signature: tuple[str, str],
    ) -> None:
        """原子发布通过格式校验的预览缓存，并拒绝产物更新期间生成的旧数据。"""

        with self._artifact_lock(model_id):
            with self._lock:
                model = self._find(model_id)
                if self._current_preview_cache_signature(model) != expected_signature:
                    raise ValueError("模型预览产物已更新，请重新加载后再保存缓存")
                with temporary_path.open("rb") as cache_file:
                    if cache_file.read(len(PREVIEW_RUNTIME_CACHE_MAGIC)) != PREVIEW_RUNTIME_CACHE_MAGIC:
                        raise ValueError("预览缓存文件格式无效")
                temporary_path.replace(self._preview_runtime_cache_path(model_id))

    def get_preview_runtime_cache_limit(self) -> int:
        """返回单个浏览器运行时预览缓存允许写入的最大字节数。"""

        return runtime_config.model_preview_runtime_cache_max_bytes

    @staticmethod
    def _publish_directory(temporary_dir: Path, target_dir: Path, task_id: str) -> None:
        """以可回滚的同卷目录交换发布单个质量档产物。"""

        backup_dir = target_dir.with_name(f".{target_dir.name}.{task_id}.old")
        shutil.rmtree(backup_dir, ignore_errors=True)
        if target_dir.exists():
            target_dir.replace(backup_dir)
        try:
            temporary_dir.replace(target_dir)
        except Exception:
            if backup_dir.exists() and not target_dir.exists():
                backup_dir.replace(target_dir)
            raise
        finally:
            shutil.rmtree(backup_dir, ignore_errors=True)

    def _public_model(self, model: dict) -> dict:
        """移除内部存储名称，并附加源文件与派生产物的公开状态。"""

        return {
            "id": model["id"],
            "filename": model["filename"],
            "size": model["size"],
            "uploaded_at": model["uploaded_at"],
            "source_format": "STEP",
            "download_url": f"/api/models/{model['id']}/file",
            "settings": self._normalize_model_settings(model.get("settings")),
            "derivatives": self._artifact_status(model),
        }

    def list_models(self) -> list[dict]:
        """返回按上传时间倒序排列的全部有效模型。"""

        with self._lock:
            available = [item for item in self.models if (self.storage_dir / item.get("stored_name", "")).is_file()]
            if len(available) != len(self.models):
                self.models = available
                self._save_metadata()
            return [
                self._public_model(item)
                for item in sorted(available, key=lambda value: value.get("uploaded_at", ""), reverse=True)
            ]

    def save_upload(self, filename: str | None, source: BinaryIO) -> dict:
        """流式保存非空 STEP/STP 原始文件，提交派生任务并返回公开元数据。

        参数：
            filename: 客户端提供的原始文件名。
            source: 支持分块读取的二进制文件对象。
        返回：
            已保存模型的公开元数据。
        异常：
            ValueError: 扩展名不受支持或文件为空。
        副作用：
            写入原始文件和元数据索引；GLB/映射会在首次预览请求时同步生成。
        """

        safe_name = self._safe_filename(filename)
        suffix = Path(safe_name).suffix.lower()
        if suffix not in self.allowed_extensions:
            raise ValueError("仅支持上传 .stp 或 .step 模型文件")
        default_settings = self._normalize_model_settings({"device_name": Path(safe_name).stem})
        model_id = uuid4().hex
        destination = self.storage_dir / f"{model_id}{suffix}"
        size = 0
        signature = bytearray()
        try:
            with destination.open("wb") as target:
                while chunk := source.read(1024 * 1024):
                    target.write(chunk)
                    size += len(chunk)
                    if len(signature) < 4096:
                        signature.extend(chunk[:4096 - len(signature)])
            if size == 0:
                raise ValueError("模型文件不能为空")
            if b"ISO-10303-21" not in bytes(signature).upper():
                raise ValueError("文件内容不是有效的 STEP 交换格式")
        except Exception:
            destination.unlink(missing_ok=True)
            raise
        item = {
            "id": model_id,
            "filename": safe_name,
            "stored_name": destination.name,
            "size": size,
            "uploaded_at": datetime.now(timezone.utc).isoformat(),
            "settings": default_settings,
        }
        with self._lock:
            self.models.append(item)
            self._save_metadata()
        public_model = self._public_model(item)
        return public_model

    def get_file_path(self, model_id: str) -> Path:
        """返回指定模型的 STEP/STP 原始文件路径。"""

        with self._lock:
            model = self._find(model_id)
            return self.storage_dir / model["stored_name"]

    def get_model_settings(self, model_id: str) -> dict:
        """返回指定模型的完整设置；旧索引会按统一配置补全。"""

        with self._lock:
            model = self._find(model_id)
            return self._normalize_model_settings(model.get("settings"))

    def update_model_settings(self, model_id: str, settings: dict) -> dict:
        """原子保存模型设置；旧客户端未传包络增量时保留现值，不修改 STEP 或预览资源。"""

        with self._lock:
            previous = self._normalize_model_settings(self._find(model_id).get("settings"))
        normalized = self._normalize_model_settings({
            "safety_clearance_mm": previous["safety_clearance_mm"], **settings,
        })
        normalized["installation_point"] = self._validate_installation_reference(
            model_id, normalized["installation_face_id"], normalized["installation_point"]
        )
        with self._lock:
            model = self._find(model_id)
            stored_settings = {
                **normalized,
                "center_of_mass": dict(normalized["center_of_mass"]) if normalized["center_of_mass"] else None,
                "installation_point": dict(normalized["installation_point"]) if normalized["installation_point"] else None,
            }
            next_models = [
                {**item, "settings": stored_settings} if item is model else item
                for item in self.models
            ]
            self._save_metadata(next_models)
            self.models = next_models
        return self._normalize_model_settings(normalized)

    def _build_artifacts(self, model_id: str, quality: str) -> dict:
        """在隔离子进程生成指定质量档的派生产物，并在源模型仍存在时发布。

        参数：
            model_id: 已保存的模型标识。
            quality: `interaction` 或 `detail`。
        异常：
            ValueError: 工作进程无法解析 STEP 或未生成完整清单。
        副作用：
            启动短生命周期 Python 进程，并替换对应质量档和公共外壳清单。
        """

        if quality not in {"interaction", "detail"}:
            raise ValueError("模型预览质量档无效")
        with self._lock:
            model = dict(self._find(model_id))
            source_path = self.storage_dir / model["stored_name"]
            public_model = self._public_model(model)
        task_id = uuid4().hex
        temporary_dir = self.artifact_dir / f".{model_id}.{quality}.{task_id}.tmp"
        request_path = self.artifact_dir / f".{model_id}.{quality}.{task_id}.request.json"
        error_path = self.artifact_dir / f".{model_id}.{quality}.{task_id}.error.txt"
        shell_map_path = self._shell_map_path(model_id)
        try:
            request_path.write_text(
                json.dumps({
                    "source_path": str(source_path),
                    "output_dir": str(temporary_dir),
                    "model": public_model,
                    "quality": quality,
                    "parameters": self._artifact_parameters(),
                    "reusable_shell_map_path": str(shell_map_path) if shell_map_path.is_file() else None,
                }, ensure_ascii=False),
                encoding="utf-8",
            )
            project_root = Path(__file__).resolve().parents[3]
            environment = dict(os.environ)
            backend_path = str(project_root / "backend")
            environment["PYTHONPATH"] = os.pathsep.join(filter(None, [backend_path, environment.get("PYTHONPATH")]))
            result = subprocess.run(
                [sys.executable, "-m", "app.domain.model_artifact_worker", str(request_path), str(error_path)],
                cwd=project_root,
                env=environment,
                capture_output=True,
                text=True,
                encoding="utf-8",
                errors="replace",
                check=False,
            )
            if result.returncode != 0:
                detail = error_path.read_text(encoding="utf-8").splitlines()[0] if error_path.exists() else result.stderr.strip()
                raise ValueError(detail or f"STEP 转换进程异常退出（{result.returncode}）")
            manifest_path = temporary_dir / "manifest.json"
            generated_shell_map = temporary_dir / "shell-map.json"
            if not manifest_path.is_file() or not generated_shell_map.is_file():
                raise ValueError("STEP 转换未生成完整派生产物清单")
            manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
            with self._lock:
                self._find(model_id)
                root_path = self._artifact_path(model_id)
                common_path = root_path / "common"
                common_path.mkdir(parents=True, exist_ok=True)
                temporary_shell_map = common_path / f".shell-map.{task_id}.tmp"
                shutil.copy2(generated_shell_map, temporary_shell_map)
                temporary_shell_map.replace(shell_map_path)
                generated_shell_map.unlink(missing_ok=True)
                target_dir = self._artifact_tier_path(model_id, quality)
                self._publish_directory(temporary_dir, target_dir, task_id)
                self._preview_runtime_cache_path(model_id).unlink(missing_ok=True)
                for legacy_name in ("manifest.json", "preview.glb", "face-map.json"):
                    (root_path / legacy_name).unlink(missing_ok=True)
            return manifest
        finally:
            shutil.rmtree(temporary_dir, ignore_errors=True)
            request_path.unlink(missing_ok=True)
            error_path.unlink(missing_ok=True)

    def _public_manifest(self, model_id: str, manifest: dict, quality: str) -> dict:
        """为内部清单补充公开模型、资源 URL 和另一质量档统计。"""

        public_manifest = dict(manifest)
        with self._lock:
            model = self._find(model_id)
            public_manifest["model"] = self._public_model(model)
            counterpart_quality = "detail" if quality == "interaction" else "interaction"
            counterpart = self._load_current_manifest(model, counterpart_quality)
        route_name = "preview-interaction.glb" if quality == "interaction" else "preview.glb"
        public_manifest["browser_asset"] = {
            **manifest["browser_asset"],
            "url": f"/api/models/{model_id}/{route_name}?v={manifest['generated_at']}",
        }
        public_stats = dict(manifest["stats"])
        if counterpart is not None:
            key = f"{counterpart_quality}_triangle_count"
            public_stats[key] = counterpart["stats"]["triangle_count"]
        public_manifest["stats"] = public_stats
        if quality == "detail":
            public_manifest["face_mapping"] = {
                **manifest["face_mapping"],
                "url": f"/api/models/{model_id}/face-map?v={manifest['generated_at']}",
            }
        return public_manifest

    def _get_manifest(self, model_id: str, quality: str) -> dict:
        """串行读取或生成指定质量档清单，并转换为公开响应。"""

        with self._artifact_lock(model_id):
            with self._lock:
                model = self._find(model_id)
                manifest = self._load_current_manifest(model, quality)
            if manifest is None:
                manifest = self._build_artifacts(model_id, quality)
        return self._public_manifest(model_id, manifest, quality)

    def get_interaction_manifest(self, model_id: str) -> dict:
        """返回优先显示的轻量交互 GLB 清单，缺失时只生成该质量档。"""

        return self._get_manifest(model_id, "interaction")

    def get_preview_manifest(self, model_id: str) -> dict:
        """返回兼容现有接口的细节 GLB 与面映射清单，缺失时生成。

        OpenCascade 在当前运行环境中不支持并行析构，故转换刻意在单一请求线程中串行执行。
        """

        return self._get_manifest(model_id, "detail")

    def get_artifact_path(self, model_id: str, kind: str) -> Path:
        """返回已生成的交互/细节 GLB 或面映射路径，不存在时生成并校验。"""

        quality = "interaction" if kind == "interaction_glb" else "detail"
        manifest = self.get_interaction_manifest(model_id) if quality == "interaction" else self.get_preview_manifest(model_id)
        section = "face_mapping" if kind == "mapping" else "browser_asset"
        artifact_path = self._artifact_tier_path(model_id, quality) / manifest[section]["file_name"]
        if not artifact_path.is_file():
            raise LookupError("找不到指定模型的派生产物")
        return artifact_path

    @staticmethod
    def _public_envelope_manifest(manifest: dict) -> dict:
        """返回不暴露本地绝对路径的包络生成结果。"""

        return {
            "state": "ready",
            "generated_at": manifest["generated_at"],
            "algorithm": manifest["algorithm"],
            "normalization": manifest["normalization"],
            "source_mesh": manifest["source_mesh"],
            "variants": [
                {key: value for key, value in variant.items() if key != "file_name"}
                for variant in manifest["variants"]
            ],
        }

    def _build_envelope(self, model_id: str, source_step_path: Path) -> dict:
        """优先复用旧外壳，并在隔离子进程原子发布唯一 0 度连续外层包络。"""

        task_id = uuid4().hex
        temporary_dir = self.artifact_dir / f".{model_id}.envelope.{task_id}.tmp"
        request_path = self.artifact_dir / f".{model_id}.envelope.{task_id}.request.json"
        error_path = self.artifact_dir / f".{model_id}.envelope.{task_id}.error.txt"
        reusable_envelope_dir = self._envelope_path(model_id)
        with self._lock:
            model = self._find(model_id)
            settings = self._normalize_model_settings(model.get("settings"))
            model_snapshot = {"id": model_id, "settings": settings}
            source = self._source_metadata(model)
            parameters = self._envelope_parameters(settings)
        try:
            request_path.write_text(json.dumps({
                "source_step_path": str(source_step_path),
                "output_dir": str(temporary_dir),
                "model": model_snapshot,
                "source": source,
                "parameters": parameters,
                "reusable_envelope_dir": (
                    str(reusable_envelope_dir)
                    if (reusable_envelope_dir / "manifest.json").is_file()
                    else None
                ),
            }, ensure_ascii=False), encoding="utf-8")
            project_root = Path(__file__).resolve().parents[3]
            environment = dict(os.environ)
            backend_path = str(project_root / "backend")
            environment["PYTHONPATH"] = os.pathsep.join(filter(None, [backend_path, environment.get("PYTHONPATH")]))
            result = subprocess.run(
                [sys.executable, "-m", "app.domain.model_envelope_worker", str(request_path), str(error_path)],
                cwd=project_root,
                env=environment,
                capture_output=True,
                text=True,
                encoding="utf-8",
                errors="replace",
                check=False,
            )
            if result.returncode != 0:
                detail = error_path.read_text(encoding="utf-8").splitlines()[0] if error_path.exists() else result.stderr.strip()
                raise ValueError(detail or f"包络生成进程异常退出（{result.returncode}）")
            manifest_path = temporary_dir / "manifest.json"
            if not manifest_path.is_file():
                raise ValueError("包络生成未返回产物清单")
            manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
            if (
                manifest.get("model_id") != model_id
                or manifest.get("source") != source
                or manifest.get("geometry_settings") != geometry_settings_fingerprint(settings)
                or manifest.get("parameters") != parameters
                or manifest.get("algorithm") != ENVELOPE_ALGORITHM
            ):
                raise ValueError("包络生成清单与当前任务不一致")
            variants = manifest.get("variants")
            if (
                not isinstance(variants, list)
                or {item.get("rot_z") for item in variants if isinstance(item, dict)} != set(STORED_ENVELOPE_ROTATIONS)
                or any(
                    not isinstance(item, dict)
                    or not isinstance(item.get("watertight"), bool)
                    or not isinstance(item.get("file_name"), str)
                    or not (temporary_dir / item["file_name"]).is_file()
                    for item in variants
                )
            ):
                raise ValueError("包络生成未产生唯一的 0 度连续外层基础包络")
            with self._lock:
                current = self._find(model_id)
                current_settings = self._normalize_model_settings(current.get("settings"))
                if (
                    self._source_metadata(current) != source
                    or geometry_settings_fingerprint(current_settings) != geometry_settings_fingerprint(settings)
                    or self._envelope_parameters(current_settings) != parameters
                ):
                    raise ValueError("包络生成期间模型设置发生变化，请重新生成")
                self._publish_directory(temporary_dir, self._envelope_path(model_id), task_id)
            return manifest
        finally:
            shutil.rmtree(temporary_dir, ignore_errors=True)
            request_path.unlink(missing_ok=True)
            error_path.unlink(missing_ok=True)

    def generate_model_envelope(self, model_id: str) -> dict:
        """确保细节预览可用，并从完整 STEP 重新生成指定模型的正式及显示外层包络。"""

        self.get_artifact_path(model_id, "glb")
        source_step_path = self.get_file_path(model_id)
        with self._artifact_lock(model_id):
            manifest = self._build_envelope(model_id, source_step_path)
        return self._public_envelope_manifest(manifest)

    def generate_all_model_envelopes(self) -> dict:
        """依次重新生成模型库全部包络，并保留每个模型的独立失败结果。"""

        with self._lock:
            models = [
                {"id": model["id"], "filename": model["filename"]}
                for model in self.models
                if (self.storage_dir / model.get("stored_name", "")).is_file()
            ]
        results: list[dict] = []
        for model in models:
            try:
                envelope = self.generate_model_envelope(model["id"])
                results.append({**model, "status": "generated", "envelope": envelope})
            except (LookupError, ValueError, OSError) as error:
                results.append({**model, "status": "failed", "error": str(error)})
        failed = sum(item["status"] == "failed" for item in results)
        return {
            "total": len(results),
            "generated": len(results) - failed,
            "failed": failed,
            "results": results,
        }

    def start_model_envelope_task(self, model_id: str) -> dict:
        """在后端后台启动单模型包络生成，并立即返回可查询的最新任务状态。"""

        with self._lock:
            self._find(model_id)
        return self._envelope_tasks.start(
            "single",
            partial(self.generate_model_envelope, model_id),
            model_id=model_id,
        )

    def start_all_model_envelopes_task(self) -> dict:
        """在后端后台启动全部模型包络生成；已有任务运行时返回原任务。"""

        return self._envelope_tasks.start("all", self.generate_all_model_envelopes)

    def get_latest_envelope_task(self) -> dict:
        """返回刷新和页面切换后仍可恢复的最新包络任务状态。"""

        return self._envelope_tasks.get_latest()

    def delete_model(self, model_id: str) -> None:
        """删除模型原始文件、索引和全部可重建的派生产物。"""

        with self._artifact_lock(model_id):
            with self._lock:
                model = self._find(model_id)
                (self.storage_dir / model["stored_name"]).unlink(missing_ok=True)
                shutil.rmtree(self._artifact_path(model_id), ignore_errors=True)
                self.models = [item for item in self.models if item.get("id") != model_id]
                self._save_metadata()

    def delete_models(self, model_ids: list[str]) -> int:
        """幂等删除多个模型，并返回实际删除数量。"""

        deleted = 0
        for model_id in dict.fromkeys(model_ids):
            try:
                self.delete_model(model_id)
            except LookupError:
                continue
            deleted += 1
        return deleted

    def shutdown(self) -> None:
        """等待服务持有的后台任务结束并释放工作线程。"""

        self._envelope_tasks.shutdown()
