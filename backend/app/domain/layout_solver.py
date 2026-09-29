"""文件说明：按勾股径向边界、层质量组合、环向配平和布局后逐颗下沉搜索最多五组布局；无 HTTP 和文件写入。

固定模型轴始终朝全局 +Z，自由轴按安装面搜索四种滚转；仅将指定卫星置于正顶部，侧挂分组质量严格递减。
依赖候选结构去重，按用户步长完整扫描半径、分组、姿态与层数。
"""

import itertools
import math

import numpy as np
from scipy.optimize import minimize
from shapely.geometry import MultiPoint

from app.domain.layout_candidates import (
    candidate_order_key, retain_candidate,
)
from app.domain.layout_config import LAYOUT_CONFIG
from app.domain.layout_geometry import make_placement, rotation_z, validate_layout
from app.domain.layout_mounts import MountOrientationError, mounting_variants, orient_for_mount
from app.domain.layout_radial import side_mount_radial_limits


class LayoutSearchCancelled(InterruptedError):
    """表示布局搜索被协作取消，并携带取消前已通过完整验收的候选。"""

    def __init__(self, candidates):
        """保存已排序、已编号的候选，供任务服务持久化并展示。"""
        super().__init__("任务已取消")
        self.candidates = candidates


class LayoutInfeasibleError(ValueError):
    """表示输入在当前安装姿态和包络约束下不可行；增加同一搜索的时间不能修复。"""


def check_feasibility(satellites, parameters) -> None:
    """检查独立于搜索的必要条件；顶部不受当前罩高上限，不能因为顶部尺寸就判整体不可行。"""
    if parameters.top_enabled and len(satellites) == 1:
        raise LayoutInfeasibleError("仅有顶部卫星时，其质心位于圆柱上方，无法落入有限中轴柱；需要侧挂质量配平")
    top = next((item for item in satellites if parameters.top_enabled and item.record_id == parameters.top_record_id), None)
    for model in satellites:
        try:
            orient_for_mount(model, "top" if model is top else "side")
        except MountOrientationError as error:
            raise LayoutInfeasibleError(str(error)) from error


def layer_partitions(satellites, layer_count, beam, cancelled, can_fit=None):
    """按重卫星优先构造非空侧挂层组合；保留质量递减且底层组合更重的分组，返回有界候选集合。"""
    ordered = sorted(range(len(satellites)), key=lambda index: (-satellites[index].mass, -satellites[index].volume))
    states = [((),) * layer_count]
    for offset, index in enumerate(ordered):
        if cancelled():
            raise InterruptedError("任务已取消")
        expanded = set()
        for state in states:
            for layer in range(layer_count):
                if layer > 0 and not state[layer - 1]:
                    break
                groups = list(state)
                groups[layer] = (*groups[layer], index)
                if can_fit is not None and not can_fit(groups[layer]):
                    continue
                if sum(not group for group in groups) <= len(ordered) - offset - 1:
                    expanded.add(tuple(groups))
        states = sorted(expanded, key=lambda state: partition_rank(state, satellites))[:beam]
    margin = LAYOUT_CONFIG["layer_mass_margin_kg"]
    canonical = {tuple(sorted(state, key=lambda group: (-sum(satellites[index].mass for index in group), group))) for state in states}
    for state in sorted(canonical, key=lambda groups: partition_rank(groups, satellites)):
        masses = [sum(satellites[index].mass for index in group) for group in state]
        if all(group for group in state) and all(a - b >= margin for a, b in zip(masses, masses[1:])):
            yield state


def partition_rank(state, satellites):
    """返回优先重载底层组合的排序键，同质量时优先降低侧挂层总高度。"""
    masses = tuple(sorted(-sum(satellites[index].mass for index in group) for group in state))
    heights = sum(max((satellites[index].upper[2] - satellites[index].lower[2] for index in group), default=0)
                  for group in state)
    return masses, heights, state


def radial_limits(model, parameters):
    """按统一勾股截面返回最大舱半径和最小有效悬高；保持安装面为 -X 的输入约定。"""
    limits = side_mount_radial_limits(model, parameters)
    return limits.max_radius_mm, limits.min_suspension_mm


