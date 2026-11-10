"""文件说明：桌面版后端启动器，读取统一配置、绑定动态本机端口并管理 CAD 子进程生命周期。

通过标准输出向 Electron 报告就绪地址，通过标准输入接收退出通知；编译态提供固定 CAD 工作入口。
"""

import argparse
import ctypes
from ctypes import wintypes
import json
import os
from pathlib import Path
import socket
import sys
from threading import Event, Thread
import tomllib

from app.core.paths import application_root
from app.core.process_job import create_process_job


def main() -> int:
    """读取配置、执行固定 CAD 工作任务或运行 API；返回退出码，业务异常由原工作入口记录。"""
    sys.stdout.reconfigure(encoding="utf-8")
    sys.stderr.reconfigure(encoding="utf-8")
    parser = argparse.ArgumentParser()
    mode = parser.add_mutually_exclusive_group(required=True)
    mode.add_argument("--config", action="store_true")
    mode.add_argument("--frontend-port", type=int)
    mode.add_argument("--worker", choices=("artifact", "envelope"))
    parser.add_argument("worker_paths", nargs="*")
    args = parser.parse_args()
    if args.worker:
        if len(args.worker_paths) != 2:
            parser.error("CAD 工作入口需要任务文件和错误文件两个路径")
        sys.argv = [sys.argv[0], *args.worker_paths]
        if args.worker == "artifact":
            from app.domain.model_artifact_worker import main as run_worker
        else:
            from app.domain.model_envelope_worker import main as run_worker
        return run_worker()
    if args.worker_paths:
        parser.error("只有 CAD 工作入口接受任务文件路径")
    root = application_root()
    with (root / "config/sat_layout_opt.toml").open("rb") as stream:
        settings = tomllib.load(stream)
    if args.config:
        print(json.dumps(settings["desktop"], ensure_ascii=False))
        return 0
    if not args.frontend_port or not os.environ.get("SAT_LAYOUT_OPT_DATA_ROOT"):
        parser.error("桌面启动需要前端端口和独立数据目录")

    job = create_process_job()
    import uvicorn
    import app.core.config as config_module
    from dataclasses import replace

    config_module.runtime_config = replace(config_module.runtime_config, frontend_host="127.0.0.1", frontend_port=args.frontend_port)
    listener = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    listener.bind(("127.0.0.1", 0))
    port = listener.getsockname()[1]
    server = uvicorn.Server(uvicorn.Config("app.main:app", host="127.0.0.1", port=port, log_level="info"))

    def request_shutdown() -> None:
        """检测退出通知及管道断开；Windows 不阻塞读取 CRT stdin，避免 NumPy 初始化争用文件锁。"""
        if os.name == "nt":
            import msvcrt
            kernel = ctypes.WinDLL("kernel32", use_last_error=True)
            kernel.PeekNamedPipe.argtypes = [wintypes.HANDLE, ctypes.c_void_p, wintypes.DWORD,
                                            ctypes.c_void_p, ctypes.POINTER(wintypes.DWORD), ctypes.c_void_p]
            handle = msvcrt.get_osfhandle(sys.stdin.fileno())
            available = wintypes.DWORD()
            wait = Event()
            while kernel.PeekNamedPipe(handle, None, 0, None, ctypes.byref(available), None):
                if available.value:
                    break
                wait.wait(settings["desktop"]["control_poll_interval_ms"] / 1000)
        else:
            sys.stdin.readline()
        server.should_exit = True

    Thread(target=request_shutdown, daemon=True).start()
    print("SAT_LAYOUT_READY=" + json.dumps({"port": port}), flush=True)
    try:
        server.run(sockets=[listener])
    finally:
        listener.close()
        # Job 句柄保留到进程真正退出，避免在解释器清理前误杀自身。
        _ = job
    return 0


if __name__ == "__main__":
    exit_code = main()
    # 与 CAD 工作进程一致：服务已经完成关闭后直接退出，避免 OpenCascade 解释器析构崩溃。
    sys.stdout.flush()
    sys.stderr.flush()
    os._exit(exit_code)
