//! 文件说明：Axum API、流式资源和布局微调及版本管理入口；领域计算和历史版本由独立业务服务处理。
use crate::{
    compute::Engine,
    config::Config,
    error::{Error, Result},
    jobs::Jobs,
    models::Models,
    pre_config::PreConfig,
    resource_budget,
    store::Store,
    store_cache::StoreCache,
};
use axum::{
    body::Body,
    extract::{DefaultBodyLimit, FromRequest, Request},
    http::{HeaderMap, HeaderValue, StatusCode},
    response::{IntoResponse, Response},
    routing::{delete, get, post, put},
    Json, Router,
};
use serde_json::Value;
use std::{path::Path, sync::Arc};
use tower_http::cors::{AllowOrigin, Any, CorsLayer};
use tower_http::services::ServeFile;

/// 共享业务服务，数据库和正式资源只有本 Rust 进程负责写入。
pub struct App {
    pub config: Arc<Config>,
    pub hardware: crate::hardware_config::HardwareConfig,
    pub engine: Arc<Engine>,
    pub models: Arc<Models>,
    pub store: Arc<Store>,
    pub store_cache: Arc<StoreCache>,
    pub pre: Arc<PreConfig>,
    pub jobs: Arc<Jobs>,
}
impl App {
    /// 初始化独立业务后端，失败立即停止启动避免部分服务可写。
    pub fn open(config: Config) -> Result<Arc<Self>> {
        let config = Arc::new(config);
        let engine = Arc::new(Engine::new(config.clone()));
        let models = Arc::new(Models::open(config.clone(), engine.clone())?);
        let store = Arc::new(Store::open(config.clone())?);
        let store_cache = Arc::new(StoreCache::new(store.clone(), engine.clone()));
        let pre = Arc::new(PreConfig::open(
            config.clone(),
            store.clone(),
            engine.clone(),
        )?);
        let jobs = Arc::new(Jobs::open(config.clone(), engine.clone(), pre.clone())?);
        Ok(Arc::new(Self {
            hardware: crate::hardware_config::HardwareConfig::new(config.clone()),
            config,
            engine,
            models,
            store,
            store_cache,
            pre,
            jobs,
        }))
    }
}
/// 自定义 JSON 提取器，把解析失败保持为旧 API 的 422 detail 响应。
pub struct Payload(pub Value);
impl<S: Send + Sync> FromRequest<S> for Payload {
    type Rejection = Error;
    /// 使用 Axum 有界 JSON 读取，不接受错误内容类型或非法 UTF-8。
    async fn from_request(request: Request, state: &S) -> Result<Self> {
        let Json(value) = Json::<Value>::from_request(request, state)
            .await
            .map_err(|e| Error::invalid(e.body_text()))?;
        Ok(Self(value))
    }
}
/// 将领域结果编码为 JSON 响应。
pub fn json(value: Value) -> Response {
    Json(value).into_response()
}
/// 为字段约束严格的请求拒绝额外键。
pub fn fields(value: &Value, allowed: &[&str]) -> Result<()> {
    if value
        .as_object()
        .is_none_or(|o| o.keys().any(|k| !allowed.contains(&k.as_str())))
    {
        return Err(Error::invalid("请求包含未知字段或不是对象"));
    }
    Ok(())
}
/// 读取、裁剪字符串并校验字符数；缺失和非字符串均为 422。
pub fn text(value: &Value, min: usize, max: usize) -> Result<String> {
    let text = value
        .as_str()
        .ok_or_else(|| Error::invalid("字段必须为字符串"))?
        .trim();
    if !(min..=max).contains(&text.chars().count()) {
        return Err(Error::invalid("字段长度超出范围"));
    }
    Ok(text.into())
}
/// 校验非空标识数组；固化记录执行既有清理规则，上传删除维持原标识。
pub fn ids(value: &Value, store: bool) -> Result<Vec<String>> {
    if store {
        fields(value, &["ids"])?;
    }
    let entries = value["ids"]
        .as_array()
        .filter(|a| !a.is_empty())
        .ok_or_else(|| Error::invalid("ids 必须为非空数组"))?;
    let mut ids = vec![];
    for id in entries {
        let id = if store {
            text(id, 1, 64)?
        } else {
            id.as_str()
                .ok_or_else(|| Error::invalid("模型标识必须为字符串"))?
                .into()
        };
        if !ids.contains(&id) {
            ids.push(id);
        }
    }
    Ok(ids)
}
/// 编码 RFC5987 UTF-8 下载文件名，阻止换行注入响应头。
pub fn filename(name: &str) -> String {
    let mut result = String::new();
    for byte in name.as_bytes() {
        if byte.is_ascii_alphanumeric() || b"-._~".contains(byte) {
            result.push(*byte as char);
        } else {
            result.push_str(&format!("%{byte:02X}"));
        }
    }
    format!("attachment; filename*=UTF-8''{result}")
}
/// 流式发送已经校验路径的资源；大模型不会先整体进入 Rust 内存。
pub async fn file(
    path: &Path,
    media: &str,
    cache: &str,
    download: bool,
    mut headers: HeaderMap,
) -> Result<Response> {
    let metadata = tokio::fs::metadata(path).await.map_err(|e| {
        if e.kind() == std::io::ErrorKind::NotFound {
            Error::missing("资源文件已丢失")
        } else {
            e.into()
        }
    })?;
    let stamp = metadata
        .modified()?
        .duration_since(std::time::UNIX_EPOCH)
        .map_err(Error::bad)?
        .as_nanos();
    let etag = format!("\"{:x}-{stamp:x}\"", metadata.len());
    if headers
        .get("if-none-match")
        .and_then(|h| h.to_str().ok())
        .is_some_and(|h| h.split(',').any(|v| v.trim() == etag || v.trim() == "*"))
    {
        return Response::builder()
            .status(304)
            .header("ETag", etag)
            .header("Cache-Control", cache)
            .body(Body::empty())
            .map_err(Error::bad);
    }
    if let Some(condition) = headers
        .get("if-range")
        .and_then(|h| h.to_str().ok())
        .filter(|s| s.starts_with('"'))
    {
        if condition != etag {
            headers.remove("range");
        }
        headers.remove("if-range");
    }
    let mut request = Request::new(Body::empty());
    *request.headers_mut() = headers;
    let mut response = ServeFile::new(path).try_call(request).await?.map(Body::new);
    if response.status() == StatusCode::NOT_FOUND {
        return Err(Error::missing("资源文件已丢失"));
    }
    if !response
        .headers()
        .get("content-type")
        .and_then(|h| h.to_str().ok())
        .is_some_and(|h| h.starts_with("multipart/"))
    {
        response
            .headers_mut()
            .insert("Content-Type", media.parse().map_err(Error::bad)?);
    }
    response
        .headers_mut()
        .insert("Cache-Control", cache.parse().map_err(Error::bad)?);
    response
        .headers_mut()
        .insert("ETag", etag.parse().map_err(Error::bad)?);
    if download {
        response.headers_mut().insert(
            "Content-Disposition",
            filename(&path.file_name().unwrap().to_string_lossy())
                .parse()
                .map_err(Error::bad)?,
        );
    }
    Ok(response)
}
/// 构建完整旧业务路由；CORS 只允许配置的前端和桌面代理来源。
pub fn router(app: Arc<App>, frontend_port: Option<u16>) -> Router {
    use crate::{api_business as b, api_models as m};
    let mut origins = vec![
        format!(
            "http://{}:{}",
            app.config.string("frontend", "host"),
            app.config.integer("frontend", "port")
        ),
        format!(
            "http://localhost:{}",
            app.config.integer("frontend", "port")
        ),
    ];
    if let Some(port) = frontend_port {
        origins.push(format!("http://127.0.0.1:{port}"));
    }
    let cors = CorsLayer::new()
        .allow_origin(AllowOrigin::list(
            origins.iter().map(|v| v.parse::<HeaderValue>().unwrap()),
        ))
        .allow_methods([
            axum::http::Method::GET,
            axum::http::Method::POST,
            axum::http::Method::PUT,
            axum::http::Method::DELETE,
            axum::http::Method::OPTIONS,
        ])
        .allow_headers(Any)
        .expose_headers([
            axum::http::header::CONTENT_DISPOSITION,
            axum::http::header::HeaderName::from_static("x-sat-operation"),
            axum::http::header::HeaderName::from_static("x-sat-cache-miss"),
        ]);
    Router::new()
        .route("/api/health", get(health))
        .route("/api/runtime-resources", get(runtime_resources))
        .route(
            "/api/hardware-config",
            get(crate::api_hardware::get).put(crate::api_hardware::save),
        )
        .route(
            "/api/hardware-config/recommendation",
            axum::routing::post(crate::api_hardware::recommendation),
        )
        .route(
            "/api/hardware-config/runtime",
            get(crate::api_hardware::runtime),
        )
        .route(
            "/api/models",
            get(m::list)
                .post(m::upload)
                .layer(DefaultBodyLimit::disable()),
        )
        .route("/api/models/batch-delete", post(m::batch_delete))
        .route("/api/models/envelopes/generate-all", post(m::generate_all))
        .route("/api/models/envelopes/task", get(m::latest))
        .route("/api/models/{id}", delete(m::delete_model))
        .route(
            "/api/models/{id}/settings",
            get(m::settings).put(m::update_settings),
        )
        .route("/api/models/{id}/envelope", post(m::generate))
        .route(
            "/api/models/{id}/envelope/preview.glb",
            get(m::envelope_preview),
        )
        .route(
            "/api/models/{id}/preview-runtime-cache",
            get(m::cache)
                .put(m::put_cache)
                .layer(DefaultBodyLimit::disable()),
        )
        .route("/api/models/{id}/{resource}", get(m::resource))
        .route("/api/store/models", get(b::store_list).post(b::store_save))
        .route("/api/store/models/save-all", post(b::store_save_all))
        .route(
            "/api/store/models/batch-delete",
            post(b::store_batch_delete),
        )
        .route("/api/store/sources/{id}", get(b::source_state))
        .route(
            "/api/store/models/{id}",
            get(b::store_get).delete(b::store_delete),
        )
        .route("/api/store/models/{id}/source", get(b::store_source))
        .route(
            "/api/store/models/{id}/fixed-display.bin",
            get(crate::fixed_display::mesh),
        )
        .route(
            "/api/store/models/{id}/envelope/preview.glb",
            get(b::store_preview),
        )
        .route(
            "/api/store/models/{id}/variants/{rotation}",
            get(b::store_variant),
        )
        .route("/api/pre-config/config", get(b::pre_get))
        .route(
            "/api/pre-config/fixed-constraints",
            get(crate::fixed_constraints::get).put(crate::fixed_constraints::save),
        )
        .route(
            "/api/pre-config/fixed-constraints/preview",
            post(crate::fixed_constraints::preview),
        )
        .route("/api/pre-config/satellite-count", put(b::pre_count))
        .route("/api/pre-config/satellite-symmetry", put(b::pre_symmetry))
        .route("/api/pre-config/fairing-segment", put(b::pre_fairing))
        .route("/api/layout-optimization/config", get(b::layout_config))
        .route(
            "/api/layout-optimization/jobs",
            get(b::jobs).post(b::start_job),
        )
        .route(
            "/api/layout-optimization/jobs/{id}",
            get(b::job).delete(b::delete_job),
        )
        .route(
            "/api/layout-optimization/jobs/{id}/cancel",
            post(b::cancel_job),
        )
        .route(
            "/api/layout-optimization/jobs/{id}/name",
            put(b::rename_job),
        )
        .route("/api/layout-optimization/jobs/{id}/meshes", get(b::meshes))
        .route(
            "/api/layout-optimization/jobs/{id}/mesh-manifest",
            get(b::mesh_manifest),
        )
        .route(
            "/api/layout-optimization/jobs/{id}/meshes/{record}/binary",
            get(b::mesh_binary),
        )
        .route(
            "/api/layout-optimization/jobs/{id}/candidates/{candidate}/export",
            get(b::export),
        )
        .route(
            "/api/layout-optimization/jobs/{id}/candidates/{candidate}/refinement",
            get(b::refinement).delete(b::delete_refinement),
        )
        .route(
            "/api/layout-optimization/jobs/{id}/candidates/{candidate}/refinement/name",
            put(b::rename_refinement),
        )
        .route(
            "/api/layout-optimization/jobs/{id}/candidates/{candidate}/refinement/preview",
            post(b::refinement_preview),
        )
        .route(
            "/api/layout-optimization/jobs/{id}/candidates/{candidate}/refinement/preview/{session}",
            delete(b::cancel_refinement_preview),
        )
        .route(
            "/api/layout-optimization/jobs/{id}/candidates/{candidate}/refinement/versions",
            post(b::refinement_save),
        )
        .fallback(missing)
        .layer(DefaultBodyLimit::max(
            app.config.integer("rust_backend", "json_max_bytes") as usize,
        ))
        .layer(cors)
        .layer(axum::middleware::from_fn_with_state(
            app.clone(),
            crate::monitoring::request,
        ))
        .with_state(app)
}
/// 健康结构保持旧契约，以响应头标识实际业务运行时供验收和排障。
async fn health() -> Response {
    let mut response = json(serde_json::json!({"status":"ok","service":"sat-layout-api"}));
    response
        .headers_mut()
        .insert("X-Sat-Backend", HeaderValue::from_static("rust"));
    response
}

/// 返回当前后端所在机器的物理内存快照；固定网格旧路径兜底只把它作为准入参考，不承诺预留全部可用内存。
async fn runtime_resources() -> Result<Response> {
    let resources = resource_budget::system_resources().map_err(|error| Error::new(500, error))?;
    let mut response = json(serde_json::json!({
        "total_memory_bytes": resources.total,
        "available_memory_bytes": resources.available,
    }));
    response
        .headers_mut()
        .insert("Cache-Control", HeaderValue::from_static("no-store"));
    Ok(response)
}
/// 未注册接口保持 JSON 404，不返回框架默认空文本。
async fn missing() -> Response {
    (
        StatusCode::NOT_FOUND,
        Json(serde_json::json!({"detail":"Not Found"})),
    )
        .into_response()
}