def maximum_side_radius(side, parameters):
    """在每颗允许的固定或自由侧挂姿态中取最佳半径，再求交集；无交集时抛出带尺寸依据的异常。"""
    tolerance = LAYOUT_CONFIG["geometry_tolerance_mm"]
    best = []
    for model in side:
        limits = max((side_mount_radial_limits(variant, parameters) for variant in mounting_variants(model, "side")),
                     key=lambda item: (item.max_radius_mm, -item.min_suspension_mm))
        best.append((model, limits))
    model, limits = min(best, key=lambda item: item[1].max_radius_mm)
    if limits.max_radius_mm < parameters.min_radius_mm - tolerance:
        orientation = ("向上轴自由，检查安装面滚转 0/90/180/270 度" if model.up_orientation == "free"
                       else f"向上轴 {model.up_orientation} 对齐全局 +Z")
        prefix = f"侧挂半径不可行：{model.name}（安装面 {model.installation_face_id}；{orientation}）。"
        if limits.min_suspension_mm > parameters.max_suspension_mm + tolerance:
            reason = (f"包络及悬高下限要求 s 至少 {limits.min_suspension_mm:.3f} mm，"
                      f"超过悬高上限 {parameters.max_suspension_mm:.3f} mm")
        elif not math.isfinite(limits.max_face_radius_mm):
            reason = (f"有效半宽 b={limits.tangential_extent_mm:.3f} mm 超过整流罩半径 "
                      f"R={parameters.fairing_radius_mm:.3f} mm，sqrt(R²-b²) 无实数解")
        else:
            reason = (f"允许姿态的最佳截面：R={parameters.fairing_radius_mm:.3f} mm，"
                      f"b={limits.tangential_extent_mm:.3f} mm，t={limits.outward_depth_mm:.3f} mm，"
                      f"s={limits.min_suspension_mm:.3f} mm；按 r_max=sqrt(R²-b²)-t-s，"
                      f"最大舱半径 {limits.max_radius_mm:.3f} mm 小于锁定下限 {parameters.min_radius_mm:.3f} mm；"
                      f"取该下限需要整流罩半径至少 {limits.required_fairing_radius(parameters.min_radius_mm):.3f} mm")
        raise LayoutInfeasibleError(f"{prefix}{reason}；未修改锁定参数或安全包络")
    return min(parameters.max_radius_mm, max(parameters.min_radius_mm, limits.max_radius_mm))


def mount_variants(model, radius, parameters):
    """按罩半径和悬高筛选允许的侧挂姿态；自由轴可滚转，固定轴不得横放或倒置。"""
    variants = mounting_variants(model, "side")
    return sorted((item for item in variants if radial_limits(item, parameters)[0] >= radius - LAYOUT_CONFIG["geometry_tolerance_mm"]),
                  key=lambda item: (item.upper[2] - item.lower[2], item.center[2] - item.lower[2]))


def initialize_ring_angles(partition, dimensions, radii, tangent_offset, trial, rng):
    """用相邻矩形分离角构造各层无穿透初值；环周不够时返回空，避免对明显塞不下的重载组合反复配平。"""
    half = dimensions[:, :2] / 2
    angles = np.zeros(len(radii))

    def separation(first, second, angle):
        """计算两径向矩形在给定相对角度的最大分离轴余量。"""
        ca, sa = math.cos(angle), math.sin(angle)
        left_axes = np.eye(2)
        right_axes = np.array([[ca, sa], [-sa, ca]])
        axes = np.concatenate([left_axes, right_axes])
        left = np.array([radii[first], tangent_offset[first]])
        right = np.array([ca * radii[second] - sa * tangent_offset[second], sa * radii[second] + ca * tangent_offset[second]])
        return float(np.max(np.abs(axes @ (right - left)) - np.abs(axes @ left_axes.T) @ half[first]
                            - np.abs(axes @ right_axes.T) @ half[second]))

    for group in partition:
        if len(group) == 1:
            angles[group[0]] = rng.uniform(0, 2 * math.pi) if trial else 0
            continue
        order = list(group)
        if trial:
            rng.shuffle(order)
        required = []
        for first, second in zip(order, [*order[1:], order[0]]):
            low, high = 0.0, math.pi
            if separation(first, second, high) < 0:
                return None
            for _ in range(32):
                midpoint = (low + high) / 2
                if separation(first, second, midpoint) >= 0:
                    high = midpoint
                else:
                    low = midpoint
            required.append(high)
        if sum(required) > 2 * math.pi:
            return None
        slack = (2 * math.pi - sum(required)) / len(group)
        cursor = rng.uniform(0, 2 * math.pi) if trial else 0.0
        for index, item in enumerate(order):
            angles[item] = cursor
            cursor += required[index] + slack
    return angles


