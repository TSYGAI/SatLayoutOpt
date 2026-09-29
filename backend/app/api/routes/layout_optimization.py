"""文件说明：布局任务、历史重命名/删除、候选与导出 API；契约校验后委托领域服务执行。"""

from threading import Lock
from urllib.parse import quote

from fastapi import APIRouter, HTTPException, Query
from fastapi.responses import Response

from app.domain.layout_jobs import LayoutJobService
from app.schemas.layout_optimization import LayoutJobNamePayload, LayoutOptimizationPayload


router = APIRouter(prefix="/api/layout-optimization", tags=["layout-optimization"])
_service = None
_lock = Lock()


def get_service():
    """惰性取得线程安全的进程级布局服务；首次访问会初始化本地历史。"""
    global _service
    with _lock:
        if _service is None:
            _service = LayoutJobService()
        return _service


def shutdown_service():
    """仅在服务已创建时取消活动任务，避免退出时反而创建历史数据库。"""
    if _service is not None:
        _service.shutdown()


def invoke(method, *arguments):
    """执行领域查询/命令并转换已知异常；不吞掉内部异常。"""
    try:
        return method(*arguments)
    except LookupError as error:
        raise HTTPException(404, detail=str(error)) from error
    except ValueError as error:
        raise HTTPException(409, detail=str(error)) from error


@router.get("/config")
def get_config():
    """返回锁定卫星清单、前置尺寸、配置指纹及布局页可填写默认值。"""
    return get_service().config()


@router.post("/jobs", status_code=202)
def create_job(payload: LayoutOptimizationPayload):
    """创建无超时后台任务并立即返回排队状态；活动任务冲突返回 409。"""
    return invoke(get_service().start, payload)


@router.get("/jobs")
def list_jobs(limit: int = Query(50, ge=1, le=500), offset: int = Query(0, ge=0)):
    """分页读取布局历史摘要，便于左栏恢复原输入和已有结果。"""
    return get_service().history(limit, offset)


@router.get("/jobs/{job_id}")
def get_job(job_id: str):
    """读取任务输入、进度、最近记录及有效候选；取消终态保留取消前已验收的候选。"""
    return invoke(get_service().get, job_id)


@router.post("/jobs/{job_id}/cancel")
def cancel_job(job_id: str):
    """协作取消指定活动任务并在收尾后保留已验收候选；已完成任务保持不变。"""
    return invoke(get_service().cancel, job_id)


@router.put("/jobs/{job_id}/name")
def rename_job(job_id: str, payload: LayoutJobNamePayload):
    """持久化历史项目名称并返回完整任务；名称非法返回 422，任务不存在返回 404。"""
    return invoke(get_service().rename, job_id, payload.name)


@router.delete("/jobs/{job_id}", status_code=204)
def delete_job(job_id: str):
    """删除历史及任务快照，成功返回空响应；未知任务返回 404，运行中或清理失败返回 409。"""
    invoke(get_service().delete, job_id)
    return Response(status_code=204)


@router.get("/jobs/{job_id}/meshes")
def get_meshes(job_id: str):
    """返回任务自己的正式包络顶点和面，历史预览不依赖模型库后续变化。"""
    return invoke(get_service().meshes, job_id)


@router.get("/jobs/{job_id}/candidates/{candidate_id}/export")
def export_candidate(job_id: str, candidate_id: str):
    """下载当前指定方案的安装表；路径参数为任务/方案标识，404 表示不存在，409 表示无法可靠导出。"""
    content = invoke(get_service().export_candidate, job_id, candidate_id)
    filename = quote(f"layout-{job_id}-{candidate_id}.xlsx", safe="")
    return Response(content, media_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
                    headers={"Content-Disposition": f"attachment; filename*=UTF-8''{filename}", "Cache-Control": "no-store"})
