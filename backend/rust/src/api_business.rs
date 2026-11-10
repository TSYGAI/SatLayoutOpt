//! 文件说明：模型固化、前置配置、布局历史及微调版本管理接口；同步工作隔离到阻塞线程，数值验收由计算服务负责。
use crate::{
    api::{self, App, Payload},
    blocking,
    error::{Error, Result},
    files,
    layout_config,
    model_settings::{number, request_number},
};
use axum::{
    body::Body,
    extract::{Path, Query, State},
    http::{HeaderMap, StatusCode},
    response::{IntoResponse, Response},
};
use futures_util::StreamExt;
use serde_json::{json, Value};
use std::{collections::HashMap, sync::Arc};

/// 校验公共分页查询；默认页长由旧接口契约指定。
fn pagination(query: &HashMap<String, String>, default: i64) -> Result<(i64, i64)> {
    let limit = query
        .get("limit")
        .map(|v| v.parse::<i64>())
        .transpose()
        .map_err(|_| Error::invalid("limit 必须为整数"))?
        .unwrap_or(default);
    let offset = query
        .get("offset")
        .map(|v| v.parse::<i64>())
        .transpose()
        .map_err(|_| Error::invalid("offset 必须为整数"))?
        .unwrap_or(0);
    if !(1..=500).contains(&limit) || offset < 0 {
        return Err(Error::invalid("分页参数超出允许范围"));
    }
    Ok((limit, offset))
}
/// 固化列表附整体统计，默认返回 100 条。
pub async fn store_list(
    State(app): State<Arc<App>>,
    Query(query): Query<HashMap<String, String>>,
) -> Result<Response> {
    let (limit, offset) = pagination(&query, 100)?;
    let keyword = query.get("keyword").cloned().unwrap_or_default();
    if keyword.chars().count() > 200 {
        return Err(Error::invalid("关键词超过 200 字符"));
    }
    Ok(api::json(
        blocking(move || {
            let mut value = app.store.list(limit, offset, &keyword)?;
            value["summary"] = app.store.summary()?;
            Ok(value)
        })
        .await?,
    ))
}
/// 创建独立模型快照；上传和固化后续删除互不影响。
pub async fn store_save(State(app): State<Arc<App>>, Payload(value): Payload) -> Result<Response> {
    api::fields(&value, &["model_id", "record_name"])?;
    let id = api::text(&value["model_id"], 1, 64)?;
    let name = if value["record_name"].is_null() {
        None
    } else {
        Some(api::text(&value["record_name"], 0, 200)?)
    };
    let record = app.store.save(app.models.clone(), id, name).await?;
    app.store_cache
        .enqueue(record["record_id"].as_str().unwrap());
    Ok((StatusCode::CREATED, axum::Json(json!({"record":record}))).into_response())
}
/// 逐项固化全部上传模型并返回汇总；成功项继续复用既有安装基准和显示缓存后台队列。
pub async fn store_save_all(State(app): State<Arc<App>>) -> Result<Response> {
    let result = app.store.save_all(app.models.clone()).await?;
    for item in result["results"].as_array().unwrap() {
        if let Some(id) = item["record"]["record_id"].as_str() {
            app.store_cache.enqueue(id);
        }
    }
    Ok(api::json(result))
}
/// 返回完整固化记录及变体资源。
pub async fn store_get(State(app): State<Arc<App>>, Path(id): Path<String>) -> Result<Response> {
    Ok(api::json(
        blocking(move || Ok(json!({"record":app.store.get(&id)?}))).await?,
    ))
}
/// 查询某来源模型的固化次数与最新记录。
pub async fn source_state(State(app): State<Arc<App>>, Path(id): Path<String>) -> Result<Response> {
    Ok(api::json(
        blocking(move || app.store.source_state(&id)).await?,
    ))
}
/// 批量删除固化记录，规范化并去重请求标识。
pub async fn store_batch_delete(
    State(app): State<Arc<App>>,
    Payload(value): Payload,
) -> Result<Response> {
    let ids = api::ids(&value, true)?;
    Ok(api::json(
        blocking(move || Ok(json!({"deleted":app.store.delete(&ids,false)?}))).await?,
    ))
}
/// 单条删除不存在时返回 404。
pub async fn store_delete(State(app): State<Arc<App>>, Path(id): Path<String>) -> Result<Response> {
    blocking(move || app.store.delete(&[id], true)).await?;
    Ok(StatusCode::NO_CONTENT.into_response())
}
/// 固化源模型流式下载。
pub async fn store_source(
    State(app): State<Arc<App>>,
    Path(id): Path<String>,
    headers: HeaderMap,
) -> Result<Response> {
    let path = blocking(move || {
        let record = app.store.get(&id)?;
        app.store.asset(
            &record,
            record["source"]["asset_name"].as_str().unwrap_or(""),
        )
    })
    .await?;
    api::file(&path, "application/step", "no-store", true, headers).await
}
/// 固化包络 GLB 下载。
pub async fn store_preview(
    State(app): State<Arc<App>>,
    Path(id): Path<String>,
    headers: HeaderMap,
) -> Result<Response> {
    let path = blocking(move || {
        let record = app.store.get(&id)?;
        app.store.asset(
            &record,
            record["envelope"]["preview_asset_name"]
                .as_str()
                .ok_or_else(|| Error::missing("未保存包络浏览网格"))?,
        )
    })
    .await?;
    api::file(
        &path,
        "model/gltf-binary",
        "private, max-age=3600",
        false,
        headers,
    )
    .await
}
/// 按方向下载正式包络；默认兼容 NPZ，format=stl 时流式返回按保存名称命名的 STL。
pub async fn store_variant(
    State(app): State<Arc<App>>,
    Path((id, rotation)): Path<(String, String)>,
    Query(query): Query<HashMap<String, String>>,
    headers: HeaderMap,
) -> Result<Response> {
    let rotation = rotation
        .parse::<i64>()
        .map_err(|_| Error::invalid("方向角必须为整数"))?;
    let format = query.get("format").map(String::as_str).unwrap_or("npz");
    if format == "stl" {
        let (outcome, filename) = app.store.export_stl(&app.engine, &id, rotation).await?;
        let file =
            tokio::fs::File::open(outcome.task.output.join("artifacts/envelope.stl")).await?;
        let size = file.metadata().await?.len();
        // 流持有 Outcome，直到传输结束或连接断开才清理导出文件及输入副本。
        let stream = tokio_util::io::ReaderStream::new(file).map(move |chunk| {
            let _task = &outcome;
            chunk
        });
        return Response::builder()
            .header("Content-Type", "model/stl")
            .header("Content-Length", size)
            .header("Content-Disposition", api::filename(&filename))
            .header("Cache-Control", "no-store")
            .body(Body::from_stream(stream))
            .map_err(Error::bad);
    }
    if format != "npz" {
        return Err(Error::invalid("下载格式仅支持 stl 或 npz"));
    }
    let (path, filename) =
        blocking(move || app.store.variant_download(&id, rotation, "npz")).await?;
    let mut response = api::file(
        &path,
        "application/octet-stream",
        "no-store",
        false,
        headers,
    )
    .await?;
    response.headers_mut().insert(
        "Content-Disposition",
        api::filename(&filename).parse().map_err(Error::bad)?,
    );
    Ok(response)
}
/// 读取前置配置和表单范围，清理已删除模型的残留设置。
pub async fn pre_get(State(app): State<Arc<App>>) -> Result<Response> {
    Ok(api::json(blocking(move || app.pre.get()).await?))
}
/// 保存数量；允许整数数值和整数文本，与旧非严格整数字段一致。
pub async fn pre_count(State(app): State<Arc<App>>, Payload(value): Payload) -> Result<Response> {
    api::fields(&value, &["record_id", "value"])?;
    let id = api::text(&value["record_id"], 1, 64)?;
    let count = value["value"]
        .as_i64()
        .or_else(|| value["value"].as_str().and_then(|s| s.trim().parse().ok()))
        .or_else(|| value["value"].as_bool().map(i64::from))
        .or_else(|| {
            request_number(&value["value"])
                .ok()?
                .as_f64()
                .filter(|x| x.fract() == 0.0 && *x >= i64::MIN as f64 && *x < i64::MAX as f64)
                .map(|x| x as i64)
        })
        .ok_or_else(|| Error::invalid("卫星数量必须为整数"))?;
    Ok(api::json(
        blocking(move || app.pre.save_count(&id, count)).await?,
    ))
}
/// 保存严格布尔对称开关和 hard/soft 模式。
pub async fn pre_symmetry(
    State(app): State<Arc<App>>,
    Payload(value): Payload,
) -> Result<Response> {
    api::fields(&value, &["record_id", "enabled", "mode"])?;
    let id = api::text(&value["record_id"], 1, 64)?;
    let enabled = value["enabled"]
        .as_bool()
        .ok_or_else(|| Error::invalid("对称开关必须为布尔值"))?;
    let mode = value.get("mode").cloned().unwrap_or(json!("hard"));
    let mode = api::text(&mode, 1, 4)?;
    if !["hard", "soft"].contains(&mode.as_str()) {
        return Err(Error::invalid("对称模式必须为 hard 或 soft"));
    }
    Ok(api::json(
        blocking(move || app.pre.save_symmetry(&id, enabled, &mode)).await?,
    ))
}
/// 校验尺寸字段后构建并保存精确整流舱，范围冲突由领域服务返回 409。
pub async fn pre_fairing(
    State(app): State<Arc<App>>,
    Payload(mut value): Payload,
) -> Result<Response> {
    api::fields(
        &value,
        &[
            "min_radius_mm",
            "max_radius_mm",
            "min_height_mm",
            "max_height_mm",
            "axis_radius_mm",
            "centroid_max_offset_mm",
            "installation_tube",
            "fairing_radius_mm",
            "fairing_form",
            "fairing_cylinder_radius_mm",
            "fairing_cylinder_height_mm",
            "lower_cone_lower_radius_mm",
            "lower_cone_upper_radius_mm",
            "lower_cone_height_mm",
            "upper_cone_lower_radius_mm",
            "upper_cone_upper_radius_mm",
            "upper_cone_height_mm",
        ],
    )?;
    if !value["installation_tube"].is_null() {
        let mut tube = value["installation_tube"].clone();
        api::fields(
            &tube,
            &[
                "min_radius_mm",
                "max_radius_mm",
                "min_height_mm",
                "max_height_mm",
                "centroid_max_offset_mm",
                "base",
            ],
        )?;
        if !tube["base"].is_null() {
            api::fields(&tube["base"], &["lower_radius_mm", "height_mm"])?;
            for key in ["lower_radius_mm", "height_mm"] {
                if tube["base"][key].is_boolean() {
                    return Err(Error::invalid("基座尺寸必须为数值"));
                }
                let dimension = number(&request_number(&tube["base"][key])?, key, 0.0, f64::MAX)?;
                if dimension == 0.0 {
                    return Err(Error::invalid("基座尺寸必须大于零"));
                }
                tube["base"][key] = json!(dimension);
            }
        }
        for key in [
            "min_radius_mm",
            "max_radius_mm",
            "min_height_mm",
            "max_height_mm",
            "centroid_max_offset_mm",
        ] {
            if tube[key].is_null() || tube[key].is_boolean() {
                return Err(Error::invalid("安装筒参数必须完整且为数值"));
            }
            value[key] = tube[key].clone();
        }
        value["axis_radius_mm"] = tube["centroid_max_offset_mm"].clone();
        value["installation_tube"] = tube;
        if value["fairing_cylinder_radius_mm"].is_null()
            || value["fairing_cylinder_height_mm"].is_null()
        {
            return Err(Error::invalid("请单独提供整流罩圆柱段半径和高度"));
        }
    }
    for key in [
        "min_radius_mm",
        "max_radius_mm",
        "min_height_mm",
        "max_height_mm",
        "fairing_radius_mm",
    ] {
        if key == "fairing_radius_mm" && !value["installation_tube"].is_null() {
            value[key] = Value::Null;
            continue;
        }
        if key == "fairing_radius_mm" && value[key].is_boolean() {
            return Err(Error::invalid("整流罩半径必须为数值"));
        }
        let n = number(&request_number(&value[key])?, key, 0.0, f64::MAX)?;
        if n == 0.0 {
            return Err(Error::invalid("尺寸必须大于零"));
        }
        value[key] = json!(n);
    }
    if value["axis_radius_mm"].is_null() && !value["centroid_max_offset_mm"].is_null() {
        value["axis_radius_mm"] = value["centroid_max_offset_mm"].clone();
    }
    if !value["axis_radius_mm"].is_null() {
        value["axis_radius_mm"] = json!(number(
            &request_number(&value["axis_radius_mm"])?,
            "中轴半径",
            -f64::MAX,
            f64::MAX
        )?);
    }
    let form = value
        .get("fairing_form")
        .cloned()
        .unwrap_or_else(|| json!("cylinder"));
    let form = api::text(&form, 1, 64)?;
    if !crate::pre_config::FAIRING_FORMS.contains(&form.as_str()) {
        return Err(Error::invalid("不支持的整流罩形态"));
    }
    value["fairing_form"] = json!(form);
    for key in ["fairing_cylinder_radius_mm", "fairing_cylinder_height_mm"] {
        if value[key].is_null() {
            value[key] = if key.ends_with("radius_mm") {
                value["min_radius_mm"].clone()
            } else {
                value["min_height_mm"].clone()
            };
        }
        value[key] = json!(number(&request_number(&value[key])?, key, 0.0, f64::MAX)?);
    }
    for key in [
        "lower_cone_lower_radius_mm",
        "lower_cone_upper_radius_mm",
        "lower_cone_height_mm",
        "upper_cone_lower_radius_mm",
        "upper_cone_upper_radius_mm",
        "upper_cone_height_mm",
    ] {
        if !value[key].is_null() {
            value[key] = json!(number(&request_number(&value[key])?, key, 0.0, f64::MAX)?);
        }
    }
    value["fairing_profile"] = json!({
        "form": value["fairing_form"],
        "cylinder": {"radius_mm": value["fairing_cylinder_radius_mm"], "height_mm": value["fairing_cylinder_height_mm"]},
        "lower_cone": {
            "lower_radius_mm": value["lower_cone_lower_radius_mm"],
            "upper_radius_mm": value.get("lower_cone_upper_radius_mm").filter(|entry| !entry.is_null()).unwrap_or(&value["fairing_cylinder_radius_mm"]),
            "height_mm": value["lower_cone_height_mm"]
        },
        "upper_cone": {
            "lower_radius_mm": value.get("upper_cone_lower_radius_mm").filter(|entry| !entry.is_null()).unwrap_or(&value["fairing_cylinder_radius_mm"]),
            "upper_radius_mm": value["upper_cone_upper_radius_mm"],
            "height_mm": value["upper_cone_height_mm"]
        }
    });
    Ok(api::json(app.pre.save_fairing(value).await?))
}
/// 布局页取得锁定参数与指纹。
pub async fn layout_config(State(app): State<Arc<App>>) -> Result<Response> {
    Ok(api::json(
        blocking(move || layout_config::configuration(&app.pre)).await?,
    ))
}
/// 历史列表只返回摘要，默认 50 条。
pub async fn jobs(
    State(app): State<Arc<App>>,
    Query(query): Query<HashMap<String, String>>,
) -> Result<Response> {
    let (limit, offset) = pagination(&query, 50)?;
    Ok(api::json(
        blocking(move || app.jobs.history(limit, offset)).await?,
    ))
}
/// 创建唯一活动布局项目，立即返回已持久化排队快照。
pub async fn start_job(State(app): State<Arc<App>>, Payload(value): Payload) -> Result<Response> {
    Ok((
        StatusCode::ACCEPTED,
        axum::Json(blocking(move || app.jobs.start(value)).await?),
    )
        .into_response())
}
/// 查询完整任务与已验收候选。
pub async fn job(State(app): State<Arc<App>>, Path(id): Path<String>) -> Result<Response> {
    Ok(api::json(blocking(move || app.jobs.get(&id)).await?))
}
/// 请求取消但允许已有候选继续显示。
pub async fn cancel_job(State(app): State<Arc<App>>, Path(id): Path<String>) -> Result<Response> {
    Ok(api::json(blocking(move || app.jobs.cancel(&id)).await?))
}
/// 重命名历史项目；不允许额外字段、空名或超长名称。
pub async fn rename_job(
    State(app): State<Arc<App>>,
    Path(id): Path<String>,
    Payload(value): Payload,
) -> Result<Response> {
    api::fields(&value, &["name"])?;
    let name = api::text(
        &value["name"],
        1,
        app.config
            .integer("layout_optimization", "history_name_max_length") as usize,
    )?;
    Ok(api::json(
        blocking(move || app.jobs.rename(&id, &name)).await?,
    ))
}
/// 删除终态历史及其快照。
pub async fn delete_job(State(app): State<Arc<App>>, Path(id): Path<String>) -> Result<Response> {
    blocking(move || app.jobs.delete(&id)).await?;
    Ok(StatusCode::NO_CONTENT.into_response())
}
/// 保留旧 JSON 网格契约供旧客户端读取，新客户端使用按型号二进制接口。
pub async fn meshes(State(app): State<Arc<App>>, Path(id): Path<String>) -> Result<Response> {
    let bytes = app.jobs.history_bytes(&id, None).await?;
    Ok((
        [
            ("Content-Type", "application/json"),
            ("Cache-Control", "no-store"),
        ],
        bytes,
    )
        .into_response())
}
/// 返回当前历史引用的型号与二进制资源地址，不解码全部网格。
pub async fn mesh_manifest(
    State(app): State<Arc<App>>,
    Path(id): Path<String>,
) -> Result<Response> {
    Ok(api::json(
        blocking(move || app.jobs.mesh_manifest(&id)).await?,
    ))
}
/// 按需生成单型号显示资源；缓存锁持续到文件打开，支持 Range 与 ETag。
pub async fn mesh_binary(
    State(app): State<Arc<App>>,
    Path((id, record)): Path<(String, String)>,
    headers: HeaderMap,
) -> Result<Response> {
    let _cache = app.jobs.mesh_cache_lock.lock().await;
    let path = app.jobs.mesh_binary(&id, &record).await?;
    api::file(
        &path,
        "application/vnd.sat-layout.mesh",
        "private, no-cache",
        false,
        headers,
    )
    .await
}
/// 从所选历史方案导出安装表，保持文件名与 XLSX 媒体类型。
pub async fn export(
    State(app): State<Arc<App>>,
    Path((id, candidate)): Path<(String, String)>,
) -> Result<Response> {
    let bytes = app.jobs.history_bytes(&id, Some(candidate.clone())).await?;
    let mut response = bytes.into_response();
    let headers = response.headers_mut();
    headers.insert(
        "Content-Type",
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
            .parse()
            .unwrap(),
    );
    headers.insert("Cache-Control", "no-store".parse().unwrap());
    headers.insert(
        "Content-Disposition",
        api::filename(&format!("layout-{id}-{candidate}.xlsx"))
            .parse()
            .map_err(Error::bad)?,
    );
    Ok(response)
}

