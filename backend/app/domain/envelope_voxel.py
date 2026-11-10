"""文件说明：按有界三维占据网格重建模型外部包络，保留真实外部凹陷和分离构件。

三角面保守栅格化、封闭内部空间填充和六向盒扫掠由 NumPy/SciPy 完成；外表面由
scikit-image 提取，再用 Manifold 精确裁剪六向边界。本模块不使用凸包替代结果，
分配前检查内存，超出单批预算时交由磁盘分批管线完成同一网格，不改变格距。
"""

from __future__ import annotations

from time import perf_counter

import numpy as np
from scipy import ndimage
import trimesh


def _resource_check(parameters, requested_bytes: int = 0) -> dict:
    """校验本任务工作空间和系统可用内存；不足时明确失败，不扩大误差或切换凸包。"""

    import psutil
    from app.domain.envelope_resources import memory_limits

    memory = psutil.virtual_memory()
    process = psutil.Process()
    info = process.memory_info()
    used = int(getattr(info, "private", info.rss))
    budget, reserve = memory_limits(parameters)
    if requested_bytes > parameters.workspace_memory_bytes:
        raise MemoryError(f"精细网格工作空间估算 {requested_bytes} 字节超过配置预算")
    if memory.available < reserve + requested_bytes:
        raise MemoryError("可用物理内存不足，无法在保留桌面和系统内存后生成精细包络")
    if used + requested_bytes > budget:
        raise MemoryError(f"包络计算超过单任务内存预算 {budget} 字节")
    return {"private_bytes": used, "available_bytes": int(memory.available), "budget_bytes": budget,
            "reserve_bytes": reserve}


def _grid_plan(mesh, negative, positive, parameters):
    """确定毫米网格原点、间距与有界尺寸；给闭运算和外表面保护保留空白边界。"""

    bounds = np.asarray(mesh.bounds, dtype=np.float64)
    pitch = float(np.max(bounds[1] - bounds[0])) / parameters.refinement_grid_size
    if not np.isfinite(pitch) or pitch <= 0:
        raise ValueError("三维包络网格间距无效")
    bridge = min(
        parameters.gap_bridge_limit_mm,
        parameters.gap_bridge_ratio * float(np.min(bounds[1] - bounds[0])),
    )
    radius = int(np.floor(bridge * 0.5 / pitch)) if bridge > 0 else 0
    padding = radius + 4
    # 以源边界锚定网格，修改增量不改变已有表面的量化相位。
    lower = bounds[0] - np.ceil(negative / pitch) * pitch
    upper = bounds[1] + positive
    shape = np.ceil((upper - lower) / pitch).astype(np.int64) + 2 * padding + 1
    cells = int(shape[0]) * int(shape[1]) * int(shape[2])
    # 包含填充/滤波中间数组、marching cubes 的 float32 数组和三角面提取工作空间。
    allocation = cells * 12 + parameters.raster_batch_cells * 160
    resources = _resource_check(parameters)
    capacity = min(parameters.workspace_memory_bytes,
                   resources["budget_bytes"] - resources["private_bytes"],
                   resources["available_bytes"] - resources["reserve_bytes"])
    resources["batched"] = cells > parameters.voxel_max_cells or allocation > capacity
    resources["workspace_bytes"] = max(0, int(capacity))
    if capacity < parameters.raster_batch_cells * 160 + 4096:
        raise MemoryError("剩余内存不足以容纳最小栅格化批次")
    return lower - padding * pitch, pitch, tuple(int(x) for x in shape), radius, resources


def _triangle_ranges(triangles, dominant):
    """计算主投影平面的整数网格范围和候选单元数，供批量分配限流。"""

    axes = [axis for axis in range(3) if axis != dominant]
    projected = triangles[:, :, axes]
    lower = np.ceil(projected.min(axis=1) - 0.5 - 1e-9).astype(np.int64)
    upper = np.floor(projected.max(axis=1) + 0.5 + 1e-9).astype(np.int64)
    counts = np.maximum(upper - lower + 1, 0)
    return axes, lower, upper, counts[:, 0] * counts[:, 1]


