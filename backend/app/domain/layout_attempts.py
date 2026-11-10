"""文件说明：定义独立试次、完整合法候选的提前发布上下文及串行执行器；不持有后端服务对象。"""

from contextlib import contextmanager
from contextvars import ContextVar
from dataclasses import dataclass

_CANDIDATE_REPORT = ContextVar("layout_candidate_report", default=None)
_CURRENT_ATTEMPT = ContextVar("layout_current_attempt", default=None)


@contextmanager
def candidate_updates(report):
    """为当前求解范围安装候选回调；异常或取消后恢复，避免不同任务的候选串线。"""
    token = _CANDIDATE_REPORT.set(report)
    try:
        yield
    finally:
        _CANDIDATE_REPORT.reset(token)


@contextmanager
def candidate_attempt(task):
    """绑定当前试次身份，供串行求解及 worker 转发完整候选；退出时恢复上层身份。"""
    token = _CURRENT_ATTEMPT.set(task)
    try:
        yield
    finally:
        _CURRENT_ATTEMPT.reset(token)


def publish_candidate(candidate):
    """发布已经完成低位落位和完整验收的候选；无回调时保持普通领域调用无副作用。"""
    report, task = _CANDIDATE_REPORT.get(), _CURRENT_ATTEMPT.get()
    if report is not None and task is not None:
        report(task, candidate)


def streaming_attempts(runner, tasks, solve, started, cancelled, report):
    """在消费试次结果期间接收提前候选；最终结果仍按既有顺序归并。"""
    with candidate_updates(report):
        yield from runner(tasks, solve, started, cancelled)


@dataclass(frozen=True)
class LayoutAttempt:
    """记录试次及软组释放阶段，供工作进程重建相同参数；序号按轮计数，随机源仍由半径、层组和试次决定。"""

    sequence: int
    radius_index: int
    radius: float
    layer_count: int
    partition: tuple[tuple[int, ...], ...]
    trial: int
    purpose: int
    release_soft_fixed: bool = False
    seed: dict | None = None


def serial_attempts(tasks, solve, started, cancelled):
    """按规划顺序执行并产出结果；每次求解前报告进度，取消时由上层保留已经验收的候选。"""
    for task in tasks:
        if cancelled():
            raise InterruptedError("任务已取消")
        started(task)
        yield task, solve(task)
