"""文件说明：按操作按需加载数值搜索、历史微调与 CAD，避免交互任务初始化无关依赖；结果只写任务暂存目录。"""

from app.compute.monitoring import observed, stage, object_context


from contextlib import nullcontext
import json
from pathlib import Path
import sys
import time

from app.compute.files import file_ref, write_json


@observed("布局准备与校验")
def prepare(request, paths, emit, cancelled, checkpoint):
    """从只读模型副本准备精确基准与数值快照；不访问模型数据库。"""
    from app.compute.snapshot import SnapshotStore, write_snapshot
    from app.schemas.layout_optimization import ResolvedLayoutParameters
    if request.payload:
        raise ValueError("layout.prepare 的 payload 必须为空")
    metadata = json.loads(paths["metadata"].read_text(encoding="utf-8"))
    parameters = ResolvedLayoutParameters.model_validate(metadata["parameters"])
    emit("progress", {"phase": "prepare"})
    envelope_only = metadata.get("envelope_only", False)
    if envelope_only:
        from app.domain.envelope_layout_models import load_envelope_satellites
        models = load_envelope_satellites(SnapshotStore(metadata, paths), parameters.satellites, cancelled)
    else:
        from app.domain.layout_models import load_satellites
        models = load_satellites(SnapshotStore(metadata, paths), parameters.satellites, cancelled)
    if cancelled():
        raise InterruptedError("任务已取消")
    path = write_snapshot(Path(request.output_root) / "prepared", models, parameters)
    if not envelope_only:
        from app.compute.geometry_operations import write_history
        write_history(Path(request.output_root) / "history", models)
    result = {"snapshot": file_ref(request.output_root, path), "instances": len(models),
              "cad_loaded": any(name == "cadquery" or name.startswith("OCP.") for name in sys.modules)}
    if envelope_only and metadata.get("fixed_preview"):
        from app.compute.fixed_operations import evaluate_fixed
        from app.schemas.fixed_constraints import FixedConstraintsPayload
        result["fixed_result"] = evaluate_fixed(models, parameters,
            FixedConstraintsPayload.model_validate(metadata["fixed_preview"]), cancelled, checkpoint)
    return result


@observed("布局求解")
def solve(request, paths, emit, cancelled, checkpoint):
    """在同一规划器下运行串行或有界多进程求解，发布已验收候选检查点并返回分阶段计时。"""
    started = time.perf_counter()
    from app.compute.parallel import OrderedPool
    from app.compute.config import COMPUTE_CONFIG
    from app.domain.layout_mount_cache import mount_cache
    from app.compute.resources import ResourcePlan, ResourceMonitor
    from app.compute.snapshot import read_snapshot
    from app.domain.layout_config import LAYOUT_CONFIG
    from app.domain.layout_geometry import validate_layout
    from app.domain.layout_solver import LayoutSearchCancelled, optimize_layout
    if set(request.payload) - {"attempt_limit", "resource_plan"}:
        raise ValueError("layout.solve 包含未知参数")
    resource_plan = request.payload.get("resource_plan")
    if resource_plan is not None:
        resource_plan = ResourcePlan.model_validate(resource_plan)
        if resource_plan.workers != request.workers:
            raise ValueError("layout.solve 资源计划无效")
    budget = request.payload.get("attempt_limit", LAYOUT_CONFIG["max_attempts_per_round"])
    if type(budget) is not int or not 1 <= budget <= LAYOUT_CONFIG["max_attempts_per_round"]:
        raise ValueError("隔离试次预算必须为正整数且不得超过正式预算")
    manifest = paths["snapshot"]
    verified = {path: request.inputs[name].model_dump() for name, path in paths.items()}
    # 数组引用相对于快照目录，协议路径相对于输入根；统一为同一相对语义再交叉核对。
    verified = {path: {**reference, "path": path.relative_to(manifest.parent).as_posix()}
                for path, reference in verified.items() if path.is_relative_to(manifest.parent)}
    models, parameters = read_snapshot(manifest, verified)
    loaded = time.perf_counter()
    progress = {}

    def report(value):
        """记录最后一次进度，并仅发布标量元数据；网格始终留在数值文件中。"""
        progress.update(value)
        emit("progress", value)

    monitor = ResourceMonitor(resource_plan, lambda value: emit("progress", value)) if resource_plan else None
    context = OrderedPool(manifest, request.workers, cancelled, monitor) if request.workers > 1 or monitor else nullcontext(None)
    state = "completed"
    original_budget = LAYOUT_CONFIG["max_attempts_per_round"]
    with context as pool, mount_cache(COMPUTE_CONFIG["mount_cache_bytes"]):
        ready = time.perf_counter()
        emit("progress", {"phase": "validate", "worker_pids": pool.pids if pool else [],
                          "workers": request.workers,
                          "resource_plan": resource_plan.model_dump() if resource_plan else None})
        LAYOUT_CONFIG["max_attempts_per_round"] = budget
        try:
            candidates = optimize_layout(models, parameters, report, cancelled, attempt_runner=pool,
                                         candidate_report=checkpoint)
        except LayoutSearchCancelled as error:
            state, candidates = "cancelled", error.candidates
        finally:
            LAYOUT_CONFIG["max_attempts_per_round"] = original_budget
        searched = time.perf_counter()
        if monitor:
            monitor.target(pool.members, True)
    validations = [validate_layout(candidate, models, parameters) for candidate in candidates]
    if not all(item["valid"] for item in validations):
        raise RuntimeError("候选未通过独立完整验收")
    checkpoint(candidates)
    return {"state": state, "candidates": candidates, "validations": validations, "progress": progress,
            "attempt_limit": budget, "workers": request.workers,
            "resource_plan": resource_plan.model_dump() if resource_plan else None,
            "resources_observed": monitor.stats if monitor else {},
            "parameters": parameters.model_dump(),
            "timings": {"load_seconds": loaded - started, "pool_seconds": ready - loaded,
                        "search_seconds": searched - ready, "total_seconds": time.perf_counter() - started},
            "cad_loaded": any(name == "cadquery" or name.startswith("OCP.") for name in sys.modules),
            "fastapi_loaded": "fastapi" in sys.modules}


