"""文件说明：为 Rust 宿主提供精确投影、预览转换、正式包络导出、整流舱几何与历史导出计算。

只读取协议已验证的输入副本，仅写任务暂存输出；不读写业务数据库或正式模型目录。
"""

from app.compute.monitoring import observed, stage, object_context


import json
from pathlib import Path

from app.compute.files import write_json
from app.compute.mesh_binary import history_mesh_binary


@observed("保存模型历史快照")
def write_history(directory, models):
    """将准备后的包络逆变换至当前模型坐标并保存兼容旧历史的 NPZ，本体坐标保持当前定义。"""
    import numpy as np
    directory.mkdir(parents=True, exist_ok=True)
    for model in {item.record_id: item for item in models}.values():
        inverse = np.linalg.inv(model.source_to_envelope)
        arrays = {"vertices": model.vertices @ inverse[:3, :3].T + inverse[:3, 3], "faces": model.faces}
        if model.body_vertices is not None:
            arrays["body_vertices"] = model.body_vertices
        np.savez_compressed(directory / f"{model.record_id}.npz", **arrays)


@observed("安装面精确投影")
def project(metadata, paths, target):
    """校验可见面与曲面点约束并投影至精确 STEP；返回归一化安装点，不保存业务设置。"""
    from app.domain.model_installation import read_installation_reference
    face_id, point = metadata["face_id"], metadata["point"]
    mapping = json.loads(paths["mapping"].read_text(encoding="utf-8"))
    entries = mapping.get("entries")
    if not isinstance(entries, list) or any(not isinstance(item, dict) for item in entries):
        raise ValueError("安装面映射不可用，请重新加载预览")
    entry = next((item for item in entries if item.get("step_face_id") == face_id), None)
    if entry is None:
        raise ValueError("安装面不属于当前模型的可见外壳")
    if entry.get("surface_type") != "PLANE" and point is None:
        raise ValueError("曲面安装必须在预览中点击并保存安装点")
    if point is not None:
        reference, _ = read_installation_reference(
            paths["source"], face_id, source_point=point,
            preview_linear_ratio=metadata.get("linear_ratio"),
            cached_faces_path=paths.get("faces"), preview_tolerance=metadata.get("tolerance"),
        )
        point = {axis: float(reference[index]) for index, axis in enumerate("xyz")}
    return {"installation_point": point}


@observed("生成包络显示资源")
def envelope_preview(metadata, paths, target):
    """从已声明 NPZ 和原模型 GLB 计算当前模型坐标预览，并返回数组规模供固化元数据使用。"""
    import numpy as np
    from app.domain.model_envelope import build_envelope_preview_glb
    path = target / "preview.glb"
    path.write_bytes(build_envelope_preview_glb(paths["envelope"], paths["preview"], metadata["settings"]))
    with np.load(paths["envelope"], allow_pickle=False) as mesh:
        counts = {"vertex_count": len(mesh["vertices"]), "face_count": len(mesh["faces"])}
    return {"counts": counts}


@observed("导出正式包络 STL")
def envelope_export_stl(metadata, paths, target):
    """从声明的正式 NPZ 写出二进制 STL；不使用可能降低精度的预览 GLB 或访问生产目录。"""
    from app.domain.envelope_export import write_envelope_stl
    if metadata:
        raise ValueError("STL 导出不接受几何变换参数")
    return write_envelope_stl(paths["envelope"], target / "envelope.stl")


@observed("生成整流罩几何")
def fairing(metadata, paths, target):
    """在暂存目录构建精确整流罩外形 STEP；安装筒和质心约束只作为独立元数据传入。"""
    from app.domain.fairing_segment import FairingSegmentService
    return {"geometry": FairingSegmentService(target).build_fairing_segment(
        metadata["radius_mm"], metadata["height_mm"],
        metadata.get("centroid_max_offset_mm", metadata.get("axis_radius_mm")), metadata.get("profile"))}


@observed("读取历史网格")
def history_meshes(metadata, paths, target):
    """解码已声明的历史 NPZ 到兼容前端 JSON 文件，避免大数组进入标准输出。"""
    import numpy as np
    meshes = {}
    for record_id, resource in metadata["snapshots"].items():
        with np.load(paths[resource], allow_pickle=False) as data:
            meshes[record_id] = {"vertices": data["vertices"].tolist(), "faces": data["faces"].tolist()}
    write_json(target / "meshes.json", {"meshes": meshes})
    return {}


@observed("导出布局 Excel")
def history_export(metadata, paths, target):
    """使用历史本体快照或摘要一致的声明源文件生成 Excel；不访问生产模型库。"""
    import shutil
    from app.compute.snapshot import SnapshotStore
    from app.compute.files import within
    from app.domain.layout_export import export_candidate_workbook
    snapshots = target / "snapshots"
    snapshots.mkdir()
    for record_id, resource in metadata["snapshots"].items():
        shutil.copy2(paths[resource], within(snapshots, f"{record_id}.npz"))
    content = export_candidate_workbook(metadata["job"], metadata["candidate_id"], snapshots,
                                        SnapshotStore(metadata, paths))
    (target / "installation.xlsx").write_bytes(content)
    return {}


@observed("几何操作")
def execute_geometry(request, paths, emit, cancelled, checkpoint):
    """固定分派几何操作，参数只从带摘要的 metadata 读取，取消后禁止返回成功结果。"""
    if request.payload:
        raise ValueError("几何操作 payload 必须为空")
    metadata = json.loads(paths["metadata"].read_text(encoding="utf-8"))
    target = Path(request.output_root) / "artifacts"
    target.mkdir(parents=True)
    emit("progress", {"phase": request.operation})
    operation = {"installation.project": project, "envelope.preview": envelope_preview,
                 "envelope.export-stl": envelope_export_stl,
                 "fairing.generate": fairing, "history.meshes": history_meshes,
                 "history.mesh-binary": history_mesh_binary, "history.export": history_export}
    result = operation[request.operation](metadata, paths, target)
    if cancelled():
        raise InterruptedError("任务已取消")
    return result
