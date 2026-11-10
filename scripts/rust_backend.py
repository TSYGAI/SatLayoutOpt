"""文件说明：在项目 Conda 环境独立构建、测试和启动 Rust 业务后端。

依赖统一工具链与缓存管理模块，在编译前清理失效产物；编译产物和测试日志集中存放。
"""

import argparse
from datetime import datetime
import os
from pathlib import Path
import subprocess
import shutil
import tomllib

from native_toolchain import native_environment
from cargo_cache import run_cargo

ROOT = Path(__file__).resolve().parents[1]


def build_backend(config, action="build", release=False):
    """清理失效缓存后运行 Cargo 并返回可执行文件路径；测试日志写 test-results，失败直接抛出。"""
    build = (ROOT / config["rust_backend"]["build_dir"]).resolve()
    if not build.is_relative_to(ROOT / "data/build"):
        raise ValueError("Rust 构建目录必须位于 data/build")
    environment = native_environment(config, ROOT, build / "target")
    command = [str(Path(environment["CARGO_HOME"]) / "bin/cargo.exe"), action,
               "--manifest-path", str(ROOT / "backend/rust/Cargo.toml")]
    if action not in ("fmt",):
        command += ["--jobs", str(config["desktop"]["tauri"]["build_jobs"])]
        if release:
            command.append("--release")
    if action == "clippy":
        command += ["--all-targets", "--", "-D", "warnings"]
    if action == "test":
        output = ROOT / "test-results/integration/rust-backend" / datetime.now().strftime("%Y%m%d-%H%M%S-%f")
        output.mkdir(parents=True)
        environment["SAT_LAYOUT_TEST_OUTPUT"] = str(output)
        print(f"TEST_OUTPUT={output}", flush=True)
        with (output / "cargo-test.log").open("w", encoding="utf-8") as log:
            run_cargo(ROOT, ROOT / "backend/rust/Cargo.toml", environment, command, stdout=log)
    elif action == "fmt":
        subprocess.run(command, cwd=ROOT, env=environment, check=True)
    else:
        run_cargo(ROOT, ROOT / "backend/rust/Cargo.toml", environment, command)
    return build / "target" / ("release" if release else "debug") / "sat-layout-api.exe"


def main():
    """按命令构建或启动；运行失败不回退旧服务，保持 stdin 控制管道传递。"""
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("action", choices=("bootstrap", "dev", "build", "check", "test", "fmt", "clippy", "run"))
    parser.add_argument("--release", action="store_true")
    args, extra = parser.parse_known_args()
    config = tomllib.loads((ROOT / "config/sat_layout_opt.toml").read_text(encoding="utf-8"))
    if args.action == "bootstrap":
        return subprocess.call([config["packaging"]["conda_executable"], "run", "--no-capture-output", "-p",
            config["packaging"]["python_environment"], "python", str(Path(__file__).resolve()), "dev"], cwd=ROOT,
            env=dict(os.environ, PYTHONUTF8="1", PYTHONIOENCODING="utf-8"))
    executable = build_backend(config, "build" if args.action in ("run", "dev") else args.action, args.release)
    if args.action == "dev":
        node = shutil.which("node")
        if not node:
            raise RuntimeError("项目环境中缺少 Node.js")
        return subprocess.call([node, "scripts/dev-supervisor.js"], cwd=ROOT,
            env=dict(os.environ, SAT_LAYOUT_RUST_BACKEND=str(executable), SAT_LAYOUT_OPT_PROJECT_ROOT=str(ROOT)))
    if args.action == "run":
        return subprocess.call([str(executable), *extra], cwd=ROOT, env=dict(os.environ, SAT_LAYOUT_OPT_PROJECT_ROOT=str(ROOT)))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
