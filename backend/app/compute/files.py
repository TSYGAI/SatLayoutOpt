"""文件说明：计算协议的路径边界、内容摘要与原子文件操作；不访问数据库，不发布正式业务产物。"""

import hashlib
import json
from pathlib import Path


def sha256(path):
    """流式计算资源 SHA-256，避免大型文件整体进入内存。"""
    with Path(path).open("rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest()


def within(root, relative):
    """解析资源根内的相对路径；拒绝绝对路径、父目录跳转及符号链接导致的越界。"""
    root = Path(root).resolve()
    path = Path(relative)
    if path.is_absolute() or path.drive or ".." in path.parts or not path.parts:
        raise ValueError("资源路径必须是根目录内的相对路径")
    target = (root / path).resolve()
    if not target.is_relative_to(root) or target == root:
        raise ValueError("资源路径越界")
    return target


def write_json(path, value):
    """以 UTF-8 原子发布任务数据；禁止 NaN/Infinity，失败时不替换已有完整文件。"""
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(path.suffix + ".tmp")
    temporary.write_text(json.dumps(value, ensure_ascii=False, allow_nan=False, indent=2), encoding="utf-8")
    temporary.replace(path)


def file_ref(root, path):
    """为已完成的输出构造带摘要、长度和相对路径的协议引用。"""
    root, path = Path(root).resolve(), Path(path).resolve()
    return {"path": path.relative_to(root).as_posix(), "sha256": sha256(path), "bytes": path.stat().st_size}
