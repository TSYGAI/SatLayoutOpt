//! 文件说明：仅监听回环地址的静态资源和流式 API 代理；不处理业务规则或保存计算数据。
//! Host/Origin 检查限制跨站请求，代理不缓存大型上传、GLB 或下载响应。

use axum::{
    body::Body,
    extract::{Request, State},
    http::{header, HeaderMap, StatusCode},
    response::Response,
    Router,
};
use std::{
    path::PathBuf,
    sync::{
        atomic::{AtomicU16, Ordering},
        Arc,
    },
    time::Duration,
};
use tower::ServiceExt;
use tower_http::services::{ServeDir, ServeFile};

/// 单个桌面实例的代理状态；后端端口在就绪协议到达后发布。
#[derive(Clone)]
pub struct Gateway {
    pub origin: String,
    pub backend_port: Arc<AtomicU16>,
    pub dist: PathBuf,
    pub entry_path: String,
    pub csp: String,
    pub client: reqwest::Client,
    pub telemetry: Option<Arc<crate::telemetry::Telemetry>>,
}

impl Gateway {
    /// 创建无系统代理、无自动重定向的本机客户端；构造失败时返回网络配置错误。
    pub fn new(
        port: u16,
        dist: PathBuf,
        entry_path: String,
        csp: String,
        timeout: Duration,
    ) -> Result<Self, reqwest::Error> {
        Ok(Self {
            origin: format!("http://127.0.0.1:{port}"),
            backend_port: Arc::new(AtomicU16::new(0)),
            dist,
            entry_path,
            csp,
            telemetry: None,
            client: reqwest::Client::builder()
                .no_proxy()
                .redirect(reqwest::redirect::Policy::none())
                .connect_timeout(timeout)
                .build()?,
        })
    }

    /// 构建无业务 API 的回退路由；上传通过流式 body 绕开 JSON 提取器的大小限制。
    pub fn router(self) -> Router {
        Router::new().fallback(dispatch).with_state(self)
    }
}

/// 删除逐跳传输头和 Connection 声明的扩展头，防止代理转发失效连接状态。
fn strip_hop_headers(headers: &mut HeaderMap) {
    let extensions = headers
        .get(header::CONNECTION)
        .and_then(|v| v.to_str().ok())
        .unwrap_or("")
        .split(',')
        .map(|v| v.trim().to_owned())
        .collect::<Vec<_>>();
    for name in extensions {
        headers.remove(name);
    }
    for name in [
        "connection",
        "keep-alive",
        "proxy-authenticate",
        "proxy-authorization",
        "te",
        "trailer",
        "transfer-encoding",
        "upgrade",
    ] {
        headers.remove(name);
    }
}

/// 创建简短的 HTTP 错误响应，错误不会暴露本机路径与内部异常。
fn status(code: StatusCode) -> Response {
    Response::builder()
        .status(code)
        .body(Body::empty())
        .unwrap()
}

