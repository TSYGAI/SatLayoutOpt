"""文件说明：把历史 NPZ 转为版本化显示网格；只降低显示坐标精度，不修改精确快照和导出数据。"""

from app.compute.monitoring import observed, stage, object_context


import struct
import zipfile

import numpy as np


@observed("编码历史二进制网格")
def history_mesh_binary(metadata, paths, target):
    """验证单型号数组及字节预算，顺序写入小端 Float32/Uint32 文件；非法或过大输入抛出 ValueError。"""
    source = paths["mesh"]
    limit = metadata["max_bytes"]
    if set(metadata) != {"max_bytes"} or type(limit) is not int or limit <= 0:
        raise ValueError("显示资源预算必须为正整数")
    with zipfile.ZipFile(source) as archive:
        size = sum(archive.getinfo(name).file_size for name in ("vertices.npy", "faces.npy"))
        # NumPy 默认允许单个 NPY 头最多 10000 字节；预检计入头部而不误拒绝小网格。
        if size > limit * 2 + 20000:
            raise ValueError("历史网格超过显示资源预算")
    with np.load(source, allow_pickle=False) as arrays:
        vertices, faces = arrays["vertices"], arrays["faces"]
        if (vertices.ndim != 2 or vertices.shape[1] != 3 or not len(vertices)
                or faces.ndim != 2 or faces.shape[1] != 3 or not len(faces)
                or vertices.dtype.kind not in "fiu" or faces.dtype.kind not in "iu"):
            raise ValueError("历史网格数组形状或类型无效")
        if (not np.isfinite(vertices).all() or np.max(np.abs(vertices)) > np.finfo(np.float32).max
                or faces.min() < 0 or faces.max() >= len(vertices)):
            raise ValueError("历史网格含非有限坐标或越界索引")
        count, indices = len(vertices), faces.size
        if count > 0xffffffff or indices > 0xffffffff or 32 + count * 12 + indices * 4 > limit:
            raise ValueError("历史网格超过显示资源预算")
        with (target / "mesh.bin").open("wb") as stream:
            stream.write(struct.pack("<8s6I", b"SATMSH01", 1, count, indices, 0, 0, 0))
            np.asarray(vertices, dtype="<f4", order="C").tofile(stream)
            np.asarray(faces, dtype="<u4", order="C").tofile(stream)
    return {"vertex_count": count, "index_count": indices}
