"""
文件说明：提供模型与包络固化存储的写入、查询、资源下载和删除接口。
路由只负责 HTTP 映射与错误转换，快照组装、资源暂存和 SQLite 读写均委托给固化存储服务。
"""

from fastapi import APIRouter, HTTPException, Query
from fastapi.responses import FileResponse, Response

from app.domain.model_store import DEFAULT_PAGE_SIZE, MAXIMUM_PAGE_SIZE, ModelStoreError
from app.domain.model_store_service import EnvelopeNotReadyError, ModelMissingError, ModelStoreService
from app.schemas.model_store import ModelStoreBatchDeletePayload, ModelStorePayload


router = APIRouter(prefix="/api/store", tags=["store"])
_service: ModelStoreService | None = None


def get_service() -> ModelStoreService:
    """返回进程内共享的固化存储服务，首次调用时才创建数据库与目录。"""

    global _service
    if _service is None:
        from app.api.routes.model_upload import service as model_upload_service

        _service = ModelStoreService(model_upload_service)
    return _service


def _handle_error(error: Exception) -> None:
    """把固化领域异常转换为稳定的 HTTP 错误。"""

    if isinstance(error, (LookupError, ModelMissingError)):
        raise HTTPException(status_code=404, detail=str(error)) from error
    if isinstance(error, (ModelStoreError, EnvelopeNotReadyError)):
        raise HTTPException(status_code=409, detail=str(error)) from error
    raise HTTPException(status_code=400, detail=str(error)) from error


@router.post("/models", status_code=201)
def save_model_to_store(payload: ModelStorePayload) -> dict:
    """把已上传模型当前的设置、STEP 原件与正式包络固化为一条存储记录。"""

    try:
        return {"record": get_service().save_model_snapshot(payload.model_id, payload.record_name)}
    except (LookupError, ModelStoreError, EnvelopeNotReadyError, ValueError, OSError) as error:
        _handle_error(error)


@router.get("/models")
def list_stored_models(
    limit: int = Query(default=DEFAULT_PAGE_SIZE, ge=1, le=MAXIMUM_PAGE_SIZE),
    offset: int = Query(default=0, ge=0),
    keyword: str | None = Query(default=None, max_length=200),
) -> dict:
    """按固化时间倒序分页返回存储记录摘要，并给出总数和存储统计。"""

    return {**get_service().list_records(limit, offset, keyword), "summary": get_service().get_summary()}


@router.post("/models/batch-delete")
def batch_delete_stored_models(payload: ModelStoreBatchDeletePayload) -> dict:
    """批量删除勾选的固化记录与资源，并返回实际删除数量。"""

    return {"deleted": get_service().delete_records(payload.ids)}


@router.get("/models/{record_id}")
def get_stored_model(record_id: str) -> dict:
    """返回一条存储记录的完整信息，包含模型设置、包络元数据和基础包络文件。"""

    try:
        return {"record": get_service().get_record(record_id)}
    except LookupError as error:
        _handle_error(error)


@router.get("/sources/{model_id}")
def get_source_storage_state(model_id: str) -> dict:
    """返回指定已上传模型是否已固化以及最近一次固化的摘要。"""

    return get_service().model_storage_state(model_id)


@router.get("/models/{record_id}/source")
def download_stored_source(record_id: str) -> FileResponse:
    """下载固化记录中作为最终数据源的 STEP 原件。"""

    try:
        path = get_service().get_source_path(record_id)
    except (LookupError, OSError) as error:
        _handle_error(error)
    return FileResponse(path, media_type="application/step", filename=path.name)


@router.get("/models/{record_id}/envelope/preview.glb")
def preview_stored_envelope(record_id: str) -> FileResponse:
    """返回固化记录中与源模型共用局部坐标的包络浏览网格。"""

    try:
        path = get_service().get_envelope_preview_path(record_id)
    except (LookupError, OSError) as error:
        _handle_error(error)
    return FileResponse(path, media_type="model/gltf-binary", headers={"Cache-Control": "private, max-age=3600"})


@router.get("/models/{record_id}/variants/{rot_z}")
def download_stored_variant(record_id: str, rot_z: int) -> Response:
    """按方向角下载固化包络的正式网格文件。"""

    try:
        path = get_service().get_variant_path(record_id, rot_z)
    except (LookupError, OSError) as error:
        _handle_error(error)
    return FileResponse(path, media_type="application/octet-stream", filename=path.name)


@router.delete("/models/{record_id}", status_code=204)
def delete_stored_model(record_id: str) -> None:
    """删除一条存储记录及其固化资源，不影响原始模型和包络产物。"""

    try:
        get_service().delete_record(record_id)
    except LookupError as error:
        _handle_error(error)