def lower_layers(side, partition, centers, angles):
    """在平面布局完成后逐颗下沉，返回各包络底高；不改水平位置、姿态或原分组。

    按原分组由下到上处理，每颗仅受投影有面积重叠的已落定包络阻挡，落至最高阻挡顶面或 z=0。
    使用与独立验收相同的保守凸包棱柱和接触容差；同组平面冲突仍交由验收拒绝。
    """
    tolerance = LAYOUT_CONFIG["geometry_tolerance_mm"]
    polygons = []
    for index, item in enumerate(side):
        midpoint = (item.lower[:2] + item.upper[:2]) / 2
        vertices = (item.vertices[:, :2] - midpoint) @ rotation_z(angles[index])[:2, :2].T + centers[index]
        polygons.append(MultiPoint(vertices).convex_hull)
    bottoms = np.zeros(len(side))
    heights = np.array([item.upper[2] - item.lower[2] for item in side])
    placed = []
    for group in partition:
        for index in group:
            floor = 0.0
            for lower in placed:
                if not polygons[index].intersection(polygons[lower]).buffer(-tolerance).is_empty:
                    floor = max(floor, bottoms[lower] + heights[lower])
            bottoms[index] = floor
        placed.extend(group)
    return bottoms


def solve_ring_arrangement(side, top, partition, radius, parameters, trial, rng, cancelled, seed=None):
    """在给定层组合和半径内求环向角、径向距离及整体配平；失败返回空，取消抛 InterruptedError。"""
    original_models = [*side, *([top] if top else [])]
    choices = [mount_variants(item, radius, parameters) for item in side]
    if any(not variants for variants in choices):
        return None
    seed_placements = {item["instance_id"]: item for item in seed["placements"]} if seed else {}
    if seed:
        side = [min(variants, key=lambda item: np.linalg.norm(
            rotation_z(-math.radians(seed_placements[item.instance_id]["rotation_z_deg"]))
            @ np.asarray(seed_placements[item.instance_id]["model_to_global_matrix"])[:3, :3] - item.source_to_envelope[:3, :3]))
            for variants in choices]
        if top:
            top = min(mounting_variants(top, "top"), key=lambda item: np.linalg.norm(
                np.asarray(seed_placements[item.instance_id]["model_to_global_matrix"])[:3, :3] - item.source_to_envelope[:3, :3]))
    else:
        side = [(min(variants, key=lambda item: item.upper[1] - item.lower[1]) if trial % 4 == 1 else variants[0])
            if trial < 4 else variants[int(rng.integers(0, len(variants)))] for variants in choices]
        top = orient_for_mount(top, "top", trial % 4) if top else None
    count = len(side)
    gap = 0.0
    scale = parameters.fairing_radius_mm
    dimensions = np.array([item.upper - item.lower for item in side])
    # 安装面径向朝内；离散姿态已遵循各颗的固定或自由轴设置，连续搜索只调整环向位置与悬高。
    yaw = np.zeros(count)
    tangent_offset = np.array([(item.lower[1] + item.upper[1]) / 2 - item.face_center[1] for item in side])
    minimum, maximum = np.array([side_mount_radial_limits(item, parameters).center_radius_bounds(radius)
                                 for item in side]).T
    if np.any(maximum < minimum - LAYOUT_CONFIG["geometry_tolerance_mm"]):
        return None
    maximum = np.maximum(maximum, minimum)
    radii_mm = maximum.copy()
    ring_angles = initialize_ring_angles(partition, dimensions, radii_mm, tangent_offset, trial, rng)
    if seed:
        ring_angles = np.array([math.radians(seed_placements[item.instance_id]["rotation_z_deg"]) for item in side])
        ring_angles += rng.normal(0, np.pi / LAYOUT_CONFIG["ordering_trials"], count)
    if ring_angles is None:
        return None
    angles = np.zeros(count)
    bottoms = np.zeros(count)
    layer_ids = np.zeros(count, dtype=int)
    floor = gap
    pairs = []
    placed_indices = []
    for level, group in enumerate(partition):
        if level:
            previous = partition[level - 1]
            minimum_floor = min(bottoms[index] + dimensions[index, 2] for index in previous)
            events = sorted({bottoms[index] + dimensions[index, 2] for index in placed_indices
                             if bottoms[index] + dimensions[index, 2] >= minimum_floor})
            floor = events[int(rng.integers(len(events)))] if trial else events[0]
        ordered = list(group)
        if trial:
            rng.shuffle(ordered)
        for order, index in enumerate(ordered):
            angles[index] = ring_angles[index]
            bottoms[index] = floor
            layer_ids[index] = level
        pairs.extend(itertools.combinations(group, 2))
        placed_indices.extend(group)
    # 各层先下降到前层较矮构件的顶面；跨层在高度上相交的实例必须在平面上分离。
    compact_pairs = [pair for pair in itertools.combinations(range(count), 2)
                     if min(bottoms[pair[0]] + dimensions[pair[0], 2], bottoms[pair[1]] + dimensions[pair[1], 2])
                     > max(bottoms[pair[0]], bottoms[pair[1]]) + LAYOUT_CONFIG["geometry_tolerance_mm"]]
    if seed:
        bottoms = np.array([seed_placements[item.instance_id]["bottom_mm"] for item in side])
        pairs = [pair for pair in itertools.combinations(range(count), 2)
                 if min(bottoms[pair[0]] + dimensions[pair[0], 2], bottoms[pair[1]] + dimensions[pair[1], 2])
                 > max(bottoms[pair[0]], bottoms[pair[1]]) + LAYOUT_CONFIG["geometry_tolerance_mm"]]
    elif trial % 2:
        pairs = compact_pairs
    # 整体质心必须在有限中轴柱内，必要时由精确质量矩给出圆柱最低高度。
    side_moment_z = sum(item.mass * (bottoms[index] + item.center[2] - item.lower[2]) for index, item in enumerate(side))
    top_suspension = max(parameters.min_suspension_mm, top.face_center[2] - top.lower[2]) if top else 0.0
    if top_suspension > parameters.max_suspension_mm:
        return None
    top_offset = top_suspension + top.center[2] - top.face_center[2] if top else 0.0
    height_for_com = (side_moment_z + (top.mass * top_offset if top else 0)) / sum(item.mass for item in side)
    height = float(max(parameters.min_height_mm, floor, height_for_com))
    top_angle = 0.0
    top_bottom = height + top_suspension - (top.face_center[2] - top.lower[2]) if top else height
    top_placement = make_placement(top, len(partition), top_angle, [0, 0], top_bottom, "top") if top else None
    top_moment = top.mass * np.asarray(top_placement["center_of_mass_mm"])[:2] if top else np.zeros(2)
    masses = np.array([item.mass for item in side])
    total_mass = masses.sum() + (top.mass if top else 0.0)
    offsets = np.array([item.center[:2] - (item.lower[:2] + item.upper[:2]) / 2 for item in side])
    radii = radii_mm / scale
    half = dimensions[:, :2] / 2 / scale
    pair_indices = np.array(pairs, dtype=int).reshape(-1, 2)

    # 安装面均径向朝内：以实际矩形的环向顺序构造不碰撞初值，再交给整体配平连续优化。
    # 先为每层单独求可行位置，避免重叠初值让带 max 的分离轴约束停在不可行局部点。

    def unpack(values):
        """将优化向量转换为归一化矩形中心、朝向单位向量及质量加权平面质心。"""
        theta, radial = values[:count], values[count:]
        rotation = theta + yaw
        cosine, sine = np.cos(rotation), np.sin(rotation)
        axes = np.stack([np.column_stack([cosine, sine]), np.column_stack([-sine, cosine])], axis=1)
        centers = radial[:, None] * np.column_stack([np.cos(theta), np.sin(theta)]) + tangent_offset[:, None] / scale * axes[:, 1]
        centers_of_mass = centers + (offsets[:, 0, None] * axes[:, 0] + offsets[:, 1, None] * axes[:, 1]) / scale
        center = ((masses[:, None] * centers_of_mass).sum(axis=0) + top_moment / scale) / total_mass
        return centers, axes, center

    def constraints(values):
        """返回每对矩形分离轴间隙及整体中轴半径余量，全部非负才满足约束。"""
        if cancelled():
            raise InterruptedError("任务已取消")
        centers, axes, center = unpack(values)
        residuals = [parameters.axis_radius_mm / scale - np.linalg.norm(center)]
        if len(pair_indices):
            first, second = pair_indices[:, 0], pair_indices[:, 1]
            directions = np.concatenate([axes[first], axes[second]], axis=1)
            difference = centers[second] - centers[first]
            projected = np.abs(np.einsum("pi,pki->pk", difference, directions))
            first_extent = np.sum(np.abs(np.einsum("pji,pki->pkj", axes[first], directions)) * half[first, None, :], axis=2)
            second_extent = np.sum(np.abs(np.einsum("pji,pki->pkj", axes[second], directions)) * half[second, None, :], axis=2)
            residuals.extend(np.max(projected - first_extent - second_extent, axis=1) - gap / scale)
        return np.asarray(residuals)

    def objective(values):
        """最小化圆截面内质心偏离并轻度鼓励径向靠舱，返回无量纲目标。"""
        _, _, center = unpack(values)
        return float(center @ center + 1e-8 * np.sum(values[count:] ** 2))

    initial = np.concatenate([angles, radii])
    initial_residuals = constraints(initial)
    if len(initial_residuals) > 1 and np.min(initial_residuals[1:]) < 0:
        def separate_objective(values):
            """先消除同层几何穿透，保持本层安装面/悬高边界，为整体配平提供无碰撞起点。"""
            residuals = constraints(values)[1:]
            return float(np.sum(np.minimum(residuals, 0.0) ** 2))

        separated = minimize(separate_objective, initial, method="L-BFGS-B",
                             bounds=[(None, None)] * count + list(zip(minimum / scale, maximum / scale)),
                             options={"maxiter": LAYOUT_CONFIG["local_iterations"], "ftol": 1e-12})
        initial = separated.x
        if np.min(constraints(initial)[1:]) < -LAYOUT_CONFIG["geometry_tolerance_mm"] / scale:
            return None

    solution = minimize(
        objective, initial, method="SLSQP",
        bounds=[(None, None)] * count + list(zip(minimum / scale, maximum / scale)),
        constraints={"type": "ineq", "fun": constraints},
        options={"maxiter": LAYOUT_CONFIG["local_iterations"], "ftol": 1e-12},
    )
    centers, _, _ = unpack(solution.x)
    # 平面配平结束后逐颗下沉，再统一生成位姿、安装坐标和质心，避免预览与导出高度不同步。
    bottoms = lower_layers(side, partition, centers * scale, solution.x[:count] + yaw)
    side_moment_z = sum(item.mass * (bottoms[index] + item.center[2] - item.lower[2]) for index, item in enumerate(side))
    height_for_com = (side_moment_z + (top.mass * top_offset if top else 0)) / sum(item.mass for item in side)
    height = float(max(parameters.min_height_mm, np.max(bottoms + dimensions[:, 2]), height_for_com))
    if height > parameters.max_height_mm + LAYOUT_CONFIG["geometry_tolerance_mm"]:
        return None
    height = min(height, parameters.max_height_mm)
    if top:
        top_bottom = height + top_suspension - (top.face_center[2] - top.lower[2])
        top_placement = make_placement(top, len(partition), top_angle, [0, 0], top_bottom, "top")
    placements = [make_placement(item, int(layer_ids[index]), solution.x[index] + yaw[index],
                                 centers[index] * scale, float(bottoms[index]), "side")
                  for index, item in enumerate(side)]
    if top_placement:
        placements.append(top_placement)
    for placement in placements:
        point = placement["installation_face_center_mm"]
        placement["suspension_mm"] = float(point[2] - height if placement["mount"] == "top" else np.linalg.norm(point[:2]) - radius)
    candidate = {"radius_mm": radius, "height_mm": height, "placements": placements,
                 "fairing_radius_mm": parameters.fairing_radius_mm,
                 "axis_radius_mm": parameters.axis_radius_mm,
                 "side_layer_count": len(partition)}
    candidate["validation"] = validate_layout(candidate, original_models, parameters)
    if not candidate["validation"]["valid"]:
        return None
    return candidate


