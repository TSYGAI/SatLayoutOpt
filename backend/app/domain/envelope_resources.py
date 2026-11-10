"""文件说明：包络阶段诊断、工作进度与独立工作进程资源保护，不启动额外几何任务。

普通调用只标记异常阶段；明确标为隔离工作进程的入口才设置 CPU 亲和性、Windows
私有内存硬限制及持续监控。超预算只终止本任务，并先保存独立失败报告。
"""

from contextlib import contextmanager
from contextvars import ContextVar
import os
import sys
import threading


_active_guard = ContextVar("envelope_resource_guard", default=None)


def memory_limits(parameters):
    """取配置与正式调度授权的更严格预算；返回进程上限及必须保留的系统余量。"""
    budget = min(parameters.process_memory_limit_bytes, int(os.environ.get(
        "SAT_LAYOUT_ENVELOPE_MEMORY_BUDGET", parameters.process_memory_limit_bytes)))
    reserve = max(parameters.memory_reserve_bytes, int(os.environ.get(
        "SAT_LAYOUT_ENVELOPE_MEMORY_RESERVE", parameters.memory_reserve_bytes)))
    return budget, reserve


@contextmanager
def envelope_stage(name):
    """记录当前阶段，并把首个明确阶段附加到异常；不掩盖原始异常类型。"""
    from app.compute.monitoring import stage
    from app.domain.envelope_progress import report_envelope_progress
    stage(name)
    report_envelope_progress(name)
    guard = _active_guard.get()
    if guard is not None:
        guard.stage = name
        if guard.report_progress is not None:
            guard.report_progress(name)
    try:
        yield
        report_envelope_progress(name, 1, 1)
    except Exception as error:
        if not hasattr(error, "envelope_stage"):
            error.envelope_stage = name
        raise


class EnvelopeResourceGuard:
    """监控一个明确隔离的包络工作进程，避免 CAD 原生调用期间失去内存保护。"""

    def __init__(self, parameters, report_failure, report_progress=None):
        """接收集中资源参数及报告回调；构造时不启动线程或改变当前进程。"""
        self.parameters = parameters
        self.report_failure = report_failure
        self.report_progress = report_progress
        self.stage = "initialization"
        self.stop = threading.Event()
        self.thread = None
        self.job = None
        self.observed = {}

    def __enter__(self):
        """仅隔离入口施加限制和监控；测试及普通调用保持可捕获异常语义。"""
        self.token = _active_guard.set(self)
        if os.environ.get("SAT_LAYOUT_ENVELOPE_ISOLATED") != "1":
            return self
        import psutil
        from app.core.process_job import create_process_job

        process = psutil.Process()
        threads = max(1, int(os.environ.get("SAT_LAYOUT_CAD_THREADS", "2")))
        if hasattr(process, "cpu_affinity"):
            process.cpu_affinity(process.cpu_affinity()[:threads])
        if os.name == "nt":
            process.nice(psutil.BELOW_NORMAL_PRIORITY_CLASS)
        budget, _ = memory_limits(self.parameters)
        if os.environ.get("SAT_LAYOUT_ENVELOPE_JOB_BOUND") != "1":
            self.job = create_process_job(memory_limit_bytes=budget)
        self.thread = threading.Thread(target=self._monitor, name="envelope-resource-monitor", daemon=True)
        self.thread.start()
        return self

    def _monitor(self):
        """持续采样本任务私有内存与系统余量；过载报告后退出隔离进程。"""
        import psutil
        from app.compute.config import COMPUTE_CONFIG

        process = psutil.Process()
        budget, reserve = memory_limits(self.parameters)
        while not self.stop.wait(COMPUTE_CONFIG["poll_interval_seconds"]):
            info = process.memory_info()
            used = int(getattr(info, "private", info.rss))
            available = int(psutil.virtual_memory().available)
            self.observed["peak_private_bytes"] = max(used, self.observed.get("peak_private_bytes", 0))
            self.observed["min_available_bytes"] = min(available, self.observed.get("min_available_bytes", available))
            if used > budget or available < reserve:
                error = MemoryError("包络隔离进程超过内存预算或系统保留内存不足，已停止本任务")
                error.envelope_stage = self.stage
                try:
                    self.report_failure(error)
                except Exception as report_error:
                    print(f"包络资源保护报告写入失败：{report_error}", file=sys.stderr, flush=True)
                os._exit(1)

    def __exit__(self, exc_type, exc, tb):
        """停止监控并恢复阶段上下文；Job 句柄随隔离进程退出回收。"""
        self.stop.set()
        if self.thread is not None:
            self.thread.join(timeout=1)
        _active_guard.reset(self.token)
