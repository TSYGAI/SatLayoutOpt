"""文件说明：为 CAD 工作进程构造开发态或 Nuitka 编译态启动参数，不执行模型业务。

编译态只允许两个固定工作入口，禁止把安装程序当作任意 Python 解释器使用。
"""

import os
from pathlib import Path
import sys

from app.core.paths import application_root, is_compiled


def worker_command(kind: str, request_path: Path, error_path: Path) -> list[str]:
    """返回指定 CAD 任务的启动命令；未知任务抛 ValueError，路径以独立参数传递。"""
    modules = {"artifact": "app.domain.model_artifact_worker", "envelope": "app.domain.model_envelope_worker"}
    if kind not in modules:
        raise ValueError(f"未知 CAD 工作入口：{kind}")
    prefix = [sys.executable, "--worker", kind] if is_compiled() else [sys.executable, "-m", modules[kind]]
    return [*prefix, str(request_path), str(error_path)]


def worker_environment() -> dict[str, str]:
    """开发态注入 backend 模块路径，编译态移除宿主 Python 路径并保持独立用户数据位置。"""
    environment = dict(os.environ)
    if is_compiled():
        for name in tuple(environment):
            if name.upper().startswith(("PYTHON", "CONDA")):
                del environment[name]
    else:
        backend_path = str(application_root() / "backend")
        environment["PYTHONPATH"] = os.pathsep.join(filter(None, [backend_path, environment.get("PYTHONPATH")]))
    return environment
