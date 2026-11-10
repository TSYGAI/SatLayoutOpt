"""文件说明：解析开发态与 Nuitka 安装态的程序根目录及用户数据目录。

决定数据位置及 Rust 计算任务的只读配置快照位置，不改变模型格式或数据库结构。
"""

import os
from pathlib import Path
import sys


def is_compiled() -> bool:
    """判断当前模块是否经 Nuitka 编译，不接受环境变量伪装编译状态。"""
    return "__compiled__" in globals()


def application_root() -> Path:
    """返回统一配置所在根目录；安装态从 backend 内的编译程序定位，开发态从源码定位。"""
    if is_compiled():
        return Path(sys.executable).resolve().parent.parent
    return Path(__file__).resolve().parents[3]


def data_root() -> Path:
    """返回数据相对路径的基准目录；环境变量用于桌面安装及隔离测试，不创建目录。"""
    override = os.environ.get("SAT_LAYOUT_OPT_DATA_ROOT")
    return Path(override).resolve() if override else application_root()


def runtime_config_path() -> Path:
    """返回宿主传入的任务配置快照；独立调用读取唯一 TOML，显式快照缺失时不回退新配置。"""
    snapshot = os.environ.get("SAT_LAYOUT_OPT_CONFIG_SNAPSHOT")
    return Path(snapshot).resolve() if snapshot else application_root() / "config" / "sat_layout_opt.toml"
