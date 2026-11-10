"""文件说明：在指定 Conda 环境构建和启动 Tauri 兼容壳，所有派生配置与产物写入 data/build。

依赖环境下的 Rust/MSVC、现有 Node/Vite 和统一缓存管理；失效产物先清理再编译。
独立 Rust 后端管理业务，Python 子进程只执行计算。
"""

import argparse
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tomllib

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "scripts"))
from native_toolchain import native_environment
from rust_backend import build_backend
from cargo_cache import run_cargo


def prepare():
    """校验项目环境并生成 Tauri TOML 与图标；返回配置、构建路径和临时工具链环境，不修改系统 PATH。"""
    config = tomllib.loads((ROOT / "config/sat_layout_opt.toml").read_text(encoding="utf-8"))
    prefix = Path(config["packaging"]["python_environment"]).resolve()
    if Path(sys.prefix).resolve() != prefix or Path(os.environ.get("CONDA_PREFIX", "")).resolve() != prefix:
        raise RuntimeError(f"请通过 conda run -p {prefix} 运行桌面入口")
    native = config["desktop"]["tauri"]
    build = (ROOT / native["build_dir"]).resolve()
    if not build.is_relative_to(ROOT / "data/build"):
        raise ValueError("desktop.tauri.build_dir 必须位于项目 data/build")
    build.mkdir(parents=True, exist_ok=True)
    from startup_icon import create_icon
    create_icon(build / "app.ico")
    # Tauri 强制要求自身格式；这里只从集中配置派生，不维护手写副本。
    generated = '\n'.join([
        '# 由 scripts/desktop/tauri.py 生成；请修改 config/sat_layout_opt.toml。',
        f'productName = {json.dumps(config["desktop"]["title"], ensure_ascii=False)}',
        f'version = {json.dumps(config["packaging"]["version"])}',
        f'identifier = {json.dumps(native["identifier"])}',
        '[build]', 'frontendDist = "http://127.0.0.1"',
        '[app]', 'windows = []', 'withGlobalTauri = false',
        '[bundle]', 'active = false', f'icon = [{json.dumps((build / "app.ico").as_posix())}]', '',
    ])
    target = build / "Tauri.toml"
    if not target.exists() or target.read_text(encoding="utf-8") != generated:
        target.write_text(generated, encoding="utf-8")
    environment = native_environment(config, ROOT, build / "target")
    environment["SAT_LAYOUT_TAURI_CONFIG"] = str(target)
    return config, build, environment


def main():
    """按子命令构建、测试或启动桌面；子命令失败立即返回非零状态，不继续启动旧二进制。"""
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("action", choices=("bootstrap", "build", "run", "check", "test"))
    parser.add_argument("--no-build", action="store_true", help="启动已构建的桌面；仅用于重复启动验收")
    parser.add_argument("--release", action="store_true", help="构建发布优化版本，供正式离线安装包组装")
    args = parser.parse_args()
    if args.no_build and args.action != "run":
        parser.error("--no-build 仅适用于 run，不能跳过构建检查或测试")
    if args.action == "bootstrap":
        config = tomllib.loads((ROOT / "config/sat_layout_opt.toml").read_text(encoding="utf-8"))["packaging"]
        return subprocess.call([config["conda_executable"], "run", "--no-capture-output", "-p", config["python_environment"],
                                "python", str(Path(__file__).resolve()), "run"], cwd=ROOT,
                               env=dict(os.environ, PYTHONUTF8="1", PYTHONIOENCODING="utf-8"))
    config, build, environment = prepare()
    backend = ROOT / config["rust_backend"]["build_dir"] / "target" / ("release" if args.release else "debug") / "sat-layout-api.exe"
    if not args.no_build:
        backend = build_backend(config, "check" if args.action == "check" else "build", args.release)
    elif not backend.is_file():
        raise RuntimeError("缺少 Rust 业务后端，请先执行完整桌面构建")
    environment["SAT_LAYOUT_RUST_BACKEND"] = str(backend)
    cargo = str(Path(environment["CARGO_HOME"]) / "bin/cargo.exe")
    if args.action in ("build", "run") and not args.no_build:
        node = shutil.which("node", path=environment["PATH"])
        subprocess.run([node, "frontend/node_modules/vite/bin/vite.js", "build", "--config", "frontend/vite.config.mjs"],
                       cwd=ROOT, env=environment, check=True)
    if not args.no_build:
        operation = "build" if args.action == "run" else args.action
        command = [cargo, operation, "--manifest-path", "frontend/tauri/Cargo.toml", "--jobs", str(config["desktop"]["tauri"]["build_jobs"])]
        if args.release:
            command.append("--release")
        inputs = [ROOT / "config/sat_layout_opt.toml", build / "Tauri.toml", build / "app.ico"]
        inputs.extend((ROOT / "frontend/tauri/capabilities").rglob("*"))
        inputs = [path for path in inputs if path.is_file()]
        if args.action == "test":
            from datetime import datetime
            output = ROOT / "test-results/integration/desktop" / datetime.now().strftime("%Y%m%d-%H%M%S")
            output.mkdir(parents=True)
            environment["SAT_LAYOUT_TEST_OUTPUT"] = str(output)
            print(f"TEST_OUTPUT={output}", flush=True)
            with (output / "cargo-test.log").open("w", encoding="utf-8") as log:
                run_cargo(ROOT, ROOT / "frontend/tauri/Cargo.toml", environment, command,
                          extra_inputs=inputs, stdout=log)
            return 0
        run_cargo(ROOT, ROOT / "frontend/tauri/Cargo.toml", environment, command, extra_inputs=inputs)
    if args.action == "run":
        executable = build / "target" / ("release" if args.release else "debug") / "sat-layout-desktop.exe"
        return subprocess.call([str(executable)], cwd=ROOT, env=environment)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
