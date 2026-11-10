//! 文件说明：固定约束 HTTP 与持久化服务；只读取固化包络及数值安装基准，复用正式验收与显示缓存，不加载 STEP 本体。
use crate::{
    api::{self, App, Payload},
    blocking,
    compute::{Outcome, Task},
    database,
    error::{Error, Result},
    files, fixed_preview_cache, layout_config,
    pre_config::PreConfig,
    prepared_cache,
};
use axum::{extract::State, http::HeaderMap, response::Response};
use rusqlite::{params, OptionalExtension};
use serde_json::{json, Value};
use std::sync::Arc;
use tokio_util::sync::CancellationToken;

impl PreConfig {
    /// 读取固定组安装参数；旧库无记录时为空，不改历史任务矩阵。
    pub fn fixed_groups(&self) -> Result<Value> {
        let _logging_step =
            crate::monitoring::Step::new("fixed_constraints::fixed_groups", serde_json::json!({}));
        let encoded: Option<String> = database::connect(&self.database, &self.config)?
            .query_row(
                "SELECT value_json FROM pre_config_values WHERE config_key='fixed_groups'",
                [],
                |r| r.get(0),
            )
            .optional()?;
        let mut groups: Value = match encoded {
            Some(value) => serde_json::from_str(&value)?,
            None => json!([]),
        };
        if let Some(items) = groups.as_array_mut() {
            for item in items {
                if let Some(fields) = item.as_object_mut() {
                    for key in ["soft_angle_deg", "soft_height_mm", "soft_suspension_mm"] {
                        fields.remove(key);
                    }
                }
            }
        }
        Ok(groups)
    }
    /// 在锁内重新核对配置指纹并原子保存参数，配置变化时拒绝覆盖。
    fn save_fixed(&self, groups: &Value, fingerprint: &Value) -> Result<Value> {
        let _logging_step =
            crate::monitoring::Step::new("fixed_constraints::save_fixed", serde_json::json!({}));
        let _store = self.store.lock.lock().unwrap();
        let _guard = self.lock.lock().unwrap();
        if layout_config::configuration_locked(self)?["config_fingerprint"] != *fingerprint {
            return Err(Error::conflict("固定计算期间配置已改变，请重新预览后保存"));
        }
        database::connect(&self.database, &self.config)?.execute(
            "INSERT INTO pre_config_values VALUES('fixed_groups',?1,?2) ON CONFLICT(config_key) DO UPDATE SET value_json=excluded.value_json,updated_at=excluded.updated_at",
            params![groups.to_string(), files::now()])?;
        Ok(layout_config::configuration_locked(self)?["config_fingerprint"].clone())
    }
}

/// 返回已保存组和配置指纹，所有模型参数仍由固化库负责。
pub async fn get(State(app): State<Arc<App>>) -> Result<Response> {
    let _logging_step =
        crate::monitoring::Step::new("fixed_constraints::get", serde_json::json!({}));
    Ok(api::json(blocking(move || {
        let config = layout_config::configuration(&app.pre)?;
        Ok(json!({"groups":config["fixed_groups"], "config_fingerprint":config["config_fingerprint"],
            "defaults":{"hard_constraint":true}}))
    }).await?))
}

