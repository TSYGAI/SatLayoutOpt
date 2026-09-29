"""
文件说明：定义模型六向包络增量的数据契约、默认值与校验规则。
包络增量属于各模型的持久化设置，以毫米计量；不读取运行配置，也不依赖 HTTP 或几何库。
"""

import math


SAFETY_DIRECTIONS = ("front", "back", "left", "right", "top", "bottom")


def default_safety_clearance() -> dict[str, float]:
    """返回独立的六向零距离设置，用于新模型和未保存该字段的历史模型。"""

    return dict.fromkeys(SAFETY_DIRECTIONS, 0.0)


def normalize_safety_clearance(value: object) -> dict[str, float]:
    """校验完整六向毫米距离并返回副本；缺项、额外字段和非有限非负数均抛出 ValueError。"""

    if not isinstance(value, dict) or set(value) != set(SAFETY_DIRECTIONS):
        raise ValueError("包络增量必须同时包含前、后、左、右、上、下六个方向")
    normalized = {}
    for direction in SAFETY_DIRECTIONS:
        distance = value[direction]
        if isinstance(distance, bool) or not isinstance(distance, (int, float)):
            raise ValueError("包络增量必须是大于或等于 0 的有限数值，单位为 mm")
        try:
            distance = float(distance)
        except OverflowError as error:
            raise ValueError("包络增量数值过大") from error
        if not math.isfinite(distance) or distance < 0:
            raise ValueError("包络增量必须是大于或等于 0 的有限数值，单位为 mm")
        normalized[direction] = distance
    return normalized
