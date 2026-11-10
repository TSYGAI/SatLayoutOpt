"""文件说明：提供 Windows 进程树生命周期边界；任务宿主退出时由系统回收其全部子进程。"""

import ctypes
from ctypes import wintypes
import os


def create_process_job(memory_limit_bytes=0):
    """创建退出回收进程树的 Job；可选私有内存硬上限保护独立计算任务，失败抛 OSError。"""
    if os.name != "nt":
        return None
    from ctypes import Structure, c_size_t, c_ulonglong

    class BasicLimits(Structure):
        """映射 Windows Job 基本限制结构，供原生 API 使用。"""
        _fields_ = [("ProcessTime", ctypes.c_longlong), ("JobTime", ctypes.c_longlong),
                    ("Flags", wintypes.DWORD), ("MinWorkingSet", c_size_t),
                    ("MaxWorkingSet", c_size_t), ("ActiveProcesses", wintypes.DWORD),
                    ("Affinity", c_size_t), ("Priority", wintypes.DWORD), ("Scheduling", wintypes.DWORD)]

    class IoCounters(Structure):
        """映射 Windows Job 的六项输入输出统计字段。"""
        _fields_ = [(name, c_ulonglong) for name in ("ReadOps", "WriteOps", "OtherOps", "ReadBytes", "WriteBytes", "OtherBytes")]

    class ExtendedLimits(Structure):
        """映射带进程树清理标志的 Windows Job 扩展限制。"""
        _fields_ = [("Basic", BasicLimits), ("Io", IoCounters), ("ProcessMemory", c_size_t),
                    ("JobMemory", c_size_t), ("PeakProcess", c_size_t), ("PeakJob", c_size_t)]

    kernel = ctypes.WinDLL("kernel32", use_last_error=True)
    kernel.CreateJobObjectW.argtypes = [ctypes.c_void_p, wintypes.LPCWSTR]
    kernel.CreateJobObjectW.restype = wintypes.HANDLE
    kernel.SetInformationJobObject.argtypes = [wintypes.HANDLE, ctypes.c_int, ctypes.c_void_p, wintypes.DWORD]
    kernel.AssignProcessToJobObject.argtypes = [wintypes.HANDLE, wintypes.HANDLE]
    kernel.GetCurrentProcess.restype = wintypes.HANDLE
    job = kernel.CreateJobObjectW(None, None)
    limits = ExtendedLimits()
    limits.Basic.Flags = 0x2000  # JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
    if memory_limit_bytes:
        limits.Basic.Flags |= 0x100  # JOB_OBJECT_LIMIT_PROCESS_MEMORY
        limits.ProcessMemory = int(memory_limit_bytes)
    if not job or not kernel.SetInformationJobObject(job, 9, ctypes.byref(limits), ctypes.sizeof(limits)):
        raise ctypes.WinError(ctypes.get_last_error())
    if not kernel.AssignProcessToJobObject(job, kernel.GetCurrentProcess()):
        raise ctypes.WinError(ctypes.get_last_error())
    return job
