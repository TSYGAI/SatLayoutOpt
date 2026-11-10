"""文件说明：分离计算错误的业务原因与诊断堆栈，跨工作进程保留错误分类，不把调用栈嵌入展示正文。"""

import traceback


class WorkerFailure(RuntimeError):
    """承接数值工作进程的结构化失败，正文仅含原因，远端堆栈由计算入口统一送往日志。"""

    def __init__(self, failure, context):
        """保存可信工作进程返回的分类和诊断，添加失败阶段但不合并堆栈到异常正文。"""
        super().__init__(f"{context}：{failure['message']}")
        self.code = failure["code"]
        self.remote_traceback = failure["traceback"]


def failure_data(error):
    """返回协议既有的 code/message/traceback 字段，保留跨进程原始位置与本地异常链。"""
    from app.domain.layout_solver import LayoutInfeasibleError

    details = "".join(traceback.format_exception(error))
    if isinstance(error, WorkerFailure):
        code = error.code
        details = error.remote_traceback + "\n数值工作进程异常传递至宿主：\n" + details
    else:
        code = ("infeasible" if isinstance(error, LayoutInfeasibleError) else
                "invalid_input" if isinstance(error, (ValueError, KeyError)) else "computation_failed")
    return {"code": code, "message": str(error) or "计算未能完成，请查看运行日志", "traceback": details}
