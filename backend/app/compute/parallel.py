"""文件说明：Windows 数值工作池，按序归并候选并分离错误正文与诊断，异常或取消回收自有进程。"""

from collections import deque
import multiprocessing
from multiprocessing.connection import wait
import os
import time
from contextlib import ExitStack

from app.compute.config import COMPUTE_CONFIG
from app.compute.errors import WorkerFailure, failure_data
from app.compute.monitoring import configure, stage, object_context, finish_lane, forward
from app.domain.layout_attempts import candidate_updates, candidate_attempt, publish_candidate


def numeric_environment():
    """在数值库导入及 spawn 前限制嵌套线程，返回需要传递给新解释器的环境变量。"""
    threads = str(COMPUTE_CONFIG["numeric_threads_per_worker"])
    return {name: threads for name in ("OMP_NUM_THREADS", "OPENBLAS_NUM_THREADS", "MKL_NUM_THREADS",
                                       "NUMEXPR_NUM_THREADS", "VECLIB_MAXIMUM_THREADS")}


class CancellationFlag:
    """宿主单写、工作进程只读的共享字节；进程被强杀不会遗留 Event 条件锁而阻塞回收。"""

    def __init__(self, context):
        """分配可由 spawn 继承的共享字节；信号只从零变一，不支持重置或等待。"""
        self.value = context.RawValue("B", 0)

    def set(self):
        """由池宿主发布取消；单字节写入无需获取可能被故障进程持有的同步锁。"""
        self.value.value = 1

    def is_set(self):
        """供工作进程和求解器轮询共享取消状态，不持有跨进程锁。"""
        return bool(self.value.value)


def worker(connection, snapshot_path, cancellation):
    """加载一次只读几何，执行小型试次描述；仅通过管道返回数值候选或错误，不导入 CAD/API。"""
    scope = ExitStack()
    configure(lambda value: connection.send(("monitor", value)))
    try:
        stage("worker 初始化依赖与数值快照", file=str(snapshot_path))
        from app.domain.layout_mount_cache import mount_cache
        scope.enter_context(mount_cache(COMPUTE_CONFIG["mount_cache_bytes"]))
        scope.enter_context(candidate_updates(lambda task, value: connection.send(("candidate", value))))
        from app.compute.snapshot import read_snapshot
        from app.domain.layout_hybrid import solve_hybrid_attempt
        from app.domain.fixed_policy import fixed_stage_parameters
        satellites, parameters = read_snapshot(snapshot_path)
        stages = {}
        finish_lane()
        connection.send(("ready", os.getpid()))
        while True:
            task = connection.recv()
            if task is None or cancellation.is_set():
                return
            object_context(trial=task.trial, radius=task.radius, layer_count=task.layer_count,
                           candidate=task.sequence, purpose=task.purpose)
            stage("worker 求解布局试次")
            if task.release_soft_fixed not in stages:
                current = fixed_stage_parameters(parameters, task.release_soft_fixed)
                top = next((item for item in satellites if current.top_enabled and item.record_id == current.top_record_id), None)
                side = sorted((item for item in satellites if item is not top), key=lambda item: (-item.mass, -item.volume))
                stages[task.release_soft_fixed] = current, top, side
            current, top, side = stages[task.release_soft_fixed]
            result = solve_hybrid_attempt(side, top, task, current, cancellation.is_set)
            finish_lane()
            connection.send(("result", result))
    except InterruptedError:
        connection.send(("cancelled", None))
    except BaseException as error:
        connection.send(("error", failure_data(error)))
    finally:
        scope.close()
        connection.close()


