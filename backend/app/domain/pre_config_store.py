"""
文件说明：前置配置页的持久化存储，用 SQLite 保存按卫星类型区分的数量与自定义整流舱段参数。
本模块只负责配置项的读写与库表初始化，不构建几何、不解析 STEP，也不处理 HTTP。
卫星数量按数据管理页的固化记录标识逐条保存，未保存过的类型一律按 0 颗处理；
整流舱段参数是页面级单例记录：半径和高度按区间保存，读取旧单值记录时自动扩展为等值区间。
"""

from __future__ import annotations

from contextlib import contextmanager
from datetime import datetime, timezone
import json
import math
from pathlib import Path
import sqlite3
from threading import RLock

from app.core.config import runtime_config


SCHEMA_VERSION = 4
FAIRING_SEGMENT_KEY = "custom_fairing_segment"
LEGACY_CYLINDER_KEY = "custom_cylinder"
LEGACY_SATELLITE_COUNT_KEY = "satellite_count"

_SCHEMA_STATEMENTS = (
    """
    CREATE TABLE IF NOT EXISTS pre_config_values (
        config_key TEXT PRIMARY KEY,
        value_json TEXT NOT NULL,
        updated_at TEXT NOT NULL
    )
    """,
    """
    CREATE TABLE IF NOT EXISTS pre_config_satellite_counts (
        record_id TEXT PRIMARY KEY,
        satellite_count INTEGER NOT NULL,
        updated_at TEXT NOT NULL
    )
    """,
)


class PreConfigError(ValueError):
    """表示前置配置写入请求本身不合法，例如卫星数量或整流舱段尺寸越界。"""


