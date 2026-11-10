"""
文件说明：提供前置配置的卫星数量、软硬对称与整流舱段接口，包括配置读写与构件构建。
路由只负责 HTTP 映射与错误转换；基座与罩体分别解析，构建与持久化复用同一组规范参数。
前置配置页不提供构件下载入口：整流舱段 STEP 仅作为后续布局阶段的内部产物。
"""

from fastapi import APIRouter, HTTPException

from app.api.routes.model_store import get_service as get_store_service
from app.domain.fairing_segment import FairingSegmentError, FairingSegmentService, normalize_fairing_profile
from app.domain.pre_config_store import PreConfigError, PreConfigStore
from app.domain.installation_tube import normalize_installation_base
from app.schemas.pre_config import FairingSegmentPayload, SatelliteCountPayload, SatelliteSymmetryPayload


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
        每项含模型标识、名称、数量、保存时间、`stored`、`symmetry_enabled` 和 `symmetry_mode`。
    异常：
        PreConfigError: 已保存的数量记录损坏。
    """

    records = []
    while True:
        page = get_store_service().list_records(limit=500, offset=len(records))
        records.extend(page["records"])
        if not page["records"] or len(records) >= page["total"]:
            break
    counts = {item["record_id"]: item for item in get_store().list_satellite_counts([item["record_id"] for item in records])}
    symmetry = get_store().list_satellite_symmetry_settings([item["record_id"] for item in records])
    return [
        {
            "record_id": record["record_id"],
            "device_name": record["device_name"],
            "created_at": record["created_at"],
            "count": counts[record["record_id"]]["count"],
            "updated_at": counts[record["record_id"]]["updated_at"],
            "stored": counts[record["record_id"]]["stored"],
            **symmetry[record["record_id"]],
        }
        for record in records
    ]


@router.get("/config")
def get_pre_config() -> dict:
    """返回按类型区分的卫星数量、自定义整流舱段参数与前端表单需要的取值范围约束。

    副作用：
        清理已不在数据管理页中的历史卫星数量与对称设置，避免随删除操作持续增长。
    """

    store = get_store()
    satellites = _list_satellite_types()
    store.prune_satellite_counts([item["record_id"] for item in satellites])
    store.prune_satellite_symmetry([item["record_id"] for item in satellites])
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


@router.put("/satellite-symmetry")
def save_satellite_symmetry(payload: SatelliteSymmetryPayload) -> dict:
    """保存已存在类型的对称开关和软硬模式；未知类型返回 404，成功返回完整卫星配置。"""
    satellite = next((item for item in _list_satellite_types() if item["record_id"] == payload.record_id), None)
    if satellite is None:
        raise HTTPException(status_code=404, detail="找不到指定的卫星类型，请先在数据管理页存储该模型")
    try:
        get_store().save_satellite_symmetry(payload.record_id, payload.enabled, payload.mode)
    except PreConfigError as error:
        _handle_error(error)
    return {"satellite": {**satellite, "symmetry_enabled": payload.enabled, "symmetry_mode": payload.mode}}


@router.put("/fairing-segment")
def save_custom_fairing_segment(payload: FairingSegmentPayload) -> dict:
    """保存整流罩外形、内部安装筒参数和整流罩边界，并返回 B-Rep 描述。"""

    store = get_store()
    try:
        installation = _installation_values(payload)
        geometry = _build_fairing_segment(payload, installation)
        return {
            "fairing_segment": store.save_fairing_segment(
                installation["min_radius_mm"],
                installation["max_radius_mm"],
                installation["min_height_mm"],
                installation["max_height_mm"],
                centroid_max_offset_mm=installation["centroid_max_offset_mm"],
                fairing_radius_mm=geometry["fairing_radius_mm"],
                fairing_profile=geometry["fairing_profile"],
                installation_base=geometry["installation_tube"].get("base"),
            ),
            "geometry": geometry,
        }
    except (PreConfigError, FairingSegmentError) as error:
        _handle_error(error)


def _build_fairing_segment(payload: FairingSegmentPayload, installation: dict) -> dict:
    """核对内部安装筒、整流罩外形和外部边界后构建 B-Rep。

    参数：
        payload: 已通过 Pydantic 类型校验的整流罩及安装筒参数。
        installation: 本次请求已解析的安装筒尺寸与质心偏移。
    返回：
        整流舱段构件的公开描述，含体积、包围盒、整流罩半径与 STEP 文件信息。
    异常：
        PreConfigError: 尺寸、中轴半径或整流罩半径超出统一配置允许的范围。
        FairingSegmentError: 几何构建或导出失败。
    """

    store = get_store()
    limits = store.get_limits()
    min_radius = installation["min_radius_mm"]
    max_radius = installation["max_radius_mm"]
    min_height = installation["min_height_mm"]
    max_height = installation["max_height_mm"]
    centroid_offset = installation["centroid_max_offset_mm"]
    if (min_radius < limits["min_fairing_radius_mm"] or min_height < limits["min_fairing_height_mm"]
            or max_radius > limits["max_fairing_size_mm"] or max_height > limits["max_fairing_size_mm"]):
        raise PreConfigError("整流舱段尺寸区间超出统一配置允许范围")
    if min_radius > max_radius:
        raise PreConfigError("安装筒半径最小值不得大于最大值")
    if min_height > max_height:
        raise PreConfigError("安装筒高度最小值不得大于最大值")
    if (payload.installation_tube is None and payload.centroid_max_offset_mm is None
            and payload.axis_radius_mm is not None and payload.axis_radius_mm >= min_radius):
        raise PreConfigError("中轴半径必须小于安装筒半径最小值")
    if centroid_offset < limits["min_axis_radius_mm"] or centroid_offset >= min_radius:
        raise PreConfigError("质心最大偏移必须大于等于下限且小于安装筒半径最小值")
    profile = _payload_profile(payload, installation)
    normalized_profile = normalize_fairing_profile(profile, min_radius, min_height)
    effective_fairing_radius = store.normalize_fairing_radius(
        normalized_profile["max_radius_mm"] if payload.installation_tube is not None else payload.fairing_radius_mm,
        max_radius,
    )
    if effective_fairing_radius < normalized_profile["max_radius_mm"]:
        raise PreConfigError("整流罩边界不能小于组合外形的最大半径")
    try:
        base = normalize_installation_base(installation.get("base"), min_radius, max_radius,
                                           max_height, effective_fairing_radius, normalized_profile)
    except ValueError as error:
        raise PreConfigError(str(error)) from error
    installation["base"] = base
    geometry = get_fairing_service().build_fairing_segment(
        min_radius, min_height, centroid_offset, normalized_profile
    )
    cylinder_segment = next(
        (item for item in normalized_profile["segments"] if item["kind"] == "cylinder"),
        None,
    )
    return {
        **geometry,
        "preview_source": "interval_minimum",
        "fairing_radius_mm": effective_fairing_radius,
        "installation_tube": installation,
        "fairing_cylinder_radius_mm": cylinder_segment["radius_mm"] if cylinder_segment else None,
        "fairing_cylinder_height_mm": cylinder_segment["height_mm"] if cylinder_segment else None,
        "fairing_profile": normalized_profile,
    }


def _installation_values(payload: FairingSegmentPayload) -> dict:
    """统一读取新安装筒对象和旧版平铺字段，避免把安装筒尺寸当作整流罩外形。"""

    if payload.installation_tube is not None:
        values = payload.installation_tube.model_dump(exclude_none=True)
    else:
        offset = payload.centroid_max_offset_mm if payload.centroid_max_offset_mm is not None else payload.axis_radius_mm
        if offset is None:
            offset = float(get_store().get_fairing_segment().get("centroid_max_offset_mm", 1.0))
        values = {
            "min_radius_mm": payload.min_radius_mm,
            "max_radius_mm": payload.max_radius_mm,
            "min_height_mm": payload.min_height_mm,
            "max_height_mm": payload.max_height_mm,
            "centroid_max_offset_mm": offset,
        }
    try:
        result = {key: float(value) for key, value in values.items() if key != "base"}
    except (TypeError, ValueError) as error:
        raise PreConfigError("安装筒参数必须是数值") from error
    if any(not value > 0 for value in result.values()):
        raise PreConfigError("安装筒参数必须是正的有限数值")
    if "base" in values:
        result["base"] = values["base"]
    return result


def _payload_profile(payload: FairingSegmentPayload, installation: dict) -> dict:
    """把外形字段转换为组合形态，复用已解析安装筒，仅为旧请求补齐缺少的圆柱尺寸。"""

    common_radius = payload.fairing_cylinder_radius_mm
    if common_radius is None:
        common_radius = payload.lower_cone_upper_radius_mm or payload.upper_cone_lower_radius_mm
    if common_radius is None:
        common_radius = installation["min_radius_mm"]
    common_height = payload.fairing_cylinder_height_mm
    if common_height is None:
        common_height = installation["min_height_mm"]

    return {
        "form": payload.fairing_form,
        "cylinder": {
            "radius_mm": common_radius,
            "height_mm": common_height,
        },
        "lower_cone": {
            "lower_radius_mm": payload.lower_cone_lower_radius_mm,
            "upper_radius_mm": payload.lower_cone_upper_radius_mm or common_radius,
            "height_mm": payload.lower_cone_height_mm,
        },
        "upper_cone": {
            "lower_radius_mm": payload.upper_cone_lower_radius_mm or common_radius,
            "upper_radius_mm": payload.upper_cone_upper_radius_mm,
            "height_mm": payload.upper_cone_height_mm,
        },
    }