def finalize_candidates(candidates, target):
    """按分层目标排序候选、限制返回数量并分配稳定的布局标识。"""
    result = sorted(candidates.values(), key=candidate_order_key)[:target]
    for index, item in enumerate(result):
        item["candidate_id"] = f"layout-{index + 1}"
    return result


def radius_scan_values(maximum_radius, minimum_radius, step):
    """按固定步长返回降序半径网格，并始终包含可行上限和用户下限。"""
    tolerance = LAYOUT_CONFIG["geometry_tolerance_mm"]
    maximum = float(maximum_radius)
    minimum = float(minimum_radius)
    interval = maximum - minimum
    if interval <= tolerance:
        return np.array([minimum], dtype=float)
    count = int(math.floor(interval / float(step) + tolerance))
    values = maximum - np.arange(count + 1, dtype=float) * float(step)
    values = values[values >= minimum - tolerance]
    values = np.append(values, minimum)
    return np.unique(np.clip(values, minimum, maximum))[::-1]


def optimize_layout(satellites, parameters, report, cancelled):
    """持续搜索并返回最多五种通过完整验收的布局结构；取消时通过异常返回已验收候选。"""
    check_feasibility(satellites, parameters)
    top = next((item for item in satellites if parameters.top_enabled and item.record_id == parameters.top_record_id), None)
    side = sorted((item for item in satellites if item is not top), key=lambda item: (-item.mass, -item.volume))
    candidates = {}
    rng = np.random.default_rng(LAYOUT_CONFIG["random_seed"])
    attempts = 0
    target = LAYOUT_CONFIG["candidate_count"]
    maximum_radius = maximum_side_radius(side, parameters)
    radii = radius_scan_values(maximum_radius, parameters.min_radius_mm, parameters.radius_step_mm)
    report({"attempts": 0, "valid_count": 0,
            "radius_index": 0, "radius_count": len(radii),
            "message": (f"勾股径向检查通过：舱体半径扫描区间 {parameters.min_radius_mm:.3f}–"
                        f"{maximum_radius:.3f} mm，步长 {parameters.radius_step_mm:.3f} mm，共 {len(radii)} 个半径")})
    fit_cache = {}

    def can_fit(group, radius):
        """按当前半径检查组合环周容量，避免筛选最大半径时漏掉较小半径的可行组合。"""
        key = (tuple(sorted(group)), float(radius))
        if key not in fit_cache:
            thin = [min(mount_variants(item, radius, parameters), key=lambda variant: variant.upper[1] - variant.lower[1])
                    for item in side]
            dimensions = np.array([item.upper - item.lower for item in thin])
            offsets = np.array([(item.upper + item.lower)[:2] - 2 * item.face_center[:2] for item in thin])
            outer_radii = np.array([side_mount_radial_limits(item, parameters).center_radius_bounds(radius)[1]
                                    for item in thin])
            fit_cache[key] = any(initialize_ring_angles([key[0]], dimensions, outer_radii, offsets[:, 1] / 2,
                                                        trial, rng) is not None
                                 for trial in range(LAYOUT_CONFIG["ordering_trials"]))
        return fit_cache[key]

    try:
        for radius_index, radius in enumerate(radii, 1):
            if cancelled():
                raise InterruptedError("任务已取消")
            for layer_count in range(1, len(side) + 1):
                partitions = layer_partitions(
                    side, layer_count, LAYOUT_CONFIG["partition_beam"], cancelled,
                    lambda group, current_radius=float(radius): can_fit(group, current_radius),
                )
                for partition in partitions:
                    if cancelled():
                        raise InterruptedError("任务已取消")
                    for trial in range(LAYOUT_CONFIG["ordering_trials"]):
                        if cancelled():
                            raise InterruptedError("任务已取消")
                        attempts += 1
                        report({"radius_index": radius_index, "radius_count": len(radii), "attempts": attempts,
                                "layer_count": layer_count, "radius_mm": float(radius), "valid_count": len(candidates),
                                "message": (f"半径扫描 {radius_index}/{len(radii)}：{layer_count} 个侧挂层，"
                                            f"半径 {radius:.3f} mm；已验收不同结构 {len(candidates)}/{target}")})
                        candidate = solve_ring_arrangement(side, top, partition, float(radius), parameters, trial, rng, cancelled)
                        if candidate is not None:
                            retain_candidate(candidates, candidate)
        result = finalize_candidates(candidates, target)
        report({"radius_index": len(radii), "radius_count": len(radii), "attempts": attempts,
                "valid_count": len(result),
                "message": f"半径步长扫描完成，共检查 {len(radii)} 个半径，保留 {len(result)} 组布局"})
        return result
    except InterruptedError as error:
        raise LayoutSearchCancelled(finalize_candidates(candidates, target)) from error
