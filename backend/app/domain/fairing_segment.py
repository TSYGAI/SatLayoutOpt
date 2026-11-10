"""
文件说明：按组合形态构建整流罩外部 B-Rep 并导出 STEP，供前置配置页预览与布局阶段使用。
模块支持下锥段、圆柱段和上锥段四种组合；旧参数和已保存段列表统一经过同一套校验与摘要计算。
安装筒尺寸和质心最大偏移只作为独立约束元数据，不会被混入整流罩外形或生成中心杆。
几何轴线固定与场景 Z 轴重合并穿过原点；本模块只做几何构建、体积自检与文件落盘，不处理 HTTP。
面向调用方的错误使用中文说明原因与处理建议，底层异常通过异常链保留供计算日志排障。
"""

from __future__ import annotations

import math
from pathlib import Path
import shutil
from threading import RLock
from uuid import uuid4

from OCP.BRepAlgoAPI import BRepAlgoAPI_Fuse
from OCP.BRepGProp import BRepGProp
from OCP.BRepPrimAPI import BRepPrimAPI_MakeCone, BRepPrimAPI_MakeCylinder
from OCP.GProp import GProp_GProps
from OCP.gp import gp_Ax2, gp_Dir, gp_Pnt
from OCP.IFSelect import IFSelect_ReturnStatus
from OCP.STEPControl import STEPControl_AsIs, STEPControl_Reader, STEPControl_Writer

from app.core.config import runtime_config
from app.core.paths import data_root