@observed("CAD 计算")
def cad(request, paths, emit, cancelled, checkpoint):
    """在本进程隔离调用现有预览或包络算法；不可协作的原生调用由宿主取消宽限处理。"""
    if request.payload:
        raise ValueError("CAD 操作的 payload 必须为空，参数由带摘要的 metadata 资源提供")
    metadata = json.loads(paths["metadata"].read_text(encoding="utf-8"))
    target = Path(request.output_root) / "artifacts"
    object_context(model_id=metadata["model"].get("id"),
                   model_name=metadata["model"].get("settings", {}).get("device_name") or metadata["model"].get("filename"),
                   face_id=metadata["model"].get("settings", {}).get("installation_face_id"),
                   file=str(paths["source"]))
    stage("加载模型计算参数", operation=request.operation)
    emit("progress", {"phase": request.operation})
    if request.operation == "preview.generate":
        from app.domain.model_artifacts import generate_model_artifacts
        generate_model_artifacts(paths["source"], target, metadata["model"], metadata["quality"], metadata["parameters"])
    else:
        from app.domain.model_envelope import generate_model_envelope
        from app.domain.envelope_progress import envelope_progress
        import os
        os.environ["SAT_LAYOUT_ENVELOPE_ISOLATED"] = "1"
        source = paths["source"].stat()
        with envelope_progress(emit):
            generate_model_envelope(paths["source"], target, metadata["model"],
                                    metadata.get("source") or {"format": "STEP", "role": "authoritative", "size": source.st_size,
                                     "modified_ns": source.st_mtime_ns}, metadata["parameters"],
                                    paths["envelope_manifest"].parent if "envelope_manifest" in paths else None)
    if cancelled():
        raise InterruptedError("任务已取消")
    return {"manifest": file_ref(request.output_root, target / "manifest.json")}


@observed("计算操作分派")
def execute(request, paths, emit, cancelled, checkpoint):
    """按固定操作名分派，不允许任务指定任意模块、可执行文件或生产数据库路径。"""
    stage("加载计算模块")
    operation = {"layout.prepare": prepare, "layout.solve": solve,
                 "preview.generate": cad, "envelope.generate": cad}.get(request.operation)
    if request.operation == "layout.refine":
        from app.compute.refinement_operations import refine
        operation = refine
    elif request.operation == "fixed.preview":
        from app.compute.fixed_operations import fixed_preview
        operation = fixed_preview
    elif request.operation == "fixed.reference":
        from app.domain.envelope_installation import prepare_reference
        operation = prepare_reference
    elif request.operation == "fixed.display":
        from app.domain.fixed_display_mesh import prepare_fixed_display
        operation = prepare_fixed_display
    if operation is None:
        from app.compute.geometry_operations import execute_geometry
        operation = execute_geometry
    result = operation(request, paths, emit, cancelled, checkpoint)
    stage("整理计算产物")
    root = Path(request.output_root)
    result["resources"] = [file_ref(root, path) for folder in ("prepared", "artifacts", "history")
                           for path in sorted((root / folder).rglob("*")) if path.is_file()]
    path = Path(request.output_root) / "result.json"
    write_json(path, result)
    return result.get("state", "completed"), file_ref(request.output_root, path)
