"""文件说明：计算协议参考客户端，拥有子进程、校验顺序事件与产物；供隔离验证和后续 Rust 桥接对照。"""

import json
import os
from pathlib import Path
from queue import Empty, Queue
import subprocess
import sys
from threading import Thread
import time

from app.compute.config import COMPUTE_CONFIG
from app.compute.files import sha256, within
from app.compute.parallel import numeric_environment
from app.compute.protocol import Resource, read_request


def check_artifact(root, reference):
    """检查事件引用产物的边界、长度和摘要，返回已核验的路径；不接受半成品。"""
    resource = Resource.model_validate(reference)
    path = within(root, resource.path)
    if not path.is_file() or path.stat().st_size != resource.bytes or sha256(path) != resource.sha256:
        raise ValueError("计算产物缺失或摘要不一致")
    return path


def read_frames(stream, messages):
    """在独立线程有界读取 NDJSON，异常交给主线程处理并回收进程。"""
    try:
        while line := stream.readline(COMPUTE_CONFIG["event_max_bytes"] + 1):
            if len(line) > COMPUTE_CONFIG["event_max_bytes"] or not line.endswith(b"\n"):
                raise ValueError("计算事件超长或不完整")
            messages.put(json.loads(line.decode("utf-8")))
    except Exception as error:
        messages.put(error)
    finally:
        messages.put(None)


def run_task(request_path, log_path, *, timeout, on_event=None, cancelled=lambda: False, on_process=None):
    """启动一个文件任务并等待唯一终态；支持协作取消和超时回收，返回事件、退出码与最后检查点。

    on_event 接收已验证事件；on_process 只用于宿主登记或测量本进程。进程异常退出返回 failed，
    已发布检查点仍可读取；协议损坏或超时抛出异常，调用方必须将任务记为失败，不能发布半成品。
    """
    request = read_request(request_path)
    Path(log_path).parent.mkdir(parents=True, exist_ok=True)
    environment = dict(os.environ, **numeric_environment(), PYTHONUTF8="1", PYTHONIOENCODING="utf-8")
    backend = str(Path(__file__).resolve().parents[2])
    environment["PYTHONPATH"] = backend
    messages, events = Queue(), []
    terminal, checkpoint, sent_cancel = None, None, False
    cancel_deadline, parent_forced = None, False
    started = time.monotonic()
    with Path(log_path).open("wb") as log:
        process = subprocess.Popen([sys.executable, "-m", "app.compute", str(Path(request_path).resolve())],
                                   stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=log, env=environment,
                                   creationflags=subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0)
        reader = Thread(target=read_frames, args=(process.stdout, messages), daemon=True)
        reader.start()
        try:
            if on_process:
                on_process(process)
            while True:
                if time.monotonic() - started > timeout:
                    raise TimeoutError("计算任务超时")
                if not sent_cancel and terminal is None and cancelled() and process.poll() is None:
                    control = {"protocol_version": 1, "task_id": request.task_id, "type": "cancel"}
                    try:
                        process.stdin.write((json.dumps(control) + "\n").encode("utf-8"))
                        process.stdin.flush()
                    except OSError:
                        # 进程可能已完成但 stdout 尚未消费，仍由后续终态和退出码判定。
                        pass
                    sent_cancel = True
                    cancel_deadline = time.monotonic() + COMPUTE_CONFIG["cancel_grace_seconds"]
                if cancel_deadline is not None and time.monotonic() >= cancel_deadline and process.poll() is None:
                    # 原生代码若占住 GIL，引擎控制线程可能也无法执行；宿主必须独立执行宽限期。
                    process.kill()
                    parent_forced = True
                try:
                    event = messages.get(timeout=COMPUTE_CONFIG["poll_interval_seconds"])
                except Empty:
                    continue
                if event is None:
                    break
                if isinstance(event, Exception):
                    raise event
                if (not isinstance(event, dict) or set(event) != {"protocol_version", "task_id", "sequence", "type", "data"}
                        or type(event["protocol_version"]) is not int or event["protocol_version"] != 1
                        or event["task_id"] != request.task_id or type(event["sequence"]) is not int
                        or event["sequence"] != len(events) + 1 or not isinstance(event["data"], dict)
                        or terminal is not None):
                    raise ValueError("计算事件任务、版本、顺序或终态无效")
                kind, data = event["type"], event["data"]
                if kind not in {"started", "progress", "candidates", "completed", "cancelled", "failed"}:
                    raise ValueError("未知计算事件")
                if (not events and kind != "started") or (events and kind == "started"):
                    raise ValueError("计算任务必须且只能启动一次")
                if kind == "started" and (data.get("operation") != request.operation or type(data.get("pid")) is not int
                                           or data["pid"] <= 0):
                    raise ValueError("启动事件的操作或进程标识无效")
                if kind == "completed" and not data.get("result"):
                    raise ValueError("完成事件必须引用完整结果")
                if kind == "candidates" and (not data.get("artifact") or type(data.get("count")) is not int
                                              or data["count"] < 0):
                    raise ValueError("候选事件必须引用合法检查点和数量")
                for key in ("artifact", "result", "checkpoint"):
                    if data.get(key) is not None:
                        path = check_artifact(request.output_root, data[key])
                        if key == "result":
                            result = json.loads(path.read_text(encoding="utf-8"))
                            for reference in result["resources"]:
                                check_artifact(request.output_root, reference)
                if kind == "candidates":
                    checkpoint = data["artifact"]
                if kind in {"completed", "cancelled", "failed"}:
                    terminal = event
                events.append(event)
                if on_event:
                    on_event(event)
            code = process.wait(timeout=COMPUTE_CONFIG["cancel_grace_seconds"])
            if terminal is None:
                terminal = ({"type": "cancelled", "data": {"reason": "cancel_timeout", "forced": True,
                                                             "checkpoint": checkpoint}} if parent_forced else
                            {"type": "failed", "data": {"code": "process_exited", "checkpoint": checkpoint}})
            expected = {"completed": 0, "cancelled": 2, "failed": 1}[terminal["type"]]
            if code != expected and terminal["type"] != "failed" and not parent_forced:
                terminal = {"type": "failed", "data": {"code": "exit_mismatch", "checkpoint": checkpoint}}
            return {"terminal": terminal, "events": events, "returncode": code,
                    "checkpoint": checkpoint, "seconds": time.monotonic() - started}
        finally:
            if process.poll() is None:
                process.kill()
                process.wait(timeout=COMPUTE_CONFIG["cancel_grace_seconds"])
            process.stdin.close()
            reader.join(timeout=COMPUTE_CONFIG["cancel_grace_seconds"])
            process.stdout.close()
