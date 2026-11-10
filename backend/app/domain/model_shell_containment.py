"""文件说明：用 OpenCascade 精确实体分类和边界距离确认预览面是否完全内含。

仅为外壳筛选提供保守删面依据，不修改 STEP、面编号或离散网格；不确定时保留面。
"""

from __future__ import annotations

import math


def _bounds(shape: object) -> tuple[tuple[float, ...], tuple[float, ...]]:
    """读取 CadQuery 形状包围盒，返回最小与最大坐标供快速排除非内含实体。"""

    box = shape.BoundingBox()
    return (box.xmin, box.ymin, box.zmin), (box.xmax, box.ymax, box.zmax)


class FaceContainmentChecker:
    """缓存封闭实体边界，为连通有效面提供严格内含检查；实例只在单次筛选中使用。"""

    def __init__(self, solids: list[object], tolerance: float) -> None:
        """缓存实体包围盒、所有壳边界和分类器；无效、开放或反向实体不作为删面依据。"""

        import cadquery as cq
        from OCP.BRepClass3d import BRepClass3d_SolidClassifier
        from OCP.TopAbs import TopAbs_OUT

        self.tolerance = tolerance
        self.regions = []
        for solid in solids:
            try:
                shells = solid.Shells()
                if not shells or not solid.isValid() or any(not shell.Closed() for shell in shells):
                    continue
                classifier = BRepClass3d_SolidClassifier(solid.wrapped)
                classifier.PerformInfinitePoint(tolerance)
                if classifier.State() != TopAbs_OUT:
                    continue
                boundary = shells[0] if len(shells) == 1 else cq.Compound.makeCompound(shells)
                self.regions.append((_bounds(solid), boundary.wrapped, classifier))
            except Exception:
                continue

    def contains(self, face: object) -> bool:
        """仅在整张面严格位于某个实体内部时返回真；接触、相交和计算失败均返回假。

        面上的精确顶点必须位于实体内，且整张面到实体所有边界的最短距离大于公差。
        有效连通面若存在外露区域，必穿过实体边界，因而不能通过该检查；不使用粗网格中心分类。
        """

        from OCP.BRep import BRep_Tool
        from OCP.BRepExtrema import BRepExtrema_DistShapeShape
        from OCP.TopAbs import TopAbs_IN

        try:
            lower, upper = _bounds(face)
            vertices = face.Vertices()
            if not vertices or not face.isValid():
                return False
            point = BRep_Tool.Pnt_s(vertices[0].wrapped)
            for (solid_lower, solid_upper), boundary, classifier in self.regions:
                if any(lower[axis] <= solid_lower[axis] + self.tolerance
                       or upper[axis] >= solid_upper[axis] - self.tolerance for axis in range(3)):
                    continue
                classifier.Perform(point, self.tolerance)
                if classifier.State() != TopAbs_IN:
                    continue
                # 必须对壳边界求距离；对实心体求距离会把内部面直接报告为零距离。
                distance = BRepExtrema_DistShapeShape(face.wrapped, boundary)
                if distance.IsDone() and distance.NbSolution() > 0:
                    value = distance.Value()
                    if math.isfinite(value) and value > self.tolerance:
                        return True
        except Exception:
            return False
        return False
