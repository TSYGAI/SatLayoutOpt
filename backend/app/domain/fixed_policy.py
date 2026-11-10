"""文件说明：固定约束的优先与释放阶段参数；只切换本次求解视图，不修改保存组或任务原始顶部选项。"""


def fixed_stage_parameters(parameters, released=False):
    """返回阶段副本；优先阶段采用固定顶部，释放后仅保留硬组及用户独立指定的顶部。"""
    result = parameters.model_copy()
    result._release_soft_fixed = released
    top = next((group for group in parameters.fixed_groups
                if group.mount == "top" and (group.hard_constraint or not released)), None)
    if top is not None:
        if parameters.top_enabled and parameters.top_record_id != top.record_id:
            raise ValueError("顶部选择与固定顶部卫星冲突")
        result.top_enabled, result.top_record_id = True, top.record_id
    return result


def candidate_fixed_parameters(candidate, parameters):
    """按服务端候选记录的阶段重建校验参数；旧候选默认优先固定，非法阶段拒绝验收。"""
    stage = candidate.get("fixed_constraint_stage", "preferred")
    if stage not in {"preferred", "released"}:
        raise ValueError("固定约束求解阶段无效")
    return fixed_stage_parameters(parameters, stage == "released")
