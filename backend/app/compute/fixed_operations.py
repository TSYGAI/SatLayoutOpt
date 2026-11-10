"""文件说明：从已验证数值快照执行固定放置预览；不访问业务数据库或 CAD，不写正式模型。"""

from app.compute.monitoring import observed, stage, object_context


import json

from app.compute.snapshot import read_snapshot
from app.domain.fixed_placements import preview_fixed, preview_fixed_action
from app.domain.fixed_pose import fixed_boundary_blocks_edit
from app.schemas.fixed_constraints import FixedConstraintsPayload


@observed("固定约束预览")
def fixed_preview(request, paths, emit, cancelled, checkpoint):
    """读取声明数组并统一计算固定组；非法参数抛验证异常，输出位姿、质心及可选网格。"""
    metadata = FixedConstraintsPayload.model_validate(json.loads(paths["metadata"].read_text(encoding="utf-8")))
    manifest = paths["snapshot"]
    verified = {path: {**request.inputs[key].model_dump(), "path": path.relative_to(manifest.parent).as_posix()}
                for key, path in paths.items() if path.is_relative_to(manifest.parent)}
    models, parameters = read_snapshot(manifest, verified)
    return evaluate_fixed(models, parameters, metadata, cancelled, checkpoint)


@observed("固定约束碰撞与边界校验")
def evaluate_fixed(models, parameters, metadata, cancelled, checkpoint=None):
    """复用数值包络计算；可先发布明确待校验的显示检查点，正式校验和严格门禁仍完整执行。"""
    def display(result):
        """仅发布服务端已计算的初始位姿；通过摘要检查点传递，避免大事件超出协议预算。"""
        if cancelled():
            raise InterruptedError('固定预览已取消')
        checkpoint([{'fixed_display': result}])
    try:
        result = (preview_fixed_action(models, parameters, metadata.groups, metadata.action) if metadata.action else
                  preview_fixed(models, parameters, metadata.groups, include_meshes=metadata.include_meshes,
                                on_display=display if checkpoint is not None else None))
        if metadata.enforce_space and fixed_boundary_blocks_edit(result["candidate"]):
            raise ValueError("操作超出可用空间，已保持原布局：" + "；".join(result["candidate"]["boundary_validation"]["violations"]))
    except ValueError as error:
        from app.domain.layout_solver import LayoutInfeasibleError
        raise LayoutInfeasibleError(str(error)) from error
    if cancelled():
        raise InterruptedError("固定预览已取消")
    return result
