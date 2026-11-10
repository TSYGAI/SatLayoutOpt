"""文件说明：从全部实际共面区域确定方向定位基准并映射安装范围，供模型加载、固定预览和布局验收共用。"""

from dataclasses import replace

import numpy as np

from app.domain.layout_config import LAYOUT_CONFIG


def with_region_reference(model):
    """返回以全部共面范围中点为坐标基准的副本；点击只选平面，中心不表示接触点，曲面保留局部基准。

    平面坐标轴优先采用模型向上轴的投影；退化时采用当前模型坐标轴，避免结果随点击位置或顶点密度改变。
    保留正式包络、共面支撑点和源变换，安装脚间的空隙不因此成为实体。
    """
    from app.domain.layout_mounts import model_up_direction
    region = installation_region(model, model.source_to_envelope)
    normal = model.face_normal / np.linalg.norm(model.face_normal)
    if np.max(np.abs((region - model.face_center) @ normal)) > LAYOUT_CONFIG["geometry_tolerance_mm"]:
        return model
    frame = model.source_to_envelope[:3, :3]
    up = model_up_direction(model)
    up = frame[:, 2].copy() if up is None else up
    up = up - (up @ normal) * normal
    if np.linalg.norm(up) <= LAYOUT_CONFIG["orientation_tolerance"]:
        axes = frame / np.linalg.norm(frame, axis=0)
        up = axes[:, int(np.argmin(np.abs(normal @ axes)))].copy()
        up -= (up @ normal) * normal
    up /= np.linalg.norm(up)
    axes = np.column_stack((normal, np.cross(up, normal), up))
    projected = region @ axes
    center = axes @ ((projected.min(axis=0) + projected.max(axis=0)) / 2)
    return replace(model, face_center=center)


def installation_region(model, matrix):
    """返回当前模型坐标安装区域经给定矩阵变换后的支撑点；缺失数据时拒绝用安装点或包络代替。"""
    points = model.installation_plane_vertices
    if points is None or len(points) < 3:
        raise ValueError(f"{model.name} 缺少共面安装区域，请重新生成安装基准缓存")
    matrix = np.asarray(matrix)
    return points @ matrix[:3, :3].T + matrix[:3, 3]


def relative_installation_heights(model):
    """返回已定向模型的共面安装区域相对安装基准点的最低和最高高度，不修改模型或安装点。"""
    points = installation_region(model, model.source_to_envelope)
    heights = points[:, 2] - model.face_center[2]
    return float(heights.min()), float(heights.max())
