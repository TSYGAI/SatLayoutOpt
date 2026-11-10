"""文件说明：将包络实际阶段和已处理批次转换为有界计算协议进度。

只在计算入口安装回调时生效；权重来自统一 TOML，不读业务状态、不计时模拟、不发布成功终态。
"""

from contextlib import contextmanager
from contextvars import ContextVar
import math
import tomllib

from app.core.paths import runtime_config_path


_active = ContextVar("envelope_progress", default=None)
_LABELS = {
    "source_loading": "正在读取模型",
    "step_tessellation": "正在离散模型",
    "source_normalization": "正在归一化模型",
    "parameter_validation": "正在校验参数",
    "grid_planning": "正在准备体素网格",
    "surface_rasterization": "正在进行体素计算",
    "exterior_fill": "正在填充包络内部",
    "directional_sweep": "正在计算六向增量",
    "surface_extraction": "正在构建包络表面",
    "artifact_write": "正在保存包络结果",
}


@contextmanager
def envelope_progress(emit):
    """为一次计算安装独立进度出口，退出时恢复上下文；配置错误在几何计算前抛出。"""
    with runtime_config_path().open("rb") as stream:
        ranges = tomllib.load(stream)["envelope_progress"]["ranges"]
    previous = 0
    for name in _LABELS:
        bounds = ranges.get(name)
        if (not isinstance(bounds, list) or len(bounds) != 2
                or any(type(value) not in (int, float) or not math.isfinite(value) for value in bounds)
                or not previous <= bounds[0] < bounds[1] < 100):
            raise ValueError(f"envelope_progress.ranges.{name} 必须按顺序覆盖 [0, 100) 内的递增区间")
        previous = bounds[1]
    token = _active.set({"emit": emit, "ranges": ranges, "percent": -1, "phase": None})
    try:
        yield
    finally:
        _active.reset(token)


def report_envelope_progress(name, completed=0, total=1):
    """按已完成工作上报阶段加权百分比；跳过重复和倒退事件，未安装出口时无副作用。"""
    current = _active.get()
    if current is None or name not in current["ranges"] or total <= 0:
        return
    low, high = current["ranges"][name]
    fraction = min(1, max(0, completed / total))
    percent = round(low + (high - low) * fraction, 1)
    if percent < current["percent"] or percent == current["percent"] and name == current["phase"]:
        return
    current.update(percent=percent, phase=name)
    current["emit"]("progress", {"envelope_progress": {
        "phase": name, "message": _LABELS[name], "percent": percent,
    }})
