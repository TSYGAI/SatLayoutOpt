"""文件说明：管理启动入口的 Cargo 缓存，按输入摘要先清理失效产物再构建。

仅操作项目 data/build 内指定的 target；依赖 Cargo、项目已有 psutil 和 Windows 文件锁。
状态文件是可再生成的构建记录，不承载运行配置；业务数据和其他构建目录不参与清理。
"""

from contextlib import contextmanager
import hashlib
import json
import os
from pathlib import Path
import subprocess
import tomllib

import psutil


def _digest(paths):
    """对输入路径和内容计算摘要；缺失文件也参与摘要，以识别新增、删除和工具配置变化。"""
    digest = hashlib.sha256()
    for path in sorted(set(paths)):
        digest.update(str(path).encode("utf-8") + b"\0")
        digest.update(hashlib.sha256(path.read_bytes()).digest() if path.is_file() else b"missing")
    return digest.hexdigest()


def _keys(root, manifest, environment, extra_inputs):
    """返回依赖与本项目源码摘要；记录编译器、Cargo 配置、编译环境及显式嵌入资源。"""
    cargo_home = Path(environment["CARGO_HOME"])
    toolchain = []
    for executable, flag in (("rustc.exe", "-vV"), ("cargo.exe", "--version")):
        toolchain.append(subprocess.check_output(
            [str(cargo_home / "bin" / executable), flag], cwd=root, env=environment,
            text=True, encoding="utf-8",
        ))
    configs = [cargo_home / "config", cargo_home / "config.toml"]
    # Cargo 从工作目录向上寻找配置；同时记录 crate 的显式配置，避免未来改变调用目录时误复用。
    for directory in {manifest.parent, root, *root.parents}:
        configs.extend((directory / ".cargo/config", directory / ".cargo/config.toml"))
    variables = {key: value for key, value in environment.items() if (
        key.upper().startswith(("CARGO_", "RUST", "CC", "CXX", "AR_"))
        or key.upper() in {"CL", "_CL_", "LINK", "_LINK_", "INCLUDE", "LIB", "LIBPATH",
                               "VCTOOLSVERSION", "WINDOWSSDKVERSION", "VCINSTALLDIR", "PATH"}
    )}
    dependency = hashlib.sha256(json.dumps([
        _digest([manifest, manifest.with_name("Cargo.lock"), *configs]), toolchain, variables,
    ], sort_keys=True).encode("utf-8")).hexdigest()
    package = tomllib.loads(manifest.read_text(encoding="utf-8"))
    sources = list((manifest.parent / "src").rglob("*"))
    sources = [path for path in sources if path.is_file()]
    sources.extend((manifest.parent / "build.rs", Path(__file__), *extra_inputs))
    # 两个独立 Rust 程序共用纯日志基础模块，纳入缓存摘要避免改动后复用旧实现。
    sources.extend((root / "shared").rglob("*.rs"))
    sources.append(root / "config/sat_layout_opt.toml")
    for kind in ("test", "bench", "example", "bin"):
        for target in package.get(kind, []):
            if "path" in target:
                sources.extend((manifest.parent / target["path"]).resolve().parent.rglob("*.rs"))
    return {"dependencies": dependency, "sources": _digest(sources)}


def _safe_target(root, target):
    """核对清理目标严格位于 data/build 的独立 target，拒绝路径逃逸及目录联接。"""
    root = root.resolve()
    boundary = root / "data/build"
    target = Path(os.path.abspath(target))
    if target.name != "target" or target.parent == boundary or not target.is_relative_to(boundary):
        raise ValueError(f"拒绝清理非独立 Cargo 构建目录：{target}")
    for path in (target, *target.parents):
        if path == root:
            break
        if path.is_symlink() or path.is_junction():
            raise ValueError(f"构建目录不得通过链接指向其他位置：{path}")
    if target.resolve() != target:
        raise ValueError(f"构建目录解析结果不一致：{target}")
    return target


