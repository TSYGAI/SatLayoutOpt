"""文件说明：从隔离协议资源读取历史数值快照并执行微调；不访问 CAD、模型库和业务数据库。"""

import json

from app.compute.snapshot import read_snapshot
from app.domain.layout_refinement import evaluate_refinement


def refine(request, paths, emit, cancelled, checkpoint):
    """校验历史数组声明后重放命令；取消时不发布校核结果。"""
    if request.payload:
        raise ValueError("微调 payload 必须为空")
    metadata = json.loads(paths["metadata"].read_text(encoding="utf-8"))
    manifest = paths["snapshot"]
    verified = {path: {**request.inputs[name].model_dump(), "path": path.relative_to(manifest.parent).as_posix()}
                for name, path in paths.items() if path.is_relative_to(manifest.parent)}
    models, parameters = read_snapshot(manifest, verified, require_current_config=False)
    result = evaluate_refinement(metadata["candidate"], models, parameters, metadata["commands"], metadata["command_limit"], cancelled)
    return result
