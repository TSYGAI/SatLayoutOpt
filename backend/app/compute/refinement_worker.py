"""文件说明：在宿主管理的隔离进程中串行执行微调文件协议；仅复用导入，不保存模型、来源、草稿或校核结果。

每次重新验证请求及全部资源，结束后释放映射再发唯一终态；错误原因与诊断分离，控制线程处理取消和宿主断开。
"""

import gc
import os
from pathlib import Path
from queue import Full, Queue
import sys
from threading import Event, Lock, Thread
import traceback


class Control:
    """接收宿主执行和取消帧，最多保留一个任务；错误或管道断开时取消当前任务并限时退出。"""

    def __init__(self, config):
        """绑定集中配置，创建有界任务队列、当前取消标志和进程退出信号。"""
        self.config = config
        self.requests = Queue(maxsize=1)
        self.lock = Lock()
        self.current = None
        self.closed, self.finished, self.invalid = Event(), Event(), Event()

    def read(self):
        """由唯一控制线程读取严格帧；任务身份不符、重复执行及未知字段均停止本进程。"""
        from app.compute.runtime import read_control_line
        try:
            while True:
                frame = read_control_line(self.config["refinement_worker_poll_seconds"])
                if frame is None:
                    break
                if not isinstance(frame, dict) or type(frame.get("protocol_version")) is not int or frame["protocol_version"] != 1:
                    raise ValueError("微调控制协议版本无效")
                with self.lock:
                    if frame.get("type") == "execute":
                        if set(frame) != {"protocol_version", "type", "task_id", "request_path"} or self.current is not None:
                            raise ValueError("微调执行帧无效或任务尚未结束")
                        cancellation = Event()
                        self.current = (frame["task_id"], cancellation)
                        self.requests.put_nowait((frame, cancellation))
                    elif frame.get("type") == "cancel":
                        if set(frame) != {"protocol_version", "type", "task_id"}:
                            raise ValueError("微调取消帧字段无效")
                        if self.current is not None:
                            if self.current[0] != frame["task_id"]:
                                raise ValueError("微调取消标识不匹配")
                            self.current[1].set()
                    else:
                        raise ValueError("未知微调控制帧")
        except Exception:
            self.invalid.set()
            traceback.print_exc(file=sys.stderr)
        finally:
            self.closed.set()
            with self.lock:
                if self.current is not None:
                    self.current[1].set()
            try:
                self.requests.put_nowait(None)
            except Full:
                pass
            if not self.finished.wait(self.config["cancel_grace_seconds"]):
                os._exit(2)

    def complete(self):
        """任务资源释放后解除身份占用；宿主收到终态后才可发下一请求。"""
        with self.lock:
            self.current = None


def execute_request(request, events, cancellation):
    """重新核对资源并执行正式微调，返回终态数据；函数返回即释放模型及网格的局部引用。"""
    from app.compute.monitoring import configure, finish_lane, stage
    from app.compute.operations import execute
    configure(lambda value: events.emit("progress", {"monitor": value}),
              progress_sink=lambda value: events.emit("progress", value))
    try:
        stage("校验微调输入文件")
        paths = request.verify_inputs()
        if cancellation.is_set():
            raise InterruptedError("任务已取消")
        Path(request.output_root).mkdir(parents=True, exist_ok=False)
        state, result = execute(request, paths, events.emit, cancellation.is_set, events.checkpoint)
        if cancellation.is_set():
            return "cancelled", {"checkpoint": events.last_checkpoint}
        return state, {"result": result, "checkpoint": events.last_checkpoint}
    except InterruptedError:
        return "cancelled", {"checkpoint": events.last_checkpoint}
    except Exception as error:
        from app.compute.errors import failure_data
        return "failed", {**failure_data(error), "checkpoint": events.last_checkpoint}
    finally:
        finish_lane()
        configure(None)


def main():
    """建立独立进程树与协议输出，串行执行仅限 layout.refine 的请求，宿主关闭后退出。"""
    from app.compute.parallel import numeric_environment
    os.environ.update(numeric_environment())
    from app.compute.config import COMPUTE_CONFIG
    from app.compute.protocol import read_request
    from app.compute.runtime import Events
    from app.core.process_job import create_process_job
    job = create_process_job()
    stream = os.fdopen(os.dup(sys.stdout.fileno()), "wb", buffering=0)
    os.dup2(sys.stderr.fileno(), sys.stdout.fileno())
    control = Control(COMPUTE_CONFIG)
    Thread(target=control.read, daemon=True).start()
    try:
        while not control.closed.is_set():
            pending = control.requests.get()
            if pending is None or control.closed.is_set():
                break
            frame, cancellation = pending
            request = read_request(frame["request_path"])
            if request.operation != "layout.refine" or request.task_id != frame["task_id"]:
                raise ValueError("微调进程拒绝操作类型或任务身份不匹配的请求")
            events = Events(request, stream)
            events.emit("started", {"operation": request.operation, "pid": os.getpid()})
            kind, data = execute_request(request, events, cancellation)
            # 清掉诊断帧等循环引用，确保终态后宿主能立即删除本任务的 NPY 映射文件。
            gc.collect()
            control.complete()
            events.emit(kind, data)
        return 1 if control.invalid.is_set() else 0
    except Exception:
        traceback.print_exc(file=sys.stderr)
        return 1
    finally:
        control.finished.set()
        _ = job
        stream.close()
