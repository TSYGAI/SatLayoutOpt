//! 文件说明：校验模型设置并按规范数值比较并发编辑基线；补全历史默认值，精确安装几何委托计算引擎。
use crate::{
    config::Config,
    error::{Error, Result},
};
use serde_json::{json, Value};

/// 六向增量名称属于持久化格式，零为历史兼容默认值。
pub const DIRECTIONS: [&str; 6] = ["front", "back", "left", "right", "top", "bottom"];
/// 从集中配置补全旧模型；仅在加载历史或创建上传时使用。
pub fn defaults(config: &Config) -> Value {
    let _logging_step =
        crate::monitoring::Step::new("model_settings::defaults", serde_json::json!({}));
    let b = &config.values["backend"];
    json!({"device_name":b["model_settings_default_device_name"], "mass":null,
        "model_scale":b["model_settings_default_scale"], "model_unit":b["model_settings_default_unit"],
        "rotation_x":b["model_settings_default_rotation_x"],"rotation_y":b["model_settings_default_rotation_y"],
        "rotation_z":b["model_settings_default_rotation_z"],"front_orientation":b["model_settings_default_front_orientation"],
        "coordinate_frame":default_coordinate_frame(),
        "envelope_settings":{"refinement_grid_size":b["model_envelope_refinement_grid_size"]},
        "center_of_mass":null,"installation_face_id":null,"installation_point":null,
        "safety_clearance_mm":DIRECTIONS.into_iter().map(|k|(k,0.0)).collect::<std::collections::BTreeMap<_,_>>()})
}
/// 校验有限数值及闭区间；JSON 布尔值不会被当成整数。
pub fn number(value: &Value, name: &str, min: f64, max: f64) -> Result<f64> {
    let _logging_step =
        crate::monitoring::Step::new("model_settings::number", serde_json::json!({}));
    let x = value
        .as_f64()
        .filter(|x| x.is_finite() && *x >= min && *x <= max)
        .ok_or_else(|| Error::invalid(format!("{name} 必须为 {min} 至 {max} 的有限数值")))?;
    Ok(x)
}
/// 对旧 Pydantic 非严格浮点字段执行兼容转换；六向增量等严格字段不使用此函数。
pub fn request_number(value: &Value) -> Result<Value> {
    let _logging_step =
        crate::monitoring::Step::new("model_settings::request_number", serde_json::json!({}));
    let parsed = value
        .as_f64()
        .or_else(|| value.as_str().and_then(|s| s.trim().parse::<f64>().ok()))
        .or_else(|| value.as_bool().map(|b| if b { 1.0 } else { 0.0 }))
        .filter(|x| x.is_finite())
        .ok_or_else(|| Error::invalid("字段必须为有限数值"))?;
    Ok(json!(parsed))
}
/// 校验可空的三轴坐标，拒绝缺项及额外字段。
fn point(value: &Value) -> Result<()> {
    let _logging_step =
        crate::monitoring::Step::new("model_settings::point", serde_json::json!({}));
    if value.is_null() {
        return Ok(());
    }
    if value.as_object().map(|x| x.len()) != Some(3) {
        return Err(Error::invalid("三轴坐标必须同时填写或全部留空"));
    }
    for axis in ["x", "y", "z"] {
        number(&value[axis], axis, -f64::MAX, f64::MAX)?;
    }
    Ok(())
}
/// 归一化设置并校验字段；strict 模式要求 PUT 必需字段且禁止未知字段。
pub fn normalize(
    config: &Config,
    value: &Value,
    previous: Option<&Value>,
    strict: bool,
) -> Result<Value> {
    let _logging_step =
        crate::monitoring::Step::new("model_settings::normalize", serde_json::json!({}));
    let mut result = defaults(config);
    let fields = result
        .as_object()
        .unwrap()
        .keys()
        .cloned()
        .collect::<Vec<_>>();
    if strict {
        let object = value
            .as_object()
            .ok_or_else(|| Error::invalid("设置必须为对象"))?;
        if object.keys().any(|key| !fields.contains(key)) {
            return Err(Error::invalid("包含未知模型设置"));
        }
        for key in [
            "device_name",
            "mass",
            "model_scale",
            "model_unit",
            "rotation_x",
            "rotation_y",
            "rotation_z",
            "front_orientation",
        ] {
            if !object.contains_key(key) {
                return Err(Error::invalid(format!("缺少 {key}")));
            }
        }
    }
    if let Some(old) = previous {
        result["safety_clearance_mm"] = old["safety_clearance_mm"].clone();
        if let Some(envelope) = old.get("envelope_settings") {
            result["envelope_settings"] = envelope.clone();
        }
        result["coordinate_frame"] = old
            .get("coordinate_frame")
            .cloned()
            .unwrap_or_else(default_coordinate_frame);
    }
    if let Some(values) = value.as_object() {
        for key in &fields {
            if let Some(v) = values.get(key) {
                result[key] = v.clone();
            }
        }
    }
    if strict {
        for key in ["mass", "model_scale"] {
            if !result[key].is_null() {
                result[key] = request_number(&result[key])?;
            }
        }
        for key in ["center_of_mass", "installation_point"] {
            if result[key].is_object() {
                for axis in ["x", "y", "z"] {
                    result[key][axis] = request_number(&result[key][axis])?;
                }
            }
        }
        for key in ["rotation_x", "rotation_y", "rotation_z"] {
            if result[key] == Value::Bool(false) {
                result[key] = json!(0);
            }
        }
    }
    let name = result["device_name"].as_str().unwrap_or("").trim();
    if name.is_empty() || name.chars().count() > 200 {
        return Err(Error::invalid("设备名称必须为 1 至 200 个字符"));
    }
    result["device_name"] = json!(name);
    if !result["mass"].is_null() {
        result["mass"] = json!(number(&result["mass"], "质量", 0.0, 1e12)?);
    }
    result["model_scale"] = json!(number(&result["model_scale"], "模型比例", 0.0001, 1e6)?);
    if !["mm", "cm", "m"].contains(&result["model_unit"].as_str().unwrap_or("")) {
        return Err(Error::invalid("模型单位必须是 mm、cm 或 m"));
    }
    for axis in ["rotation_x", "rotation_y", "rotation_z"] {
        let angle = result[axis]
            .as_f64()
            .ok_or_else(|| Error::invalid("模型旋转角度无效"))?;
        if ![0.0, 90.0, 180.0, 270.0].contains(&angle) {
            return Err(Error::invalid("模型旋转角度必须是 0、90、180 或 270 度"));
        }
        result[axis] = json!(angle as u16);
    }
    if !["+X", "-X", "+Y", "-Y", "+Z", "-Z", "free"]
        .contains(&result["front_orientation"].as_str().unwrap_or(""))
    {
        return Err(Error::invalid("向上轴向无效"));
    }
    point(&result["center_of_mass"])?;
    let minimum = config
        .integer("backend", "model_envelope_refinement_grid_min")
        .max(32);
    if result["envelope_settings"].as_object().map(|x| x.len()) != Some(1)
        || result["envelope_settings"]["refinement_grid_size"]
            .as_u64()
            .is_none_or(|x| x < minimum)
    {
        return Err(Error::invalid(format!(
            "包络设置必须且只能包含不小于 {minimum} 的整数体素分辨率 refinement_grid_size"
        )));
    }
    point(&result["installation_point"])?;
    result["coordinate_frame"] = normalize_coordinate_frame(&result["coordinate_frame"])?;
    if !result["installation_face_id"].is_null() {
        let id = result["installation_face_id"].as_str().unwrap_or("");
        if id.len() != 10
            || !id.starts_with("FACE_")
            || !id.as_bytes()[5..].iter().all(|b| b.is_ascii_digit())
        {
            return Err(Error::invalid("安装面 ID 格式无效"));
        }
    } else if !result["installation_point"].is_null() {
        return Err(Error::invalid("未选择安装面时不能设置安装点"));
    }
    if result["safety_clearance_mm"].as_object().map(|x| x.len()) != Some(6) {
        return Err(Error::invalid("包络增量必须同时包含六个方向"));
    }
    for key in DIRECTIONS {
        let value = number(
            &result["safety_clearance_mm"][key],
            "包络增量",
            0.0,
            f64::MAX,
        )?;
        result["safety_clearance_mm"][key] = json!(value);
    }
    Ok(result)
}
/// 比较已保存设置的业务值；仅规范化副本中的整数/浮点表示，保留空值且不使用近似容差。
pub fn matches_baseline(config: &Config, expected: &Value, current: &Value) -> Result<bool> {
    let _logging_step =
        crate::monitoring::Step::new("model_settings::matches_baseline", serde_json::json!({}));
    let mut expected = normalize(config, expected, None, false)?;
    let mut current = normalize(config, current, None, false)?;
    // 普通 PUT 已把这两个点转换为浮点数；基线来自浏览器时整数值会重新编码为 JSON 整数。
    for settings in [&mut expected, &mut current] {
        for key in ["center_of_mass", "installation_point"] {
            if !settings[key].is_null() {
                for axis in ["x", "y", "z"] {
                    settings[key][axis] =
                        json!(number(&settings[key][axis], axis, -f64::MAX, f64::MAX)?);
                }
            }
        }
    }
    Ok(expected == current)
}