/// 从固化包络准备数值预览并复用服务端验收；空组直接返回，保存时在锁内再次复核配置。
pub(crate) async fn calculate(
    app: Arc<App>,
    value: Value,
    save: bool,
    events: Option<tokio::sync::mpsc::Sender<Value>>,
) -> Result<Value> {
    let _logging_step =
        crate::monitoring::Step::new("fixed_constraints::calculate", serde_json::json!({}));
    let _gate = app.pre.fixed_gate.lock().await;
    api::fields(
        &value,
        &[
            "groups",
            "config_fingerprint",
            "include_meshes",
            "action",
            "enforce_space",
        ],
    )?;
    if save && !value["action"].is_null() {
        return Err(Error::invalid(
            "原子微调只用于预览；保存时提交确认后的完整组",
        ));
    }
    if !value["action"].is_null() && value["action"]["kind"] != "translate" {
        return Err(Error::invalid(
            "原子微调仅支持世界轴平移，三轴姿态旋转功能已移除",
        ));
    }
    if value["groups"]
        .as_array()
        .is_none_or(|groups| groups.len() > 1000)
    {
        return Err(Error::invalid("固定组必须为数组且不超过1000组"));
    }
    for key in ["include_meshes", "enforce_space"] {
        if value.get(key).is_some_and(|entry| !entry.is_boolean()) {
            return Err(Error::invalid("预览开关必须为布尔值"));
        }
    }
    let this = app.clone();
    let current = blocking(move || layout_config::configuration(&this.pre)).await?;
    if current["config_fingerprint"] != value["config_fingerprint"] {
        return Err(Error::conflict("前置配置或模型库已改变，请刷新固定约束"));
    }
    // 空固定组与总装载数量无关；没有已放置卫星时禁止启动任何模型准备或 CAD。
    if value["groups"].as_array().unwrap().is_empty() {
        if !value["action"].is_null() {
            return Err(Error::conflict("空固定组不能执行微调"));
        }
        if save {
            let this = app.clone();
            let fingerprint = current["config_fingerprint"].clone();
            blocking(move || this.pre.save_fixed(&json!([]), &fingerprint)).await?;
        }
        let this = app.clone();
        let latest = blocking(move || layout_config::configuration(&this.pre)).await?;
        let geometry = &latest["geometry"];
        return Ok(
            json!({"groups":[],"meshes":{},"config_fingerprint":latest["config_fingerprint"],
            "candidate":{"radius_mm":geometry["min_radius_mm"],"height_mm":geometry["min_height_mm"],
                "fairing_radius_mm":geometry["fairing_radius_mm"],"axis_radius_mm":geometry["axis_radius_mm"],"placements":[],
                "installation_base":geometry["installation_tube"]["base"],"fairing_profile":geometry["fairing_profile"],
                "boundary_validation":{"valid":true,"violations":[],"violation_codes":[],"instances":{}},
                "validation":{"valid":true,"violations":[],"complete":false,"loaded_count":0,"total_mass_kg":0.0,
                    "center_of_mass_mm":[0.0,0.0,0.0],"center_label":"已放置卫星质心","collision_method":"formal_envelope_convex_prisms"}}}),
        );
    }
    let this = app.clone();
    let input = value.clone();
    let context = current.clone();
    let cached = blocking(move || {
        let mut cache = this.pre.fixed_cache.lock().unwrap();
        if cache.preview.is_none() {
            cache.preview = fixed_preview_cache::read(&this.config);
        }
        Ok(cache
            .preview
            .as_ref()
            .filter(|entry| {
                input["action"].is_null()
                    && fixed_preview_cache::matches(
                        entry,
                        &context["config_fingerprint"],
                        &input["groups"],
                    )
                    && (input["include_meshes"] != true
                        || input["groups"].as_array().unwrap().iter().all(|group| {
                            entry["result"]["meshes"]
                                .get(group["record_id"].as_str().unwrap_or(""))
                                .is_some()
                        }))
            })
            .map(|entry| {
                Value::Object(
                    entry["result"]
                        .as_object()
                        .unwrap()
                        .iter()
                        .filter(|(key, _)| input["include_meshes"] == true || *key != "meshes")
                        .map(|(key, value)| (key.clone(), value.clone()))
                        .collect(),
                )
            }))
    })
    .await?;
    if let Some(result) = cached {
        return finish(app.clone(), value, current, result, save).await;
    }
    let this = app.clone();
    let input = value.clone();
    let (configuration, parameters, prepare_key, reusable) = blocking(move || {
        let configuration = layout_config::configuration(&this.pre)?;
        if configuration["config_fingerprint"] != input["config_fingerprint"] {
            return Err(Error::conflict("前置配置或模型库已改变，请刷新固定约束"));
        }
        let options = json!({"config_fingerprint":configuration["config_fingerprint"],
            "min_suspension_mm":configuration["defaults"]["min_suspension_mm"],
            "max_suspension_mm":configuration["defaults"]["max_suspension_mm"],
            "radius_step_mm":configuration["defaults"]["radius_step_mm"],
            "random_seed":this.config.values["layout_optimization"]["random_seed"], "top_enabled":false, "top_record_id":null, "notes":""});
        let mut parameters = layout_config::resolve(&configuration, &options)?;
        parameters["fixed_groups"] = json!([]);
        parameters["top_enabled"] = json!(false);
        parameters["top_record_id"] = Value::Null;
        // 只加载固定组引用的包络；保留所引用型号的全部数量以验收硬配对。
        for selection in parameters["satellites"].as_array_mut().unwrap() {
            if !input["groups"].as_array().unwrap().iter().any(|g| g["record_id"] == selection["record_id"]) {
                selection["count"] = json!(0);
            }
        }
        let records = {
            let _store = this.pre.store.lock.lock().unwrap();
            parameters["satellites"].as_array().unwrap().iter().filter(|s| s["count"] != 0)
                .map(|s| this.pre.store.get(s["record_id"].as_str().unwrap())).collect::<Result<Vec<_>>>()?
        };
        let key = files::fingerprint(&json!({"parameters":parameters,"records":records,
            "version":this.config.values["rust_backend"]["prepared_cache_version"],
            "backend":this.config.values["backend"],"solver":this.config.values["layout_optimization"]}));
        let reusable = this.pre.fixed_cache.lock().unwrap().prepared.as_ref()
            .filter(|(previous, _)| previous == &key).map(|(_, outcome)| outcome.clone());
        Ok((configuration, parameters, key, reusable))
    }).await?;
    let mut initial_result = None;
    let prepared = if let Some(outcome) = reusable {
        outcome
    } else {
        for selection in parameters["satellites"]
            .as_array()
            .unwrap()
            .iter()
            .filter(|item| item["count"] != 0)
        {
            app.store_cache
                .ensure(selection["record_id"].as_str().unwrap(), false)
                .await?;
        }
        let this = app.clone();
        let preview_input = value.clone();
        let (task, cached) = blocking(move || {
            let mut task = this
                .jobs
                .prepare_task_mode(&json!({"parameters":parameters}), true)?;
            let mut metadata = files::read_json(&task.input.join("metadata.json"))?;
            metadata["fixed_preview"] = preview_input;
            task.metadata(&metadata)?;
            let cached = prepared_cache::restore(&task, &this.config)?;
            Ok((task, cached))
        })
        .await?;
        let mut outcome = if let Some(result) = cached {
            Outcome {
                task,
                result,
                cancelled: false,
                candidates: json!([]),
            }
        } else {
            let outcome = app
                .engine
                .run(
                    task,
                    "fixed-prepare",
                    CancellationToken::new(),
                    events.clone(),
                )
                .await
                .map_err(calculation_error)?;
            let this = app.clone();
            blocking(move || {
                prepared_cache::store(&outcome, &this.config)?;
                Ok(outcome)
            })
            .await?
        };
        initial_result = outcome
            .result
            .as_object_mut()
            .and_then(|result| result.remove("fixed_result"));
        let outcome = Arc::new(outcome);
        app.pre.fixed_cache.lock().unwrap().prepared = Some((prepare_key, outcome.clone()));
        outcome
    };
    let mut result = if let Some(result) = initial_result {
        result
    } else {
        let config = app.config.clone();
        let input = value.clone();
        let task = blocking(move || {
            let snapshot = prepared.task.output.join("prepared/snapshot.json");
            let manifest = files::read_json(&snapshot)?;
            let mut task = Task::new(&config, "fixed.preview", &input)?;
            task.add_shared("snapshot", "prepared/snapshot.json", &snapshot)?;
            for (key, reference) in manifest["arrays"]
                .as_object()
                .ok_or_else(|| Error::bad("快照缺少数组"))?
            {
                let path = files::verify(snapshot.parent().unwrap(), reference)?;
                task.add_shared(
                    key,
                    &format!("prepared/{}", reference["path"].as_str().unwrap()),
                    &path,
                )?;
            }
            Ok(task)
        })
        .await?;
        let outcome = app
            .engine
            .run(task, "fixed-preview", CancellationToken::new(), events)
            .await
            .map_err(calculation_error)?;
        outcome.result.clone()
    };
    let total: u64 = configuration["satellites"]
        .as_array()
        .unwrap()
        .iter()
        .map(|s| s["count"].as_u64().unwrap_or(0))
        .sum();
    let complete = result["candidate"]["placements"].as_array().unwrap().len() as u64 == total;
    result["candidate"]["validation"]["complete"] = json!(complete);
    result["candidate"]["validation"]["center_label"] = json!(if complete {
        "全部卫星质心"
    } else {
        "已放置卫星质心"
    });
    finish(app.clone(), value, configuration, result, save).await
}