@contextmanager
def _build_lock(target):
    """在清理和构建全程持有进程锁；并发启动立即报错，进程退出后由操作系统释放锁。"""
    import msvcrt

    target.parent.mkdir(parents=True, exist_ok=True)
    with (target.parent / ".cargo-cache.lock").open("a+b") as stream:
        if stream.tell() == 0:
            stream.write(b"0")
            stream.flush()
        stream.seek(0)
        try:
            msvcrt.locking(stream.fileno(), msvcrt.LK_NBLCK, 1)
        except OSError as error:
            raise RuntimeError(f"另一个构建正在使用 {target}，请等待完成后重试。") from error
        try:
            yield
        finally:
            stream.seek(0)
            msvcrt.locking(stream.fileno(), msvcrt.LK_UNLCK, 1)


def _check_cleanup(target):
    """清理前检查运行中的产物和子目录链接；发现占用或链接时中止，不终止用户进程。"""
    for process in psutil.process_iter(["pid", "exe"]):
        executable = process.info["exe"]
        if executable and Path(executable).resolve().is_relative_to(target):
            raise RuntimeError(
                f"构建缓存已失效，但程序仍在运行（PID {process.pid}）。请关闭桌面程序后重试。"
            )
    for directory, children, files in os.walk(target, followlinks=False):
        for name in [*children, *files]:
            path = Path(directory) / name
            if path.is_symlink() or path.is_junction():
                raise ValueError(f"拒绝清理包含链接的构建目录：{path}")


def _read_state(path):
    """读取成功或中断的缓存记录；缺失、损坏和未知版本均视为无法验证的旧缓存。"""
    try:
        state = json.loads(path.read_text(encoding="utf-8"))
    except (FileNotFoundError, UnicodeError, json.JSONDecodeError):
        return None
    if not isinstance(state, dict) or state.get("version") != 1:
        return None
    if not all(isinstance(state.get(key), str) for key in ("dependencies", "sources")):
        return None
    if type(state.get("complete")) is not bool or state.get("cleanup") not in ("all", "package"):
        return None
    return state


def _write_state(path, state):
    """原子替换 UTF-8 构建记录，避免中断留下被误判为可复用的半份状态。"""
    temporary = path.with_suffix(".tmp")
    temporary.write_text(json.dumps(state, ensure_ascii=False, indent=2), encoding="utf-8")
    temporary.replace(path)


def run_cargo(root, manifest, environment, command, *, extra_inputs=(), stdout=None):
    """先清理失效缓存再执行 Cargo；成功后登记输入，失败留待下次清理并原样抛出异常。

    依赖或工具链变化清理整个指定 target；仅源码变化清理本包，保留第三方依赖。
    不变的输入交由 Cargo 校验并复用；stdout 可指定测试日志文件，所有操作保持同一把锁。
    """
    root, manifest = Path(root).resolve(), Path(manifest).resolve()
    target = _safe_target(root, Path(environment["CARGO_TARGET_DIR"]))
    state_path = target.parent / "cargo-cache-state.json"
    with _build_lock(target):
        current = _keys(root, manifest, environment, extra_inputs)
        previous = _read_state(state_path)
        cleanup = None
        if previous is None or previous["dependencies"] != current["dependencies"]:
            cleanup = "all"
        elif not previous["complete"]:
            cleanup = previous["cleanup"]
        elif previous["sources"] != current["sources"]:
            cleanup = "package"
        if cleanup:
            _check_cleanup(target)
        pending = {"version": 1, **current, "complete": False, "cleanup": cleanup or "package"}
        _write_state(state_path, pending)
        options = dict(cwd=root, env=environment, check=True, stdout=stdout)
        if stdout is not None:
            options["stderr"] = subprocess.STDOUT
        if cleanup:
            scope = "全部产物" if cleanup == "all" else "本项目产物（保留第三方依赖）"
            print(f"[构建缓存] {manifest.parent.name}：缓存失效，先清理{scope}。", flush=True)
            clean = [command[0], "clean", "--manifest-path", str(manifest), "--target-dir", str(target)]
            if cleanup == "package":
                package = tomllib.loads(manifest.read_text(encoding="utf-8"))["package"]["name"]
                clean.extend(("--package", package))
            subprocess.run(clean, **options)
        else:
            print(f"[构建缓存] {manifest.parent.name}：输入未变化，复用现有缓存。", flush=True)
        subprocess.run(command, **options)
        if _keys(root, manifest, environment, extra_inputs) != current:
            raise RuntimeError("构建期间输入发生变化，未登记成功缓存；请重新运行启动脚本。")
        _write_state(state_path, {**pending, "complete": True})
