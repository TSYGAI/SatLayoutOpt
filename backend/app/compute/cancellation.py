"""文件说明：为一次数值请求绑定协作取消检查；上下文结束即恢复，普通求解与其他请求不会继承微调的取消状态。"""

from contextlib import contextmanager
from contextvars import ContextVar


_cancelled = ContextVar("numeric_request_cancelled", default=None)


def check_cancelled():
    """在几何阶段和循环之间响应取消；被取消时抛 InterruptedError，不把部分结果作为正式校核返回。"""
    callback = _cancelled.get()
    if callback is not None and callback():
        raise InterruptedError("微调校核已取消")


@contextmanager
def cancellation_scope(cancelled):
    """仅在当前请求作用域启用取消回调；正常结束或异常退出均清理，避免复用进程污染下一任务。"""
    token = _cancelled.set(cancelled)
    try:
        check_cancelled()
        yield
    finally:
        _cancelled.reset(token)
