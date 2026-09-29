"""
文件说明：用 B-Rep 方式构建自定义整流舱段（圆柱段）并导出 STEP 实体，供前置配置页预览与后续布局使用。
几何中轴固定与场景 Z 轴重合且穿过原点，圆柱沿 Z 轴居中（底面 z = -H/2、顶面 z = +H/2），
本模块只做几何构建、体积自检与文件落盘，不处理 HTTP，也不参与模型上传与包络流程。
"""

from __future__ import annotations

import math
from pathlib import Path
import shutil
from threading import RLock
from uuid import uuid4

from OCP.BRepAlgoAPI import BRepAlgoAPI_Fuse
from OCP.BRepGProp import BRepGProp
from OCP.BRepPrimAPI import BRepPrimAPI_MakeCylinder
from OCP.GProp import GProp_GProps
from OCP.gp import gp_Ax2, gp_Dir, gp_Pnt
from OCP.IFSelect import IFSelect_ReturnStatus
from OCP.STEPControl import STEPControl_AsIs, STEPControl_Reader, STEPControl_Writer

from app.core.config import runtime_config


STEP_FILE_NAME = "fairing-segment.step"
_VOLUME_TOLERANCE_RATIO = 1e-6


class FairingSegmentError(RuntimeError):
    """表示整流舱段构建或 STEP 导出失败，例如内核拒绝参数或磁盘写入失败。"""


class FairingSegmentService:
    """构建自定义整流舱段 B-Rep、导出 STEP 并维护最近一次的构件描述。"""

    def __init__(self, output_dir: Path | None = None) -> None:
        """创建整流舱段构件服务并确保输出目录存在。

        参数：
            output_dir: 可选输出目录，测试时用于隔离真实数据。
        副作用：
            创建构件输出目录。
        """

        project_root = Path(__file__).resolve().parents[3]
        self.output_dir = Path(
            output_dir or (project_root / runtime_config.pre_config_dir / runtime_config.pre_config_cylinder_subdir)
        )
        self._lock = RLock()
        self.output_dir.mkdir(parents=True, exist_ok=True)

    def build_fairing_segment(
        self,
        radius_mm: float,
        height_mm: float,
        axis_radius_mm: float | None = None,
    ) -> dict:
        """按尺寸与中轴半径构建整流舱段并导出 STEP。

        参数：
            radius_mm: 圆柱段底面半径，单位为毫米，必须为正数。
            height_mm: 圆柱段高度，单位为毫米，必须为正数。
            axis_radius_mm: 可选中轴（中心杆）半径，单位为毫米；必须为正数且小于圆柱半径。
        返回：
            含尺寸、体积、中轴半径与方向、包围盒及 STEP 文件路径的字典。
        异常：
            FairingSegmentError: 参数非法、中轴半径不小于圆柱半径、内核构造失败、体积自检不通过或文件写入失败。
        副作用：
            以原子替换方式覆盖输出目录下的 STEP 文件。
        """

        radius = float(radius_mm)
        height = float(height_mm)
        if not math.isfinite(radius) or not math.isfinite(height) or radius <= 0 or height <= 0:
            raise FairingSegmentError("整流舱段底面半径和高度必须是正的有限数值")
        axis_radius = _coerce_axis_radius(axis_radius_mm, radius)

        with self._lock:
            try:
                shape = _make_fairing_shape(radius, height, axis_radius)
                volume = _shape_volume(shape)
            except FairingSegmentError:
                raise
            except Exception as error:  # OCC 以通用异常报告内核失败
                raise FairingSegmentError(f"整流舱段 B-Rep 构建失败：{error}") from error
            _verify_volume(radius, height, volume, axis_radius)
            step_path = self._write_step(shape)

        return {
            "kind": "fairing_segment",
            "radius_mm": radius,
            "height_mm": height,
            "diameter_mm": radius * 2.0,
            "axis_radius_mm": axis_radius,
            "volume_mm3": volume,
            "axis": {
                "origin": [0.0, 0.0, 0.0],
                "direction": [0.0, 0.0, 1.0],
                "radius_mm": axis_radius,
            },
            "bounds": {
                "min": [-radius, -radius, -height / 2.0],
                "max": [radius, radius, height / 2.0],
            },
            "step_file_name": step_path.name,
            "step_size": step_path.stat().st_size,
        }

    def _write_step(self, shape: object) -> Path:
        """把 B-Rep 实体写入 STEP 文件，写入过程使用临时文件原子替换。

        参数：
            shape: OCC TopoDS_Shape 实体。
        返回：
            最终 STEP 文件路径。
        异常：
            FairingSegmentError: 内核导出失败或写入状态非成功。
        副作用：
            覆盖输出目录下的 STEP 文件。
        """

        target_path = self.output_dir / STEP_FILE_NAME
        temporary_path = self.output_dir / f".{uuid4().hex}.step.tmp"
        try:
            writer = STEPControl_Writer()
            writer.Transfer(shape, STEPControl_AsIs)
            status = writer.Write(str(temporary_path))
            if status != IFSelect_ReturnStatus.IFSelect_RetDone:
                raise FairingSegmentError(f"STEP 导出失败（状态 {status}）")
            temporary_path.replace(target_path)
        except FairingSegmentError:
            temporary_path.unlink(missing_ok=True)
            raise
        except Exception as error:
            temporary_path.unlink(missing_ok=True)
            raise FairingSegmentError(f"STEP 导出失败：{error}") from error
        return target_path

    def get_step_path(self) -> Path:
        """返回最近一次导出的 STEP 文件路径。

        异常：
            LookupError: 尚未生成过自定义整流舱段。
        """

        path = self.output_dir / STEP_FILE_NAME
        if not path.is_file():
            raise LookupError("尚未生成自定义整流舱段模型")
        return path

    def clear(self) -> None:
        """删除已生成的整流舱段 STEP 构件，用于测试清理或用户重置。"""

        with self._lock:
            shutil.rmtree(self.output_dir, ignore_errors=True)
            self.output_dir.mkdir(parents=True, exist_ok=True)


