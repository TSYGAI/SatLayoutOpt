"""文件说明：单次求解上下文内的有界安装姿态和接触截面缓存；按模型身份复用只读几何，退出立即释放。"""

from collections import OrderedDict
from contextlib import contextmanager
from contextvars import ContextVar
from dataclasses import fields

import numpy as np

_CURRENT = ContextVar("layout_mount_cache", default=None)


class MountCache:
    """按字节数限制的 LRU；保留来源引用防止对象 ID 复用，不缓存异常或超大条目。"""

    def __init__(self, budget):
        """设置缓存预算，命中与淘汰只影响执行成本，不改变几何算法。"""
        self.budget, self.bytes = budget, 0
        self.entries = OrderedDict()

    def resolve(self, model, mount, roll, produce):
        """命中返回相同只读结果；未命中执行原算法，条目超额则直接返回且不保留。"""
        key = (id(model), mount, roll)
        if key in self.entries:
            source, value, size = self.entries.pop(key)
            self.entries[key] = (source, value, size)
            return value
        value = produce(model, mount, roll)
        arrays = {id(array): array for field in fields(value)
                  for array in (getattr(value, field.name) if isinstance(getattr(value, field.name), tuple)
                                else (getattr(value, field.name),))
                  if isinstance(array, np.ndarray)}
        size = sum(array.nbytes for array in arrays.values())
        if size > self.budget:
            return value
        for array in arrays.values():
            array.flags.writeable = False
        while self.entries and self.bytes + size > self.budget:
            _, (_, _, removed) = self.entries.popitem(last=False)
            self.bytes -= removed
        self.entries[key] = (model, value, size)
        self.bytes += size
        return value


@contextmanager
def mount_cache(budget):
    """为当前求解线程启用有界姿态复用；退出或异常时恢复上层上下文并释放引用。"""
    token = _CURRENT.set(MountCache(budget))
    try:
        yield
    finally:
        _CURRENT.reset(token)


def cached_mount(model, mount, roll, produce):
    """普通领域调用保持无缓存；计算引擎显式进入上下文后才复用姿态。"""
    cache = _CURRENT.get()
    return produce(model, mount, roll) if cache is None else cache.resolve(model, mount, roll, produce)
