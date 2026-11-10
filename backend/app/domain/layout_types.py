"""文件说明：定义仅依赖 NumPy 的布局输入类型，使独立数值工作进程无需导入 STEP/OCC 加载器。"""

from dataclasses import dataclass

import numpy as np

from app.core.config import runtime_config


@dataclass(frozen=True)
class LayoutSatellite:
    """保存毫米包络、当前模型坐标本体、安装区域及支撑点；source_to_envelope 表示当前模型到包络的矩阵。"""

    instance_id: str
    record_id: str
    name: str
    mass: float
    center: np.ndarray
    vertices: np.ndarray
    faces: np.ndarray
    footprint: np.ndarray
    lower: np.ndarray
    upper: np.ndarray
    volume: float
    source_sha256: str
    envelope_sha256: str
    source_to_envelope: np.ndarray
    installation_face_id: str
    face_center: np.ndarray
    face_normal: np.ndarray
    body_vertices: np.ndarray | None = None
    up_orientation: str = runtime_config.model_settings_default_front_orientation
    body_faces: np.ndarray | None = None
    body_hull_vertices: np.ndarray | None = None
    installation_plane_vertices: np.ndarray | None = None
