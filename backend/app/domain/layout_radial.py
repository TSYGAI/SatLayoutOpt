"""文件说明：以真实三角包络的筒壁首次接触为零悬高，计算侧挂半径上界；共面基准只定位方向。

输入必须已将指定安装面法向对准 -X；尺寸来自正式安全包络，不改模型、用户参数或安装姿态。
"""

from dataclasses import dataclass
from functools import cached_property
import math
import numpy as np

from app.domain.layout_config import LAYOUT_CONFIG
from app.domain.layout_contact import contact_offset, projected_clearance, surface_segments
from app.domain.layout_mount_cache import cached_mount


@dataclass(frozen=True)
class SideMountRadialLimits:
    """保存毫米制径向截面及边界；偏心包络用最远切向偏距代替居中矩形的半宽。"""

    outward_depth_mm: float
    tangential_extent_mm: float
    min_suspension_mm: float
    max_suspension_mm: float
    max_face_radius_mm: float
    center_offset_mm: float
    projected_points: np.ndarray | None = None
    mesh_faces: np.ndarray | None = None
    contact_segments: tuple[np.ndarray, np.ndarray] | None = None

    @cached_property
    def max_radius_mm(self) -> float:
        """把包络放到罩内允许的最外位置，返回该位置真实投影可容纳的筒半径；不要求安装平面贴筒。"""
        if self.min_suspension_mm > self.max_suspension_mm + LAYOUT_CONFIG["geometry_tolerance_mm"]:
            return -math.inf
        if not math.isfinite(self.max_face_radius_mm):
            return -math.inf
        if self.mesh_faces is not None:
            points = np.column_stack((self.projected_points, np.zeros(len(self.projected_points))))
            points[:, 0] += self.max_face_radius_mm - self.min_suspension_mm
            return projected_clearance(points, self.mesh_faces)
        return self.max_face_radius_mm - self.min_suspension_mm

    def contact_reference_radius(self, radius: float) -> float:
        """返回给定筒半径时方向基准的零悬高径向坐标，可小于筒半径。"""
        return contact_offset(*self.contact_segments, radius) if self.contact_segments is not None else radius

    def center_radius_bounds(self, radius: float) -> tuple[float, float]:
        """由给定舱半径返回包络盒中心的径向分量区间；下界大于上界表示无法安装。"""
        contact = self.contact_reference_radius(radius)
        if not math.isfinite(contact):
            return math.inf, -math.inf
        lower = contact + self.min_suspension_mm + self.center_offset_mm
        upper = min(contact + self.max_suspension_mm, self.max_face_radius_mm) + self.center_offset_mm
        if lower <= upper + LAYOUT_CONFIG["geometry_tolerance_mm"]:
            upper = max(lower, upper)
        return lower, upper

    def required_fairing_radius(self, radius: float) -> float:
        """返回给定舱半径和最小有效悬高所需的罩半径，用于说明径向冲突。"""
        if self.projected_points is not None:
            contact = self.contact_reference_radius(radius)
            return float(np.linalg.norm(self.projected_points + [contact + self.min_suspension_mm, 0], axis=1).max())
        return math.hypot(radius + self.min_suspension_mm + self.outward_depth_mm, self.tangential_extent_mm)


def side_mount_radial_limits(model, parameters) -> SideMountRadialLimits:
    """在单次求解的有界几何缓存中复用真实接触截面；参数或模型变化时重新计算，普通调用不保留输入。"""
    key = (parameters.fairing_radius_mm, parameters.min_suspension_mm, parameters.max_suspension_mm)

    def compute(source, kind, values):
        """为缓存创建指定模型和毫米参数的接触限制，忽略仅用于区分缓存类型的 kind。"""
        return _side_mount_radial_limits(source, parameters)

    return cached_mount(model, "side_radial_limits", key, compute)


def _side_mount_radial_limits(model, parameters) -> SideMountRadialLimits:
    """逐点确定罩内最大平移，逐真实三角面确定筒壁接触；两者共同约束筒半径和沿法向退让量。

    b 为包络相对共面方向基准的最大切向偏距；平面到包络内沿的距离不再强加为最小悬高。
    切向偏距大于罩半径时无实数解，将安装面半径上限置为负无穷，不缩小包络。
    """
    outward = float(model.upper[0] - model.face_center[0])
    tangential = float(max(abs(model.lower[1] - model.face_center[1]), abs(model.upper[1] - model.face_center[1])))
    suspension = float(parameters.min_suspension_mm)
    points = model.vertices[:, :2] - model.face_center[:2]
    squared = parameters.fairing_radius_mm ** 2 - points[:, 1] ** 2
    face_limit = float(np.min(np.sqrt(np.maximum(squared, 0)) - points[:, 0])) if np.all(squared >= 0) else -math.inf
    return SideMountRadialLimits(
        outward_depth_mm=outward, tangential_extent_mm=tangential,
        min_suspension_mm=suspension, max_suspension_mm=parameters.max_suspension_mm,
        max_face_radius_mm=face_limit,
        center_offset_mm=float((model.upper[0] + model.lower[0]) / 2 - model.face_center[0]),
        projected_points=points,
        mesh_faces=model.faces,
        contact_segments=surface_segments(model.vertices - model.face_center, model.faces),
    )
