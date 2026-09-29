"""文件说明：读取统一 TOML 中的布局优化配置，供契约、任务服务与求解器共享；不处理模型或 HTTP。"""

from pathlib import Path
import tomllib


def load_layout_config() -> dict:
    """返回统一 TOML 中的布局参数；缺少必需小节时抛出 KeyError，不写入文件。"""
    path = Path(__file__).resolve().parents[3] / "config" / "sat_layout_opt.toml"
    with path.open("rb") as stream:
        return tomllib.load(stream)["layout_optimization"]


LAYOUT_CONFIG = load_layout_config()
