"""文件说明：为独立 Rust 后端和 Tauri 构建提供项目环境内的 Cargo/MSVC，不修改全局 PATH。"""

import os
from pathlib import Path
import subprocess
import sys


def native_environment(config, root, target):
    """校验指定 Conda 环境并返回进程级编译环境；缺少工具链或环境不一致时拒绝执行。"""
    prefix = Path(config["packaging"]["python_environment"]).resolve()
    if Path(sys.prefix).resolve() != prefix or Path(os.environ.get("CONDA_PREFIX", "")).resolve() != prefix:
        raise RuntimeError(f"请通过 conda run -p {prefix} 运行构建入口")
    native = config["desktop"]["tauri"]
    cargo_dir = prefix / native["cargo_dir"]
    environment = dict(os.environ, CARGO_HOME=str(cargo_dir), RUSTUP_HOME=str(prefix / native["rustup_dir"]),
                       CARGO_TARGET_DIR=str(target), SAT_LAYOUT_OPT_PROJECT_ROOT=str(root),
                       PYTHONUTF8="1", PYTHONIOENCODING="utf-8")
    environment["PATH"] = str(cargo_dir / "bin") + os.pathsep + environment["PATH"]
    vcvars = prefix / native["msvc_dir"] / "VC/Auxiliary/Build/vcvars64.bat"
    if not vcvars.is_file() or not (cargo_dir / "bin/cargo.exe").is_file():
        raise RuntimeError("缺少项目环境内的 Rust 或 MSVC")
    result = subprocess.run(f'cmd.exe /d /u /s /c ""{vcvars}" >nul && set"',
                            env=environment, stdout=subprocess.PIPE, stderr=subprocess.PIPE, check=True)
    for line in result.stdout.decode("utf-16-le").splitlines():
        name, separator, value = line.partition("=")
        if separator and name:
            environment[name.upper() if name.upper() == "PATH" else name] = value
    return environment
