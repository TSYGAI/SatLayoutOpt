"""文件说明：读取集中 TOML 的计算进程及微调复用限制，供协议、客户端与工作池共同校验。"""

import tomllib

from app.core.paths import runtime_config_path


def load_compute_config():
    """返回经过范围校验的计算配置；缺失、布尔值或非正限制视为启动错误。"""
    with runtime_config_path().open("rb") as stream:
        values = tomllib.load(stream)["compute_engine"]
    integers = ("request_max_bytes", "event_max_bytes", "max_workers", "numeric_threads_per_worker",
                "prefetch_per_worker", "mount_cache_bytes")
    for key in integers:
        if type(values[key]) is not int or values[key] <= 0:
            raise ValueError(f"compute_engine.{key} 必须为正整数")
    for key in ("poll_interval_seconds", "cancel_grace_seconds", "resource_sample_seconds"):
        if type(values[key]) not in (int, float) or not 0 < values[key] <= 60:
            raise ValueError(f"compute_engine.{key} 必须在 (0, 60] 内")
    # 旧宿主的只读配置快照没有复用字段，仍可执行原单次协议；新复用配置必须完整提供。
    refinement_keys = {"refinement_worker_enabled", "refinement_worker_idle_seconds", "refinement_worker_poll_seconds"}
    if refinement_keys.intersection(values):
        if not refinement_keys.issubset(values):
            raise ValueError("compute_engine 微调复用配置不完整")
        for key in ("refinement_worker_idle_seconds", "refinement_worker_poll_seconds"):
            if type(values[key]) not in (int, float) or not 0 < values[key] <= 3600:
                raise ValueError(f"compute_engine.{key} 必须在 (0, 3600] 内")
        if type(values["refinement_worker_enabled"]) is not bool:
            raise ValueError("compute_engine.refinement_worker_enabled 必须为布尔值")
    if type(values["memory_estimate_margin"]) not in (float, int) or not 1 <= values["memory_estimate_margin"] <= 4:
        raise ValueError("compute_engine.memory_estimate_margin 必须在 [1, 4] 内")
    return values


COMPUTE_CONFIG = load_compute_config()