/// 将数值层的参数错误和不可行冲突映射为既有 HTTP 错误语义。
fn calculation_error(error: Error) -> Error {
    let _logging_step = crate::monitoring::Step::new(
        "fixed_constraints::calculation_error",
        serde_json::json!({}),
    );
    match error.computation_code.as_deref() {
        Some("invalid_input") => Error::invalid(&error.message),
        Some("infeasible") => Error::conflict(&error.message),
        _ => error,
    }
}

/// 发布已验收结果；缓存命中仍执行指纹复核、严格空间门禁及保存事务，不接受客户端矩阵或验收结论。
async fn finish(
    app: Arc<App>,
    value: Value,
    configuration: Value,
    mut result: Value,
    save: bool,
) -> Result<Value> {
    let _logging_step =
        crate::monitoring::Step::new("fixed_constraints::finish", serde_json::json!({}));
    if value["enforce_space"] == true
        && result["candidate"]["boundary_validation"]["violation_codes"]
            .as_array()
            .is_some_and(|codes| codes.iter().any(|code| code != "fairing_radius"))
    {
        return Err(Error::conflict("操作超出可用空间，已保持原布局"));
    }
    let expected = if save {
        if result["candidate"]["validation"]["valid"] != true {
            return Err(Error::conflict(format!(
                "固定约束不可保存：{}",
                result["candidate"]["validation"]["violations"]
            )));
        }
        let this = app.clone();
        let groups = result["groups"].clone();
        let fingerprint = configuration["config_fingerprint"].clone();
        blocking(move || this.pre.save_fixed(&groups, &fingerprint)).await?
    } else {
        configuration["config_fingerprint"].clone()
    };
    let this = app.clone();
    let latest = blocking(move || layout_config::configuration(&this.pre)).await?;
    if latest["config_fingerprint"] != expected {
        return Err(Error::conflict("固定预览期间配置已改变，请重新读取"));
    }
    result["config_fingerprint"] = latest["config_fingerprint"].clone();
    if value["action"].is_null() {
        let entry = fixed_preview_cache::entry(
            &app.config,
            &latest["config_fingerprint"],
            &value["groups"],
            &result,
        );
        let this = app.clone();
        blocking(move || {
            let bytes = serde_json::to_vec(&entry)?.len() as u64;
            if bytes
                <= this
                    .config
                    .integer("rust_backend", "fixed_preview_cache_max_bytes")
            {
                // 命中未修改的结果不重复同步磁盘，保存与读取只支付短事务开销。
                let mut cache = this.pre.fixed_cache.lock().unwrap();
                if cache.preview.as_ref() != Some(&entry) {
                    if let Err(error) = fixed_preview_cache::write(&this.config, &entry) {
                        crate::logging::issue(
                            crate::runtime_logging::Level::Warn,
                            format_args!("固定预览缓存写入失败：{error}"),
                        );
                    }
                    cache.preview = Some(entry);
                }
            }
            Ok(())
        })
        .await?;
    }
    if value["include_meshes"] != true {
        result["meshes"] = json!({});
    }
    Ok(result)
}

/// 计算预览并持续返回冲突列表；不写业务配置。
pub async fn preview(
    State(app): State<Arc<App>>,
    headers: HeaderMap,
    Payload(value): Payload,
) -> Result<Response> {
    let _logging_step =
        crate::monitoring::Step::new("fixed_constraints::preview", serde_json::json!({}));
    if headers
        .get("accept")
        .is_some_and(|v| v == "application/x-ndjson")
    {
        return Ok(crate::fixed_stream::preview(app, value));
    }
    Ok(api::json(calculate(app, value, false, None).await?))
}

/// 保存经过正式包络验收的全量组；同一输入复用服务端结果，配置变化或验收失败保留此前约束。
pub async fn save(State(app): State<Arc<App>>, Payload(value): Payload) -> Result<Response> {
    let _logging_step =
        crate::monitoring::Step::new("fixed_constraints::save", serde_json::json!({}));
    Ok(api::json(calculate(app, value, true, None).await?))
}
