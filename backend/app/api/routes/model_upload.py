"""
文件说明：提供模型上传、曲面安装基准、六向包络增量、包络生成与预览、双 LOD 资源及删除接口。
路由只负责 HTTP 映射，格式校验、存储和派生任务均委托给模型领域服务。
"""

from uuid import uuid4

from fastapi import APIRouter, File, HTTPException, Request, Response, UploadFile
from fastapi.responses import FileResponse

from app.domain.model_upload_service import (
    PREVIEW_RUNTIME_CACHE_MAGIC,
    PREVIEW_RUNTIME_CACHE_MEDIA_TYPE,
    ModelUploadService,
)
from app.schemas.model_upload import ModelBatchDeletePayload, ModelSettingsPayload


router = APIRouter(prefix="/api/models", tags=["models"])
service = ModelUploadService()


def _handle_error(error: Exception) -> None:
    """把领域层的查找和输入异常转换为稳定的 HTTP 错误。"""

    if isinstance(error, LookupError):
        raise HTTPException(status_code=404, detail=str(error)) from error
    raise HTTPException(status_code=400, detail=str(error)) from error


@router.get("")
def list_models() -> dict:
    """返回所有已上传模型及 GLB/面映射生成状态。"""

    return {"models": service.list_models()}


@router.post("", status_code=201)
def upload_model(file: UploadFile = File(...)) -> dict:
    """接收一个 STEP/STP 原始模型；派生产物在首次预览请求时生成。"""

    try:
        return {"model": service.save_upload(file.filename, file.file)}
    except (ValueError, TypeError, OSError) as error:
        _handle_error(error)
    finally:
        file.file.close()


@router.get("/{model_id}/file")
def download_model(model_id: str) -> FileResponse:
    """下载作为最终数据源的 STEP/STP 原始模型。"""

    try:
        path = service.get_file_path(model_id)
    except (LookupError, OSError) as error:
        _handle_error(error)
    return FileResponse(path, media_type="application/step", filename=path.name)


@router.get("/{model_id}/settings")
def get_model_settings(model_id: str) -> dict:
    """返回指定模型当前保存的设备、变换、质心、安装面/点和六向包络增量。"""

    try:
        return {"settings": service.get_model_settings(model_id)}
    except (LookupError, ValueError, OSError) as error:
        _handle_error(error)


@router.put("/{model_id}/settings")
def update_model_settings(model_id: str, payload: ModelSettingsPayload) -> dict:
    """持久化模型设置，并返回由后端重新判定的包络有效状态。"""

    try:
        excluded = {"safety_clearance_mm"} if "safety_clearance_mm" not in payload.model_fields_set else set()
        settings = service.update_model_settings(model_id, payload.model_dump(exclude=excluded))
        return {
            "settings": settings,
            "envelope": service.get_model_envelope_status(model_id),
        }
    except (LookupError, ValueError, OSError) as error:
        _handle_error(error)


@router.post("/{model_id}/envelope", status_code=202)
def generate_model_envelope(model_id: str) -> dict:
    """把指定模型的基础包络生成提交到后端后台任务。"""

    try:
        return {"task": service.start_model_envelope_task(model_id)}
    except (LookupError, ValueError, OSError, RuntimeError) as error:
        _handle_error(error)


@router.post("/envelopes/generate-all", status_code=202)
def generate_all_model_envelopes() -> dict:
    """把全部已上传模型的包络生成提交到后端后台任务。"""

    try:
        return {"task": service.start_all_model_envelopes_task()}
    except (ValueError, OSError, RuntimeError) as error:
        _handle_error(error)


@router.get("/envelopes/task")
def get_latest_envelope_task() -> dict:
    """返回后端持有的最新包络任务，供页面切换或刷新后恢复状态。"""

    return {"task": service.get_latest_envelope_task()}


@router.get("/{model_id}/envelope/preview.glb")
def preview_envelope(model_id: str) -> Response:
    """返回已有安全包络的浏览网格，与源模型共用局部坐标；失效时拒绝返回旧资源。"""

    try:
        content = service.get_model_envelope_preview(model_id)
    except (LookupError, ValueError, OSError) as error:
        _handle_error(error)
    return Response(content, media_type="model/gltf-binary", headers={"Cache-Control": "private, no-store"})


@router.get("/{model_id}/preview-manifest")
def preview_manifest(model_id: str) -> dict:
    """返回浏览器加载细节 GLB 和外壳面映射所需的兼容清单。"""

    try:
        return service.get_preview_manifest(model_id)
    except (LookupError, ValueError, OSError) as error:
        _handle_error(error)


@router.get("/{model_id}/preview-interaction-manifest")
def preview_interaction_manifest(model_id: str) -> dict:
    """返回优先加载的轻量交互 GLB 清单。"""

    try:
        return service.get_interaction_manifest(model_id)
    except (LookupError, ValueError, OSError) as error:
        _handle_error(error)


