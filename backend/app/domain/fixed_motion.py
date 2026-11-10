"""文件说明：校验当前筒尺寸下固定安装矩阵、悬高及真实分段罩边界；复用三维裁切，已释放软组由普通规则验收。"""

import numpy as np
from shapely.geometry import MultiPoint, Point

from app.domain.layout_config import LAYOUT_CONFIG
from app.domain.layout_space import fairing_sections, radial_limit
from app.domain.layout_boundary import envelope_hull, outer_clearance
from app.domain.installation_region import installation_region
from app.domain.layout_contact import directional_suspension, projected_clearance


def fixed_boundary_residuals(fixed, satellites, parameters, radius):
    """返回当前筒尺寸下固定包络的筒罩与悬高余量；顶部在最终筒高下另由完整候选验收。"""
    result = []
    p = parameters
    base_height = p.installation_base.height_mm
    sections = fairing_sections(p.fairing_profile)
    models = {item.instance_id: item for item in satellites}
    for key, placement in fixed.items():
        model = models[key]
        transform = np.asarray(placement["model_to_global_matrix"]) @ np.linalg.inv(model.source_to_envelope)
        vertices = model.vertices @ transform[:3, :3].T + transform[:3, 3]
        point = np.asarray(placement["installation_point_mm"])
        lower, upper = float(vertices[:, 2].min()), float(vertices[:, 2].max())
        if placement["mount"] == "side":
            region = installation_region(model, placement["model_to_global_matrix"])
            outer = radial_limit(sections, lower, upper) - np.linalg.norm(vertices[:, :2], axis=1).max()
            if outer < 0:
                outer = outer_clearance(envelope_hull(vertices), sections)
            result.extend((lower, float(region[:, 2].min()) - base_height,
                           outer,
                           sections[-1]["top_mm"] - upper))
            suspension = directional_suspension(vertices, model.faces, placement["installation_face_normal"], radius)
            result.extend((base_height + p.max_height_mm - region[:, 2].max(),
                           projected_clearance(vertices, model.faces) - radius,
                           suspension - p.min_suspension_mm, p.max_suspension_mm - suspension))
        else:
            result.extend((vertices[:, 2].min() - base_height - p.min_height_mm,
                           placement["suspension_mm"] - p.min_suspension_mm,
                           p.max_suspension_mm - placement["suspension_mm"]))
    return np.asarray(result)


def fixed_motion_violations(expected, actual):
    """核对实际矩阵与当前筒尺寸的预期矩阵；拒绝额外位移、旋转、安装位置或镜像变化。"""
    errors = []
    for key, before in expected.items():
        after = actual.get(key)
        message = f"固定卫星 {before['name']} 相对安装筒的固定位姿被改变"
        if after is None or after["mount"] != before["mount"] or bool(after.get("fixed_mirrored")) != bool(before.get("fixed_mirrored")):
            errors.append(message)
            continue
        old, new = np.asarray(before["model_to_global_matrix"]), np.asarray(after["model_to_global_matrix"])
        if (not np.allclose(old[:3, :3], new[:3, :3], atol=LAYOUT_CONFIG["orientation_tolerance"], rtol=0)
                or np.linalg.norm(new[:3, 3] - old[:3, 3]) > LAYOUT_CONFIG["geometry_tolerance_mm"]):
            errors.append(message)
    return list(dict.fromkeys(errors))
