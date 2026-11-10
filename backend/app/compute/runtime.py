"""文件说明：计算协议输出与有界控制读取；单次及复用进程共享严格分帧，原生日志走 stderr。"""

import ctypes
from ctypes import wintypes
import json
import os
from pathlib import Path
import sys
from threading import Event, Lock, Thread
import time

from app.compute.config import COMPUTE_CONFIG
from app.compute.files import file_ref, write_json


class Events:
    """序列化进度、候选与唯一终态，检查点文件先原子落盘再向宿主发布。"""

    def __init__(self, request, stream):
        """绑定当前任务和专用 stdout 描述符，避免 CAD 的 C 级输出污染协议。"""
        self.request, self.stream = request, stream
        self.sequence, self.finished, self.last_checkpoint = 0, False, None
        self.lock = Lock()
        self.checkpoint_count = 0
        self.last_candidates = None

    def emit(self, kind, data):
        """写一条有长度上限的协议帧；终态后忽略迟到进度，返回是否实际写出。"""
        with self.lock:
            if self.finished:
                return False
            message = {"protocol_version": 1, "task_id": self.request.task_id,
                       "sequence": self.sequence + 1, "type": kind, "data": data}
            content = (json.dumps(message, ensure_ascii=False, allow_nan=False) + "\n").encode("utf-8")
            if len(content) > COMPUTE_CONFIG["event_max_bytes"]:
                raise ValueError("计算事件超过协议长度上限")
            self.stream.write(content)
            self.stream.flush()
            self.sequence += 1
            self.finished = kind in {"completed", "cancelled", "failed"}
            return True

    def checkpoint(self, candidates):
        """仅在合法候选变化时生成不可变检查点，供协作取消、强制终止或进程故障恢复。"""
        if candidates == self.last_candidates:
            return
        self.checkpoint_count += 1
        path = Path(self.request.output_root) / "checkpoints" / f"{self.checkpoint_count:06d}.json"
        write_json(path, {"candidates": candidates})
        reference = file_ref(self.request.output_root, path)
        self.last_candidates, self.last_checkpoint = candidates, reference
        self.emit("candidates", {"artifact": reference, "count": len(candidates)})


def read_control_line(poll_seconds=None):
    """读取有界 stdin 控制帧；可指定轮询间隔，Windows 查询管道以免阻塞 CRT 锁干扰原生库初始化。"""
    buffer = bytearray()
    if os.name == "nt":
        import msvcrt
        kernel = ctypes.WinDLL("kernel32", use_last_error=True)
        kernel.PeekNamedPipe.argtypes = [wintypes.HANDLE, ctypes.c_void_p, wintypes.DWORD,
                                        ctypes.c_void_p, ctypes.POINTER(wintypes.DWORD), ctypes.c_void_p]
        handle = msvcrt.get_osfhandle(sys.stdin.fileno())
        available = wintypes.DWORD()
    while len(buffer) <= COMPUTE_CONFIG["event_max_bytes"]:
        if os.name == "nt":
            if not kernel.PeekNamedPipe(handle, None, 0, None, ctypes.byref(available), None):
                return None
            if not available.value:
                time.sleep(COMPUTE_CONFIG["poll_interval_seconds"] if poll_seconds is None else poll_seconds)
                continue
        value = os.read(sys.stdin.fileno(), 1)
        if not value:
            return None
        buffer.extend(value)
        if value == b"\n":
            return json.loads(buffer.decode("utf-8"))
    raise ValueError("控制帧超过上限")


def watch_control(events, cancellation):
    """处理有效取消、无效控制或宿主管道断开；到期终止当前 Job，保留此前已发布的候选检查点。"""
    reason = "parent_disconnected"
    try:
        control = read_control_line()
        if control is not None:
            expected = {"protocol_version": 1, "task_id": events.request.task_id, "type": "cancel"}
            if control != expected or type(control["protocol_version"]) is not int:
                raise ValueError("无效取消帧")
            reason = "requested"
    except Exception as error:
        print(f"计算控制协议错误：{error}", file=sys.stderr, flush=True)
        reason = "invalid_control"
    cancellation.set()
    deadline = time.monotonic() + COMPUTE_CONFIG["cancel_grace_seconds"]
    while not events.finished and time.monotonic() < deadline:
        time.sleep(COMPUTE_CONFIG["poll_interval_seconds"])
    if not events.finished:
        try:
            events.emit("cancelled", {"reason": reason, "forced": True, "checkpoint": events.last_checkpoint})
        finally:
            os._exit(2)


def start_control(events):
    """创建任务级取消标志并启动只读控制线程，返回领域算法可轮询的 Event。"""
    cancellation = Event()
    Thread(target=watch_control, args=(events, cancellation), daemon=True).start()
    return cancellation