@router.get("/{model_id}/preview.glb")
def preview_glb(model_id: str) -> FileResponse:
    """返回用于静态显示、外壳面拾取和快速计算的细节 GLB。"""

    try:
        path = service.get_artifact_path(model_id, "glb")
    except (LookupError, ValueError, OSError) as error:
        _handle_error(error)
    return FileResponse(path, media_type="model/gltf-binary", headers={"Cache-Control": "private, max-age=31536000"})


@router.get("/{model_id}/preview-interaction.glb")
def preview_interaction_glb(model_id: str) -> FileResponse:
    """返回旋转、平移和缩放期间使用的轻量交互 GLB。"""

    try:
        path = service.get_artifact_path(model_id, "interaction_glb")
    except (LookupError, ValueError, OSError) as error:
        _handle_error(error)
    return FileResponse(path, media_type="model/gltf-binary", headers={"Cache-Control": "private, max-age=31536000"})


@router.get("/{model_id}/face-map")
def face_mapping(model_id: str) -> FileResponse:
    """返回把细节 GLB 外壳三角形范围关联到 STEP 面的 JSON 映射表。"""

    try:
        path = service.get_artifact_path(model_id, "mapping")
    except (LookupError, ValueError, OSError) as error:
        _handle_error(error)
    return FileResponse(path, media_type="application/json", headers={"Cache-Control": "private, max-age=31536000"})


@router.get("/{model_id}/preview-runtime-cache")
def preview_runtime_cache(model_id: str) -> FileResponse:
    """返回与当前双 LOD 匹配的浏览器已合并预览缓存；缓存缺失或失效时返回 404。"""

    try:
        path = service.get_preview_runtime_cache_path(model_id)
    except (LookupError, OSError) as error:
        _handle_error(error)
    if path is None:
        raise HTTPException(status_code=404, detail="预览运行时缓存不存在或已失效")
    return FileResponse(path, media_type=PREVIEW_RUNTIME_CACHE_MEDIA_TYPE, headers={"Cache-Control": "private, no-store"})


@router.put("/{model_id}/preview-runtime-cache", status_code=204)
async def save_preview_runtime_cache(model_id: str, request: Request) -> Response:
    """流式写入浏览器已合并预览缓存，并在写入期间校验体积、文件头和产物版本。"""

    content_type = request.headers.get("content-type", "").partition(";")[0].lower()
    if content_type != PREVIEW_RUNTIME_CACHE_MEDIA_TYPE:
        raise HTTPException(status_code=415, detail="预览运行时缓存格式不受支持")
    maximum_bytes = service.get_preview_runtime_cache_limit()
    content_length = request.headers.get("content-length")
    if content_length and content_length.isdigit() and int(content_length) > maximum_bytes:
        raise HTTPException(status_code=413, detail=f"预览运行时缓存不能超过 {maximum_bytes // (1024 * 1024)} MB")

    temporary_path = None
    try:
        cache_path, signature = service.prepare_preview_runtime_cache_write(model_id)
        temporary_path = cache_path.with_name(f".{cache_path.name}.{uuid4().hex}.tmp")
        bytes_written = 0
        prefix = bytearray()
        with temporary_path.open("xb") as destination:
            async for chunk in request.stream():
                if not chunk:
                    continue
                bytes_written += len(chunk)
                if bytes_written > maximum_bytes:
                    raise HTTPException(status_code=413, detail=f"预览运行时缓存不能超过 {maximum_bytes // (1024 * 1024)} MB")
                if len(prefix) < len(PREVIEW_RUNTIME_CACHE_MAGIC):
                    prefix.extend(chunk[:len(PREVIEW_RUNTIME_CACHE_MAGIC) - len(prefix)])
                destination.write(chunk)
        if bytes(prefix) != PREVIEW_RUNTIME_CACHE_MAGIC:
            raise HTTPException(status_code=400, detail="预览运行时缓存文件无效")
        service.publish_preview_runtime_cache(model_id, temporary_path, signature)
    except HTTPException:
        raise
    except (LookupError, ValueError, OSError) as error:
        _handle_error(error)
    finally:
        if temporary_path is not None:
            temporary_path.unlink(missing_ok=True)
    return Response(status_code=204)


@router.delete("/{model_id}", status_code=204)
def delete_model(model_id: str) -> None:
    """删除指定模型的源文件与全部可重建派生产物。"""

    try:
        service.delete_model(model_id)
    except LookupError as error:
        _handle_error(error)


@router.post("/batch-delete")
def batch_delete_models(payload: ModelBatchDeletePayload) -> dict:
    """批量删除模型并返回实际删除数量。"""

    return {"deleted": service.delete_models(payload.ids)}