def _raster_batch(grid, triangles, normals, dominant, lower, upper, grid_offset=0):
    """向网格写入一批三角面覆盖的单元；投影边界和深度范围都采用向外保守舍入。"""

    axes = [axis for axis in range(3) if axis != dominant]
    widths = upper - lower + 1
    counts = widths[:, 0] * widths[:, 1]
    members = np.repeat(np.arange(len(triangles)), counts)
    if not len(members):
        return
    starts = np.cumsum(counts) - counts
    local = np.arange(len(members)) - np.repeat(starts, counts)
    points = np.column_stack((
        lower[members, 0] + local // widths[members, 1],
        lower[members, 1] + local % widths[members, 1],
    ))
    keep = np.ones(len(points), dtype=bool)
    # 轴排列不同会改变投影绕序；按实际二维有向面积确定内侧。
    p = triangles[:, :, axes]
    signed = (p[:, 1, 0] - p[:, 0, 0]) * (p[:, 2, 1] - p[:, 0, 1]) - (
        p[:, 1, 1] - p[:, 0, 1]
    ) * (p[:, 2, 0] - p[:, 0, 0])
    sign = np.sign(signed[members])
    for edge in range(3):
        first = p[members, edge]
        delta = p[members, (edge + 1) % 3] - first
        cross = delta[:, 0] * (points[:, 1] - first[:, 1]) - delta[:, 1] * (points[:, 0] - first[:, 0])
        allowance = 0.5 * (np.abs(delta[:, 0]) + np.abs(delta[:, 1])) + 1e-9
        keep &= sign * cross >= -allowance
    points, members = points[keep], members[keep]
    if not len(points):
        return
    normal = normals[members]
    first = triangles[members, 0]
    plane = first[:, dominant] - np.sum(
        normal[:, axes] * (points - first[:, axes]), axis=1,
    ) / normal[:, dominant]
    slope = 0.5 * np.abs(normal[:, axes]).sum(axis=1) / np.abs(normal[:, dominant])
    low = np.ceil(plane - slope - 0.5 - 1e-9).astype(np.int64)
    high = np.floor(plane + slope + 0.5 + 1e-9).astype(np.int64)
    # 主轴选择保证 slope <= 1；最多四层，不会对三角面包围体积做无界枚举。
    for offset in range(4):
        depth = low + offset
        valid = depth <= high
        indices = np.empty((int(valid.sum()), 3), dtype=np.int64)
        indices[:, axes] = points[valid]
        indices[:, dominant] = depth[valid]
        indices -= grid_offset
        inside = np.all((indices >= 0) & (indices < np.asarray(grid.shape)), axis=1)
        indices = indices[inside]
        grid[indices[:, 0], indices[:, 1], indices[:, 2]] = True