class PreConfigStore:
    """提供按类型区分的卫星数量与自定义整流舱段参数的读取和覆盖写入。"""

    def __init__(self, store_dir: Path | None = None, database_name: str | None = None) -> None:
        """创建前置配置存储并初始化数据库结构。

        参数：
            store_dir: 可选存储目录，测试时用于隔离真实数据。
            database_name: 可选数据库文件名，默认取统一配置。
        副作用：
            创建存储目录和 SQLite 数据库文件。
        """

        project_root = Path(__file__).resolve().parents[3]
        self.store_dir = Path(store_dir or (project_root / runtime_config.pre_config_dir))
        self.database_path = self.store_dir / (database_name or runtime_config.pre_config_database_name)
        self.minimum_satellite_count = int(runtime_config.min_satellite_count)
        self.maximum_satellite_count = int(runtime_config.max_satellite_count)
        self.minimum_fairing_radius_mm = float(runtime_config.min_cylinder_radius_mm)
        self.minimum_fairing_height_mm = float(runtime_config.min_cylinder_height_mm)
        self.maximum_fairing_size_mm = float(runtime_config.max_cylinder_size_mm)
        self.minimum_axis_radius_mm = float(runtime_config.min_axis_radius_mm)
        self.minimum_fairing_shell_radius_mm = float(runtime_config.min_fairing_shell_radius_mm)
        self.radial_segments = int(runtime_config.cylinder_radial_segments)
        self._lock = RLock()
        self.store_dir.mkdir(parents=True, exist_ok=True)
        self._initialize_schema()

    def _connect(self) -> sqlite3.Connection:
        """打开一个新连接并启用行名访问，由调用方负责关闭。"""

        connection = sqlite3.connect(self.database_path, timeout=30.0)
        connection.row_factory = sqlite3.Row
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
        """按当前版本创建缺失的配置表、卫星数量表和模式版本记录，并清理旧的单例记录。"""

        with self._lock, self._session() as connection:
            for statement in _SCHEMA_STATEMENTS:
                connection.execute(statement)
            # 旧版本的总体卫星数量与旧键名整流舱段记录不再参与读取，删除以避免残留误导。
            connection.execute(
                "DELETE FROM pre_config_values WHERE config_key IN (?, ?)",
                (LEGACY_SATELLITE_COUNT_KEY, LEGACY_CYLINDER_KEY),
            )
            connection.execute(f"PRAGMA user_version = {SCHEMA_VERSION}")

    def _write_value(self, key: str, payload: str) -> None:
        """覆盖写入一个配置项，并记录最后一次写入时间。"""

        with self._lock, self._session() as connection:
            connection.execute(
                """
                INSERT INTO pre_config_values (config_key, value_json, updated_at) VALUES (?, ?, ?)
                ON CONFLICT(config_key) DO UPDATE SET value_json = excluded.value_json,
                    updated_at = excluded.updated_at
                """,
                (key, payload, current_timestamp()),
            )

    def _read_value(self, key: str) -> tuple[str, str] | None:
        """读取一个配置项的原始 JSON 文本与写入时间，缺失时返回空。"""

        with self._lock, self._session() as connection:
            row = connection.execute(
                "SELECT value_json, updated_at FROM pre_config_values WHERE config_key = ?", (key,)
            ).fetchone()
        return (row["value_json"], row["updated_at"]) if row is not None else None

    def list_satellite_counts(self, record_ids: list[str]) -> list[dict]:
        """返回给定卫星类型的数量清单，未保存过的类型按 0 颗处理。

        参数：
            record_ids: 数据管理页的固化记录标识，按传入顺序返回。
        返回：
            每项含 `record_id`、`count`、`updated_at` 和 `stored` 的列表。
        """

        unique_ids = [item for item in dict.fromkeys(record_ids) if isinstance(item, str) and item]
        if not unique_ids:
            return []
        with self._lock, self._session() as connection:
            rows = connection.execute(
                f"SELECT record_id, satellite_count, updated_at FROM pre_config_satellite_counts "
                f"WHERE record_id IN ({','.join('?' * len(unique_ids))})",
                unique_ids,
            ).fetchall()
        stored = {row["record_id"]: row for row in rows}
        return [
            {
                "record_id": record_id,
                "count": int(stored[record_id]["satellite_count"]) if record_id in stored else 0,
                "updated_at": stored[record_id]["updated_at"] if record_id in stored else None,
                "stored": record_id in stored,
            }
            for record_id in unique_ids
        ]

    def save_satellite_count(self, record_id: object, value: object) -> dict:
        """校验并覆盖保存某一类卫星的数量。

        参数：
            record_id: 数据管理页的固化记录标识。
            value: 卫星数量，必须为范围内整数。
        返回：
            与 `list_satellite_counts` 单项结构一致的保存结果。
        异常：
            PreConfigError: 标识为空、取值不是整数或超出统一配置允许的范围。
        """

        normalized_id = _coerce_record_id(record_id)
        count = _coerce_integer(value, "卫星数量")
        if count < self.minimum_satellite_count or count > self.maximum_satellite_count:
            raise PreConfigError(
                f"卫星数量必须在 {self.minimum_satellite_count} 至 {self.maximum_satellite_count} 之间"
            )
        with self._lock, self._session() as connection:
            connection.execute(
                """
                INSERT INTO pre_config_satellite_counts (record_id, satellite_count, updated_at)
                VALUES (?, ?, ?)
                ON CONFLICT(record_id) DO UPDATE SET satellite_count = excluded.satellite_count,
                    updated_at = excluded.updated_at
                """,
                (normalized_id, count, current_timestamp()),
            )
        return self.list_satellite_counts([normalized_id])[0]

    def prune_satellite_counts(self, record_ids: list[str]) -> int:
        """删除已不在数据管理页中的卫星数量记录，返回删除数量。

        参数：
            record_ids: 当前仍然存在的固化记录标识。
        """

        known = [item for item in record_ids if isinstance(item, str) and item]
        with self._lock, self._session() as connection:
            if known:
                placeholders = ",".join("?" * len(known))
                deleted = connection.execute(
                    f"DELETE FROM pre_config_satellite_counts WHERE record_id NOT IN ({placeholders})",
                    known,
                ).rowcount
            else:
                deleted = connection.execute("DELETE FROM pre_config_satellite_counts").rowcount
        return int(deleted)

    def get_fairing_segment(self) -> dict:
        """返回已保存的自定义整流舱段参数区间；旧单值记录会兼容为两端相等的区间。"""

        record = self._read_value(FAIRING_SEGMENT_KEY)
        if record is None:
            radius = float(runtime_config.default_cylinder_radius_mm)
            height = float(runtime_config.default_cylinder_height_mm)
            return {
                "min_radius_mm": radius,
                "max_radius_mm": radius,
                "min_height_mm": height,
                "max_height_mm": height,
                "axis_radius_mm": self._default_axis_radius(radius),
                "fairing_radius_mm": self._default_fairing_radius(radius),
                "radial_segments": self.radial_segments,
                "updated_at": None,
                "stored": False,
            }
        try:
            payload = json.loads(record[0])
            legacy_radius = payload.get("radius_mm")
            legacy_height = payload.get("height_mm")
            min_radius = float(payload.get("min_radius_mm", legacy_radius))
            max_radius = float(payload.get("max_radius_mm", legacy_radius))
            min_height = float(payload.get("min_height_mm", legacy_height))
            max_height = float(payload.get("max_height_mm", legacy_height))
            self._validate_fairing_interval(min_radius, max_radius, min_height, max_height)
            segments = int(payload.get("radial_segments") or self.radial_segments)
            axis_radius = self.normalize_axis_radius(payload.get("axis_radius_mm"), min_radius)
            fairing_radius = self._read_fairing_radius(payload, min_radius, max_radius)
        except (TypeError, ValueError, KeyError) as error:
            raise PreConfigError("已保存的整流舱段参数记录已损坏，请重新保存") from error
        return {
            "min_radius_mm": min_radius,
            "max_radius_mm": max_radius,
            "min_height_mm": min_height,
            "max_height_mm": max_height,
            "axis_radius_mm": axis_radius,
            "fairing_radius_mm": fairing_radius,
            "radial_segments": segments,
            "updated_at": record[1],
            "stored": True,
        }

    def _default_axis_radius(self, cylinder_radius: float) -> float:
        """返回可用的默认中轴半径，默认值不小于圆柱半径时收敛为圆柱半径的一半。"""

        configured = max(float(runtime_config.default_axis_radius_mm), self.minimum_axis_radius_mm)
        return configured if configured < cylinder_radius else cylinder_radius / 2.0

    def normalize_axis_radius(self, value: object, cylinder_radius: float) -> float:
        """校验中轴半径：必须是正的有限数值且严格小于圆柱半径。

        参数：
            value: 中轴半径；历史记录缺省时回落到默认值。
            cylinder_radius: 圆柱段底面半径，单位为毫米。
        返回：
            可用的中轴半径，单位为毫米。
        异常：
            PreConfigError: 取值非法或不小于圆柱半径。
        """

        if value is None:
            return self._default_axis_radius(cylinder_radius)
        if isinstance(value, bool):
            raise PreConfigError("中轴半径必须是正的有限数值")
        try:
            radius = float(value)
        except (TypeError, ValueError) as error:
            raise PreConfigError("中轴半径必须是正的有限数值") from error
        if not math.isfinite(radius) or radius < self.minimum_axis_radius_mm:
            raise PreConfigError(f"中轴半径必须是大于等于 {self.minimum_axis_radius_mm} 毫米的有限数值")
        if radius >= cylinder_radius:
            raise PreConfigError("中轴半径必须小于整流舱段底面半径")
        return radius

    def _default_fairing_radius(self, cylinder_max_radius: float) -> float:
        """返回大于整流舱最大半径且位于统一配置范围内的默认整流罩半径。

        参数：
            cylinder_max_radius: 整流舱底面半径区间最大值，单位为毫米。
        返回：
            可直接用于预览的整流罩半径，单位为毫米。
        异常：
            PreConfigError: 整流舱最大半径已使统一上限内不存在合法整流罩半径。
        """

        margin = max(self.minimum_fairing_shell_radius_mm, 1e-9)
        radius = max(float(runtime_config.default_fairing_shell_radius_mm), cylinder_max_radius + margin)
        if radius > self.maximum_fairing_size_mm:
            raise PreConfigError("整流舱底面半径最大值过大，统一上限内无法设置更大的整流罩半径")
        return radius

    def _read_fairing_radius(self, payload: dict, min_radius: float, max_radius: float) -> float:
        """读取当前整流罩半径，并把历史径向净距记录转换为直接半径。

        参数：
            payload: 数据库中解析出的整流舱参数字典。
            min_radius: 整流舱底面半径区间最小值。
            max_radius: 整流舱底面半径区间最大值。
        返回：
            合法的整流罩半径；历史净距按“最小半径 + 净距”转换，过小时收敛到合法默认值。
        """

        value = payload.get("fairing_radius_mm")
        if value is None and payload.get("radial_clearance_mm") is not None:
            value = min_radius + float(payload["radial_clearance_mm"])
            if value <= max_radius:
                return self._default_fairing_radius(max_radius)
        return self.normalize_fairing_radius(value, max_radius)

    def normalize_fairing_radius(self, value: object, cylinder_max_radius: float) -> float:
        """校验整流罩半径必须为有限正数且严格大于整流舱最大半径。

        参数：
            value: 整流罩半径，单位为毫米；历史记录缺省时回落到统一配置默认值。
            cylinder_max_radius: 整流舱底面半径区间最大值，单位为毫米。
        返回：
            合法的整流罩半径，单位为毫米。
        异常：
            PreConfigError: 取值非法、越界或不大于整流舱最大半径。
        """

        if value is None:
            return self._default_fairing_radius(cylinder_max_radius)
        if isinstance(value, bool):
            raise PreConfigError("整流罩半径必须是正的有限数值")
        try:
            radius = float(value)
        except (TypeError, ValueError) as error:
            raise PreConfigError("整流罩半径必须是正的有限数值") from error
        if (
            not math.isfinite(radius)
            or radius < self.minimum_fairing_shell_radius_mm
            or radius > self.maximum_fairing_size_mm
        ):
            raise PreConfigError(
                f"整流罩半径必须在 {self.minimum_fairing_shell_radius_mm} "
                f"至 {self.maximum_fairing_size_mm} 毫米之间"
            )
        if radius <= cylinder_max_radius:
            raise PreConfigError("整流罩半径必须大于整流舱段底面半径最大值")
        return radius

    def save_fairing_segment(
        self,
        min_radius_mm: object,
        max_radius_mm: object,
        min_height_mm: object,
        max_height_mm: object,
        axis_radius_mm: object = None,
        fairing_radius_mm: object = None,
    ) -> dict:
        """校验并覆盖保存整流舱段尺寸区间、中轴半径与整流罩半径。

        参数：
            min_radius_mm: 底面半径区间最小值，单位为毫米，必须为正数。
            max_radius_mm: 底面半径区间最大值，单位为毫米，必须不小于最小值。
            min_height_mm: 高度区间最小值，单位为毫米，必须为正数。
            max_height_mm: 高度区间最大值，单位为毫米，必须不小于最小值。
            axis_radius_mm: 可选中轴（中心杆）半径；缺省时沿用已保存的值，从未保存过则用默认值。
            fairing_radius_mm: 可选整流罩半径；缺省时沿用已保存值，从未保存过则用默认值。
        返回：
            含尺寸区间、中轴半径、整流罩半径、圆周分段与存储状态的字典。
        异常：
            PreConfigError: 尺寸、中轴半径或整流罩半径不是统一配置允许的值。
        """

        min_radius = _coerce_positive(min_radius_mm, "整流舱段底面半径最小值")
        max_radius = _coerce_positive(max_radius_mm, "整流舱段底面半径最大值")
        min_height = _coerce_positive(min_height_mm, "整流舱段高度最小值")
        max_height = _coerce_positive(max_height_mm, "整流舱段高度最大值")
        self._validate_fairing_interval(min_radius, max_radius, min_height, max_height)
        current = self.get_fairing_segment()
        axis_radius = (
            current["axis_radius_mm"] if axis_radius_mm is None
            else self.normalize_axis_radius(axis_radius_mm, min_radius)
        )
        if fairing_radius_mm is None:
            inherited_fairing_radius = current["fairing_radius_mm"]
            fairing_radius = (
                inherited_fairing_radius
                if inherited_fairing_radius > max_radius
                else self._default_fairing_radius(max_radius)
            )
        else:
            fairing_radius = self.normalize_fairing_radius(fairing_radius_mm, max_radius)
        # 圆柱半径缩小时，沿用下来的中轴半径可能不再合法，此时回落到默认值。
        if axis_radius >= min_radius:
            axis_radius = self._default_axis_radius(min_radius)
        self._write_value(
            FAIRING_SEGMENT_KEY,
            json.dumps({
                "min_radius_mm": min_radius,
                "max_radius_mm": max_radius,
                "min_height_mm": min_height,
                "max_height_mm": max_height,
                "axis_radius_mm": axis_radius,
                "fairing_radius_mm": fairing_radius,
                "radial_segments": self.radial_segments,
            }),
        )
        return self.get_fairing_segment()

    def _validate_fairing_interval(
        self,
        min_radius: float,
        max_radius: float,
        min_height: float,
        max_height: float,
    ) -> None:
        """校验整流舱段半径和高度区间的边界范围及端点顺序。

        参数：
            min_radius: 底面半径最小值，单位为毫米。
            max_radius: 底面半径最大值，单位为毫米。
            min_height: 高度最小值，单位为毫米。
            max_height: 高度最大值，单位为毫米。
        异常：
            PreConfigError: 任一端点越界或最小值大于最大值。
        """

        if min_radius < self.minimum_fairing_radius_mm or max_radius > self.maximum_fairing_size_mm:
            raise PreConfigError(
                f"整流舱段底面半径区间必须在 {self.minimum_fairing_radius_mm} "
                f"至 {self.maximum_fairing_size_mm} 毫米之间"
            )
        if min_height < self.minimum_fairing_height_mm or max_height > self.maximum_fairing_size_mm:
            raise PreConfigError(
                f"整流舱段高度区间必须在 {self.minimum_fairing_height_mm} "
                f"至 {self.maximum_fairing_size_mm} 毫米之间"
            )
        if min_radius > max_radius:
            raise PreConfigError("整流舱段底面半径最小值不得大于最大值")
        if min_height > max_height:
            raise PreConfigError("整流舱段高度最小值不得大于最大值")

    def get_limits(self) -> dict:
        """返回前端表单直接使用的取值范围约束。"""

        return {
            "min_satellite_count": self.minimum_satellite_count,
            "max_satellite_count": self.maximum_satellite_count,
            "min_fairing_radius_mm": self.minimum_fairing_radius_mm,
            "min_fairing_height_mm": self.minimum_fairing_height_mm,
            "max_fairing_size_mm": self.maximum_fairing_size_mm,
            "min_axis_radius_mm": self.minimum_axis_radius_mm,
            "min_fairing_shell_radius_mm": self.minimum_fairing_shell_radius_mm,
        }


