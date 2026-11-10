//! 文件说明：验证双 LOD 与各模型分辨率对应的包络清单，维护源指纹和旧格式兼容；不执行 CAD 计算。
use crate::{config::Config, error::Result, files, model_settings};
use serde_json::{json, Value};
use std::{collections::HashSet, path::Path, time::UNIX_EPOCH};

/// 比较清单参数时允许 JSON 数字使用不同指数书写，但不放宽字符串和结构字段。
fn same_value(left: &Value, right: &Value) -> bool {
    if let (Some(a), Some(b)) = (left.as_f64(), right.as_f64()) {
        return a == b;
    }
    left == right
}

/// 提取实际源文件的 STEP 指纹；输入副本通过保留修改时间复用此语义。
pub fn source(path: &Path) -> Result<Value> {
    let metadata = std::fs::metadata(path)?;
    let modified = metadata
        .modified()?
        .duration_since(UNIX_EPOCH)
        .map_err(crate::error::Error::bad)?
        .as_nanos();
    Ok(
        json!({"format":"STEP","role":"authoritative","size":metadata.len(),"modified_ns":modified as u64}),
    )
}
/// 根据集中配置构造与旧 Python 一致的预览参数。
pub fn preview_parameters(config: &Config, quality: &str) -> Value {
    let b = &config.values["backend"];
    let mut p = serde_json::Map::new();
    for key in [
        "detail_linear_ratio",
        "detail_angular_degrees",
        "interaction_linear_ratio",
        "interaction_max_linear_ratio",
        "interaction_angular_degrees",
        "interaction_max_angular_degrees",
        "interaction_triangle_target",
        "interaction_fast_enabled",
        "shell_samples_per_face",
        "shell_ray_epsilon_ratio",
    ] {
        p.insert(key.into(), b[format!("model_preview_{key}")].clone());
    }
    p.insert(
        "preview_artifact_version".into(),
        b["model_preview_artifact_version"].clone(),
    );
    p.insert(
        "shell_policy".into(),
        json!(
            if quality == "interaction" && b["model_preview_interaction_fast_enabled"] == true {
                "all_faces_interaction"
            } else {
                "conservative_exterior"
            }
        ),
    );
    Value::Object(p)
}
/// 根据集中配置、每模型分辨率及六向增量构造参数，分辨率变化同步影响缓存和发布校验。
pub fn envelope_parameters(config: &Config, settings: &Value) -> Value {
    let mut p = serde_json::Map::new();
    for key in [
        "step_linear_ratio",
        "step_min_linear_tolerance_mm",
        "step_angular_degrees",
        "refinement_grid_size",
        "refinement_direction_count",
        "connectivity_core_inset_ratio",
        "detail_smoothing_ratio",
        "outline_simplify_ratio",
        "gap_bridge_ratio",
        "artifact_version",
        "gap_bridge_limit_mm",
        "voxel_max_cells",
        "surface_batch_cells",
        "raster_triangle_batch",
        "raster_batch_cells",
        "workspace_memory_bytes",
        "process_memory_limit_bytes",
        "memory_reserve_bytes",
    ] {
        p.insert(
            key.into(),
            config.values["backend"][format!("model_envelope_{key}")].clone(),
        );
    }
    p.insert(
        "refinement_grid_size".into(),
        settings
            .get("envelope_settings")
            .and_then(|x| x.get("refinement_grid_size"))
            .unwrap_or(&config.values["backend"]["model_envelope_refinement_grid_size"])
            .clone(),
    );
    for key in model_settings::DIRECTIONS {
        p.insert(
            format!("{key}_clearance_mm"),
            settings["safety_clearance_mm"][key].clone(),
        );
    }
    Value::Object(p)
}
/// 检查清单声明的资源存在且路径受限。
fn exists(root: &Path, value: &Value) -> bool {
    value
        .as_str()
        .and_then(|x| files::within(root, x).ok())
        .is_some_and(|x| x.is_file())
}
/// 读取仍有效的预览，检查公共面表的完整分区与源/参数一致性。
pub fn preview(config: &Config, root: &Path, source: &Value, quality: &str) -> Option<Value> {
    let tier = root.join(quality);
    let params = preview_parameters(config, quality);
    let shell = if quality == "interaction" && params["shell_policy"] == "all_faces_interaction" {
        tier.join("shell-map.json")
    } else {
        root.join("common/shell-map.json")
    };
    preview_files(config, &tier, &shell, source, quality)
}
/// 同样校验暂存或正式资源，允许宿主在覆盖旧预览前验证完整产物。
pub fn preview_files(
    config: &Config,
    tier: &Path,
    shell: &Path,
    source: &Value,
    quality: &str,
) -> Option<Value> {
    let m = files::read_json(&tier.join("manifest.json")).ok()?;
    if &m["source"] != source || m["quality"] != quality {
        return None;
    }
    let params = preview_parameters(config, quality);
    if params
        .as_object()?
        .iter()
        .any(|(key, v)| !same_value(&m["parameters"][key], v))
    {
        return None;
    }
    let s = files::read_json(shell).ok()?;
    let shell_parameters = json!({"policy":params["shell_policy"],"samples_per_face":params["shell_samples_per_face"],"ray_epsilon_ratio":params["shell_ray_epsilon_ratio"],"direction_set":"cube_26","preview_artifact_version":params["preview_artifact_version"]});
    if &s["source"] != source
        || !s["parameters"]
            .as_object()
            .zip(shell_parameters.as_object())
            .is_some_and(|(a, b)| {
                a.len() == b.len() && a.iter().all(|(key, value)| same_value(value, &b[key]))
            })
    {
        return None;
    }
    let retained = s["retained_face_ids"].as_array()?;
    let culled = s["culled_face_ids"].as_array()?;
    let ids: HashSet<_> = retained
        .iter()
        .chain(culled)
        .filter_map(Value::as_str)
        .collect();
    let count = m["stats"]["source_face_count"].as_u64()?;
    if count as usize != ids.len()
        || retained.len() + culled.len() != ids.len()
        || (1..=count).any(|i| !ids.contains(format!("FACE_{i:05}").as_str()))
        || m["stats"]["retained_face_count"].as_u64()? != retained.len() as u64
        || m["stats"]["culled_face_count"].as_u64()? != culled.len() as u64
    {
        return None;
    }
    if !exists(tier, &m["browser_asset"]["file_name"]) {
        return None;
    }
    if (quality == "detail" || params["shell_policy"] == "all_faces_interaction")
        && !exists(tier, &m["face_mapping"]["file_name"])
    {
        return None;
    }
    if quality == "interaction"
        && params["shell_policy"] == "all_faces_interaction"
        && !tier.join("faces.brep").is_file()
    {
        return None;
    }
    Some(m)
}
/// 读取有效的正式包络，兼容既有四方向文件，新生成仍只允许基础 0 度。
pub fn envelope(config: &Config, root: &Path, source: &Value, settings: &Value) -> Option<Value> {
    let directory = root.join("envelope");
    let m = files::read_json(&directory.join("manifest.json")).ok()?;
    if m["format_version"] != 1
        || m["algorithm"] != config.string("rust_backend", "envelope_algorithm")
        || &m["source"] != source
        || m["geometry_settings"] != model_settings::geometry(settings)
        || m["parameters"] != envelope_parameters(config, settings)
    {
        return None;
    }
    let variants = m["variants"].as_array()?;
    let rotations: HashSet<_> = variants
        .iter()
        .filter_map(|x| x["rot_z"].as_i64())
        .collect();
    if rotations != HashSet::from([0]) && rotations != HashSet::from([0, 90, 180, 270]) {
        return None;
    }
    if variants
        .iter()
        .any(|v| !exists(&directory, &v["file_name"]) || !v["watertight"].is_boolean())
    {
        return None;
    }
    Some(m)
}
/// 列表和设置响应所需的包络摘要。
pub fn envelope_status(manifest: Option<&Value>) -> Value {
    match manifest {
        Some(m) => {
            json!({"state":"ready","generated_at":m["generated_at"],"algorithm":m["algorithm"],"variant_count":m["variants"].as_array().unwrap().len()})
        }
        None => json!({"state":"pending"}),
    }
}
