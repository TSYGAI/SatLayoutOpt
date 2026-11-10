"""文件说明：发布版计算引擎入口；处理 Windows spawn 后执行版本化文件协议，不启动 HTTP 服务。

Nuitka standalone 保留独立进程语义；工作进程必须在业务入口和输出重定向前完成分流。
"""

import multiprocessing
import os
import sys


def main():
    """分流冻结程序的多进程启动，执行一个计算请求并返回协议约定的退出码。"""
    multiprocessing.freeze_support()
    from app.compute.__main__ import main as compute
    return compute()


if __name__ == "__main__":
    code = main()
    sys.stdout.flush()
    sys.stderr.flush()
    # 协议与文件均已完成收尾；避免 OpenCascade 的解释器退出析构缺陷。
    os._exit(code)