STEP_FILE_NAME = "fairing-segment.step"
_VOLUME_TOLERANCE_RATIO = 1e-6
FAIRING_FORMS = (
    "lower_cone_cylinder_upper_cone",
    "lower_cone_cylinder",
    "cylinder_upper_cone",
    "cylinder",
)


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

        project_root = data_root()
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
        profile: dict | None = None,
    ) -> dict:
        """按整流罩组合形态构建外部 B-Rep，并返回内部安装筒约束元数据。

        参数：
            radius_mm: 兼容旧接口的内部安装筒最小半径，单位为毫米。
            height_mm: 兼容旧接口的内部安装筒最小高度，单位为毫米。
            axis_radius_mm: 兼容旧接口的质心最大偏移，必须为正数且小于安装筒最小半径。
            profile: 整流罩外部组合形态；缺省时使用兼容旧接口的纯圆柱形态。
        返回：
            含安装筒兼容尺寸、整流罩轮廓、体积、质心偏移约束、包围盒及 STEP 文件路径的字典。
        异常：
            FairingSegmentError: 参数非法、质心偏移不小于安装筒半径、内核构造失败、体积自检不通过或文件写入失败。
        副作用：
            以原子替换方式覆盖输出目录下的 STEP 文件。
        """

        radius = float(radius_mm)
        height = float(height_mm)
        if not math.isfinite(radius) or not math.isfinite(height) or radius <= 0 or height <= 0:
            raise FairingSegmentError("整流舱段底面半径和高度必须是正的有限数值")
        centroid_offset = _coerce_centroid_offset(axis_radius_mm, radius)
        normalized_profile = normalize_fairing_profile(profile, radius, height)

        with self._lock:
            try:
                shape = _make_fairing_shape(normalized_profile)
                volume = _shape_volume(shape)
            except FairingSegmentError:
                raise
            except Exception as error:  # OCC 以通用异常报告内核失败
                raise FairingSegmentError(
                    "整流舱段几何构建失败，请检查各段半径、高度及连接处尺寸后重试。"
                ) from error
            _verify_volume(normalized_profile, volume)
            step_path = self._write_step(shape)

        total_height = normalized_profile["total_height_mm"]
        max_radius = normalized_profile["max_radius_mm"]
        return {
            "kind": "fairing_segment",
            "radius_mm": radius,
            "height_mm": height,
            "diameter_mm": radius * 2.0,
            "total_height_mm": total_height,
            "max_radius_mm": max_radius,
            "centroid_max_offset_mm": centroid_offset,
            # 保留旧字段，供尚未升级的布局快照读取；新代码使用 centroid_max_offset_mm。
            "axis_radius_mm": centroid_offset,
            "profile": normalized_profile,
            "fairing_profile": normalized_profile,
            "volume_mm3": volume,
            "axis": {
                "origin": [0.0, 0.0, 0.0],
                "direction": [0.0, 0.0, 1.0],
                "radius_mm": centroid_offset,
            },
            "bounds": {
                "min": [-max_radius, -max_radius, -total_height / 2.0],
                "max": [max_radius, max_radius, total_height / 2.0],
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
                raise FairingSegmentError(
                    "整流舱段模型文件导出失败，请检查存储空间及目录写入权限后重试。"
                )
            temporary_path.replace(target_path)
        except FairingSegmentError:
            temporary_path.unlink(missing_ok=True)
            raise
        except Exception as error:
            temporary_path.unlink(missing_ok=True)
            raise FairingSegmentError(
                "整流舱段模型文件保存失败，请检查文件是否被占用、存储空间及目录写入权限后重试。"
            ) from error
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


def _coerce_centroid_offset(value: object, cylinder_radius: float) -> float:
    """把质心最大偏移规范化为正的有限数值，并确认它严格小于安装筒半径。

    参数：
        value: 质心最大偏移，单位为毫米；缺省时取历史配置默认值，默认值不小于安装筒半径时
            收敛为安装筒半径的一半。
        cylinder_radius: 安装筒最小半径，单位为毫米。
    返回：
        可用的中轴半径，单位为毫米。
    异常：
        FairingSegmentError: 显式取值非正、非有限，或不小于安装筒半径。
    """

    if value is None:
        configured = float(runtime_config.default_axis_radius_mm)
        if not math.isfinite(configured) or configured <= 0:
            configured = cylinder_radius / 2.0
        return configured if configured < cylinder_radius else cylinder_radius / 2.0
    try:
        radius = float(value)
    except (TypeError, ValueError) as error:
        raise FairingSegmentError("质心最大偏移必须是正的有限数值") from error
    if not math.isfinite(radius) or radius <= 0:
        raise FairingSegmentError("质心最大偏移必须是正的有限数值")
    if radius >= cylinder_radius:
        raise FairingSegmentError(
            f"质心最大偏移必须小于安装筒半径（{radius:g} ≥ {cylinder_radius:g} 毫米）"
        )
    return radius


def normalize_fairing_profile(profile: dict | None, radius: float, height: float) -> dict:
    """规范化四种整流罩组合，并校验相邻段半径连续。

    参数：
        profile: 组合形态字典；旧调用传入空值时生成纯圆柱形态。
        radius: 兼容旧接口的圆柱半径，单位为毫米。
        height: 兼容旧接口的圆柱高度，单位为毫米。
    返回：
        含 `form`、`segments`、总高度和最大半径的规范化字典。
    异常：
        FairingSegmentError: 形态未知、段参数非法或连接处半径不一致。
    """

    source = profile if isinstance(profile, dict) else {}
    form = str(source.get("form", source.get("fairing_form", "cylinder"))).strip()
    aliases = {
        "lower_cone+cylinder+upper_cone": "lower_cone_cylinder_upper_cone",
        "lower_cone+cylinder": "lower_cone_cylinder",
        "cylinder+upper_cone": "cylinder_upper_cone",
        "圆柱段": "cylinder",
    }
    form = aliases.get(form, form)
    if form not in FAIRING_FORMS:
        raise FairingSegmentError("不支持的整流罩形态，请重新选择整流罩形态。")

    def positive(value: object, label: str) -> float:
        """将段尺寸转换为正的有限数值，非法输入抛出领域错误。"""

        try:
            result = float(value)
        except (TypeError, ValueError) as error:
            raise FairingSegmentError(f"{label}必须是正的有限数值") from error
        if not math.isfinite(result) or result <= 0:
            raise FairingSegmentError(f"{label}必须是正的有限数值")
        return result

    def segment(name: str, values: dict, *, cone: bool) -> dict:
        """按段类型转换原始尺寸，返回只含规范字段的段记录。"""

        if cone:
            kind = "lower_cone" if name in ("lower_cone", "下锥段") else "upper_cone"
            label = "下锥段" if kind == "lower_cone" else "上锥段"
            lower = positive(values.get("lower_radius_mm"), f"{label}下底面半径")
            upper = positive(values.get("upper_radius_mm"), f"{label}上底面半径")
            segment_height = positive(values.get("height_mm"), f"{label}高度")
            return {"kind": kind, "lower_radius_mm": lower, "upper_radius_mm": upper, "height_mm": segment_height}
        segment_radius = positive(values.get("radius_mm"), f"{name}半径")
        segment_height = positive(values.get("height_mm"), f"{name}高度")
        return {"kind": "cylinder", "radius_mm": segment_radius, "height_mm": segment_height}

    existing_segments = source.get("segments")
    if isinstance(existing_segments, list) and existing_segments:
        segments: list[dict] = []
        for item in existing_segments:
            if not isinstance(item, dict):
                raise FairingSegmentError("整流罩组合段记录格式无效")
            kind = str(item.get("kind", ""))
            if kind in ("cylinder", "圆柱段"):
                segments.append(segment("圆柱段", item, cone=False))
            elif kind in ("lower_cone", "下锥段", "upper_cone", "上锥段"):
                segments.append(segment(kind, item, cone=True))
            else:
                raise FairingSegmentError("不支持的整流罩段类型，请重新选择整流罩形态。")
    else:
        cylinder_values = source.get("cylinder") if isinstance(source.get("cylinder"), dict) else {}
        cylinder = segment("圆柱段", {
            "radius_mm": cylinder_values.get("radius_mm", source.get("cylinder_radius_mm", radius)),
            "height_mm": cylinder_values.get("height_mm", source.get("cylinder_height_mm", height)),
        }, cone=False)
        segments = []
        if form in ("lower_cone_cylinder_upper_cone", "lower_cone_cylinder"):
            values = source.get("lower_cone") if isinstance(source.get("lower_cone"), dict) else {}
            segments.append(segment("下锥段", {
                "lower_radius_mm": values.get("lower_radius_mm", source.get("lower_cone_lower_radius_mm")),
                "upper_radius_mm": values.get("upper_radius_mm", source.get("lower_cone_upper_radius_mm", cylinder["radius_mm"])),
                "height_mm": values.get("height_mm", source.get("lower_cone_height_mm")),
            }, cone=True))
        segments.append(cylinder)
        if form in ("lower_cone_cylinder_upper_cone", "cylinder_upper_cone"):
            values = source.get("upper_cone") if isinstance(source.get("upper_cone"), dict) else {}
            segments.append(segment("上锥段", {
                "lower_radius_mm": values.get("lower_radius_mm", source.get("upper_cone_lower_radius_mm", cylinder["radius_mm"])),
                "upper_radius_mm": values.get("upper_radius_mm", source.get("upper_cone_upper_radius_mm")),
                "height_mm": values.get("height_mm", source.get("upper_cone_height_mm")),
            }, cone=True))

    expected_kinds = {
        "lower_cone_cylinder_upper_cone": ("lower_cone", "cylinder", "upper_cone"),
        "lower_cone_cylinder": ("lower_cone", "cylinder"),
        "cylinder_upper_cone": ("cylinder", "upper_cone"),
        "cylinder": ("cylinder",),
    }[form]
    if tuple(item["kind"] for item in segments) != expected_kinds:
        raise FairingSegmentError("整流罩组合段顺序与形态不一致")
    for previous, current in zip(segments, segments[1:]):
        upper = previous.get("radius_mm", previous.get("upper_radius_mm"))
        lower = current.get("radius_mm", current.get("lower_radius_mm"))
        if not math.isclose(upper, lower, rel_tol=0, abs_tol=1e-9):
            raise FairingSegmentError("相邻整流罩段半径必须连续")
    total_height = sum(item["height_mm"] for item in segments)
    max_radius = max(
        max(item.get("radius_mm", 0), item.get("lower_radius_mm", 0), item.get("upper_radius_mm", 0))
        for item in segments
    )
    return {"form": form, "segments": segments, "total_height_mm": total_height, "max_radius_mm": max_radius}


def _make_fairing_shape(profile: dict) -> object:
    """按原点中轴构建整流罩外部组合段，不创建内部安装筒中心杆。

    参数：
        profile: 规范化后的组合段字典。
    返回：
        OCC TopoDS_Shape 实体，底面位于 z = -H/2。
    异常：
        FairingSegmentError: 锥段半径退化，提供中文段名、实际尺寸及修正建议。
        其他内核异常交由构件服务统一转换为中文错误，并保留原始异常链。
    """

    start_z = -profile["total_height_mm"] / 2.0
    shape = None
    current_z = start_z
    for item in profile["segments"]:
        axis = gp_Ax2(gp_Pnt(0.0, 0.0, current_z), gp_Dir(0.0, 0.0, 1.0))
        if item["kind"] == "cylinder":
            part = BRepPrimAPI_MakeCylinder(axis, item["radius_mm"], item["height_mm"]).Shape()
        else:
            try:
                part = BRepPrimAPI_MakeCone(
                    axis, item["lower_radius_mm"], item["upper_radius_mm"], item["height_mm"]
                ).Shape()
            except Exception as error:
                # 内核以 identic 或 identical 描述退化锥段；在此保留实际段名和尺寸供用户修正。
                if "cone with two identic" not in str(error).casefold():
                    raise
                label = "下锥段" if item["kind"] == "lower_cone" else "上锥段"
                raise FairingSegmentError(
                    f"{label}上下底面半径不能相同或过于接近"
                    f"（下底面 {item['lower_radius_mm']:g} 毫米，上底面 {item['upper_radius_mm']:g} 毫米），"
                    f"请调整半径，或选择不含{label}的整流罩形态。"
                ) from error
        shape = part if shape is None else BRepAlgoAPI_Fuse(shape, part).Shape()
        current_z += item["height_mm"]
    return shape


def _shape_volume(shape: object) -> float:
    """返回 B-Rep 实体的体积，单位为立方毫米。"""

    properties = GProp_GProps()
    BRepGProp.VolumeProperties_s(shape, properties)
    return float(properties.Mass())


def _verify_volume(profile: dict, volume: float) -> None:
    """用各段解析体积核对 B-Rep 结果，避免把退化实体当成有效构件。

    期望体积只由整流罩外部组合段决定，内部安装筒和质心约束不参与外部 B-Rep 体积。

    参数：
        profile: 规范化后的组合段字典。
        volume: 内核报告的体积，单位为立方毫米。
    异常：
        FairingSegmentError: 体积与解析值偏差超限。
    """

    expected = 0.0
    for item in profile["segments"]:
        if item["kind"] == "cylinder":
            expected += math.pi * item["radius_mm"] ** 2 * item["height_mm"]
        else:
            expected += math.pi * item["height_mm"] * (
                item["lower_radius_mm"] ** 2
                + item["lower_radius_mm"] * item["upper_radius_mm"]
                + item["upper_radius_mm"] ** 2
            ) / 3.0
    if expected <= 0 or not math.isfinite(volume):
        raise FairingSegmentError("整流舱段体积自检无法完成")
    if abs(volume - expected) > expected * _VOLUME_TOLERANCE_RATIO:
        raise FairingSegmentError(
            f"整流罩体积自检不通过：期望 {expected:.6f} 立方毫米，实际 {volume:.6f} 立方毫米，"
            "请检查各段尺寸后重新生成。"
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
