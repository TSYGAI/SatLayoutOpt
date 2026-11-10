"""文件说明：管理模型派生子进程的登记、输出收集和按模型取消。

本模块只处理进程生命周期；模型存在性、删除排他与产物发布由模型上传服务负责。
"""

from pathlib import Path
import subprocess
from threading import RLock


class ModelWorkerProcesses:
    """按模型登记工作进程，使删除能够终止目标转换且不影响其他模型。"""

    def __init__(self) -> None:
        """建立线程安全的进程注册表，不预先启动任何子进程。"""
        self._lock = RLock()
        self._active: dict[str, set[subprocess.Popen[str]]] = {}

    def start(self, model_id: str, command: list[str], cwd: Path, environment: dict[str, str]) -> subprocess.Popen[str]:
        """启动并登记工作进程；调用方须在模型锁内完成存在性校验，启动失败抛 OSError。"""
        with self._lock:
            process = subprocess.Popen(
                command, cwd=cwd, env=environment,
                creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
                stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                text=True, encoding="utf-8", errors="replace",
            )
            self._active.setdefault(model_id, set()).add(process)
            return process

    def wait(self, model_id: str, process: subprocess.Popen[str]) -> subprocess.CompletedProcess[str]:
        """收集输出并等待退出；异常时终止进程，所有退出路径均回收注册表记录。"""
        try:
            stdout, stderr = process.communicate()
            return subprocess.CompletedProcess(process.args, process.returncode, stdout, stderr)
        finally:
            if process.poll() is None:
                process.kill()
                process.communicate()
            with self._lock:
                processes = self._active.get(model_id)
                if processes is not None:
                    processes.discard(process)
                    if not processes:
                        del self._active[model_id]

    def cancel(self, model_id: str) -> None:
        """终止指定模型的全部在途进程；原请求负责等待退出和清理临时文件，无目标时幂等返回。"""
        with self._lock:
            for process in tuple(self._active.get(model_id, ())):
                if process.poll() is None:
                    process.kill()