def _coerce_record_id(value: object) -> str:
    """把输入转换为非空的固化记录标识。"""

    if not isinstance(value, str) or not value.strip():
        raise PreConfigError("卫星类型标识必须是数据管理页中的固化记录标识")
    return value.strip()


def _coerce_integer(value: object, label: str) -> int:
    """把输入转换为整数，拒绝布尔值、小数和无法解析的内容。"""

    if isinstance(value, bool):
        raise PreConfigError(f"{label}必须是整数")
    if isinstance(value, int):
        return value
    if isinstance(value, float):
        if not math.isfinite(value) or value != int(value):
            raise PreConfigError(f"{label}必须是整数")
        return int(value)
    if isinstance(value, str) and value.strip():
        try:
            return int(value.strip())
        except ValueError as error:
            raise PreConfigError(f"{label}必须是整数") from error
    raise PreConfigError(f"{label}必须是整数")


def current_timestamp() -> str:
    """返回 UTC ISO-8601 时间戳，供前置配置记录写入。"""

    return datetime.now(timezone.utc).isoformat()


def _coerce_positive(value: object, label: str) -> float:
    """把输入转换为有限正浮点数，拒绝其他内容。"""

    if isinstance(value, bool):
        raise PreConfigError(f"{label}必须是正的有限数值")
    try:
        number = float(value)
    except (TypeError, ValueError) as error:
        raise PreConfigError(f"{label}必须是正的有限数值") from error
    if not math.isfinite(number) or number <= 0:
        raise PreConfigError(f"{label}必须是正的有限数值")
    return number