/// 提取影响包络几何的姿态与单位；质量和显示名称不会使包络失效。
pub fn geometry(settings: &Value) -> Value {
    let _logging_step =
        crate::monitoring::Step::new("model_settings::geometry", serde_json::json!({}));
    let mut out = serde_json::Map::new();
    for key in [
        "model_scale",
        "model_unit",
        "rotation_x",
        "rotation_y",
        "rotation_z",
        "coordinate_frame",
    ] {
        out.insert(key.into(), settings[key].clone());
    }
    Value::Object(out)
}

/// 返回相对初始 STEP 原点、初始轴向的默认模型坐标系。
pub fn default_coordinate_frame() -> Value {
    let _logging_step = crate::monitoring::Step::new(
        "model_settings::default_coordinate_frame",
        serde_json::json!({}),
    );
    json!({"version":1,"origin":{"x":0.0,"y":0.0,"z":0.0},
        "orientation":{"mode":"euler_xyz","angles_deg":{"x":0.0,"y":0.0,"z":0.0}}})
}

/// 校验坐标系定义；角度按固定初始 X/Y/Z 轴依次旋转，三点模式检查右手正交轴可构造。
pub fn normalize_coordinate_frame(value: &Value) -> Result<Value> {
    let _logging_step = crate::monitoring::Step::new(
        "model_settings::normalize_coordinate_frame",
        serde_json::json!({}),
    );
    if value.is_null() {
        return Ok(default_coordinate_frame());
    }
    if value["version"].as_i64() != Some(1) || value.as_object().map(|x| x.len()) != Some(3) {
        return Err(Error::invalid("坐标系定义版本不受支持"));
    }
    if value["orientation"]["mode"].as_str() == Some("three_points") {
        if value["orientation"].as_object().map(|x| x.len()) != Some(3) {
            return Err(Error::invalid("三点定义包含未知字段"));
        }
        for v in [
            &value["origin"],
            &value["orientation"]["x_point"],
            &value["orientation"]["xy_point"],
        ] {
            point(v)?;
            if v.is_null() {
                return Err(Error::invalid("坐标系参考点必须完整填写"));
            }
        }
        let mut vectors = [[0.0_f64; 3]; 2];
        for (index, key) in ["x_point", "xy_point"].iter().enumerate() {
            for (axis, label) in ["x", "y", "z"].iter().enumerate() {
                vectors[index][axis] = value["orientation"][key][label].as_f64().unwrap()
                    - value["origin"][label].as_f64().unwrap();
            }
            let magnitude = vectors[index].iter().fold(0.0_f64, |a, b| a.max(b.abs()));
            if !magnitude.is_finite() || magnitude == 0.0 {
                return Err(Error::invalid("参考点不能与原点重合或超出数值范围"));
            }
            for v in &mut vectors[index] {
                *v /= magnitude;
            }
            let norm = vectors[index].iter().map(|v| v * v).sum::<f64>().sqrt();
            for v in &mut vectors[index] {
                *v /= norm;
            }
        }
        let [a, b] = vectors;
        let cross = [
            a[1] * b[2] - a[2] * b[1],
            a[2] * b[0] - a[0] * b[2],
            a[0] * b[1] - a[1] * b[0],
        ];
        if cross.iter().map(|v| v * v).sum::<f64>().sqrt() <= f64::EPSILON * 64.0 {
            return Err(Error::invalid("坐标系三个参考点不能共线或接近共线"));
        }
        let mut result = value.clone();
        for axis in ["x", "y", "z"] {
            result["origin"][axis] = json!(value["origin"][axis].as_f64().unwrap());
            for key in ["x_point", "xy_point"] {
                result["orientation"][key][axis] =
                    json!(value["orientation"][key][axis].as_f64().unwrap());
            }
        }
        return Ok(result);
    }
    if value["orientation"]["mode"].as_str() != Some("euler_xyz")
        || value["orientation"].as_object().map(|x| x.len()) != Some(2)
    {
        return Err(Error::invalid("坐标轴方向必须使用角度或三点定义"));
    }
    point(&value["origin"])?;
    point(&value["orientation"]["angles_deg"])?;
    if value["origin"].is_null() || value["orientation"]["angles_deg"].is_null() {
        return Err(Error::invalid("坐标系原点和角度必须完整填写"));
    }
    let mut result = default_coordinate_frame();
    for axis in ["x", "y", "z"] {
        result["origin"][axis] = json!(number(
            &value["origin"][axis],
            "坐标系原点",
            -f64::MAX,
            f64::MAX
        )?);
        result["orientation"]["angles_deg"][axis] = json!(number(
            &value["orientation"]["angles_deg"][axis],
            "坐标轴角度",
            -f64::MAX,
            f64::MAX
        )?);
    }
    Ok(result)
}
