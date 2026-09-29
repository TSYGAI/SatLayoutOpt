"""
文件说明：隔离运行 CadQuery/OpenCascade 的 STEP 派生产物工作进程入口。
成功或失败后使用 os._exit 结束，避免 OpenCascade 在解释器析构阶段影响长期运行的 API 进程。
"""

import json
import os
from pathlib import Path
import sys
import traceback

from app.domain.model_artifacts import generate_model_artifacts


def main() -> int:
    """读取任务描述、生成 GLB 与面映射，并将异常写入独立错误文件。

    返回：
        0 表示产物生成成功，1 表示任务参数或 STEP 转换失败。
    副作用：
        写入任务指定的产物目录；失败时写入 UTF-8 错误说明。
    """

    if len(sys.argv) != 3:
        return 1
    request_path = Path(sys.argv[1])
    error_path = Path(sys.argv[2])
    try:
        request = json.loads(request_path.read_text(encoding="utf-8"))
        generate_model_artifacts(
            Path(request["source_path"]),
            Path(request["output_dir"]),
            request["model"],
            str(request["quality"]),
            request["parameters"],
            Path(request["reusable_shell_map_path"]) if request.get("reusable_shell_map_path") else None,
        )
        return 0
    except Exception as error:
        error_path.write_text(
            f"{error}\n{traceback.format_exc()}",
            encoding="utf-8",
        )
        return 1


if __name__ == "__main__":
    exit_code = main()
    sys.stdout.flush()
    sys.stderr.flush()
    os._exit(exit_code)
