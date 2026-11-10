"""文件说明：计算阶段轻量上下文，向宿主发送有界诊断、业务提示及记录更新标识，不写独立日志。

进程/线程分别持有阶段上下文，worker 经既有管道转交宿主；正常步骤仅更新内存轨迹。
原生调用阻塞时最后状态已提前发送，宿主可独立判定慢或无进展。
"""
from contextvars import ContextVar
from functools import wraps
import inspect
import os
import threading
import time

_sink = None
_progress_sink = None
_limit = None
_context = ContextVar("compute_log_context", default={})


def configure(sink, progress_sink=None):
    """安装进程状态出口和可选业务进度出口；禁用时清空两者，普通诊断不生成业务记录。"""
    global _sink, _progress_sink, _limit
    import tomllib
    from app.core.paths import runtime_config_path
    _limit = tomllib.loads(runtime_config_path().read_text(encoding="utf-8"))["logging"]["field_max_chars"]
    _sink = sink
    _progress_sink = progress_sink
    _context.set({})


def forward(state):
    """保留 worker 诊断，转发显式消息及可选记录标识供宿主合并；不覆盖试次计数。"""
    if _sink is not None:
        _sink(state)
    message = state.get("message")
    if _progress_sink is not None and isinstance(message, str) and message.strip():
        update = {"message": message}
        key = state.get("message_key")
        if isinstance(key, str) and key.strip():
            update["message_key"] = key
        _progress_sink(update)


def stage(name, *, progress=True, message=None, message_key=None, **details):
    """发布步骤及可选运行记录；消息和更新标识只用于本次发送，不被内部诊断继承。"""
    if _sink is None:
        return
    if "model_id" in details:
        object_context(**{key: value for key, value in details.items()
                          if key in {"model_id", "model_name", "face_id", "installation_face_id", "file"}})
    frame = inspect.currentframe().f_back
    state = {**_context.get(), "step":name, "pid":os.getpid(), "thread":threading.get_ident(),
             "source_file":frame.f_code.co_filename,
             "function":frame.f_code.co_name, "line":frame.f_lineno,
             **details}
    state = {key: value if isinstance(value, (str, int, float, bool, type(None))) else str(value)
             for key, value in state.items()}
    state = {key: value[:_limit] if isinstance(value, str) else value for key, value in state.items()}
    _context.set(state)
    event = {"lane": f"compute-{os.getpid()}-{threading.get_ident()}", "progress": progress, **state}
    if message is not None:
        event["message"] = message
        if message_key is not None:
            event["message_key"] = message_key
    forward(event)


def object_context(**details):
    """更新业务身份；切换模型时清掉上一模型的文件和安装面，避免错误归属。"""
    current = dict(_context.get())
    if "model_id" in details and details["model_id"] != current.get("model_id"):
        for key in ("model_name", "face_id", "installation_face_id", "file"):
            current.pop(key, None)
    _context.set(dict(current, **details))


def finish_lane():
    """进程空闲或退出时结束当前执行者，避免把等待下一试次误判为停滞。"""
    if _sink is not None:
        _sink({"lane": f"compute-{os.getpid()}-{threading.get_ident()}", "finished": True})


def observed(name):
    """为耗时功能边界提供开始、成功恢复和失败位置，保留原函数异常与返回值。"""
    def decorate(function):
        """构造保留函数签名元数据的透明包装。"""
        @wraps(function)
        def run(*args, **kwargs):
            """在领域调用前发布阶段，失败时保留最深阶段供宿主诊断。"""
            if _sink is None:
                return function(*args, **kwargs)
            previous = _context.get()
            start = time.monotonic()
            phase = previous.get("phase", "")
            phase = f"{phase} → {name}" if phase and phase.split(" → ")[-1] != name else name
            stage(name, phase=phase, source_file=function.__code__.co_filename, function=function.__name__,
                  line=function.__code__.co_firstlineno)
            try:
                result = function(*args, **kwargs)
            except BaseException:
                raise
            else:
                _context.set(previous)
                stage(previous.get("step", "操作收尾"), last_completed=name,
                      last_elapsed_ms=round((time.monotonic()-start)*1000))
                return result
        return run
    return decorate
