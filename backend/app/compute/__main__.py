"""文件说明：独立计算入口，按文件协议执行单次任务或微调复用进程；错误正文与完整诊断分离，不启动 FastAPI。"""

import os
import sys


def main():
    """分派微调复用模式或执行单次任务；退出码 0 完成、2 取消、1 失败，均由宿主管理进程树。"""
    if len(sys.argv) == 2 and sys.argv[1] == "--refinement-worker":
        from app.compute.refinement_worker import main as refinement_main
        return refinement_main()
    from app.compute.parallel import numeric_environment
    os.environ.update(numeric_environment())
    from app.compute.protocol import read_request
    from app.compute.runtime import Events, start_control
    from app.core.process_job import create_process_job
    from pathlib import Path
    events = None
    job = None
    stream = os.fdopen(os.dup(sys.stdout.fileno()), "wb", buffering=0)
    os.dup2(sys.stderr.fileno(), sys.stdout.fileno())
    try:
        request = read_request(sys.argv[1])
        # 包络任务在进入 CAD 前就创建带内存上限的 Job；资源守卫复用该 Job，避免 Windows 进程重复入 Job。
        envelope_budget = int(os.environ.get("SAT_LAYOUT_ENVELOPE_MEMORY_BUDGET", "0"))
        job = create_process_job(envelope_budget if request.operation == "envelope.generate" else 0)
        if request.operation == "envelope.generate":
            os.environ["SAT_LAYOUT_ENVELOPE_JOB_BOUND"] = "1"
        events = Events(request, stream)
        events.emit("started", {"operation": request.operation, "pid": os.getpid()})
        from app.compute.monitoring import configure, stage, finish_lane
        configure(lambda value: events.emit("progress", {"monitor": value}),
                  progress_sink=lambda value: events.emit("progress", value))
        stage("校验输入文件")
        cancellation = start_control(events)
        paths = request.verify_inputs()
        if cancellation.is_set():
            raise InterruptedError("任务已取消")
        Path(request.output_root).mkdir(parents=True, exist_ok=False)
        # 固定预览及包络数值准备不能初始化 CAD；线程池只服务确实需要源几何的操作。
        needs_cad = request.operation in {"preview.generate", "envelope.generate", "installation.project",
                                          "envelope.preview", "fairing.generate", "history.export", "fixed.reference"}
        if request.operation == "layout.prepare":
            import json
            needs_cad = not json.loads(paths["metadata"].read_text(encoding="utf-8")).get("envelope_only", False)
        stage("初始化计算依赖与 CAD 线程池")
        if needs_cad and os.environ.get("SAT_LAYOUT_CAD_THREADS"):
            from OCP.OSD import OSD_ThreadPool, OSD_Parallel
            threads = int(os.environ["SAT_LAYOUT_CAD_THREADS"])
            if threads < 1:
                raise ValueError("CAD 线程数必须为正整数")
            OSD_Parallel.SetUseOcctThreads_s(True)
            pool = OSD_ThreadPool.DefaultPool_s(threads)
            pool.Init(threads)
            pool.SetNbDefaultThreadsToLaunch(threads)
        from app.compute.operations import execute
        state, result = execute(request, paths, events.emit, cancellation.is_set, events.checkpoint)
        if cancellation.is_set():
            state = "cancelled"
        finish_lane()
        events.emit(state, {"result": result, "checkpoint": events.last_checkpoint})
        return 0 if state == "completed" else 2
    except InterruptedError:
        if events:
            events.emit("cancelled", {"forced": False, "checkpoint": events.last_checkpoint})
        return 2
    except Exception as error:
        from app.compute.errors import failure_data
        failure = failure_data(error)
        if events is None:
            print(failure["traceback"], file=sys.stderr)
        if events:
            events.emit("failed", {**failure, "checkpoint": events.last_checkpoint})
        return 1
    finally:
        _ = job
        stream.close()


if __name__ == "__main__":
    code = main()
    sys.stdout.flush()
    sys.stderr.flush()
    # CAD 的解释器析构缺陷已有确认；正常数值和 CAD 入口使用同一可预测退出语义。
    os._exit(code)
