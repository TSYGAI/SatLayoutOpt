"""
文件说明：提供前置配置页的卫星类型数量与自定义整流舱段接口，包括配置读写与构件构建。
路由只负责 HTTP 映射与错误转换，参数校验、B-Rep 构建、数据管理页记录读取和 SQLite 读写分别委托给领域层。
前置配置页不提供构件下载入口：整流舱段 STEP 仅作为后续布局阶段的内部产物。
"""

from fastapi import APIRouter, HTTPException

from app.api.routes.model_store import get_service as get_store_service
from app.domain.fairing_segment import FairingSegmentError, FairingSegmentService
from app.domain.pre_config_store import PreConfigError, PreConfigStore
from app.schemas.pre_config import FairingSegmentPayload, SatelliteCountPayload


router = APIRouter(prefix="/api/pre-config", tags=["pre-config"])
_store: PreConfigStore | None = None
_fairings: FairingSegmentService | None = None


def get_store() -> PreConfigStore:
    """返回进程内共享的前置配置存储，首次调用时才创建数据库。"""

    global _store
    if _store is None:
        _store = PreConfigStore()
    return _store


def get_fairing_service() -> FairingSegmentService:
    """返回进程内共享的自定义整流舱段构件服务。"""

    global _fairings
    if _fairings is None:
        _fairings = FairingSegmentService()
    return _fairings


def _handle_error(error: Exception) -> None:
    """把前置配置领域异常转换为稳定的 HTTP 错误。"""

    if isinstance(error, LookupError):
        raise HTTPException(status_code=404, detail=str(error)) from error
    if isinstance(error, (PreConfigError, FairingSegmentError)):
        raise HTTPException(status_code=409, detail=str(error)) from error
    raise HTTPException(status_code=400, detail=str(error)) from error


def _list_satellite_types() -> list[dict]:
    """读取数据管理页的固化记录，并合并已保存的每类卫星数量。

    返回：
        每项含 `record_id`、`device_name`、`created_at`、`count`、`updated_at` 和 `stored` 的列表。
    异常：
        PreConfigError: 已保存的数量记录损坏。
    """

    records = get_store_service().list_records(limit=500, offset=0)["records"]
    counts = {item["record_id"]: item for item in get_store().list_satellite_counts([item["record_id"] for item in records])}
    return [
        {
            "record_id": record["record_id"],
            "device_name": record["device_name"],
            "created_at": record["created_at"],
            "count": counts[record["record_id"]]["count"],
            "updated_at": counts[record["record_id"]]["updated_at"],
            "stored": counts[record["record_id"]]["stored"],
        }
        for record in records
    ]


@router.get("/config")
def get_pre_config() -> dict:
    """返回按类型区分的卫星数量、自定义整流舱段参数与前端表单需要的取值范围约束。

    副作用：
        清理已不在数据管理页中的历史卫星数量记录，避免列表随删除操作持续增长。
    """

    store = get_store()
    satellites = _list_satellite_types()
    store.prune_satellite_counts([item["record_id"] for item in satellites])
    return {
        "satellites": satellites,
        "fairing_segment": store.get_fairing_segment(),
        "limits": store.get_limits(),
    }


@router.put("/satellite-count")
def save_satellite_count(payload: SatelliteCountPayload) -> dict:
    """保存某一类卫星的数量，返回更新后的该类记录。"""

    store = get_store()
    try:
        saved = store.save_satellite_count(payload.record_id, payload.value)
    except PreConfigError as error:
        _handle_error(error)
    satellite = next(
        (item for item in _list_satellite_types() if item["record_id"] == saved["record_id"]),
        None,
    )
    if satellite is None:
        raise HTTPException(status_code=404, detail="找不到指定的卫星类型，请先在数据管理页存储该模型")
    return {"satellite": satellite, "limits": store.get_limits()}


@router.put("/fairing-segment")
def save_custom_fairing_segment(payload: FairingSegmentPayload) -> dict:
    """保存整流舱段尺寸区间和整流罩半径，并返回按区间最小值构建的 B-Rep 描述。"""

    store = get_store()
    try:
        geometry = _build_fairing_segment(payload)
        return {
            "fairing_segment": store.save_fairing_segment(
                payload.min_radius_mm,
                payload.max_radius_mm,
                payload.min_height_mm,
                payload.max_height_mm,
                axis_radius_mm=payload.axis_radius_mm,
                fairing_radius_mm=payload.fairing_radius_mm,
            ),
            "geometry": geometry,
        }
    except (PreConfigError, FairingSegmentError) as error:
        _handle_error(error)


def _build_fairing_segment(payload: FairingSegmentPayload) -> dict:
    """核对尺寸区间、中轴半径与整流罩半径后，按两个最小值构建整流舱段 B-Rep。

    参数：
        payload: 已通过 Pydantic 类型校验的整流舱段尺寸区间与中轴半径。
    返回：
        整流舱段构件的公开描述，含体积、包围盒、整流罩半径与 STEP 文件信息。
    异常：
        PreConfigError: 尺寸、中轴半径或整流罩半径超出统一配置允许的范围。
        FairingSegmentError: 几何构建或导出失败。
    """

    store = get_store()
    limits = store.get_limits()
    if (
        payload.min_radius_mm < limits["min_fairing_radius_mm"]
        or payload.min_height_mm < limits["min_fairing_height_mm"]
        or payload.max_radius_mm > limits["max_fairing_size_mm"]
        or payload.max_height_mm > limits["max_fairing_size_mm"]
    ):
        raise PreConfigError("整流舱段尺寸区间超出统一配置允许范围")
    if payload.min_radius_mm > payload.max_radius_mm:
        raise PreConfigError("整流舱段底面半径最小值不得大于最大值")
    if payload.min_height_mm > payload.max_height_mm:
        raise PreConfigError("整流舱段高度最小值不得大于最大值")
    current = store.get_fairing_segment()
    if payload.axis_radius_mm is None:
        inherited_axis_radius = current["axis_radius_mm"]
        effective_axis_radius = (
            inherited_axis_radius
            if inherited_axis_radius < payload.min_radius_mm
            else store.normalize_axis_radius(None, payload.min_radius_mm)
        )
    else:
        effective_axis_radius = store.normalize_axis_radius(payload.axis_radius_mm, payload.min_radius_mm)
    effective_fairing_radius = store.normalize_fairing_radius(
        payload.fairing_radius_mm,
        payload.max_radius_mm,
    )
    geometry = get_fairing_service().build_fairing_segment(
        payload.min_radius_mm, payload.min_height_mm, effective_axis_radius
    )
    return {
        **geometry,
        "preview_source": "interval_minimum",
        "fairing_radius_mm": effective_fairing_radius,
    }
