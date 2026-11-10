"""文件说明：将固化正式包络的 NPZ 数组导出为二进制 STL，不修改顶点坐标、单位或三角拓扑。

本模块仅处理已授权的本地网格路径，复用 NumPy 与 Trimesh；不访问数据库、HTTP 或浏览预览网格。
"""

from pathlib import Path
import re
from typing import BinaryIO

import numpy as np
import trimesh


def download_filename(name: str, rotation: int, extension: str) -> str:
    """按保存名称生成安全文件名；保留中文，移除模型扩展名，历史方向附角度，禁用字符替换为下划线。"""
    stem = re.sub(r'[<>:"/\\|?*\x00-\x1f\x7f-\x9f]', "_", name.strip()).rstrip(" .")
    stem = re.sub(r"\.(step|stp|npz|stl|glb)$", "", stem, flags=re.IGNORECASE) or "未命名模型"
    if re.fullmatch(r"CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9]", stem.split(".")[0], re.IGNORECASE):
        stem = "_" + stem
    suffix = "" if rotation == 0 else f"_Rz{rotation}"
    return f"{stem}{suffix}.{extension}"


def write_envelope_stl(source: Path, target: Path | BinaryIO) -> dict:
    """校验正式包络数组并写出 STL，返回顶点和三角面数量。

    参数：source 为只读 NPZ，target 为调用方管理的输出文件路径或二进制流。
    异常：数组缺失、坐标无效、索引越界或超过 STL 容量时抛出 ValueError；文件错误原样传播。
    副作用：仅写入 target；不执行坐标变换、重采样、网格合并或修复。
    """
    with np.load(source, allow_pickle=False) as arrays:
        vertices, faces = arrays["vertices"], arrays["faces"]
        if (vertices.ndim != 2 or vertices.shape[1] != 3 or not len(vertices)
                or vertices.dtype.kind not in "fiu" or faces.ndim != 2 or faces.shape[1] != 3
                or not len(faces) or faces.dtype.kind not in "iu"):
            raise ValueError("正式包络的顶点或三角面数组无效")
        if (not np.isfinite(vertices).all() or np.max(np.abs(vertices)) > np.finfo(np.float32).max
                or faces.min() < 0 or faces.max() >= len(vertices) or len(faces) > 0xffffffff):
            raise ValueError("正式包络包含无效坐标、越界索引或超过 STL 容量")
        mesh = trimesh.Trimesh(vertices=vertices, faces=faces, process=False)
        mesh.export(file_obj=target, file_type="stl")
        return {"vertex_count": len(vertices), "triangle_count": len(faces)}