/// 从指定来源的真实数值快照读取可编辑上下文及完整校核结果。
pub async fn refinement(
    State(app): State<Arc<App>>,
    Path((id, candidate)): Path<(String, String)>,
) -> Result<Response> {
    Ok(api::json(
        app.jobs.refine(&id, &candidate, json!({"commands":[]}), false).await?,
    ))
}

/// 重放微调命令并返回完整验收；预览不写正式历史。
pub async fn refinement_preview(
    State(app): State<Arc<App>>,
    Path((id, candidate)): Path<(String, String)>,
    Payload(body): Payload,
) -> Result<Response> {
    Ok(api::json(app.jobs.refine(&id, &candidate, body, false).await?))
}

/// 重置或离页时关闭指定实时校验会话，取消其计算但不修改草稿或保存版本。
pub async fn cancel_refinement_preview(
    State(app): State<Arc<App>>,
    Path((id, candidate, session)): Path<(String, String, String)>,
) -> Result<Response> {
    files::safe_id(&id)?;
    files::safe_id(&candidate)?;
    app.jobs
        .refinement_validations
        .close(&id, &candidate, &session)?;
    Ok(StatusCode::NO_CONTENT.into_response())
}

/// 重新验收通过后另存微调版本，不覆盖原候选。
pub async fn refinement_save(
    State(app): State<Arc<App>>,
    Path((id, candidate)): Path<(String, String)>,
    Payload(body): Payload,
) -> Result<Response> {
    Ok((StatusCode::CREATED, api::json(app.jobs.refine(&id, &candidate, body, true).await?)).into_response())
}

/// 重命名已保存的微调版本，沿用历史项目的名称长度、去空白和字段白名单校验。
pub async fn rename_refinement(
    State(app): State<Arc<App>>,
    Path((id, candidate)): Path<(String, String)>,
    Payload(body): Payload,
) -> Result<Response> {
    api::fields(&body, &["name"])?;
    let name = api::text(
        &body["name"],
        1,
        app.config.integer("layout_optimization", "history_name_max_length") as usize,
    )?;
    Ok(api::json(
        blocking(move || app.jobs.update_refinement(&id, &candidate, Some(&name))).await?,
    ))
}

/// 删除单个已保存的微调版本；保留其来源、派生版本和项目共享模型资源。
pub async fn delete_refinement(
    State(app): State<Arc<App>>,
    Path((id, candidate)): Path<(String, String)>,
) -> Result<Response> {
    blocking(move || app.jobs.update_refinement(&id, &candidate, None)).await?;
    Ok(StatusCode::NO_CONTENT.into_response())
}