def _coerce_axis_radius(value: object, cylinder_radius: float) -> float:
    """把中轴半径规范化为正的有限数值，并确认它严格小于圆柱半径。

    参数：
        value: 中轴（中心杆）半径，单位为毫米；缺省时取统一配置的默认值，默认值不小于圆柱半径时
            收敛为圆柱半径的一半，避免小尺寸构件因默认值过大而无法构建。
        cylinder_radius: 圆柱段底面半径，单位为毫米。
    返回：
        可用的中轴半径，单位为毫米。
    异常：
        FairingSegmentError: 显式取值非正、非有限，或不小于圆柱半径。
    """

    if value is None:
        configured = float(runtime_config.default_axis_radius_mm)
        if not math.isfinite(configured) or configured <= 0:
            configured = cylinder_radius / 2.0
        return configured if configured < cylinder_radius else cylinder_radius / 2.0
    try:
        radius = float(value)
    except (TypeError, ValueError) as error:
        raise FairingSegmentError("中轴半径必须是正的有限数值") from error
    if not math.isfinite(radius) or radius <= 0:
        raise FairingSegmentError("中轴半径必须是正的有限数值")
    if radius >= cylinder_radius:
        raise FairingSegmentError(
            f"中轴半径必须小于整流舱段底面半径（{radius:g} ≥ {cylinder_radius:g} 毫米）"
        )
    return radius


def _make_fairing_shape(
    radius: float,
    height: float,
    axis_radius: float,
) -> object:
    """按原点中轴构建圆柱段并与中心杆合并。

    参数：
        radius: 底面半径，单位为毫米。
        height: 高度，单位为毫米。
        axis_radius: 中轴（中心杆）半径，单位为毫米。
    返回：
        OCC TopoDS_Shape 实体，底面位于 z = -H/2。
    """

    axis = gp_Ax2(gp_Pnt(0.0, 0.0, -height / 2.0), gp_Dir(0.0, 0.0, 1.0))
    shape = BRepPrimAPI_MakeCylinder(axis, radius, height).Shape()
    # 中心杆与圆柱同轴等长、两端齐平。中轴半径必然小于圆柱半径，
    # 因此杆被完全包裹在圆柱内，合并后体积不变，仍是单个实体便于导出。
    rod = BRepPrimAPI_MakeCylinder(axis, axis_radius, height).Shape()
    shape = BRepAlgoAPI_Fuse(shape, rod).Shape()
    return shape


def _shape_volume(shape: object) -> float:
    """返回 B-Rep 实体的体积，单位为立方毫米。"""

    properties = GProp_GProps()
    BRepGProp.VolumeProperties_s(shape, properties)
    return float(properties.Mass())


def _verify_volume(radius: float, height: float, volume: float, axis_radius: float) -> None:
    """用解析体积核对 B-Rep 结果，避免把退化实体当成有效构件。

    中轴半径小于圆柱半径，中心杆被圆柱完全包裹，因此期望体积仍是圆柱的解析体积。

    参数：
        radius: 底面半径，单位为毫米。
        height: 高度，单位为毫米。
        volume: 内核报告的体积，单位为立方毫米。
        axis_radius: 中轴（中心杆）半径，单位为毫米，仅用于失败时说明。
    异常：
        FairingSegmentError: 体积与解析值偏差超限。
    """

    expected = math.pi * radius * radius * height
    if expected <= 0 or not math.isfinite(volume):
        raise FairingSegmentError("整流舱段体积自检无法完成")
    if abs(volume - expected) > expected * _VOLUME_TOLERANCE_RATIO:
        raise FairingSegmentError(
            f"整流舱段体积自检不通过（中轴半径 {axis_radius:g} mm）："
            f"期望 {expected:.6f} mm³，实际 {volume:.6f} mm³"
        )


def import_fairing_segment_step(path: Path) -> float:
    """读取一个 STEP 文件并返回其实体体积，用于验证导出结果可被重新载入。

    参数：
        path: STEP 文件路径。
    返回：
        重新载入后的实体体积，单位为立方毫米。
    异常：
        FairingSegmentError: 文件不存在或内核读取失败。
    """

    if not path.is_file():
        raise FairingSegmentError("STEP 文件不存在")
    reader = STEPControl_Reader()
    if reader.ReadFile(str(path)) != IFSelect_ReturnStatus.IFSelect_RetDone:
        raise FairingSegmentError("STEP 文件读取失败")
    if not reader.TransferRoots():
        raise FairingSegmentError("STEP 文件没有可转换的实体")
    return _shape_volume(reader.OneShape())
