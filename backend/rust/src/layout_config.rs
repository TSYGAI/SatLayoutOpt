//! 文件说明：锁定布局配置并校验任务独立搜索参数；Rust 管理业务选择和上限，Python 求解并独立验收。
use crate::{
    config::Config,
    error::{Error, Result},
    files,
    model_settings::number,
    pre_config::PreConfig,
};
use serde_json::{json, Value};

/// 获取跨固化库与前置配置的一致快照；指纹为不透明标识，覆盖设置、源和包络摘要。
pub fn configuration(pre: &PreConfig) -> Result<Value> {
    let _logging_step =
        crate::monitoring::Step::new("layout_config::configuration", serde_json::json!({}));
    let _store = pre.store.lock.lock().unwrap();
    let _pre = pre.lock.lock().unwrap();
    configuration_locked(pre)
}
/// 调用方已持固化与前置配置锁时构造同一配置快照，供原子保存复核。
pub(crate) fn configuration_locked(pre: &PreConfig) -> Result<Value> {
    let _logging_step =
        crate::monitoring::Step::new("layout_config::configuration_locked", serde_json::json!({}));
    let records = pre.store.all()?;
    let selected = pre.satellites(&records)?;
    let mut satellites = vec![];
    let mut fingerprints = vec![];
    for (record, count) in records.iter().zip(selected) {
        let settings = &record["settings"];
        satellites.push(json!({"record_id":record["record_id"],"name":record["device_name"],"count":count["count"],"symmetry_enabled":count["symmetry_enabled"],"symmetry_mode":count["symmetry_mode"],"mass_kg":settings["mass"],"center_of_mass":settings["center_of_mass"],"model_unit":settings["model_unit"],"up_orientation":settings.get("front_orientation").unwrap_or(&pre.config.values["backend"]["model_settings_default_front_orientation"]),"installation_face_id":settings["installation_face_id"],"installation_point":settings["installation_point"]}));
        fingerprints.push(json!({"record_id":record["record_id"],"settings":settings,"source":record["source"]["sha256"],"envelope":record["envelope"]["mesh_sha256"]}));
    }
    let geometry = pre.fairing()?;
    let fixed_groups = pre.fixed_groups()?;
    let options = &pre.config.values["layout_optimization"];
    let fingerprint = files::fingerprint(
        &json!({"geometry":geometry,"satellites":satellites,"model_fingerprints":fingerprints,"fixed_groups":fixed_groups}),
    );
    Ok(
        json!({"geometry":geometry,"satellites":satellites,"fixed_groups":fixed_groups,"candidate_count":options["candidate_count"],"candidate_archive_limit":options["candidate_archive_limit"],"history_name_max_length":options["history_name_max_length"],"max_attempts_per_round":options["max_attempts_per_round"],"defaults":{"min_suspension_mm":options["min_suspension_mm"],"max_suspension_mm":options["max_suspension_mm"],"radius_step_mm":options["radius_step_mm"],"candidate_limit":options["candidate_limit"],"hybrid_attempt_budget":options["hybrid_attempt_budget"],"alns_budget_fraction":options["alns_budget_fraction"],"hybrid_radius_samples":options["hybrid_radius_samples"],"cp_partition_limit":options["cp_partition_limit"]},"config_fingerprint":fingerprint}),
    )
}
/// 校验独立任务选项并为本次启动生成随机种子；防止客户端覆盖锁定几何、数量和质量。
pub fn options(config: &Config, input: &Value) -> Result<Value> {
    let _logging_step =
        crate::monitoring::Step::new("layout_config::options", serde_json::json!({}));
    let allowed = [
        "min_suspension_mm",
        "max_suspension_mm",
        "radius_step_mm",
        "candidate_limit",
        "hybrid_attempt_budget",
        "alns_budget_fraction",
        "hybrid_radius_samples",
        "cp_partition_limit",
        "top_enabled",
        "top_record_id",
        "config_fingerprint",
        "notes",
    ];
    if input
        .as_object()
        .is_none_or(|o| o.keys().any(|k| !allowed.contains(&k.as_str())))
    {
        return Err(Error::invalid("布局请求含未知字段"));
    }
    let seed = uuid::Uuid::new_v4().as_u128() % (u128::from(config.integer("layout_optimization", "random_seed_max")) + 1);
    let mut output = json!({"radius_step_mm":config.values["layout_optimization"]["radius_step_mm"],"random_seed":seed as u64,"top_enabled":false,"top_record_id":null,"notes":""});
    for (key, value) in input.as_object().unwrap() {
        output[key] = value.clone();
    }
    for key in ["hybrid_attempt_budget", "alns_budget_fraction", "hybrid_radius_samples", "cp_partition_limit", "candidate_limit"] {
        if input.get(key).is_none() {
            output[key] = config.values["layout_optimization"][key].clone();
        }
    }
    for key in ["hybrid_attempt_budget", "hybrid_radius_samples", "cp_partition_limit", "candidate_limit"] {
        let value = output[key]
            .as_u64()
            .filter(|value| *value > 0)
            .ok_or_else(|| Error::invalid(format!("{key} 必须为正整数")))?;
        if key == "hybrid_attempt_budget"
            && value > config.integer("layout_optimization", "max_attempts_per_round")
        {
            return Err(Error::invalid("总尝试次数不得超过服务端配置上限"));
        }
        if key == "candidate_limit"
            && value > config.integer("layout_optimization", "candidate_archive_limit")
        {
            return Err(Error::invalid("展示方案数量不得超过服务端候选存档上限"));
        }
    }
    if output["alns_budget_fraction"]
        .as_f64()
        .is_none_or(|value| !value.is_finite() || !(0.0..1.0).contains(&value))
    {
        return Err(Error::invalid("自适应搜索预算比例必须大于等于0且小于1"));
    }
    for key in ["min_suspension_mm", "max_suspension_mm", "radius_step_mm"] {
        let value = number(
            &crate::model_settings::request_number(&output[key])?,
            key,
            0.0,
            1e6,
        )?;
        if key == "radius_step_mm" && value == 0.0 {
            return Err(Error::invalid("半径步长必须大于零"));
        }
        output[key] = json!(value);
    }
    if output["min_suspension_mm"].as_f64() > output["max_suspension_mm"].as_f64() {
        return Err(Error::invalid("悬高最小值不得大于最大值"));
    }
    let top = output["top_enabled"]
        .as_bool()
        .ok_or_else(|| Error::invalid("顶部开关必须为布尔值"))?;
    if !output["top_record_id"].is_null() {
        let id = output["top_record_id"]
            .as_str()
            .ok_or_else(|| Error::invalid("顶部类型无效"))?;
        if id.len() > 64 || files::safe_id(id).is_err() {
            return Err(Error::invalid("顶部类型标识无效"));
        }
    }
    if top == output["top_record_id"].is_null() {
        return Err(Error::invalid("顶部开关和类型选择不一致"));
    }
    let fingerprint = output["config_fingerprint"].as_str().unwrap_or("");
    if fingerprint.len() != 64
        || !fingerprint
            .bytes()
            .all(|x| x.is_ascii_digit() || (b'a'..=b'f').contains(&x))
    {
        return Err(Error::invalid("配置指纹无效"));
    }
    if output["notes"]
        .as_str()
        .is_none_or(|x| x.chars().count() > 4000)
    {
        return Err(Error::invalid("备注长度超限"));
    }
    Ok(output)
}
/// 将锁定前置参数与用户选项合并；拒绝空载及硬对称顶部冲突。
pub fn resolve(configuration: &Value, options: &Value) -> Result<Value> {
    let _logging_step =
        crate::monitoring::Step::new("layout_config::resolve", serde_json::json!({}));
    if configuration["config_fingerprint"] != options["config_fingerprint"] {
        return Err(Error::conflict(
            "前置配置或模型库已改变，请刷新锁定参数后重新开始",
        ));
    }
    if configuration["geometry"]["stored"] != true {
        return Err(Error::conflict("请先在前置配置页保存尺寸和卫星数量"));
    }
    let mut parameters = options.clone();
    parameters
        .as_object_mut()
        .unwrap()
        .remove("config_fingerprint");
    for key in [
        "min_radius_mm",
        "max_radius_mm",
        "min_height_mm",
        "max_height_mm",
        "axis_radius_mm",
        "fairing_radius_mm",
        "fairing_profile",
    ] {
        parameters[key] = configuration["geometry"][key].clone();
    }
    let base = &configuration["geometry"]["installation_tube"]["base"];
    parameters["installation_base"] =
        json!({"lower_radius_mm":base["lower_radius_mm"],"height_mm":base["height_mm"]});
    let selections:Vec<_>=configuration["satellites"].as_array().unwrap().iter().map(|item|json!({"record_id":item["record_id"],"count":item["count"],"symmetry_enabled":item["symmetry_enabled"],"symmetry_mode":item["symmetry_mode"]})).collect();
    if !selections
        .iter()
        .any(|s| s["count"].as_i64().unwrap_or(0) > 0)
    {
        return Err(Error::conflict("至少选择一颗卫星"));
    }
    if options["top_enabled"] == true {
        let top = selections
            .iter()
            .find(|s| {
                s["record_id"] == options["top_record_id"] && s["count"].as_i64().unwrap_or(0) > 0
            })
            .ok_or_else(|| Error::conflict("顶部类型必须已设置正的装载数量"))?;
        if top["symmetry_enabled"] == true
            && top["symmetry_mode"] == "hard"
            && top["count"].as_i64().unwrap() % 2 == 0
        {
            return Err(Error::conflict(
                "启用硬对称的偶数数量类型不能单独取一颗放在顶部",
            ));
        }
    }
    parameters["satellites"] = json!(selections);
    parameters["fixed_groups"] = configuration
        .get("fixed_groups")
        .cloned()
        .unwrap_or(json!([]));
    if let Some(top) = parameters["fixed_groups"].as_array().and_then(|groups| {
        groups
            .iter()
            .find(|group| group["mount"] == "top" && group["hard_constraint"] != false)
    }) {
        let id = top["record_id"].clone();
        if options["top_enabled"] == true && options["top_record_id"] != id {
            return Err(Error::conflict("顶部选择与已保存固定顶部卫星冲突"));
        }
        parameters["top_enabled"] = json!(true);
        parameters["top_record_id"] = id;
    }
    Ok(parameters)
}
