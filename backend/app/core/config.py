"""
文件说明：读取统一 TOML 的运行及算法参数；模型六向包络增量由独立模型设置提供。
本模块只处理配置解析，不包含模型业务逻辑或环境密钥。
"""

from dataclasses import dataclass
from pathlib import Path
import tomllib


@dataclass(frozen=True)
class RuntimeConfig:
    """描述前后端监听、模型存储、STEP 三角化和包络生成所需的运行时参数。"""

    backend_host: str
    backend_port: int
    frontend_host: str
    frontend_port: int
    model_storage_dir: str
    model_artifact_dir: str
    model_preview_detail_linear_ratio: float
    model_preview_detail_angular_degrees: float
    model_preview_interaction_linear_ratio: float
    model_preview_interaction_max_linear_ratio: float
    model_preview_interaction_angular_degrees: float
    model_preview_interaction_max_angular_degrees: float
    model_preview_interaction_triangle_target: int
    model_preview_shell_samples_per_face: int
    model_preview_shell_ray_epsilon_ratio: float
    model_preview_artifact_version: int
    model_preview_runtime_cache_max_bytes: int
    model_settings_default_device_name: str
    model_settings_default_scale: float
    model_settings_default_unit: str
    model_settings_default_rotation_x: int
    model_settings_default_rotation_y: int
    model_settings_default_rotation_z: int
    model_settings_default_front_orientation: str
    model_envelope_step_linear_ratio: float
    model_envelope_step_min_linear_tolerance_mm: float
    model_envelope_step_angular_degrees: float
    model_envelope_refinement_grid_size: int
    model_envelope_refinement_direction_count: int
    model_envelope_connectivity_core_inset_ratio: float
    model_envelope_detail_smoothing_ratio: float
    model_envelope_outline_simplify_ratio: float
    model_envelope_gap_bridge_ratio: float
    model_envelope_artifact_version: int
    model_store_dir: str
    model_store_database_name: str
    model_store_max_variants: int
    pre_config_dir: str
    pre_config_database_name: str
    pre_config_cylinder_subdir: str
    min_satellite_count: int
    max_satellite_count: int
    min_cylinder_radius_mm: float
    min_cylinder_height_mm: float
    max_cylinder_size_mm: float
    cylinder_radial_segments: int
    default_cylinder_radius_mm: float
    default_cylinder_height_mm: float
    min_axis_radius_mm: float
    default_axis_radius_mm: float
    min_fairing_shell_radius_mm: float
    default_fairing_shell_radius_mm: float


def _read_toml(path: Path) -> dict:
    """以二进制方式读取 UTF-8 TOML 文件并返回解析结果。"""

    with path.open("rb") as config_file:
        return tomllib.load(config_file)


