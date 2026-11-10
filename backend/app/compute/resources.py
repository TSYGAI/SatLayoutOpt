"""文件说明：数值池的内存采样与缩容策略；遵守 Rust 授予的预算，借助 psutil 观察本任务进程，不修改求解规则。"""

import os
import time

from pydantic import BaseModel, ConfigDict, Field

from app.compute.config import COMPUTE_CONFIG


class ResourcePlan(BaseModel):
    """Rust 的单任务准入合同；多进程数和字节限制均严格校验，禁止隐式扩大预算。"""

    model_config = ConfigDict(extra="forbid", strict=True)
    workers: int = Field(ge=1, le=COMPUTE_CONFIG["max_workers"])
    cpu_slots: int = Field(ge=1)
    cad_threads: int = Field(ge=1)
    cpu_count: int = Field(ge=1)
    available_memory_bytes: int = Field(ge=0)
    memory_reserve_bytes: int = Field(ge=0)
    budget_bytes: int = Field(ge=1)
    worker_memory_bytes: int = Field(ge=1)
    host_memory_bytes: int = Field(ge=1)


def worker_allowance(plan, parent_bytes, worker_bytes, available_bytes, estimate):
    """依据任务预算和系统可用内存选择目标进程数；已运行进程只在试次结束后退出，零表示等待。"""
    budget_limit = max(0, plan.budget_bytes - parent_bytes) // estimate
    reclaimable = sum(worker_bytes)
    system_limit = max(0, available_bytes + reclaimable - plan.memory_reserve_bytes) // estimate
    return min(plan.workers, budget_limit, system_limit)


class ResourceMonitor:
    """持续记录进程私有内存高水位；估计只增不减，避免长短试次之间频繁缩放。"""

    def __init__(self, plan, report):
        """保存准入预算和进度回调；仅正式任务启用采样，旧串行对照仍可不提供预算。"""
        import psutil
        self.plan, self.report = plan, report
        self.parent = psutil.Process(os.getpid())
        self.next_sample = 0
        self.limit = plan.workers
        self.estimate = plan.worker_memory_bytes
        self.stats = {"worker_peak_bytes": 0, "tree_peak_private_bytes": 0,
                      "min_available_bytes": plan.available_memory_bytes, "reductions": 0, "samples": 0}

    def target(self, members, force=False):
        """采样已创建的本池成员并返回派发上限；进程已退出交给工作池的崩溃检查处理。"""
        import psutil
        now = time.monotonic()
        if not force and now < self.next_sample:
            return self.limit
        self.next_sample = now + COMPUTE_CONFIG["resource_sample_seconds"]
        private = []
        for process, _ in members:
            try:
                info = psutil.Process(process.pid).memory_info()
                private.append(getattr(info, "private", info.rss))
            except psutil.NoSuchProcess:
                pass
        info = self.parent.memory_info()
        parent = getattr(info, "private", info.rss)
        available = psutil.virtual_memory().available
        peak = max(private, default=0)
        self.estimate = max(self.estimate, int(peak * COMPUTE_CONFIG["memory_estimate_margin"]))
        limit = worker_allowance(self.plan, parent, private, available, self.estimate)
        self.stats["worker_peak_bytes"] = max(self.stats["worker_peak_bytes"],
                                             int(peak * COMPUTE_CONFIG["memory_estimate_margin"]))
        self.stats["tree_peak_private_bytes"] = max(self.stats["tree_peak_private_bytes"], parent + sum(private))
        self.stats["min_available_bytes"] = min(self.stats["min_available_bytes"], available)
        self.stats["samples"] += 1
        if limit < self.limit:
            self.stats["reductions"] += 1
        self.limit = limit
        self.report({"resource_usage": {**self.stats, "workers_target": limit, "workers_live": len(members),
                                       "budget_bytes": self.plan.budget_bytes}})
        if parent + self.estimate > self.plan.budget_bytes and not members:
            raise MemoryError("布局数值输入和单个工作进程超过本次内存预算，请提高预算后重新运行")
        return limit
