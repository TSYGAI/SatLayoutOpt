"""
文件说明：在后端进程内执行可脱离浏览器请求生命周期的后台任务，并只保留最新任务状态。
本模块不持久化任务历史；具体业务、HTTP 映射和产物存储由调用方负责。
"""

from __future__ import annotations

from concurrent.futures import ThreadPoolExecutor
from copy import deepcopy
from datetime import datetime, timezone
from threading import RLock
from typing import Any, Callable
from uuid import uuid4


class LatestBackgroundTask:
    """串行执行后台工作，并提供线程安全的最新任务快照。"""

    def __init__(self, thread_name_prefix: str) -> None:
        """创建单工作线程执行器；任务状态只保存在当前后端进程内。"""

        self._lock = RLock()
        self._executor = ThreadPoolExecutor(max_workers=1, thread_name_prefix=thread_name_prefix)
        self._latest: dict[str, Any] | None = None
        self._closed = False

    @staticmethod
    def _timestamp() -> str:
        """返回 UTC ISO 8601 时间，供任务开始和结束状态使用。"""

        return datetime.now(timezone.utc).isoformat()

    def start(
        self,
        kind: str,
        action: Callable[[], Any],
        *,
        model_id: str | None = None,
    ) -> dict[str, Any]:
        """启动新任务；已有任务运行时幂等返回该任务，避免并发覆盖最新产物。"""

        with self._lock:
            if self._latest is not None and self._latest.get("state") == "running":
                return deepcopy(self._latest)
            if self._closed:
                raise RuntimeError("后台任务执行器已经关闭")
            task_id = uuid4().hex
            task: dict[str, Any] = {
                "id": task_id,
                "kind": kind,
                "state": "running",
                "started_at": self._timestamp(),
            }
            if model_id is not None:
                task["model_id"] = model_id
            self._latest = task
            try:
                self._executor.submit(self._run, task_id, action)
            except Exception:
                self._latest = None
                raise
            return deepcopy(task)

    def _run(self, task_id: str, action: Callable[[], Any]) -> None:
        """执行一次业务操作，并仅在其仍为最新任务时发布终态。"""

        try:
            result = action()
        except Exception as error:
            terminal = {"state": "failed", "error": str(error), "finished_at": self._timestamp()}
        else:
            terminal = {"state": "succeeded", "result": result, "finished_at": self._timestamp()}
        with self._lock:
            if self._latest is not None and self._latest.get("id") == task_id:
                self._latest = {**self._latest, **terminal}

    def get_latest(self) -> dict[str, Any]:
        """返回最新任务的独立快照；从未启动任务时返回空闲状态。"""

        with self._lock:
            return deepcopy(self._latest) if self._latest is not None else {"state": "idle"}

    def shutdown(self) -> None:
        """停止接收新任务，并等待已经开始的任务结束。"""

        with self._lock:
            self._closed = True
        self._executor.shutdown(wait=True, cancel_futures=False)