/// 校验请求来源并分派到静态资源或独立 Python API；原始响应状态及下载头保持兼容。
async fn dispatch(State(state): State<Gateway>, request: Request) -> Response {
    let expected_host = state.origin.trim_start_matches("http://");
    if request
        .headers()
        .get(header::HOST)
        .and_then(|v| v.to_str().ok())
        != Some(expected_host)
        || request
            .headers()
            .get(header::ORIGIN)
            .is_some_and(|v| v.to_str().ok() != Some(state.origin.as_str()))
        || request
            .headers()
            .get("sec-fetch-site")
            .is_some_and(|v| v == "cross-site")
    {
        return status(StatusCode::FORBIDDEN);
    }
    if request.uri().path() == "/__desktop/telemetry" {
        let Some(telemetry) = &state.telemetry else {
            return status(StatusCode::NOT_FOUND);
        };
        if request.method() != axum::http::Method::POST
            || request
                .headers()
                .get(header::ORIGIN)
                .and_then(|v| v.to_str().ok())
                != Some(state.origin.as_str())
            || request
                .headers()
                .get("x-sat-telemetry")
                .and_then(|v| v.to_str().ok())
                != Some("1")
        {
            return status(StatusCode::FORBIDDEN);
        }
        return match axum::body::to_bytes(request.into_body(), telemetry.max_bytes()).await {
            Ok(bytes) => match serde_json::from_slice(&bytes) {
                Ok(value) => {
                    if telemetry.accept(value).is_ok() {
                        status(StatusCode::NO_CONTENT)
                    } else {
                        status(StatusCode::BAD_REQUEST)
                    }
                }
                Err(_) => status(StatusCode::BAD_REQUEST),
            },
            Err(_) => status(StatusCode::PAYLOAD_TOO_LARGE),
        };
    }
    if request.uri().path() == "/api" || request.uri().path().starts_with("/api/") {
        return proxy(&state, request).await;
    }
    if !matches!(
        *request.method(),
        axum::http::Method::GET | axum::http::Method::HEAD
    ) {
        return status(StatusCode::METHOD_NOT_ALLOWED);
    }
    let path = request.uri().path();
    if path == "/"
        || (path.starts_with("/frontend/") && path.ends_with(".html") && !path[10..].contains('/'))
    {
        let destination = if path == "/" {
            state.entry_path.clone()
        } else {
            path.trim_end_matches(".html").to_owned()
        };
        let query = request
            .uri()
            .query()
            .map(|q| format!("?{q}"))
            .unwrap_or_default();
        return Response::builder()
            .status(StatusCode::FOUND)
            .header(header::LOCATION, destination + &query)
            .body(Body::empty())
            .unwrap();
    }
    let spa = path == "/frontend"
        || path == "/frontend/"
        || (path.starts_with("/frontend/") && std::path::Path::new(path).extension().is_none());
    let result = if spa {
        ServeFile::new(state.dist.join("frontend/index.html"))
            .oneshot(request)
            .await
    } else {
        ServeDir::new(&state.dist).oneshot(request).await
    };
    let mut response = result.unwrap().map(Body::new);
    let headers = response.headers_mut();
    headers.insert(header::CACHE_CONTROL, "no-cache".parse().unwrap());
    headers.insert(header::X_CONTENT_TYPE_OPTIONS, "nosniff".parse().unwrap());
    if let Ok(csp) = state.csp.parse() {
        headers.insert(header::CONTENT_SECURITY_POLICY, csp);
    }
    response
}

/// 双向流式转发请求；客户端取消时 body 被释放，上游流同时结束，避免大型文件完整驻留 Rust 堆。
async fn proxy(state: &Gateway, request: Request) -> Response {
    let trace = request
        .headers()
        .get("x-sat-operation")
        .and_then(|value| value.to_str().ok())
        .unwrap_or("未提供")
        .to_owned();
    let path = request.uri().path().to_owned();
    let port = state.backend_port.load(Ordering::Acquire);
    if port == 0 {
        if let Some(telemetry) = &state.telemetry {
            telemetry.proxy_failure(&trace, &path, "后端尚未就绪");
        }
        return status(StatusCode::SERVICE_UNAVAILABLE);
    }
    let (mut parts, body) = request.into_parts();
    strip_hop_headers(&mut parts.headers);
    parts.headers.remove(header::HOST);
    let target = format!(
        "http://127.0.0.1:{port}{}",
        parts
            .uri
            .path_and_query()
            .map(|v| v.as_str())
            .unwrap_or("/")
    );
    let upstream = state
        .client
        .request(parts.method, target)
        .headers(parts.headers)
        .body(reqwest::Body::wrap_stream(body.into_data_stream()))
        .send()
        .await;
    let incoming = match upstream {
        Ok(value) => value,
        Err(error) => {
            if let Some(telemetry) = &state.telemetry {
                telemetry.proxy_failure(&trace, &path, &error.to_string());
            }
            return status(StatusCode::BAD_GATEWAY);
        }
    };
    let mut headers = incoming.headers().clone();
    strip_hop_headers(&mut headers);
    let mut response = Response::builder()
        .status(incoming.status())
        .body(Body::from_stream(incoming.bytes_stream()))
        .unwrap();
    *response.headers_mut() = headers;
    response
}
