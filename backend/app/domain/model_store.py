"""
文件说明：以 SQLite 与同目录二进制资源固化模型及其安全包络，供数据管理页长期查阅。
本模块只负责固化记录的读写、资源落盘与删除，不解析 STEP、不生成包络，也不处理 HTTP。
固化记录是成果快照：删除或重新生成来源模型不会影响已固化内容，反之亦然。
"""

from __future__ import annotations

from contextlib import contextmanager
from datetime import datetime, timezone
import json
from pathlib import Path
import shutil
import sqlite3
from threading import RLock
from typing import Iterable
from uuid import uuid4

from app.core.config import runtime_config


SCHEMA_VERSION = 1
DEFAULT_PAGE_SIZE = 100
MAXIMUM_PAGE_SIZE = 500
SOURCE_ASSET_FORMAT = "STEP"

_SCHEMA_STATEMENTS = (
    """
    CREATE TABLE IF NOT EXISTS store_models (
        record_id TEXT PRIMARY KEY,
        source_model_id TEXT NOT NULL,
        device_name TEXT NOT NULL,
        source_filename TEXT NOT NULL,
        source_format TEXT NOT NULL,
        source_size INTEGER NOT NULL,
        source_asset_name TEXT NOT NULL,
        source_sha256 TEXT NOT NULL,
        settings_json TEXT NOT NULL,
        envelope_state TEXT NOT NULL,
        envelope_algorithm TEXT,
        envelope_generated_at TEXT,
        envelope_variant_count INTEGER NOT NULL DEFAULT 0,
        envelope_mesh_sha256 TEXT,
        envelope_preview_asset_name TEXT,
        envelope_preview_sha256 TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
    )
    """,
    """
    CREATE TABLE IF NOT EXISTS store_envelope_variants (
        variant_id INTEGER PRIMARY KEY AUTOINCREMENT,
        record_id TEXT NOT NULL REFERENCES store_models(record_id) ON DELETE CASCADE,
        rot_z INTEGER NOT NULL,
        file_name TEXT NOT NULL,
        asset_name TEXT NOT NULL,
        size INTEGER NOT NULL,
        sha256 TEXT NOT NULL,
        vertex_count INTEGER NOT NULL,
        face_count INTEGER NOT NULL,
        watertight INTEGER NOT NULL,
        bounds_json TEXT NOT NULL
    )
    """,
    "CREATE INDEX IF NOT EXISTS idx_store_models_created_at ON store_models(created_at DESC)",
    "CREATE INDEX IF NOT EXISTS idx_store_models_source_model ON store_models(source_model_id)",
    "CREATE INDEX IF NOT EXISTS idx_store_variants_record ON store_envelope_variants(record_id, rot_z)",
)


class ModelStoreError(ValueError):
    """表示固化请求本身不合法，例如来源模型缺少已生成的包络。"""


