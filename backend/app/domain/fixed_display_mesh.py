"""文件说明：将正式包络预制为固定页二进制显示资源；保留双精度源顶点，派生显示法向和边线，不改变碰撞数据。"""

from app.compute.monitoring import observed, stage, object_context


import json
from pathlib import Path
import struct

import numpy as np

from app.compute.files import file_ref, sha256, write_json


class FixedDisplayBudgetError(ValueError):
    """可选显示资源超出预算；不能因此阻止正式模型固化，实际加载时仍报告预算错误。"""


def display_arrays(vertices, faces):
    """从显示精度顶点派生平滑法向与一度折线；合并同坐标边，开放边保留，不改变正式顶点或面。"""
    positions = vertices.astype(np.float32).astype(float)
    triangles = positions[faces]
    normals = np.cross(triangles[:, 2] - triangles[:, 1], triangles[:, 0] - triangles[:, 1])
    smooth = np.zeros_like(positions)
    for column in range(3):
        np.add.at(smooth, faces[:, column], normals)
    lengths = np.linalg.norm(smooth, axis=1)
    smooth /= np.where(lengths > 0, lengths, 1)[:, None]
    lengths = np.linalg.norm(normals, axis=1)
    normals /= np.where(lengths > 0, lengths, 1)[:, None]
    # 与 Three.js EdgesGeometry 的四位小数坐标合并和默认一度折线阈值一致。
    _, welded = np.unique(np.floor(positions * 10000 + 0.5), axis=0, return_inverse=True)
    edges = faces[:, [[0, 1], [1, 2], [2, 0]]].reshape(-1, 2)
    keys = np.sort(welded[edges], axis=1)
    usable = (keys[:, 0] != keys[:, 1]) & np.repeat(lengths > 0, 3)
    edges, keys, owners = edges[usable], keys[usable], np.repeat(np.arange(len(faces)), 3)[usable]
    order = np.lexsort((keys[:, 1], keys[:, 0]))
    edges, keys, owners = edges[order], keys[order], owners[order]
    if not len(edges):
        return smooth.astype('<f4'), np.empty((0, 3), dtype='<f4')
    starts = np.r_[0, np.flatnonzero(np.any(keys[1:] != keys[:-1], axis=1)) + 1]
    counts = np.diff(np.r_[starts, len(keys)])
    selected = counts == 1
    paired = np.flatnonzero(counts == 2)
    first = starts[paired]
    threshold = np.cos(np.pi / 180)
    selected[paired] = np.einsum('ij,ij->i', normals[owners[first]], normals[owners[first + 1]]) <= threshold
    # 非流形共边逐行检查法向，保留相同折线规则并避免二次方的临时内存分配。
    for index in np.flatnonzero(counts > 2):
        group = np.unique(normals[owners[starts[index]:starts[index] + counts[index]]], axis=0)
        selected[index] = any(np.any(group @ normal <= threshold) for normal in group)
    return smooth.astype('<f4'), positions[edges[starts[selected]]].reshape(-1, 3).astype('<f4')


def build_fixed_display(envelope, reference, target, max_bytes):
    """验证正式包络并保存版本化二进制与摘要；容量超限或基准错误抛 ValueError，目标为可重建派生目录。"""
    if sha256(envelope) != reference['envelope_sha256']:
        raise ValueError('固定显示资源的正式包络摘要不一致')
    transform = np.asarray(reference['source_to_envelope'], dtype=float)
    if (reference.get('version') != 3 or reference.get('model_coordinate_space') != 'current_model_v1'
            or transform.shape != (4, 4) or not np.isfinite(transform).all()
            or not np.allclose(transform[3], [0, 0, 0, 1])):
        raise ValueError('固定显示资源的安装基准无效')
    with np.load(envelope, allow_pickle=False) as data:
        vertices = np.asarray(data['vertices'], dtype=float)
        faces = np.asarray(data['faces'])
    if (vertices.ndim != 2 or vertices.shape[1] != 3 or not len(vertices) or not np.isfinite(vertices).all()
            or faces.ndim != 2 or faces.shape[1] != 3 or not len(faces) or faces.dtype.kind not in 'iu'
            or faces.min() < 0 or faces.max() >= len(vertices)):
        raise ValueError('固定显示资源的包络数组无效')
    # 必需数组已超限时无需构建边线；可容纳时按实际保留的折线核算文件大小，避免把全部三角形边当作输出。
    if 64 + len(vertices) * 36 + faces.size * 4 > max_bytes:
        raise FixedDisplayBudgetError('固定显示资源超过网格容量预算')
    inverse = np.linalg.inv(transform)
    vertices = np.ascontiguousarray(vertices @ inverse[:3, :3].T + inverse[:3, 3], dtype='<f8')
    if not np.isfinite(vertices.astype(np.float32)).all():
        raise ValueError('固定显示坐标超出显示精度范围')
    normals, edges = display_arrays(vertices, faces)
    faces = np.ascontiguousarray(faces, dtype='<u4')
    if 64 + sum(array.nbytes for array in (vertices, faces, normals, edges)) > max_bytes:
        raise FixedDisplayBudgetError('固定显示资源超过网格容量预算')
    target = Path(target)
    target.mkdir(parents=True, exist_ok=True)
    path = target / 'fixed-display.bin'
    with path.open('wb') as stream:
        stream.write(struct.pack('<8s14I', b'SATFIX01', 1, len(vertices), faces.size, len(edges), *([0] * 10)))
        for array in (vertices, faces, normals, edges):
            stream.write(array.tobytes())
    manifest = {key: reference[key] for key in ('source_sha256', 'envelope_sha256', 'settings')}
    manifest.update(version=1, mesh=file_ref(target, path))
    write_json(target / 'fixed-display.json', manifest)
    return manifest


@observed("生成固定模型显示资源")
def prepare_fixed_display(request, paths, emit, cancelled, checkpoint):
    """为旧固化模型补建一次显示资源；只消费已声明 NPZ 与数值基准，不加载 CAD 或修改业务数据。"""
    metadata = json.loads(paths['metadata'].read_text(encoding='utf-8'))
    reference = json.loads(paths['reference'].read_text(encoding='utf-8'))
    if any(reference.get(key) != metadata[key] for key in ('settings', 'source_sha256', 'envelope_sha256')):
        raise ValueError('固定显示资源安装基准已失效，请重新固化')
    manifest = build_fixed_display(paths['envelope'], reference, Path(request.output_root) / 'artifacts', metadata['max_bytes'])
    if cancelled():
        raise InterruptedError('固定显示准备已取消')
    return {'display': manifest}
