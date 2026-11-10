"""文件说明：将包络占据网格暂存磁盘，以有界薄片执行形态学与全局外部连通填充。

保持 SciPy 六邻域填充和一维滤波语义；边界空气分量通过并查集合并，不能把切片
边界误当成模型外部。本模块仅管理临时网格，不修改模型或正式产物。
"""

from contextlib import contextmanager
from math import prod

import numpy as np
from scipy import ndimage


class DiskGrid:
    """磁盘上的布尔网格；每次仅映射连续薄片，关闭映射后归还驻留页。"""

    def __init__(self, path, shape):
        """创建全零临时文件；路径须由调用方的专用临时目录提供。"""
        self.path, self.shape = path, tuple(shape)
        with path.open("wb") as stream:
            stream.truncate(prod(shape))

    @contextmanager
    def slab(self, start, stop, mode="r"):
        """映射指定首轴区间；退出时刷新写入并关闭映射，视图不得逸出上下文。"""
        data = np.memmap(self.path, dtype=np.bool_, mode=mode,
                         offset=start * prod(self.shape[1:]),
                         shape=(stop - start, *self.shape[1:]))
        try:
            yield data
        finally:
            if mode != "r":
                data.flush()
            data._mmap.close()

    def blocks(self, depth):
        """逐个返回无重叠薄片范围；最后一个薄片保留全部剩余单元。"""
        for start in range(0, self.shape[0], depth):
            yield start, min(self.shape[0], start + depth)


def filter_axis(source, target, axis, size, origin, depth, maximum, check):
    """按完整扫描线分批滤波，增量再大也不扩张批次内存；保留非对称扫掠相位。"""
    operation = ndimage.maximum_filter1d if maximum else ndimage.minimum_filter1d
    if axis == 0:
        # 首轴扫描按第二轴分条，保留完整首轴依赖，避免大增量导致 halo 无界扩大。
        width = max(1, depth * source.shape[1] // source.shape[0])
        for first in range(0, source.shape[1], width):
            last = min(source.shape[1], first + width)
            with source.slab(0, source.shape[0]) as incoming:
                values = np.array(incoming[:, first:last, :])
            result = operation(values, size, axis=axis, origin=origin, mode="constant", cval=False)
            del values
            with target.slab(0, source.shape[0], "r+") as outgoing:
                outgoing[:, first:last, :] = result
            del result
            check()
        return
    for start, stop in source.blocks(depth):
        with source.slab(start, stop) as incoming, target.slab(start, stop, "r+") as outgoing:
            result = operation(incoming, size, axis=axis, origin=origin, mode="constant", cval=False)
            outgoing[:] = result
            del result
        check()


class AirComponents:
    """记录跨薄片空气分量的并查集；编号零代表占据单元，不参与连通。"""

    def __init__(self):
        """初始化占据编号和外部标志。"""
        self.parents = [0]
        self.exterior = [False]

    def add(self, count):
        """追加局部分量，返回全局编号偏移。"""
        offset = len(self.parents) - 1
        self.parents.extend(range(offset + 1, offset + count + 1))
        self.exterior.extend([False] * count)
        return offset

    def root(self, value):
        """以路径压缩返回分量根节点。"""
        while self.parents[value] != value:
            self.parents[value] = self.parents[self.parents[value]]
            value = self.parents[value]
        return value

    def join(self, first, second):
        """合并跨界相邻空气分量，并传播与真实网格外部的连接。"""
        first, second = self.root(int(first)), self.root(int(second))
        if first != second:
            lower, upper = min(first, second), max(first, second)
            self.parents[upper] = lower
            self.exterior[lower] |= self.exterior[upper]


def fill_holes(source, target, depth, check):
    """两遍局部标记加全局连通合并，精确等价于整网格 binary_fill_holes。

    第一遍只保存相邻切面和分量关系，第二遍重算局部编号并写回填充结果，避免
    保存每单元四字节的全局标签；返回诊断统计。异常由调用方清理临时目录。
    """
    components, records, previous = AirComponents(), [], None
    for start, stop in source.blocks(depth):
        with source.slab(start, stop) as grid:
            labels, count = ndimage.label(~grid)
        offset = components.add(count)
        records.append((start, stop, offset, count))
        boundaries = [labels[:, 0, :], labels[:, -1, :], labels[:, :, 0], labels[:, :, -1]]
        if start == 0:
            boundaries.append(labels[0])
        if stop == source.shape[0]:
            boundaries.append(labels[-1])
        for boundary in boundaries:
            for label in np.unique(boundary):
                if label:
                    components.exterior[components.root(int(label) + offset)] = True
        if previous is not None:
            current = labels[0].ravel()
            connected = (previous > 0) & (current > 0)
            pairs = np.unique(previous[connected] * (count + 1) + current[connected])
            for pair in pairs:
                first, second = divmod(int(pair), count + 1)
                components.join(first, second + offset)
        previous = labels[-1].ravel().astype(np.int64)
        previous[previous > 0] += offset
        del labels, boundaries
        check()
    for start, stop, offset, count in records:
        with source.slab(start, stop) as grid:
            labels, _ = ndimage.label(~grid)
        filled = np.ones(count + 1, dtype=bool)
        for label in range(1, count + 1):
            filled[label] = not components.exterior[components.root(offset + label)]
        with target.slab(start, stop, "r+") as output:
            output[:] = filled[labels]
        del labels
        check()
    return {"air_components": len(components.parents) - 1, "fill_slabs": len(records)}
