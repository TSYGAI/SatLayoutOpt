//! 文件说明：模型 HTTP 契约和流式上传/缓存接收；业务校验、计算及发布委托 Rust 模型服务。
use crate::{
    api::{self, App, Payload},
    blocking,
    error::{Error, Result},
    files,
};
use axum::{
    extract::{Multipart, Path, Request, State},
    http::{HeaderMap, StatusCode},
    response::{IntoResponse, Response},
};
use futures_util::StreamExt;
use serde_json::json;
use std::{path::PathBuf, sync::Arc};
use tokio::io::AsyncWriteExt;

/// 接收中断或错误时清理仅本次创建的上传文件。
struct Temporary(PathBuf);
impl Drop for Temporary {
    /// HTTP 请求结束时清理未发布的临时资源。
    fn drop(&mut self) {
        let _ = std::fs::remove_file(&self.0);
    }
}
/// 返回全部上传模型与派生状态。
pub async fn list(State(app): State<Arc<App>>) -> Result<Response> {
    Ok(api::json(blocking(move || app.models.list()).await?))
}
/// 分块接收 multipart 模型，检查字段名并交由业务层验证 STEP 签名。
pub async fn upload(
    State(app): State<Arc<App>>,
    multipart: std::result::Result<Multipart, axum::extract::multipart::MultipartRejection>,
) -> Result<Response> {
    let mut multipart = multipart.map_err(|e| Error::invalid(e.body_text()))?;
    while let Some(mut field) = multipart.next_field().await.map_err(Error::bad)? {
        if field.name() != Some("file") {
            continue;
        }
        let filename = field.file_name().unwrap_or("").to_string();
        let temp = Temporary(
            app.models
                .storage
                .join(format!(".upload-{}", files::identifier())),
        );
        let mut output = tokio::fs::OpenOptions::new()
            .create_new(true)
            .write(true)
            .open(&temp.0)
            .await?;
        while let Some(chunk) = field.chunk().await.map_err(Error::bad)? {
            output.write_all(&chunk).await?;
        }
        output.flush().await?;
        drop(output);
        let result = blocking(move || app.models.upload(&filename, &temp.0)).await?;
        return Ok((StatusCode::CREATED, axum::Json(result)).into_response());
    }
    Err(Error::invalid("缺少 file 上传字段"))
}
/// 返回当前完整模型设置。
pub async fn settings(State(app): State<Arc<App>>, Path(id): Path<String>) -> Result<Response> {
    Ok(api::json(
        blocking(move || Ok(json!({"settings":app.models.get(&id)?["settings"]}))).await?,
    ))
}
/// 保存设置并返回重新判定的包络状态。
pub async fn update_settings(
    State(app): State<Arc<App>>,
    Path(id): Path<String>,
    Payload(value): Payload,
) -> Result<Response> {
    Ok(api::json(app.models.update(&id, value).await?))
}
/// 提交单模型后台包络任务。
pub async fn generate(State(app): State<Arc<App>>, Path(id): Path<String>) -> Result<Response> {
    Ok((
        StatusCode::ACCEPTED,
        axum::Json(app.models.start_envelopes(Some(id))?),
    )
        .into_response())
}
/// 提交全模型后台包络任务，活动任务期间幂等返回。
pub async fn generate_all(State(app): State<Arc<App>>) -> Result<Response> {
    Ok((
        StatusCode::ACCEPTED,
        axum::Json(app.models.start_envelopes(None)?),
    )
        .into_response())
}
/// 查询最新包络后台状态。
pub async fn latest(State(app): State<Arc<App>>) -> Response {
    api::json(app.models.latest())
}
/// 返回已有有效包络的源坐标 GLB，缺失时由计算引擎转换。
pub async fn envelope_preview(
    State(app): State<Arc<App>>,
    Path(id): Path<String>,
    headers: HeaderMap,
) -> Result<Response> {
    let path = app.models.envelope_preview(&id).await?;
    api::file(
        &path,
        "model/gltf-binary",
        "private, no-store",
        false,
        headers,
    )
    .await
}
/// 分派固定资源名，原 STEP 流式发送，派生资源先校验清单后发送。
pub async fn resource(
    State(app): State<Arc<App>>,
    Path((id, kind)): Path<(String, String)>,
    headers: HeaderMap,
) -> Result<Response> {
    if kind == "file" {
        let models = app.models.clone();
        let path = blocking(move || models.source_path(&models.get(&id)?)).await?;
        return api::file(&path, "application/step", "no-store", true, headers).await;
    }
    if ![
        "preview-manifest",
        "preview-interaction-manifest",
        "preview.glb",
        "preview-interaction.glb",
        "face-map",
        "interaction-face-map",
    ]
    .contains(&kind.as_str())
    {
        return Err(Error::missing("找不到指定接口"));
    }
    let tier = if kind.contains("interaction") {
        "interaction"
    } else {
        "detail"
    };
    let manifest = app.models.preview(&id, tier).await?;
    if kind.ends_with("manifest") {
        return Ok(api::json(manifest));
    }
    let mapping = kind.contains("face-map");
    let section = if mapping {
        "face_mapping"
    } else {
        "browser_asset"
    };
    let path = files::within(
        &app.models.root(&id).join(tier),
        manifest[section]["file_name"]
            .as_str()
            .ok_or_else(|| Error::missing("当前预览档没有 STEP 面映射"))?,
    )?;
    api::file(
        &path,
        if mapping {
            "application/json"
        } else {
            "model/gltf-binary"
        },
        "private, max-age=31536000",
        false,
        headers,
    )
    .await
}
/// 缓存未就绪立即返回 404，允许前端先显示交互档。
pub async fn cache(
    State(app): State<Arc<App>>,
    Path(id): Path<String>,
    headers: HeaderMap,
) -> Result<Response> {
    let models = app.models.clone();
    let path = blocking(move || models.cache_path(&id)).await?;
    api::file(
        &path,
        "application/vnd.sat-layout-opt.runtime-preview",
        "no-store",
        false,
        headers,
    )
    .await
}
/// 限长流式接收运行缓存，校验魔数和接收前后生成标识，成功返回空 204。
pub async fn put_cache(
    State(app): State<Arc<App>>,
    Path(id): Path<String>,
    request: Request,
) -> Result<Response> {
    let media = request
        .headers()
        .get("content-type")
        .and_then(|v| v.to_str().ok())
        .unwrap_or("")
        .split(';')
        .next()
        .unwrap_or("")
        .trim();
    if media != "application/vnd.sat-layout-opt.runtime-preview" {
        return Err(Error::new(415, "预览运行时缓存 Content-Type 无效"));
    }
    let maximum = app
        .config
        .integer("backend", "model_preview_runtime_cache_max_bytes");
    if request
        .headers()
        .get("content-length")
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.parse::<u64>().ok())
        .is_some_and(|n| n > maximum)
    {
        return Err(Error::new(413, "预览运行时缓存超过上限"));
    }
    let models = app.models.clone();
    let key = id.clone();
    let signature = blocking(move || {
        models
            .cache_signature(&models.get(&key)?)
            .ok_or_else(|| Error::bad("模型双 LOD 尚未就绪，不能保存预览缓存"))
    })
    .await?;
    let path = app
        .models
        .root(&id)
        .join(format!(".runtime-{}.tmp", files::identifier()));
    let temporary = Temporary(path);
    let mut output = tokio::fs::OpenOptions::new()
        .create_new(true)
        .write(true)
        .open(&temporary.0)
        .await?;
    let mut stream = request.into_body().into_data_stream();
    let mut size = 0u64;
    let mut prefix = Vec::new();
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(Error::bad)?;
        size += chunk.len() as u64;
        if size > maximum {
            return Err(Error::new(413, "预览运行时缓存超过上限"));
        }
        let amount = (9 - prefix.len()).min(chunk.len());
        prefix.extend_from_slice(&chunk[..amount]);
        output.write_all(&chunk).await?;
    }
    output.flush().await?;
    drop(output);
    if prefix != b"SATPREV1\0" {
        return Err(Error::bad("预览缓存文件格式无效"));
    }
    blocking(move || app.models.publish_cache(&id, &temporary.0, &signature)).await?;
    Ok(StatusCode::NO_CONTENT.into_response())
}
/// 删除单模型并等待该模型的转换进程回收。
pub async fn delete_model(State(app): State<Arc<App>>, Path(id): Path<String>) -> Result<Response> {
    app.models.delete(&id).await?;
    Ok(StatusCode::NO_CONTENT.into_response())
}
/// 批量幂等删除上传，忽略不存在的模型但传播真实文件失败。
pub async fn batch_delete(
    State(app): State<Arc<App>>,
    Payload(value): Payload,
) -> Result<Response> {
    let mut deleted = 0;
    for id in api::ids(&value, false)? {
        match app.models.delete(&id).await {
            Ok(()) => deleted += 1,
            Err(e) if e.status == StatusCode::NOT_FOUND => {}
            Err(e) => return Err(e),
        }
    }
    Ok(api::json(json!({"deleted":deleted})))
}