class OrderedPool:
    """拥有独立数值进程和共享取消信号，串行规划器通过本对象消费有序结果。"""

    def __init__(self, snapshot_path, count, cancelled, monitor=None):
        """创建显式 spawn 上下文；启动由上下文入口完成，失败由同一所有者负责回收。"""
        self.context = multiprocessing.get_context("spawn")
        self.stop = CancellationFlag(self.context)
        self.snapshot_path, self.count, self.cancelled = str(snapshot_path), count, cancelled
        self.members = []
        self.pids = []
        self.monitor = monitor
        self.log_sink = forward

    def add_member(self):
        """启动并登记一个长期复用的进程，初始化失败由池所有者回收，不泄漏管道。"""
        parent, child = self.context.Pipe()
        process = self.context.Process(target=worker, args=(child, self.snapshot_path, self.stop))
        try:
            process.start()
        except BaseException:
            parent.close()
            child.close()
            raise
        child.close()
        self.members.append((process, parent))
        kind, pid = self.receive((process, parent))
        if kind == "error":
            raise WorkerFailure(pid, "数值工作进程初始化失败")
        if kind != "ready":
            raise RuntimeError(f"数值工作进程初始化失败：{pid}")
        self.pids.append(pid)

    def resize(self, busy, force=False):
        """只回收空闲进程；正在执行的试次完整返回并按序归并，缩容不改变试次预算与候选。"""
        limit = self.monitor.target(self.members, force) if self.monitor else self.count
        for member in list(reversed(self.members)):
            if len(self.members) <= limit:
                break
            process, connection = member
            if connection in busy:
                continue
            connection.send(None)
            process.join(COMPUTE_CONFIG["cancel_grace_seconds"])
            if process.is_alive():
                process.terminate()
                process.join()
            connection.close()
            process.close()
            self.members.remove(member)
        while len(self.members) < limit:
            if self.cancelled():
                raise InterruptedError("任务已取消")
            self.add_member()
            if self.monitor:
                limit = self.monitor.target(self.members, True)
        return limit

    def __enter__(self):
        """启动并等待所有数值进程就绪；调用方可单独测量准备时间。"""
        os.environ.update(numeric_environment())
        try:
            while not self.members:
                self.resize({}, True)
                if not self.members:
                    if self.cancelled():
                        raise InterruptedError("任务已取消")
                    time.sleep(COMPUTE_CONFIG["poll_interval_seconds"])
            return self
        except BaseException:
            self.__exit__(None, None, None)
            raise

    def receive(self, member):
        """轮询当前有序结果；取消立即中止，进程崩溃转换为明确异常，不无限等待管道。"""
        process, connection = member
        while True:
            if connection.poll(COMPUTE_CONFIG["poll_interval_seconds"]):
                message = connection.recv()
                if message[0] == "monitor":
                    if self.log_sink:
                        self.log_sink(message[1])
                    continue
                return message
            if self.cancelled():
                self.stop.set()
                raise InterruptedError("任务已取消")
            if not process.is_alive():
                raise RuntimeError(f"数值进程异常退出：{process.exitcode}")

    def __call__(self, tasks, solve, started, cancelled):
        """完整合法候选即时转发供展示；压紧最终结果仍按序归并，不改变试次预算和随机源。"""
        iterator, order = iter(tasks), deque()
        busy, results = {}, {}
        exhausted = False
        capacity = self.count * COMPUTE_CONFIG["prefetch_per_worker"]
        announced = None
        while True:
            if cancelled():
                raise InterruptedError("任务已取消")
            limit = self.resize(busy)
            for member in self.members:
                process, connection = member
                if connection in busy or exhausted or len(order) >= capacity or len(busy) >= limit:
                    continue
                task = next(iterator, None)
                if task is None:
                    exhausted = True
                    break
                connection.send(task)
                busy[connection] = task
                order.append(task)
            if not order and exhausted:
                return
            if not order:
                time.sleep(COMPUTE_CONFIG["poll_interval_seconds"])
                continue
            if announced != order[0].sequence:
                announced = order[0].sequence
                started(order[0])
            if order[0].sequence in results:
                task = order.popleft()
                yield task, results.pop(task.sequence)
                continue
            if not busy:
                time.sleep(COMPUTE_CONFIG["poll_interval_seconds"])
            for connection in wait(list(busy), timeout=COMPUTE_CONFIG["poll_interval_seconds"]) if busy else []:
                kind, result = connection.recv()
                if kind == "monitor":
                    if self.log_sink:
                        self.log_sink(result)
                    continue
                if kind == "candidate":
                    with candidate_attempt(busy[connection]):
                        publish_candidate(result)
                    continue
                task = busy.pop(connection)
                if kind == "cancelled":
                    raise InterruptedError("任务已取消")
                if kind == "error":
                    raise WorkerFailure(result, "数值试次失败")
                if kind != "result":
                    raise RuntimeError(f"数值试次失败：{result}")
                results[task.sequence] = result
            if any(not process.is_alive() for process, connection in self.members):
                raise RuntimeError("数值工作进程异常退出")

    def __exit__(self, exc_type, exc, tb):
        """停止派发并在统一宽限时间内退出；超时强制终止本池拥有的进程，关闭所有句柄。"""
        self.stop.set()
        for process, connection in self.members:
            try:
                connection.send(None)
            except (OSError, EOFError):
                pass
        deadline = time.monotonic() + COMPUTE_CONFIG["cancel_grace_seconds"]
        for process, connection in self.members:
            process.join(max(0, deadline - time.monotonic()))
        for process, connection in self.members:
            if process.is_alive():
                process.terminate()
            process.join()
            connection.close()
            process.close()
        self.members.clear()
