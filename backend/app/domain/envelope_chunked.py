"""文件说明：在固定格距下分批重建完整包络，连接磁盘占据网格与有界表面提取。

沿用保守栅格化、闭运算、全局空气填充、六向扫掠和最终裁剪；空间分块只改变
执行方式。临时文件位于集中配置指定的数据目录，成功或异常均自动清理。
"""

from itertools import product
from math import prod
import os
from pathlib import Path
import shutil
import tempfile
from time import perf_counter

import numpy as np
import trimesh

from app.domain.envelope_chunked_grid import DiskGrid, fill_holes, filter_axis
from app.domain.envelope_resources import envelope_stage
from app.domain.envelope_progress import report_envelope_progress


def _surface(grid, origin, pitch, bounds, parameters, check):
    """分块提取同一等值面并精确融合；仅零容差去除共面点，最后沿用原简化容差。

    各块包含相邻采样点，人工封口放在块外，融合区重叠半格以避免共面零厚碎片。内部块
    使用同尺寸实体填满，布尔并集去除人工内面，避免裂缝及局部填充伪空腔。
    """
    from manifold3d import Manifold, Mesh64
    from skimage.measure import marching_cubes

    resources = check()
    capacity = min(parameters.workspace_memory_bytes, resources["budget_bytes"] - resources["private_bytes"],
                   resources["available_bytes"] - resources["reserve_bytes"])
    surface_cells = min(parameters.surface_batch_cells, max(0, capacity) // 512)
    if surface_cells < 343:
        raise MemoryError("剩余内存不足以提取最小包络表面分块")
    edge = max(2, int(surface_cells ** (1 / 3)) - 5)
    levels = []
    blocks, surface_blocks = 0, 0
    for start in product(*(range(0, size - 1, edge) for size in grid.shape)):
        stop = tuple(min(size - 1, first + edge) for size, first in zip(grid.shape, start))
        low = np.maximum(0, np.asarray(start) - 1)
        high = np.minimum(np.asarray(grid.shape) - 1, np.asarray(stop) + 1)
        clip_low = np.maximum(0, np.asarray(start) - 0.25)
        clip_high = np.minimum(np.asarray(grid.shape) - 1, np.asarray(stop) + 0.25)
        with grid.slab(int(low[0]), int(high[0]) + 1) as slab:
            samples = np.array(slab[:, low[1]:high[1] + 1, low[2]:high[2] + 1])
        blocks += 1
        if not samples.any():
            continue
        if samples.all():
            part = Manifold.cube(tuple(clip_high - clip_low)).translate(tuple(clip_low))
        else:
            padded = np.pad(samples, 1)
            vertices, faces, _, _ = marching_cubes(padded, 0.5, allow_degenerate=False)
            # 二值 MC 在半整数格点上，无需用浮点容差焊接分块边缘。
            vertices = vertices.astype(np.float64) + low - 1
            part = Manifold(Mesh64(vert_properties=vertices, tri_verts=faces[:, ::-1].astype(np.uint64)))
            if part.is_empty():
                raise ValueError(f"包络分块表面无效：{part.status()}")
            part = part.simplify(0)
            for axis in range(3):
                normal = [0.0, 0.0, 0.0]
                normal[axis] = 1.0
                part = part.trim_by_plane(tuple(normal), clip_low[axis])
                if part.is_empty():
                    break
                normal[axis] = -1.0
                part = part.trim_by_plane(tuple(normal), -clip_high[axis])
                if part.is_empty():
                    break
            surface_blocks += 1
            del padded, vertices, faces
        del samples
        if part.is_empty():
            from manifold3d import Error
            if part.status() != Error.NoError:
                raise ValueError(f"分块裁剪失败：位置 {start}，状态 {part.status()}")
            continue
        # 二进制归并使每块最多参与对数次融合；只保留每层一个已求值实体。
        level = 0
        while level < len(levels) and levels[level] is not None:
            part = (levels[level] + part).simplify(0)
            levels[level] = None
            part.num_tri()
            if part.is_empty():
                raise ValueError(f"分块融合失败：位置 {start}，状态 {part.status()}")
            level += 1
        if level == len(levels):
            levels.append(part)
        else:
            levels[level] = part
        check()
    accumulated = Manifold()
    for part in levels:
        if part is not None:
            accumulated = (accumulated + part).simplify(0)
            accumulated.num_tri()
            if accumulated.is_empty():
                raise ValueError(f"分批归并失败：{accumulated.status()}")
            check()
    outer = accumulated.scale((pitch, pitch, pitch)).translate(tuple(origin))
    clip = Manifold.cube(tuple(bounds[1] - bounds[0])).translate(tuple(bounds[0]))
    outer = outer.simplify(pitch * 0.02) ^ clip
    if outer.is_empty():
        raise ValueError(f"分批精细包络融合裁剪后为空：{outer.status()}，融合状态 {accumulated.status()}")
    data = outer.to_mesh64()
    result = trimesh.Trimesh(np.asarray(data.vert_properties[:, :3]), np.asarray(data.tri_verts), process=False)
    if not result.is_watertight or not result.is_winding_consistent or not result.is_volume:
        raise ValueError("分批精细包络融合后不是水密实体")
    if not np.allclose(result.bounds, bounds, rtol=0, atol=max(pitch * 1e-6, 1e-7)):
        raise ValueError("分批包络未保持六向目标边界")
    return result, {"surface_blocks": surface_blocks, "visited_blocks": blocks, "surface_block_edge": edge}


def _raster_slabs(mesh, grid, origin, pitch, parameters, depth, check):
    """按首轴范围筛选源面并保守栅格化；使用两格余量保留边缘和退化线。"""
    from app.domain.envelope_voxel import _rasterize

    faces, vertices = np.asarray(mesh.faces), np.asarray(mesh.vertices)
    low, high = np.empty(len(faces)), np.empty(len(faces))
    for first in range(0, len(faces), parameters.raster_triangle_batch):
        last = min(len(faces), first + parameters.raster_triangle_batch)
        coordinates = (vertices[faces[first:last], 0] - origin[0]) / pitch
        low[first:last], high[first:last] = coordinates.min(axis=1), coordinates.max(axis=1)
    batches = 0
    for start, stop in grid.blocks(depth):
        chosen = np.flatnonzero((high >= start - 2) & (low <= stop + 1))
        if len(chosen):
            with grid.slab(start, stop, "r+") as slab:
                stats = _rasterize(mesh, slab, origin, pitch, parameters, chosen, (start, 0, 0))
                batches += stats["raster_batches"]
        check()
        report_envelope_progress("surface_rasterization", stop, grid.shape[0])
    return {"raster_batches": batches, "raster_slabs": (grid.shape[0] + depth - 1) // depth}


def build_chunked_envelope(mesh, negative, positive, parameters, origin, pitch, shape, radius, resources, started):
    """在剩余内存内执行完整分批管线，返回带资源证据的同精度包络。"""
    from app.core.config import runtime_config
    from app.core.paths import data_root
    from app.domain.envelope_voxel import _resource_check

    def check():
        """沿用调用方的进程预算与系统预留检查；任何失败交由原异常链报告。"""
        return _resource_check(parameters)

    # 为 NumPy 标签、滤波、索引数组保留余量，不以总网格单元数申请内存。
    cells = min(parameters.voxel_max_cells,
                (resources["workspace_bytes"] - parameters.raster_batch_cells * 160) // 16)
    plane = prod(shape[1:])
    depth = min(shape[0], int(cells // plane))
    if depth < 1:
        raise MemoryError("剩余工作空间不足一个网格切片，请增加包络批次预算")
    directory = Path(os.environ["SAT_LAYOUT_ENVELOPE_SCRATCH_ROOT"]) if os.environ.get(
        "SAT_LAYOUT_ENVELOPE_SCRATCH_ROOT") else data_root() / runtime_config.model_envelope_scratch_dir
    directory.mkdir(parents=True, exist_ok=True)
    disk_bytes = prod(shape) * 3
    if shutil.disk_usage(directory).free < disk_bytes + runtime_config.model_envelope_scratch_reserve_bytes:
        raise OSError(f"包络临时磁盘空间不足，需要 {disk_bytes} 字节并保留配置余量")
    stages = {}
    with tempfile.TemporaryDirectory(prefix="envelope-", dir=directory) as temporary:
        grids = [DiskGrid(Path(temporary) / f"grid-{index}.bin", shape) for index in range(3)]
        source, spare, scratch = grids
        with envelope_stage("surface_rasterization"):
            stage_start = perf_counter()
            raster = _raster_slabs(mesh, source, origin, pitch, parameters, depth, check)
            stages["surface_rasterization_seconds"] = perf_counter() - stage_start
        with envelope_stage("exterior_fill"):
            stage_start = perf_counter()
            current = source
            if radius:
                for maximum in (True, False):
                    for axis in range(3):
                        target = spare if current is not spare else scratch
                        filter_axis(current, target, axis, 2 * radius + 1, 0, depth, maximum, check)
                        current = target
                for first, last in source.blocks(depth):
                    with source.slab(first, last) as original, current.slab(first, last, "r+") as closed:
                        closed |= original
            target = spare if current is not spare else scratch
            fill_stats = fill_holes(current, target, depth, check)
            current = target
            stages["exterior_fill_seconds"] = perf_counter() - stage_start
        with envelope_stage("directional_sweep"):
            stage_start = perf_counter()
            for axis in range(3):
                left, right = int(np.ceil(positive[axis] / pitch)), int(np.ceil(negative[axis] / pitch))
                size = left + right + 1
                if size > 1:
                    target = spare if current is not spare else scratch
                    filter_axis(current, target, axis, size, left - size // 2, depth, True, check)
                    current = target
            for axis in range(3):
                target = spare if current is not spare else scratch
                filter_axis(current, target, axis, 3, 0, depth, True, check)
                current = target
            stages["directional_sweep_seconds"] = perf_counter() - stage_start
        with envelope_stage("surface_extraction"):
            stage_start = perf_counter()
            bounds = np.asarray(mesh.bounds) + np.stack((-negative, positive))
            result, surface_stats = _surface(current, origin, pitch, bounds, parameters, check)
            stages["surface_extraction_seconds"] = perf_counter() - stage_start
    result.metadata["envelope_quality"] = {
        "method": "exterior_occupancy_directional_sweep", "fallback_used": False,
        "grid_pitch_mm": pitch, "grid_shape": list(shape), "grid_cells": prod(shape),
        "small_gap_closing_mm": 2 * radius * pitch, "surface_guard_mm": pitch,
        "external_body_count": int(result.body_count), "generation_seconds": perf_counter() - started,
        "stages": stages, "resources": {"planned": resources, "final": check()},
        "batching": {"enabled": True, "slab_depth": depth, "batch_cells": depth * plane,
                     "scratch_bytes": disk_bytes, **raster, **fill_stats, **surface_stats},
    }
    return result
