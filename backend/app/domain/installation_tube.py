"""文件说明：规范安装筒基座并校验整个组件在分段罩体内的容纳关系，供保存、求解快照和候选验收共用。"""

from __future__ import annotations

import math

from app.core.config import runtime_config


def normalize_installation_base(
    base: dict | None, min_radius: float, max_radius: float,
    max_height: float, fairing_radius: float,
    fairing_profile: dict | None = None,
) -> dict:
    """校验毫米单位的基座并派生上底面范围；非法尺寸或越界时抛出 ValueError。

    未指定尺寸时直接加载集中配置的预设基座。整体高度等于筒体高度加基座高度，
    上底面范围始终取筒体范围，不能独立保存另一组连接半径。
    fairing_profile 为规范化罩体段；保存和求解时提供以检查完整区间，读取已有设置时允许先展示再修正。
    """

    if base is None:
        bottom = fairing_profile["segments"][0] if fairing_profile is not None else None
        bottom_radius = fairing_radius
        if bottom:
            bottom_radius = bottom["lower_radius_mm"] if bottom["kind"] == "lower_cone" else bottom["radius_mm"]
        base = {
            "lower_radius_mm": min(runtime_config.default_installation_base_lower_radius_mm, bottom_radius),
            "height_mm": runtime_config.default_installation_base_height_mm,
        }
    if not isinstance(base, dict):
        raise ValueError("安装筒基座必须是参数对象")
    dimensions = {}
    for key, label, minimum in (
        ("lower_radius_mm", "基座下底面半径", runtime_config.min_cylinder_radius_mm),
        ("height_mm", "基座高度", runtime_config.min_cylinder_height_mm),
    ):
        raw = base.get(key)
        try:
            value = float(raw)
        except (TypeError, ValueError, OverflowError) as error:
            raise ValueError(f"{label}必须是正的有限数值") from error
        if isinstance(raw, bool) or not math.isfinite(value) or not minimum <= value <= runtime_config.max_cylinder_size_mm:
            raise ValueError(f"{label}必须在 {minimum:g} 至 {runtime_config.max_cylinder_size_mm:g} 毫米之间")
        dimensions[key] = value
    if dimensions["lower_radius_mm"] > fairing_radius:
        raise ValueError("基座下底面半径不得超过整流罩最大半径")
    if max_height + dimensions["height_mm"] > runtime_config.max_cylinder_size_mm:
        raise ValueError("安装筒与基座的整体高度超出统一尺寸上限")
    if fairing_profile is not None:
        validate_installation_bounds(max_radius, max_height, dimensions, fairing_profile)
    return {**dimensions, "min_upper_radius_mm": min_radius, "max_upper_radius_mm": max_radius}


def validate_installation_bounds(radius: float, height: float, base: dict, profile: dict) -> None:
    """核对筒体尺寸或区间最大值及基座是否完整位于罩体内；贴合合法，越界抛 ValueError。

    profile 使用已规范化的段列表，重新累计段高，不信任外部传入的摘要值。
    以罩底为零点，基座在下、筒体在上；外罩和组件的截面均分段线性，
    因此逐段检查重叠区间两端即可覆盖整个高度，无需离散采样或修改用户尺寸。
    """
    try:
        segments = profile["segments"]
        bottom = segments[0]
        bottom_radius = float(bottom["lower_radius_mm"] if bottom["kind"] == "lower_cone" else bottom["radius_mm"])
        heights = [float(segment["height_mm"]) for segment in segments]
        radii = [
            (float(segment["radius_mm"]), float(segment["radius_mm"]))
            if segment["kind"] == "cylinder" else
            (float(segment["lower_radius_mm"]), float(segment["upper_radius_mm"]))
            for segment in segments
        ]
        lower_radius, base_height = float(base["lower_radius_mm"]), float(base["height_mm"])
        if not all(math.isfinite(value) and value > 0 for value in [
            radius, height, bottom_radius, *heights, lower_radius, base_height,
            *(value for pair in radii for value in pair),
        ]):
            raise ValueError
    except (TypeError, KeyError, IndexError, ValueError, OverflowError) as error:
        raise ValueError("安装筒约束所需的基座或整流罩尺寸无效") from error
    if radius > lower_radius:
        raise ValueError("安装筒半径最大值不得超过基座下底面半径")
    if lower_radius > bottom_radius:
        label = "下锥段下底面半径" if bottom["kind"] == "lower_cone" else "整流罩圆柱段半径"
        raise ValueError(f"基座下底面半径不得超过{label}")
    if height + base_height > sum(heights):
        raise ValueError("基座高度与安装筒高度最大值之和不得超过整流罩总高度")
    components = (
        ("基座", 0.0, base_height, lower_radius, radius),
        ("安装筒", base_height, base_height + height, radius, radius),
    )
    start = 0.0
    for segment, segment_height, (lower, upper) in zip(segments, heights, radii):
        end = start + segment_height
        label = {"lower_cone": "下锥段", "cylinder": "圆柱段", "upper_cone": "上锥段"}[segment["kind"]]
        for component, bottom, top, component_lower, component_upper in components:
            overlap_bottom, overlap_top = max(start, bottom), min(end, top)
            if overlap_bottom > overlap_top:
                continue
            for position in (overlap_bottom, overlap_top):
                available = _linear_radius_at(position, start, end, lower, upper)
                required = _linear_radius_at(position, bottom, top, component_lower, component_upper)
                if required > available:
                    raise ValueError(
                        f"整流罩{label}在距罩底 {position:g} 毫米处的可用半径为 {available:g} 毫米，"
                        f"小于{component}所需的 {required:g} 毫米，无法容纳{component}。"
                        f"请增大整流罩对应位置的半径或调整{component}尺寸。"
                    )
        start = end


def _linear_radius_at(position: float, bottom: float, top: float, lower: float, upper: float) -> float:
    """返回区间内指定高度的线性截面半径；端点直接返回输入半径，避免浮点消减误判贴合。"""
    if position == bottom:
        return lower
    if position == top:
        return upper
    return lower + (upper - lower) * ((position - bottom) / (top - bottom))
