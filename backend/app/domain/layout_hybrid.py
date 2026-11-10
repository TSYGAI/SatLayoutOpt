"""文件说明：按任务独立参数调度低位优先构造与ALNS改善；完整验收候选及时展示，管理层限、归档和取消快照。"""

from copy import deepcopy
import math

import numpy as np

from app.domain.fixed_policy import fixed_stage_parameters
from app.domain.layout_attempts import LayoutAttempt, serial_attempts, candidate_attempt, streaming_attempts
from app.domain.layout_candidates import retain_candidate, candidate_order_key
from app.domain.layout_config import LAYOUT_CONFIG
from app.domain.layout_cp import cp_partitions
from app.domain.layout_symmetry import placement_units, symmetry_pairs


def solve_hybrid_attempt(side, top, task, parameters, cancelled):
    """串行与多进程共用完全相同的试次入口，随机源包含结构、半径、阶段及序号。"""
    from app.domain.layout_solver import attempt_rng, solve_ring_arrangement
    rng = attempt_rng(task.radius, task.layer_count, task.partition, task.trial,
                      purpose=task.purpose, random_seed=parameters.random_seed)
    with candidate_attempt(task):
        if task.seed is None:
            return solve_ring_arrangement(side, top, task.partition, task.radius, parameters, task.trial, rng, cancelled)
        return solve_ring_arrangement(side, top, task.partition, task.radius, parameters, task.trial, rng, cancelled, seed=task.seed)


def candidate_partition(candidate, side):
    """将实际验收层转换为侧挂索引组，供 CP 修复保留未破坏单元。"""
    indices = {item.instance_id: i for i, item in enumerate(side)}
    groups = {}
    for item in candidate["placements"]:
        if item["mount"] == "side":
            groups.setdefault(item["layer"], []).append(indices[item["instance_id"]])
    return tuple(tuple(sorted(values)) for _, values in sorted(groups.items()))