def load_runtime_config() -> RuntimeConfig:
    """加载并约束项目根目录中的统一运行时配置。"""

    config_path = Path(__file__).resolve().parents[3] / "config" / "sat_layout_opt.toml"
    values = _read_toml(config_path)
    backend = values["backend"]
    frontend = values["frontend"]
    pre_config = values.get("pre_config", {})
    return RuntimeConfig(
        backend_host=str(backend["host"]),
        backend_port=int(backend["port"]),
        frontend_host=str(frontend["host"]),
        frontend_port=int(frontend["port"]),
        model_storage_dir=str(backend["model_storage_dir"]),
        model_artifact_dir=str(backend["model_artifact_dir"]),
        model_preview_detail_linear_ratio=max(float(backend.get("model_preview_detail_linear_ratio", 0.0005)), 1e-8),
        model_preview_detail_angular_degrees=max(float(backend.get("model_preview_detail_angular_degrees", 10.0)), 0.1),
        model_preview_interaction_linear_ratio=max(float(backend.get("model_preview_interaction_linear_ratio", 0.002)), 1e-8),
        model_preview_interaction_max_linear_ratio=max(float(backend.get("model_preview_interaction_max_linear_ratio", 0.005)), 1e-8),
        model_preview_interaction_angular_degrees=max(float(backend.get("model_preview_interaction_angular_degrees", 20.0)), 0.1),
        model_preview_interaction_max_angular_degrees=max(float(backend.get("model_preview_interaction_max_angular_degrees", 30.0)), 0.1),
        model_preview_interaction_triangle_target=max(int(backend.get("model_preview_interaction_triangle_target", 250000)), 1),
        model_preview_shell_samples_per_face=max(int(backend.get("model_preview_shell_samples_per_face", 9)), 1),
        model_preview_shell_ray_epsilon_ratio=max(float(backend.get("model_preview_shell_ray_epsilon_ratio", 1e-7)), 1e-12),
        model_preview_artifact_version=max(int(backend.get("model_preview_artifact_version", 1)), 1),
        model_preview_runtime_cache_max_bytes=max(int(backend.get("model_preview_runtime_cache_max_bytes", 536870912)), 1024 * 1024),
        model_settings_default_device_name=str(backend.get("model_settings_default_device_name", "GPS satellite")).strip(),
        model_settings_default_scale=float(backend.get("model_settings_default_scale", 1.0)),
        model_settings_default_unit=str(backend.get("model_settings_default_unit", "mm")),
        model_settings_default_rotation_x=int(backend.get("model_settings_default_rotation_x", 0)),
        model_settings_default_rotation_y=int(backend.get("model_settings_default_rotation_y", 0)),
        model_settings_default_rotation_z=int(backend.get("model_settings_default_rotation_z", 0)),
        model_settings_default_front_orientation=str(backend.get("model_settings_default_front_orientation", "+Z")),
        model_envelope_step_linear_ratio=max(float(backend.get("model_envelope_step_linear_ratio", 1.0 / 450.0)), 1e-8),
        model_envelope_step_min_linear_tolerance_mm=max(float(backend.get("model_envelope_step_min_linear_tolerance_mm", 0.5)), 1e-8),
        model_envelope_step_angular_degrees=max(float(backend.get("model_envelope_step_angular_degrees", 14.32394487827058)), 0.1),
        model_envelope_refinement_grid_size=max(int(backend.get("model_envelope_refinement_grid_size", 384)), 32),
        model_envelope_refinement_direction_count=min(max(int(backend.get("model_envelope_refinement_direction_count", 20)), 2), 64),
        model_envelope_connectivity_core_inset_ratio=min(max(float(backend.get("model_envelope_connectivity_core_inset_ratio", 0.12)), 0.0), 0.5),
        model_envelope_detail_smoothing_ratio=max(float(backend.get("model_envelope_detail_smoothing_ratio", 0.008)), 0.0),
        model_envelope_outline_simplify_ratio=max(float(backend.get("model_envelope_outline_simplify_ratio", 0.004)), 0.0),
        model_envelope_gap_bridge_ratio=max(float(backend.get("model_envelope_gap_bridge_ratio", 0.06)), 0.0),
        model_envelope_artifact_version=max(int(backend.get("model_envelope_artifact_version", 9)), 1),
        model_store_dir=str(backend.get("model_store_dir", "data/store")),
        model_store_database_name=str(backend.get("model_store_database_name", "sat_layout_opt.sqlite3")),
        model_store_max_variants=max(int(backend.get("model_store_max_variants", 1)), 1),
        pre_config_dir=str(backend.get("pre_config_dir", "data/pre_config")),
        pre_config_database_name=str(backend.get("pre_config_database_name", "pre_config.sqlite3")),
        pre_config_cylinder_subdir=str(backend.get("pre_config_cylinder_subdir", "cylinders")),
        min_satellite_count=max(int(backend.get("min_satellite_count", 0)), 0),
        max_satellite_count=max(int(backend.get("max_satellite_count", 1000)), 1),
        min_cylinder_radius_mm=max(float(backend.get("min_cylinder_radius_mm", 0.001)), 1e-9),
        min_cylinder_height_mm=max(float(backend.get("min_cylinder_height_mm", 0.001)), 1e-9),
        max_cylinder_size_mm=max(float(backend.get("max_cylinder_size_mm", 1000000.0)), 1e-6),
        cylinder_radial_segments=max(int(backend.get("cylinder_radial_segments", 96)), 8),
        default_cylinder_radius_mm=max(float(backend.get("default_cylinder_radius_mm", 400.0)), 1e-9),
        default_axis_radius_mm=max(float(backend.get("default_axis_radius_mm", 80.0)), 1e-9),
        min_axis_radius_mm=max(float(backend.get("min_axis_radius_mm", 0.001)), 1e-9),
        min_fairing_shell_radius_mm=max(
            float(pre_config.get("min_fairing_shell_radius_mm", 0.001)), 1e-9
        ),
        default_fairing_shell_radius_mm=max(
            float(pre_config.get("default_fairing_shell_radius_mm", 800.0)),
            max(float(pre_config.get("min_fairing_shell_radius_mm", 0.001)), 1e-9),
        ),
        default_cylinder_height_mm=max(float(backend.get("default_cylinder_height_mm", 3600.0)), 1e-9),
    )


runtime_config = load_runtime_config()
