"""文件说明：读取统一 TOML 并校验每轮搜索上限，供契约、任务服务与求解器共享；不处理模型或 HTTP。"""

import tomllib

from app.core.paths import runtime_config_path


def load_layout_config() -> dict:
    """返回布局参数；缺少必需项抛 KeyError，每轮上限非正整数抛 ValueError，不写文件。"""
    path = runtime_config_path()
    with path.open("rb") as stream:
        config = tomllib.load(stream)["layout_optimization"]
    limit = config["max_attempts_per_round"]
    if type(limit) is not int or limit <= 0:
        raise ValueError("layout_optimization.max_attempts_per_round 必须为正整数")
    for key in ("candidate_archive_limit", "candidate_limit", "hybrid_attempt_budget", "hybrid_radius_samples", "cp_partition_limit", "cp_angle_scale",
                "bottom_up_angle_samples", "layer_mass_scale"):
        if type(config[key]) is not int or config[key] <= 0:
            raise ValueError(f"layout_optimization.{key} 必须为正整数")
    if config["candidate_limit"] > config["candidate_archive_limit"]:
        raise ValueError("layout_optimization.candidate_limit 不得超过候选存档上限")
    for key in ("alns_destroy_fraction", "alns_reaction"):
        if not 0 < config[key] <= 1:
            raise ValueError(f"layout_optimization.{key} 必须位于 (0,1]")
    if not 0 <= config["alns_budget_fraction"] < 1 or config["cp_deterministic_time"] <= 0:
        raise ValueError("A+B 预算比例或 CP 工作量无效")
    if not config["geometry_tolerance_mm"] <= config["vertical_contact_precision_mm"] <= config["objective_tolerance_mm"]:
        raise ValueError("vertical_contact_precision_mm 必须位于几何容差与目标参考尺度之间")
    return config


LAYOUT_CONFIG = load_layout_config()