def optimize_hybrid(satellites, parameters, report, cancelled, *, attempt_runner=None, candidate_report=None):
    """先覆盖大半径和少层结构，再自适应改善合法解；两种软固定策略公平搜索，共享任务预算和层上限。"""
    from app.domain.layout_solver import (LayoutInfeasibleError, LayoutSearchCancelled, check_feasibility,
                                         maximum_side_radius, radius_scan_values, finalize_candidates)
    archive, pending, contexts = {}, {}, []
    budget = parameters.hybrid_attempt_budget
    fraction = parameters.alns_budget_fraction
    radius_samples = parameters.hybrid_radius_samples
    partition_limit = parameters.cp_partition_limit
    total = min(LAYOUT_CONFIG["max_attempts_per_round"],
                LAYOUT_CONFIG["hybrid_attempt_budget"] if budget is None else budget)
    fraction = LAYOUT_CONFIG["alns_budget_fraction"] if fraction is None else fraction
    radius_samples = LAYOUT_CONFIG["hybrid_radius_samples"] if radius_samples is None else radius_samples
    partition_limit = LAYOUT_CONFIG["cp_partition_limit"] if partition_limit is None else partition_limit
    construction = max(1, math.ceil(total * (1 - fraction)))
    attempted, first_layer = 0, None
    target = LAYOUT_CONFIG["candidate_archive_limit"] if parameters.candidate_limit is None else parameters.candidate_limit
    rng = np.random.default_rng(parameters.random_seed)
    weights = np.ones(4)
    operator_counts = np.zeros(4, dtype=int)
    improvements = 0
    last_batch_feasible = False
    runner = attempt_runner or serial_attempts
    progress = {}

    def snapshot(limit=target):
        """合并完整合法候选并按指定数量截取；默认用于展示，内部搜索显式读取完整候选档案。"""
        visible = dict(archive)
        for candidate in pending.values():
            if first_layer is None or candidate["side_layer_count"] <= first_layer + 1:
                retain_candidate(visible, candidate)
        return finalize_candidates(visible, limit)

    def emit(message, **values):
        """发布进度、预算和首可行层；记录更新标识不继承到后续普通消息。"""
        metrics, visible = {}, snapshot()
        if visible:
            metrics = {"best_height_mm": min(item["height_mm"] for item in visible),
                       "best_radius_mm": max(item["radius_mm"] for item in visible),
                       "best_center_z_mm": min(item["validation"]["center_of_mass_mm"][2] for item in visible)}
        progress.update({"phase": "search", "message": message, "message_key": None, "attempts": attempted,
                "round_index": 1, "round_attempts": attempted, "round_attempt_limit": total,
                "valid_count": len(visible), "first_feasible_layer": first_layer,
                "layer_limit": None if first_layer is None else first_layer + 1,
                "algorithm": "cp-sat-alns-v2", **metrics, **values})
        report(dict(progress))

    def receive_candidate(task, candidate):
        """立即展示已经落位并完整验收的独立副本，试次归并后参与搜索；取消保留该副本。"""
        if not candidate.get("validation", {}).get("valid"):
            raise ValueError("提前发布仅接受完整验收通过的布局")
        previous = pending.get(task.sequence)
        if previous is not None and candidate_order_key(previous) <= candidate_order_key(candidate):
            return
        pending[task.sequence] = deepcopy(candidate)
        if candidate_report:
            candidate_report(snapshot())
        count = max(attempted + 1, progress.get("attempts", 0))
        emit(f"试次 {task.sequence}：低位布局已通过完整验收，方案已可查看",
             attempts=count, round_attempts=count, message_key="layout-compaction")
        if cancelled():
            raise InterruptedError("任务已取消")

    def run_batch(tasks, context):
        """有限批次归并后才生成后续层，避免多进程预取越过首个可行层的 L+1 限制。"""
        nonlocal attempted, first_layer, last_batch_feasible
        last_batch_feasible = False
        current, side, top, _ = context

        def solve(task):
            """将闭包参数传给公共试次入口。"""
            return solve_hybrid_attempt(side, top, task, current, cancelled)

        def started(task):
            """报告正在求解的真实层数与筒半径。"""
            emit(f"A+B：{task.layer_count} 层，筒半径 {task.radius:.3f} mm，进行连续几何修复",
                 radius_mm=task.radius, layer_count=task.layer_count,
                 attempts=attempted + 1, round_attempts=attempted + 1,
                 radius_index=task.radius_index, radius_count=len(context[3]),
                 fixed_constraint_stage="released" if task.release_soft_fixed else "preferred")

        accepted = False
        for task, candidate in streaming_attempts(runner, tasks, solve, started, cancelled, receive_candidate):
            attempted += 1
            preliminary = pending.pop(task.sequence, None)
            if candidate is None and preliminary is not None:
                candidate = preliminary
            if candidate is None:
                if cancelled():
                    raise InterruptedError("任务已取消")
                continue
            physical = candidate["side_layer_count"]
            if first_layer is None:
                first_layer = physical
            else:
                first_layer = min(first_layer, physical)
            if physical > first_layer + 1:
                continue
            last_batch_feasible = True
            # 新发现更少实际层时，移除超出用户层数政策的旧候选。
            for key in list(archive):
                if archive[key]["side_layer_count"] > first_layer + 1:
                    del archive[key]
            accepted = retain_candidate(archive, candidate) or accepted
            if candidate_report:
                candidate_report(snapshot())
            if cancelled():
                raise InterruptedError("任务已取消")
        return accepted

    try:
        errors = []
        policies = (False, True) if any(not group.hard_constraint for group in parameters.fixed_groups) else (False,)
        for released in policies:
            if cancelled():
                raise InterruptedError("任务已取消")
            report({"phase": "validate", "attempts": 0, "valid_count": 0,
                    "fixed_constraint_stage": "released" if released else "preferred",
                    "message": "先计算最大筒半径上界，再校验安装区域、模型与悬高"})
            try:
                current = fixed_stage_parameters(parameters, released)
                top = next((item for item in satellites if current.top_enabled and item.record_id == current.top_record_id), None)
                side = sorted((item for item in satellites if item is not top), key=lambda item: (-item.mass, -item.volume))
                if not side:
                    check_feasibility(satellites, current)
                maximum = maximum_side_radius(side, current, satellites)
                check_feasibility(satellites, current)
            except (LayoutInfeasibleError, ValueError) as error:
                errors.append(error)
                continue
            grid = radius_scan_values(maximum, current.min_radius_mm, current.radius_step_mm)
            contexts.append((current, side, top, grid))
            emit(f"必要条件通过，筒半径上界 {maximum:.3f} mm；该上界尚不代表多星布局可行",
                 fixed_constraint_stage="released" if released else "preferred")
        if not contexts:
            error = errors[-1]
            summary = getattr(error, "summary", str(error))
            report({"phase": "validation_failed", "message": str(error), "validation_summary": summary,
                    "termination_reason": "validation_failed", "attempts": 0, "valid_count": 0})
            raise LayoutInfeasibleError(str(error), summary) from error
        max_layers = max(len(side) - len(symmetry_pairs(side, current, include_top=False))
                         for current, side, _, _ in contexts)
        quota = max(1, construction // max_layers // len(contexts))
        for layer_count in range(1, max_layers + 1):
            if first_layer is not None and layer_count > first_layer + 1:
                break
            for context in contexts:
                if first_layer is not None and layer_count > first_layer + 1:
                    break
                current, side, top, grid = context
                samples = min(len(grid), radius_samples, quota)
                positions = np.unique(np.linspace(0, len(grid) - 1, samples, dtype=int))
                # 各半径先获得一次预算；只有覆盖后才追加同点试次。
                plans = []
                for position in positions:
                    structures = cp_partitions(side, satellites, current, float(grid[position]), layer_count,
                                               parameters.random_seed + layer_count, cancelled, limit=partition_limit)
                    plans.append((int(position), structures))
                tasks = []
                for trial in range(math.ceil(quota / max(1, len(positions)))):
                    for position, structures in plans:
                        if not structures or len(tasks) >= quota or attempted + len(tasks) >= construction:
                            continue
                        partition = structures[trial % len(structures)]
                        tasks.append(LayoutAttempt(attempted + len(tasks) + 1, position + 1, float(grid[position]),
                                                   layer_count, partition, trial, 2, current._release_soft_fixed))
                run_batch(tasks, context)
            if attempted >= construction:
                break
        emit("进入 B：按改善收益自适应选择重排、换层、扩大半径及姿态重启", search_stage="alns")
        # 即使构造阶段无解，仍用剩余预算对允许的层数进行随机结构修复，不伪称不可行。
        while attempted < total:
            if cancelled():
                raise InterruptedError("任务已取消")
            context = contexts[(attempted - construction) % len(contexts)]
            current, side, top, grid = context
            operation = int(rng.choice(len(weights), p=weights / weights.sum()))
            operator_counts[operation] += 1
            eligible = [item for item in snapshot(LAYOUT_CONFIG["candidate_archive_limit"])
                        if (item.get("fixed_constraint_stage") == "released") == current._release_soft_fixed]
            source = eligible[int(rng.integers(len(eligible)))] if eligible else None
            layer_limit = min(max_layers, first_layer + 1 if first_layer is not None else max_layers)
            partition = candidate_partition(source, side) if source else None
            layer_count = len(partition) if partition else int(rng.integers(1, layer_limit + 1))
            radius_index = int(np.argmin(np.abs(grid - source["radius_mm"]))) if source else int(rng.integers(len(grid)))
            locked = None
            seed = source
            if operation == 0 and partition:
                units = placement_units(list(range(len(side))), symmetry_pairs(side, current, include_top=False))
                remove = rng.choice(len(units), max(1, math.ceil(len(units) * LAYOUT_CONFIG["alns_destroy_fraction"])), replace=False)
                removed = {index for unit in remove for index in units[unit]}
                locked = {i: level for level, group in enumerate(partition) for i in group if i not in removed}
            elif operation == 1:
                layer_count = int(rng.integers(1, layer_limit + 1))
            elif operation == 2:
                radius_index = max(0, radius_index - int(rng.integers(1, max(2, math.ceil(len(grid) / radius_samples)))))
            else:
                seed = None
            structures = cp_partitions(side, satellites, current, float(grid[radius_index]), layer_count,
                                       int(rng.integers(2**31 - 1)), cancelled, limit=partition_limit, locked=locked)
            if not structures:
                # 无结构也消耗一次规划预算，防止 CP 空结果导致无限循环。
                attempted += 1
                success = False
                last_batch_feasible = False
            else:
                task = LayoutAttempt(attempted + 1, radius_index + 1, float(grid[radius_index]), layer_count,
                                     structures[int(rng.integers(len(structures)))], attempted + 4,
                                     101 + operation, current._release_soft_fixed, seed)
                success = run_batch([task], context)
            reward = (LAYOUT_CONFIG["alns_improvement_reward"] if success else
                      LAYOUT_CONFIG["alns_feasible_reward"] if last_batch_feasible else LAYOUT_CONFIG["alns_failure_reward"])
            reaction = LAYOUT_CONFIG["alns_reaction"]
            weights[operation] = (1 - reaction) * weights[operation] + reaction * reward
            improvements += int(success)
        emit("搜索预算完成；保留经过完整验收的布局，未找到解不等于已证明无解", termination_reason="attempt_limit",
             search_stage="complete", alns_improvements=improvements,
             alns_operator_counts=operator_counts.tolist(), alns_weights=weights.tolist())
        return snapshot()
    except InterruptedError as error:
        raise LayoutSearchCancelled(snapshot()) from error
