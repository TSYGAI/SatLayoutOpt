"""
文件说明：在短生命周期子进程中复用旧外壳或读取完整 STEP，并生成连续外层包络。
工作进程只读取任务 JSON，并把失败首因和堆栈写入调用方指定的 UTF-8 错误文件。
"""

import json
import os
from pathlib import Path
import sys
import traceback

from app.domain.model_envelope import generate_model_envelope


def main() -> int:
    """执行一个包络任务，成功返回零，失败时保存可诊断错误并返回一。"""

    if len(sys.argv) != 3:
        return 1
    request_path = Path(sys.argv[1])
    error_path = Path(sys.argv[2])
    try:
        request = json.loads(request_path.read_text(encoding="utf-8"))
        generate_model_envelope(
            Path(request["source_step_path"]),
            Path(request["output_dir"]),
            request["model"],
            request["source"],
            request["parameters"],
            Path(request["reusable_envelope_dir"]) if request.get("reusable_envelope_dir") else None,
        )
        return 0
    except Exception as error:
        error_path.write_text(f"{error}\n{traceback.format_exc()}", encoding="utf-8")
        return 1


if __name__ == "__main__":
    exit_code = main()
    sys.stdout.flush()
    sys.stderr.flush()
    os._exit(exit_code)
