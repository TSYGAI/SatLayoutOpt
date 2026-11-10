"""文件说明：定义各模型独立保存的包络计算设置，提供配置默认值与严格整数校验。

本模块不读取模型文件或执行几何计算；默认分辨率和最小值依赖统一 TOML 配置。
"""

from app.core.config import runtime_config


def default_envelope_settings() -> dict[str, int]:
    """为新模型和缺少该字段的历史模型返回独立的默认包络设置。"""

    return {"refinement_grid_size": runtime_config.model_envelope_refinement_grid_size}


def normalize_envelope_settings(value: object) -> dict[str, int]:
    """校验完整包络设置并返回副本；缺项、未知字段和非整数分辨率抛出 ValueError。"""

    if not isinstance(value, dict) or set(value) != {"refinement_grid_size"}:
        raise ValueError("包络设置必须且只能包含体素分辨率 refinement_grid_size")
    resolution = value["refinement_grid_size"]
    minimum = runtime_config.model_envelope_refinement_grid_min
    if isinstance(resolution, bool) or not isinstance(resolution, int) or resolution < minimum:
        raise ValueError(f"体素分辨率必须为不小于 {minimum} 的整数")
    return {"refinement_grid_size": resolution}
