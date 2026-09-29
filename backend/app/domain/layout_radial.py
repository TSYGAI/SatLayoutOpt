"""文件说明：按侧挂截面的勾股关系计算舱体半径与安装径向范围，统一预检查和搜索边界。

输入必须已将指定安装面法向对准 -X；尺寸来自正式安全包络，不改模型、用户参数或安装姿态。
"""

from dataclasses import dataclass
import math

from app.domain.layout_config import LAYOUT_CONFIG


@dataclass(frozen=True)
class SideMountRadialLimits:
    """保存毫米制径向截面及边界；偏心包络用最远切向偏距代替居中矩形的半宽。"""

    outward_depth_mm: float
    tangential_extent_mm: float
    min_suspension_mm: float
    max_suspension_mm: float
    max_face_radius_mm: float
    center_offset_mm: float

    @property
    def max_radius_mm(self) -> float:
        """返回 r_max = sqrt(R²-b²)-t-s；悬高区间不允许包络内伸时返回负无穷。"""
        if self.min_suspension_mm > self.max_suspension_mm + LAYOUT_CONFIG["geometry_tolerance_mm"]:
            return -math.inf
        return self.max_face_radius_mm - self.min_suspension_mm

    def center_radius_bounds(self, radius: float) -> tuple[float, float]:
        """由给定舱半径返回包络盒中心的径向分量区间；下界大于上界表示无法安装。"""
        lower = radius + self.min_suspension_mm + self.center_offset_mm
        upper = min(radius + self.max_suspension_mm, self.max_face_radius_mm) + self.center_offset_mm
        if lower <= upper + LAYOUT_CONFIG["geometry_tolerance_mm"]:
            upper = max(lower, upper)
        return lower, upper

    def required_fairing_radius(self, radius: float) -> float:
        """返回给定舱半径和最小有效悬高所需的罩半径，用于说明径向冲突。"""
        return math.hypot(radius + self.min_suspension_mm + self.outward_depth_mm, self.tangential_extent_mm)


def side_mount_radial_limits(model, parameters) -> SideMountRadialLimits:
    """从定向后的正式包络提取 t、b 和 s，返回勾股条件 (r+s+t)²+b²<=R² 对应边界。

    包络居中时 b=w/2，否则取安装面中心至左右边界的较大距离；内伸量形成最小悬高。
    切向偏距大于罩半径时无实数解，将安装面半径上限置为负无穷，不缩小包络。
    """
    outward = float(model.upper[0] - model.face_center[0])
    tangential = float(max(abs(model.lower[1] - model.face_center[1]), abs(model.upper[1] - model.face_center[1])))
    suspension = float(max(parameters.min_suspension_mm, model.face_center[0] - model.lower[0]))
    squared = parameters.fairing_radius_mm ** 2 - tangential ** 2
    face_limit = math.sqrt(squared) - outward if squared >= 0 else -math.inf
    return SideMountRadialLimits(
        outward_depth_mm=outward, tangential_extent_mm=tangential,
        min_suspension_mm=suspension, max_suspension_mm=parameters.max_suspension_mm,
        max_face_radius_mm=face_limit,
        center_offset_mm=float((model.upper[0] + model.lower[0]) / 2 - model.face_center[0]),
    )