class ModelStore:
    """提供模型与包络固化记录的创建、查询、资源读取和删除。"""

    def __init__(self, store_dir: Path | None = None, database_name: str | None = None) -> None:
        """创建固化存储并初始化数据库结构与资源目录。

        参数：
            store_dir: 可选固化目录，测试时用于隔离真实数据。
            database_name: 可选数据库文件名，默认取统一配置。
        副作用：
            创建固化目录、资源子目录和 SQLite 数据库文件。
        """

        project_root = Path(__file__).resolve().parents[3]
        self.store_dir = Path(store_dir or (project_root / runtime_config.model_store_dir))
        self.asset_dir = self.store_dir / "assets"
        self.database_path = self.store_dir / (database_name or runtime_config.model_store_database_name)
        self.maximum_variants = int(runtime_config.model_store_max_variants)
        self._lock = RLock()
        self.store_dir.mkdir(parents=True, exist_ok=True)
        self.asset_dir.mkdir(parents=True, exist_ok=True)
        self._initialize_schema()

    def _connect(self) -> sqlite3.Connection:
        """打开一个新连接并启用外键约束与行名访问。

        返回的连接由调用方负责关闭，避免 Windows 上数据库文件句柄长期占用。
        """

        connection = sqlite3.connect(self.database_path, timeout=30.0)
        connection.row_factory = sqlite3.Row
        connection.execute("PRAGMA foreign_keys = ON")
        return connection

    @contextmanager
    def _session(self):
        """以自动提交或回滚的短事务执行一次数据库操作，退出时关闭连接。"""

        connection = self._connect()
        try:
            with connection:
                yield connection
        finally:
            connection.close()

    def _initialize_schema(self) -> None:
        """按当前版本创建缺失的表、索引和模式版本记录。"""

        with self._lock, self._session() as connection:
            for statement in _SCHEMA_STATEMENTS:
                connection.execute(statement)
            connection.execute(f"PRAGMA user_version = {SCHEMA_VERSION}")

    def _record_asset_dir(self, record_id: str) -> Path:
        """返回单个固化记录存放二进制资源的目录。"""

        return self.asset_dir / record_id

    def save_record(self, payload: dict, staged_asset_dir: Path) -> dict:
        """把已落盘的暂存资源与元数据提交为一条固化记录，失败时清理暂存目录。

        参数：
            payload: 记录元数据与变体描述，字段由 `ModelStoreService` 组装。
            staged_asset_dir: 已写入全部资源文件的暂存目录，提交后整体搬移到固化目录内。
        返回：
            可直接返回给前端的固化记录结构。
        异常：
            ModelStoreError: 包络未生成、变体数量异常或资源目录为空。
            OSError: 数据库提交或资源搬移失败。
        副作用：
            搬移暂存目录到 `assets/{record_id}`，并向 SQLite 提交记录与变体行。
        """

        variants = list(payload.get("variants") or [])
        if payload.get("envelope_state") != "ready":
            raise ModelStoreError("包络尚未生成或已失效，请先生成包络再固化存储")
        if not variants:
            raise ModelStoreError("包络缺少可固化的 0 度基础包络")
        if len(variants) > self.maximum_variants:
            raise ModelStoreError(f"基础包络文件超过允许固化的 {self.maximum_variants} 个")
        if not staged_asset_dir.is_dir():
            raise ModelStoreError("固化资源暂存目录不存在")

        record_id = uuid4().hex
        asset_directory = self._record_asset_dir(record_id)
        try:
            self._publish_assets(staged_asset_dir, asset_directory)
            with self._lock, self._session() as connection:
                connection.execute(
                    """
                    INSERT INTO store_models (
                        record_id, source_model_id, device_name, source_filename, source_format,
                        source_size, source_asset_name, source_sha256, settings_json,
                        envelope_state, envelope_algorithm, envelope_generated_at,
                        envelope_variant_count, envelope_mesh_sha256,
                        envelope_preview_asset_name, envelope_preview_sha256, created_at, updated_at
                    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                    """,
                    (
                        record_id,
                        payload["source_model_id"],
                        payload["device_name"],
                        payload["source_filename"],
                        payload["source_format"],
                        int(payload["source_size"]),
                        payload["source_asset_name"],
                        payload["source_sha256"],
                        json.dumps(payload["settings"], ensure_ascii=False),
                        payload["envelope_state"],
                        payload.get("envelope_algorithm"),
                        payload.get("envelope_generated_at"),
                        len(variants),
                        payload.get("envelope_mesh_sha256"),
                        payload.get("envelope_preview_asset_name"),
                        payload.get("envelope_preview_sha256"),
                        payload["created_at"],
                        payload["created_at"],
                    ),
                )
                connection.executemany(
                    """
                    INSERT INTO store_envelope_variants (
                        record_id, rot_z, file_name, asset_name, size, sha256,
                        vertex_count, face_count, watertight, bounds_json
                    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                    """,
                    [
                        (
                            record_id,
                            int(variant["rot_z"]),
                            variant["file_name"],
                            variant["asset_name"],
                            int(variant["size"]),
                            variant["sha256"],
                            int(variant["vertex_count"]),
                            int(variant["face_count"]),
                            1 if variant["watertight"] else 0,
                            json.dumps(variant["bounds"], ensure_ascii=False),
                        )
                        for variant in variants
                    ],
                )
        except Exception:
            shutil.rmtree(asset_directory, ignore_errors=True)
            shutil.rmtree(staged_asset_dir, ignore_errors=True)
            raise
        record = self.get_record(record_id)
        if record is None:
            raise OSError("固化记录写入后无法读取")
        return record

    @staticmethod
    def _publish_assets(staged_asset_dir: Path, asset_directory: Path) -> None:
        """把暂存资源目录发布为记录资源目录。

        Windows 上目录改名可能因杀毒或索引服务短暂占用而失败，此时退化为复制后删除暂存目录。
        """

        try:
            staged_asset_dir.replace(asset_directory)
            return
        except OSError:
            pass
        shutil.copytree(staged_asset_dir, asset_directory)
        shutil.rmtree(staged_asset_dir, ignore_errors=True)

    def list_records(self, limit: int = DEFAULT_PAGE_SIZE, offset: int = 0, keyword: str | None = None) -> dict:
        """按固化时间倒序分页返回记录摘要，并给出总条数。

        参数：
            limit: 每页条数，超限时收敛到最大页长。
            offset: 跳过的记录数量，负数按 0 处理。
            keyword: 可选关键字，匹配设备名称或来源文件名。
        返回：
            含 `records`、`total`、`limit` 和 `offset` 的字典。
        """

        safe_limit = min(max(int(limit), 1), MAXIMUM_PAGE_SIZE)
        safe_offset = max(int(offset), 0)
        conditions = ""
        parameters: list[object] = []
        if keyword and keyword.strip():
            conditions = " WHERE device_name LIKE ? OR source_filename LIKE ?"
            pattern = f"%{keyword.strip()}%"
            parameters = [pattern, pattern]
        with self._lock, self._session() as connection:
            total = int(connection.execute(f"SELECT COUNT(*) FROM store_models{conditions}", parameters).fetchone()[0])
            rows = connection.execute(
                f"SELECT * FROM store_models{conditions} ORDER BY created_at DESC, record_id DESC LIMIT ? OFFSET ?",
                [*parameters, safe_limit, safe_offset],
            ).fetchall()
        return {
            "records": [self._public_record(row) for row in rows],
            "total": total,
            "limit": safe_limit,
            "offset": safe_offset,
        }

    def get_record(self, record_id: str) -> dict | None:
        """返回指定固化记录的完整公开结构，不存在时返回空。"""

        with self._lock, self._session() as connection:
            row = connection.execute(
                "SELECT * FROM store_models WHERE record_id = ?", (record_id,)
            ).fetchone()
            if row is None:
                return None
            variants = connection.execute(
                "SELECT * FROM store_envelope_variants WHERE record_id = ? ORDER BY rot_z", (record_id,)
            ).fetchall()
        return self._public_record(row, variants)

    def has_records_for_model(self, model_id: str) -> int:
        """返回指定来源模型已固化的记录数量。"""

        with self._lock, self._session() as connection:
            return int(connection.execute(
                "SELECT COUNT(*) FROM store_models WHERE source_model_id = ?", (model_id,)
            ).fetchone()[0])

    def get_latest_record_for_model(self, model_id: str) -> dict | None:
        """返回指定来源模型最近一次固化的记录摘要，不存在时返回空。"""

        with self._lock, self._session() as connection:
            row = connection.execute(
                "SELECT * FROM store_models WHERE source_model_id = ? ORDER BY created_at DESC LIMIT 1", (model_id,)
            ).fetchone()
        return self._public_record(row) if row is not None else None

    def get_asset_path(self, record_id: str, asset_name: str) -> Path:
        """返回固化的二进制资源路径，记录或资源缺失时抛出 LookupError。"""

        record = self.get_record(record_id)
        if record is None:
            raise LookupError("找不到指定的固化记录")
        known_names = {record["source"]["asset_name"]}
        known_names.update(variant["asset_name"] for variant in record["envelope"]["variants"])
        if record["envelope"]["preview_asset_name"]:
            known_names.add(record["envelope"]["preview_asset_name"])
        if asset_name not in known_names:
            raise LookupError("固化记录中不存在该资源")
        path = self._record_asset_dir(record_id) / asset_name
        if not path.is_file():
            raise LookupError("固化资源文件已丢失")
        return path

    def delete_record(self, record_id: str) -> None:
        """删除一条固化记录及其全部资源，记录不存在时不做任何处理。"""

        self.delete_records([record_id])

    def delete_records(self, record_ids: Iterable[str]) -> int:
        """在单次数据库事务中删除指定固化记录，清理对应资源并返回实际删除数量。"""

        identifiers = list(dict.fromkeys(record_ids))
        if not identifiers:
            return 0
        existing: list[str] = []
        with self._lock, self._session() as connection:
            for start in range(0, len(identifiers), MAXIMUM_PAGE_SIZE):
                batch = identifiers[start:start + MAXIMUM_PAGE_SIZE]
                placeholders = ", ".join("?" for _ in batch)
                rows = connection.execute(
                    f"SELECT record_id FROM store_models WHERE record_id IN ({placeholders})",
                    batch,
                ).fetchall()
                found = [row["record_id"] for row in rows]
                if not found:
                    continue
                found_placeholders = ", ".join("?" for _ in found)
                connection.execute(
                    f"DELETE FROM store_envelope_variants WHERE record_id IN ({found_placeholders})",
                    found,
                )
                connection.execute(
                    f"DELETE FROM store_models WHERE record_id IN ({found_placeholders})",
                    found,
                )
                existing.extend(found)
        for record_id in existing:
            shutil.rmtree(self._record_asset_dir(record_id), ignore_errors=True)
        return len(existing)

    def delete_records_for_model(self, model_id: str) -> int:
        """删除指定来源模型的全部固化记录并返回删除数量。"""

        with self._lock, self._session() as connection:
            rows = connection.execute(
                "SELECT record_id FROM store_models WHERE source_model_id = ?", (model_id,)
            ).fetchall()
        return self.delete_records(row["record_id"] for row in rows)

    def summary(self) -> dict:
        """返回固化存储的整体统计与数据库位置描述。"""

        with self._lock, self._session() as connection:
            total = int(connection.execute("SELECT COUNT(*) FROM store_models").fetchone()[0])
            ready = int(connection.execute(
                "SELECT COUNT(*) FROM store_models WHERE envelope_state = 'ready'"
            ).fetchone()[0])
            envelope_bytes = int(connection.execute(
                "SELECT COALESCE(SUM(size), 0) FROM store_envelope_variants"
            ).fetchone()[0])
            source_bytes = int(connection.execute(
                "SELECT COALESCE(SUM(source_size), 0) FROM store_models"
            ).fetchone()[0])
        return {
            "total": total,
            "envelope_ready": ready,
            "source_bytes": source_bytes,
            "envelope_bytes": envelope_bytes,
            "database_name": self.database_path.name,
            "schema_version": SCHEMA_VERSION,
        }

    @staticmethod
    def _public_record(row: sqlite3.Row, variant_rows: Iterable[sqlite3.Row] = ()) -> dict:
        """把数据库行转换为前端使用的公开结构。"""

        record_id = row["record_id"]
        variants = [
            {
                "rot_z": int(variant["rot_z"]),
                "file_name": variant["file_name"],
                "asset_name": variant["asset_name"],
                "size": int(variant["size"]),
                "sha256": variant["sha256"],
                "vertex_count": int(variant["vertex_count"]),
                "face_count": int(variant["face_count"]),
                "watertight": bool(variant["watertight"]),
                "bounds": json.loads(variant["bounds_json"]),
                "download_url": f"/api/store/models/{record_id}/variants/{int(variant['rot_z'])}",
            }
            for variant in variant_rows
        ]
        return {
            "record_id": record_id,
            "source_model_id": row["source_model_id"],
            "device_name": row["device_name"],
            "created_at": row["created_at"],
            "updated_at": row["updated_at"],
            "settings": json.loads(row["settings_json"]),
            "source": {
                "filename": row["source_filename"],
                "format": row["source_format"],
                "size": int(row["source_size"]),
                "asset_name": row["source_asset_name"],
                "sha256": row["source_sha256"],
                "download_url": f"/api/store/models/{record_id}/source",
            },
            "envelope": {
                "state": row["envelope_state"],
                "algorithm": row["envelope_algorithm"],
                "generated_at": row["envelope_generated_at"],
                "variant_count": int(row["envelope_variant_count"]),
                "mesh_sha256": row["envelope_mesh_sha256"],
                "preview_asset_name": row["envelope_preview_asset_name"],
                "preview_sha256": row["envelope_preview_sha256"],
                "preview_url": (
                    f"/api/store/models/{record_id}/envelope/preview.glb"
                    if row["envelope_preview_asset_name"]
                    else None
                ),
                "variants": variants,
            },
        }


def current_timestamp() -> str:
    """返回 UTC ISO-8601 时间戳，供固化记录写入。"""

    return datetime.now(timezone.utc).isoformat()
