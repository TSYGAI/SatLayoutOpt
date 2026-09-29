"""
文件说明：SatLayoutOpt FastAPI 入口，配置跨域、模型数据、前置配置及布局优化任务路由。
应用关闭时调用模型服务的统一清理入口，不在此文件实现领域业务。
"""

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from app.api.routes.model_store import router as model_store_router
from app.api.routes.model_upload import router as model_upload_router
from app.api.routes.model_upload import service as model_upload_service
from app.api.routes.pre_config import router as pre_config_router
from app.api.routes.layout_optimization import router as layout_router, shutdown_service as shutdown_layout_service
from app.core.config import runtime_config


app = FastAPI(title="SatLayoutOpt API", version="0.3.0")
app.add_middleware(
    CORSMiddleware,
    allow_origins=[
        f"http://{runtime_config.frontend_host}:{runtime_config.frontend_port}",
        f"http://localhost:{runtime_config.frontend_port}",
    ],
    allow_methods=["GET", "POST", "PUT", "DELETE", "OPTIONS"],
    allow_headers=["*"],
)
app.include_router(model_upload_router)
app.include_router(model_store_router)
app.include_router(pre_config_router)
app.include_router(layout_router)


@app.get("/api/health", tags=["system"])
def health_check() -> dict:
    """返回后端服务健康状态。"""

    return {"status": "ok", "service": "sat-layout-api"}


@app.on_event("shutdown")
def shutdown_model_service() -> None:
    """应用关闭时调用模型服务的统一清理入口。"""

    model_upload_service.shutdown()
    shutdown_layout_service()
