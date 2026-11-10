"""
文件说明：定义模型相对初始 STEP 坐标系的用户坐标系，并提供严格的矩阵转换。
本模块只处理坐标系参数校验、初始坐标到当前坐标的刚体变换和方向变换，
不读取模型文件、不参与布局策略；包络和优化加载器复用这里的同一套约定。
"""

from __future__ import annotations

import math

import numpy as np


COORDINATE_FRAME_VERSION = 1
_AXES = ("x", "y", "z")


def default_coordinate_frame() -> dict:
    """返回与初始 STEP 坐标系重合的默认定义。"""

    return {
        "version": COORDINATE_FRAME_VERSION,
        "origin": {axis: 0.0 for axis in _AXES},
        "orientation": {
            "mode": "euler_xyz",
            "angles_deg": {axis: 0.0 for axis in _AXES},
        },
    }


def _finite_number(value: object, name: str) -> float:
    """校验并返回有限浮点数；布尔值不视为坐标。"""

    if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(float(value)):
        raise ValueError(f"坐标系{name}必须是有限数值")
    return float(value)


def normalize_coordinate_frame(value: object | None) -> dict:
    """规范化坐标系定义，缺省值表示初始坐标系。"""

    if value is None:
        value = default_coordinate_frame()
    if not isinstance(value, dict):
        raise ValueError("坐标系定义必须是对象")
    version = value.get("version")
    if type(version) is not int or version != COORDINATE_FRAME_VERSION or set(value) != {"version", "origin", "orientation"}:
        raise ValueError("坐标系定义版本不受支持")
    origin = value.get("origin")
    if not isinstance(origin, dict) or set(origin) != set(_AXES):
        raise ValueError("坐标系原点必须完整包含 x、y、z")
    orientation = value.get("orientation")
    if not isinstance(orientation, dict):
        raise ValueError("坐标轴方向定义无效")
    normalized_origin = {axis: _finite_number(origin[axis], f"原点 {axis.upper()}") for axis in _AXES}
    if orientation.get("mode") == "three_points":
        if set(orientation) != {"mode", "x_point", "xy_point"}:
            raise ValueError("三点定义必须包含 X 正向点和 XY 平面点")
        normalized_orientation = {"mode": "three_points"}
        for name in ("x_point", "xy_point"):
            point = orientation[name]
            if not isinstance(point, dict) or set(point) != set(_AXES):
                raise ValueError("参考点必须完整包含 x、y、z")
            normalized_orientation[name] = {axis: _finite_number(point[axis], name) for axis in _AXES}
        result = {"version": 1, "origin": normalized_origin, "orientation": normalized_orientation}
        _three_point_axes(result)
        return result
    if orientation.get("mode") != "euler_xyz" or set(orientation) != {"mode", "angles_deg"}:
        raise ValueError("坐标轴方向必须使用角度或三点定义")
    angles = orientation.get("angles_deg")
    if not isinstance(angles, dict) or set(angles) != set(_AXES):
        raise ValueError("坐标轴角度必须完整包含 x、y、z")
    return {
        "version": COORDINATE_FRAME_VERSION,
        "origin": normalized_origin,
        "orientation": {
            "mode": "euler_xyz",
            "angles_deg": {axis: _finite_number(angles[axis], f"{axis.upper()} 轴角度") for axis in _AXES},
        },
    }


def _three_point_axes(frame: dict) -> np.ndarray:
    """按原点、X 正向点和 XY 平面点构造右手正交轴；退化输入抛错。"""

    origin = np.array([frame["origin"][axis] for axis in _AXES])
    vectors = [np.array([frame["orientation"][name][axis] for axis in _AXES]) - origin
               for name in ("x_point", "xy_point")]
    normalized = []
    for vector in vectors:
        magnitude = float(np.max(np.abs(vector)))
        if not math.isfinite(magnitude) or magnitude == 0:
            raise ValueError("坐标系参考点不能与原点重合或超出数值范围")
        scaled = vector / magnitude
        normalized.append(scaled / np.linalg.norm(scaled))
    x_axis, plane = normalized
    z_axis = np.cross(x_axis, plane)
    length = np.linalg.norm(z_axis)
    if length <= np.finfo(float).eps * 64:
        raise ValueError("坐标系三个参考点不能共线或接近共线")
    z_axis /= length
    return np.column_stack((x_axis, np.cross(z_axis, x_axis), z_axis))


def _rotation_x(angle: float) -> np.ndarray:
    """返回绕 X 轴的列向量旋转矩阵。"""

    cosine, sine = math.cos(angle), math.sin(angle)
    return np.array([[1.0, 0.0, 0.0], [0.0, cosine, -sine], [0.0, sine, cosine]])


def _rotation_y(angle: float) -> np.ndarray:
    """返回绕 Y 轴的列向量旋转矩阵。"""

    cosine, sine = math.cos(angle), math.sin(angle)
    return np.array([[cosine, 0.0, sine], [0.0, 1.0, 0.0], [-sine, 0.0, cosine]])


def _rotation_z(angle: float) -> np.ndarray:
    """返回绕 Z 轴的列向量旋转矩阵。"""

    cosine, sine = math.cos(angle), math.sin(angle)
    return np.array([[cosine, -sine, 0.0], [sine, cosine, 0.0], [0.0, 0.0, 1.0]])


def frame_axes_in_initial(frame: object | None) -> np.ndarray:
    """返回当前坐标轴在初始坐标中的旋转矩阵。"""

    normalized = normalize_coordinate_frame(frame)
    if normalized["orientation"]["mode"] == "three_points":
        return _three_point_axes(normalized)
    angles = normalized["orientation"]["angles_deg"]
    radians = {axis: math.radians(float(angles[axis]) % 360) for axis in _AXES}
    return _rotation_z(radians["z"]) @ _rotation_y(radians["y"]) @ _rotation_x(radians["x"])


def initial_to_current_matrix(frame: object | None) -> np.ndarray:
    """返回把初始 STEP 坐标列向量转换到当前模型坐标的 4x4 矩阵。"""

    normalized = normalize_coordinate_frame(frame)
    axes = frame_axes_in_initial(normalized)
    origin = np.array([normalized["origin"][axis] for axis in _AXES], dtype=float)
    matrix = np.eye(4)
    matrix[:3, :3] = axes.T
    matrix[:3, 3] = -axes.T @ origin
    return matrix


def current_to_initial_matrix(frame: object | None) -> np.ndarray:
    """返回把当前模型坐标列向量转换回初始 STEP 坐标的 4x4 矩阵。"""

    return np.linalg.inv(initial_to_current_matrix(frame))


def transform_point(point: object, frame: object | None) -> np.ndarray:
    """把一个初始坐标点转换为当前模型坐标点。"""

    vector = np.asarray(point, dtype=float)
    if vector.shape != (3,) or not np.isfinite(vector).all():
        raise ValueError("坐标点必须是三个有限数值")
    matrix = initial_to_current_matrix(frame)
    return (matrix @ np.array([*vector, 1.0]))[:3]


def transform_direction(direction: object, frame: object | None) -> np.ndarray:
    """把一个初始坐标方向转换为当前模型方向，不应用原点平移。"""

    vector = np.asarray(direction, dtype=float)
    if vector.shape != (3,) or not np.isfinite(vector).all():
        raise ValueError("方向必须是三个有限数值")
    result = initial_to_current_matrix(frame)[:3, :3] @ vector
    norm = np.linalg.norm(result)
    if norm <= 1e-12:
        raise ValueError("方向向量长度不能为零")
    return result / norm
