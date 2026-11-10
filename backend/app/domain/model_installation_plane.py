"""文件说明：辨认 STEP 中几何上真正的平面，包括由样条或Bezier表示的平面；供共面区域提取使用。"""

import numpy as np


def is_geometric_plane(face):
    """按解析类型或全部控制点的仿射维度判断平面，不以离散采样或毫米容差抹平真实曲率。"""
    kind = face.geomType()
    if kind == "PLANE":
        return True
    if kind not in {"BSPLINE", "BEZIER"}:
        return False
    surface = face._geomAdaptor()
    points = np.array([surface.Pole(i, j).Coord()
                       for i in range(1, surface.NbUPoles() + 1)
                       for j in range(1, surface.NbVPoles() + 1)])
    centered = points - points[0]
    singular = np.linalg.svd(centered, compute_uv=False)
    tolerance = singular[0] * max(centered.shape) * np.finfo(float).eps
    return np.count_nonzero(singular > tolerance) == 2
