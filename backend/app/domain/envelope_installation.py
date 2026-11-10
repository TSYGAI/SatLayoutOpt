"""文件说明：固化或缓存维护时提取共面安装区域、安装基准及本体支撑点；允许解析源模型，固定预览仅消费数值缓存。"""

from app.compute.monitoring import observed, stage, object_context


import numpy as np

from app.core.config import runtime_config


def build_envelope_installation(source, settings, source_sha256, envelope_sha256):
    """提取当前模型坐标安装区域、本体凸包和包络坐标安装点及法向，返回 v3 缓存，不修改源文件。"""
    from scipy.spatial import ConvexHull
    from app.domain.model_envelope import envelope_current_transform, load_step_triangle_mesh
    from app.domain.coordinate_frame import initial_to_current_matrix
    from app.domain.model_installation import read_installation_reference
    from app.domain.layout_config import LAYOUT_CONFIG
    mesh = load_step_triangle_mesh(source,
        linear_ratio=runtime_config.model_envelope_step_linear_ratio,
        minimum_linear_tolerance_mm=runtime_config.model_envelope_step_min_linear_tolerance_mm,
        angular_degrees=runtime_config.model_envelope_step_angular_degrees)
    frame = initial_to_current_matrix(settings.get("coordinate_frame"))
    mesh.apply_transform(frame)
    transform = envelope_current_transform(mesh, settings)
    point, normal, region = read_installation_reference(source, settings.get("installation_face_id"), transform @ frame,
        settings.get("installation_point"), include_region=True, plane_tolerance=LAYOUT_CONFIG["geometry_tolerance_mm"])
    inverse = np.linalg.inv(transform)
    region = region @ inverse[:3, :3].T + inverse[:3, 3]
    return {"version": 3, "region_rule": "all_geometric_planes_v1", "model_coordinate_space": "current_model_v1", "settings": settings, "source_sha256": source_sha256,
            "envelope_sha256": envelope_sha256, "source_to_envelope": transform.tolist(),
            "face_center": point.tolist(), "face_normal": normal.tolist(),
            "installation_plane_vertices": region.tolist(),
            "body_hull_vertices": mesh.vertices[ConvexHull(mesh.vertices).vertices].tolist()}


@observed("生成包络安装基准")
def prepare_reference(request, paths, emit, cancelled, checkpoint):
    """为已固化快照生成安装基准；后台队列可单独发布基准后再生成显示文件，旧调用保持兼容。"""
    import json
    from pathlib import Path
    from app.compute.files import write_json
    metadata = json.loads(paths["metadata"].read_text(encoding="utf-8"))
    if not metadata["settings"].get("installation_face_id"):
        return {"reference": None}
    value = build_envelope_installation(paths["source"], metadata["settings"],
                                        metadata["source_sha256"], metadata["envelope_sha256"])
    write_json(Path(request.output_root) / "artifacts/envelope-installation.json", value)
    result = {"reference": "artifacts/envelope-installation.json"}
    if 'envelope' in paths and metadata.get('build_display', True):
        from app.domain.fixed_display_mesh import build_fixed_display, FixedDisplayBudgetError
        try:
            build_fixed_display(paths['envelope'], value, Path(request.output_root) / 'artifacts', metadata['max_bytes'])
        except FixedDisplayBudgetError as error:
            result['display_unavailable'] = str(error)
    return result