def _rasterize(mesh, grid, origin, pitch, parameters, face_indices=None, grid_offset=None):
    """保守栅格化全部源三角面，按投影候选数拆批，限制临时数组规模。"""

    from app.domain.envelope_progress import report_envelope_progress

    vertices = (np.asarray(mesh.vertices, dtype=np.float64) - origin) / pitch
    grid_offset = np.zeros(3, dtype=np.int64) if grid_offset is None else np.asarray(grid_offset, dtype=np.int64)
    faces = np.asarray(mesh.faces)
    if face_indices is not None:
        faces = faces[face_indices]
    batches = 0
    peak = _resource_check(parameters)
    for start in range(0, len(faces), parameters.raster_triangle_batch):
        triangles = vertices[faces[start:start + parameters.raster_triangle_batch]]
        normals = np.cross(triangles[:, 1] - triangles[:, 0], triangles[:, 2] - triangles[:, 0])
        magnitude = np.abs(normals).max(axis=1)
        degenerate = magnitude < 1e-12
        if np.any(degenerate):
            # 退化细杆必须保留整条线段，不能只留下两端顶点。
            for triangle in triangles[degenerate]:
                for edge in range(3):
                    first, last = triangle[edge], triangle[(edge + 1) % 3]
                    steps = max(1, int(np.ceil(np.max(np.abs(last - first)) * 2)))
                    for segment in range(0, steps + 1, parameters.raster_batch_cells):
                        fraction = np.arange(segment, min(steps + 1, segment + parameters.raster_batch_cells)) / steps
                        indices = np.rint(first + fraction[:, None] * (last - first)).astype(np.int64)
                        indices -= grid_offset
                        inside = np.all((indices >= 0) & (indices < np.asarray(grid.shape)), axis=1)
                        indices = indices[inside]
                        grid[indices[:, 0], indices[:, 1], indices[:, 2]] = True
        dominant_axes = np.argmax(np.abs(normals), axis=1)
        for dominant in range(3):
            chosen = (dominant_axes == dominant) & ~degenerate
            group, group_normals = triangles[chosen], normals[chosen]
            if not len(group):
                continue
            _, lower, upper, counts = _triangle_ranges(group, dominant)
            axes = [axis for axis in range(3) if axis != dominant]
            lower = np.maximum(lower, grid_offset[axes])
            upper = np.minimum(upper, grid_offset[axes] + np.asarray(grid.shape)[axes] - 1)
            valid = np.all(upper >= lower, axis=1)
            group, group_normals, lower, upper = group[valid], group_normals[valid], lower[valid], upper[valid]
            counts = np.prod(upper - lower + 1, axis=1)
            cursor = 0
            while cursor < len(group):
                remaining = np.cumsum(counts[cursor:])
                length = max(1, int(np.searchsorted(remaining, parameters.raster_batch_cells, side="right")))
                stop = min(cursor + length, len(group))
                if int(counts[cursor]) > parameters.raster_batch_cells:
                    # 单个巨大面按主平面的第一轴分条，不突破批量内存限制。
                    width = int(upper[cursor, 1] - lower[cursor, 1] + 1)
                    rows = max(1, parameters.raster_batch_cells // width)
                    for row in range(int(lower[cursor, 0]), int(upper[cursor, 0]) + 1, rows):
                        strip_lower = lower[cursor:cursor + 1].copy()
                        strip_upper = upper[cursor:cursor + 1].copy()
                        strip_lower[0, 0] = row
                        strip_upper[0, 0] = min(row + rows - 1, strip_upper[0, 0])
                        _raster_batch(grid, group[cursor:cursor + 1], group_normals[cursor:cursor + 1], dominant, strip_lower, strip_upper, grid_offset)
                    stop = cursor + 1
                else:
                    _raster_batch(grid, group[cursor:stop], group_normals[cursor:stop], dominant, lower[cursor:stop], upper[cursor:stop], grid_offset)
                cursor = stop
                batches += 1
        resources = _resource_check(parameters)
        peak["private_bytes"] = max(peak["private_bytes"], resources["private_bytes"])
        peak["available_bytes"] = min(peak["available_bytes"], resources["available_bytes"])
        if face_indices is None:
            report_envelope_progress("surface_rasterization", min(start + parameters.raster_triangle_batch, len(faces)), len(faces))
    return {"raster_batches": batches, **peak}


def _close_and_fill(grid, radius):
    """只封连配置阈值内的细小凹槽，并填充封闭内部空间；原占据单元不会被削掉。"""

    if radius:
        closed = grid.copy()
        for axis in range(3):
            closed = ndimage.maximum_filter1d(closed, 2 * radius + 1, axis=axis, mode="constant", cval=False)
        for axis in range(3):
            closed = ndimage.minimum_filter1d(closed, 2 * radius + 1, axis=axis, mode="constant", cval=False)
        grid |= closed
        del closed
    return ndimage.binary_fill_holes(grid)


def _directional_dilation(grid, negative, positive, pitch):
    """执行与非对称六向增量盒等价的离散连续扫掠，保留原位和全部中间位移。"""

    for axis in range(3):
        left = int(np.ceil(positive[axis] / pitch))
        right = int(np.ceil(negative[axis] / pitch))
        size = left + right + 1
        if size > 1:
            grid = ndimage.maximum_filter1d(
                grid, size, axis=axis, origin=left - size // 2, mode="constant", cval=False,
            )
    # marching cubes 会切掉二值单元的角；全邻域增加一格保护，保证不削去源三角面。
    for axis in range(3):
        grid = ndimage.maximum_filter1d(grid, 3, axis=axis, mode="constant", cval=False)
    return grid


def _extract_outer_surface(grid, origin, pitch, target_bounds):
    """提取水密外表面并精确裁剪六向边界；保留有实际尺寸的分离外部构件。"""

    from skimage.measure import marching_cubes
    from manifold3d import Manifold, Mesh64

    vertices, faces, _, _ = marching_cubes(grid, 0.5, allow_degenerate=False)
    vertices = vertices.astype(np.float64) * pitch + origin
    candidate = trimesh.Trimesh(vertices, faces, process=False)
    if candidate.volume < 0:
        candidate.invert()
    outer = Manifold(Mesh64(
        vert_properties=np.asarray(candidate.vertices, dtype=np.float64),
        tri_verts=np.asarray(candidate.faces, dtype=np.uint64),
    ))
    if outer.is_empty():
        raise ValueError(f"三维外表面网格不满足 Manifold 实体约束：{outer.status()}")
    clip = Manifold.cube(tuple(target_bounds[1] - target_bounds[0])).translate(tuple(target_bounds[0]))
    # 简化必须先于精确裁剪，否则 Manifold 会把裁剪平面也移动到目标边界内侧。
    outer = outer.simplify(pitch * 0.02) ^ clip
    if outer.is_empty():
        raise ValueError("三维精细外表面裁剪后为空")
    data = outer.to_mesh64()
    result = trimesh.Trimesh(np.asarray(data.vert_properties[:, :3]), np.asarray(data.tri_verts), process=False)
    if not result.is_watertight or not result.is_winding_consistent or not result.is_volume:
        raise ValueError("三维精细外表面不是水密实体")
    tolerance = max(float(pitch) * 1e-6, 1e-7)
    if not np.allclose(result.bounds, target_bounds, rtol=0.0, atol=tolerance):
        raise ValueError("三维精细外表面未保持六向目标边界")
    return result


def build_outer_voxel_envelope(mesh, negative, positive, parameters):
    """在明确资源预算内生成精细三维包络；失败带阶段异常上抛，始终不返回凸包。"""

    started = perf_counter()
    from app.domain.envelope_resources import envelope_stage

    stages = {}
    with envelope_stage("grid_planning"):
        origin, pitch, shape, radius, resources = _grid_plan(mesh, negative, positive, parameters)
        if resources["batched"]:
            from app.domain.envelope_chunked import build_chunked_envelope
            return build_chunked_envelope(mesh, negative, positive, parameters,
                                          origin, pitch, shape, radius, resources, started)
        grid = np.zeros(shape, dtype=bool)
    with envelope_stage("surface_rasterization"):
        raster_started = perf_counter()
        raster = _rasterize(mesh, grid, origin, pitch, parameters)
        stages["surface_rasterization_seconds"] = perf_counter() - raster_started
    with envelope_stage("exterior_fill"):
        fill_started = perf_counter()
        grid = _close_and_fill(grid, radius)
        stages["exterior_fill_seconds"] = perf_counter() - fill_started
        _resource_check(parameters)
    with envelope_stage("directional_sweep"):
        sweep_started = perf_counter()
        grid = _directional_dilation(grid, negative, positive, pitch)
        stages["directional_sweep_seconds"] = perf_counter() - sweep_started
        _resource_check(parameters)
    with envelope_stage("surface_extraction"):
        extraction_started = perf_counter()
        target_bounds = np.asarray(mesh.bounds) + np.stack((-negative, positive))
        result = _extract_outer_surface(grid, origin, pitch, target_bounds)
        stages["surface_extraction_seconds"] = perf_counter() - extraction_started
    result.metadata["envelope_quality"] = {
        "method": "exterior_occupancy_directional_sweep",
        "fallback_used": False,
        "grid_pitch_mm": pitch,
        "grid_shape": list(shape),
        "grid_cells": int(np.prod(shape)),
        "small_gap_closing_mm": 2 * radius * pitch,
        "surface_guard_mm": pitch,
        "external_body_count": int(result.body_count),
        "generation_seconds": perf_counter() - started,
        "stages": stages,
        "resources": {"planned": resources, "raster": raster, "final": _resource_check(parameters)},
    }
    return result
