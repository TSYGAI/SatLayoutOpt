//! 文件说明：后端操作上下文、步骤守卫和 HTTP 全响应监测；不改动接口业务结构。
use crate::{
    api::App,
    runtime_logging::{Level, Operation},
};
use axum::{
    body::{Body, HttpBody},
    extract::{Request, State},
    middleware::Next,
    response::Response,
};
use futures_util::Stream;
use serde_json::{json, Value};
use std::{
    cell::RefCell,
    future::Future,
    pin::Pin,
    sync::Arc,
    task::{Context, Poll},
};

tokio::task_local! { static ASYNC_OPERATION: Arc<Operation>; }
thread_local! { static SYNC_OPERATION: RefCell<Option<Arc<Operation>>> = const { RefCell::new(None) }; }

/// 返回当前操作；阻塞线程与异步任务上下文分离，避免并发串号。
pub fn current() -> Option<Arc<Operation>> {
    ASYNC_OPERATION
        .try_with(Clone::clone)
        .ok()
        .or_else(|| SYNC_OPERATION.with(|value| value.borrow().clone()))
}
/// 在异步作用域显式传播操作，调用者创建新任务时必须使用本入口。
pub async fn scope<T>(operation: Arc<Operation>, future: impl Future<Output = T>) -> T {
    ASYNC_OPERATION.scope(operation, future).await
}
/// 创建后台任务时显式继承当前操作，避免模型批处理和布局任务与请求脱节。
pub fn spawn<T: Send + 'static>(
    future: impl Future<Output = T> + Send + 'static,
) -> tokio::task::JoinHandle<T> {
    let operation = current();
    tokio::spawn(async move {
        if let Some(operation) = operation {
            scope(operation, future).await
        } else {
            future.await
        }
    })
}
/// 为异步业务任务建立独立生命周期，继承起始操作编号但不随 HTTP 202 响应关闭。
pub fn background(log: &crate::logging::SessionLog, name: &str) -> Arc<Operation> {
    log.operation(
        current()
            .map(|operation| operation.id.clone())
            .unwrap_or_else(|| trace_id(None)),
        name.to_owned(),
        false,
        true,
    )
}
/// 在同步线程中传播操作，panic 时也恢复前一上下文。
pub fn in_sync<T>(operation: Option<Arc<Operation>>, action: impl FnOnce() -> T) -> T {
    let previous = SYNC_OPERATION.with(|value| value.replace(operation));
    let _restore = Restore(previous);
    action()
}
/// 阻塞线程上下文恢复守卫。
struct Restore(Option<Arc<Operation>>);
impl Drop for Restore {
    /// 还原当前线程上下文，防止线程池复用时污染其他请求。
    fn drop(&mut self) {
        SYNC_OPERATION.with(|value| value.replace(self.0.take()));
    }
}
/// 保留调用位置和当前步骤，正常退出只更新有限内存轨迹。
pub struct Step {
    operation: Option<Arc<Operation>>,
    lane: String,
}
impl Step {
    /// 为一个耗时边界建立独立步骤，允许并发嵌套而不互相覆盖。
    #[track_caller]
    pub fn new(name: &str, object: Value) -> Self {
        let operation = current();
        let lane = format!("rust-{}", crate::files::identifier());
        let caller = std::panic::Location::caller();
        if let Some(operation) = &operation {
            operation.stage(&lane,json!({"step":name,"object":object,"file":caller.file(),"line":caller.line(),"pid":std::process::id()}),true);
        }
        Self { operation, lane }
    }
}
impl Drop for Step {
    /// 步骤结束进入最近历史；实际业务错误由操作终态统一展开。
    fn drop(&mut self) {
        if let Some(operation) = &self.operation {
            operation.end_lane(&self.lane);
        }
    }
}
/// 统一派生操作编号，拒绝日志注入和不受限外部标识。
pub fn trace_id(value: Option<&str>) -> String {
    value
        .filter(|value| {
            !value.is_empty()
                && value.len() <= 80
                && value
                    .bytes()
                    .all(|byte| byte.is_ascii_alphanumeric() || b"-_".contains(&byte))
        })
        .map(str::to_owned)
        .unwrap_or_else(|| format!("op-{}", crate::files::identifier()))
}
/// 全接口监测；流式下载在 body 消费结束后计时，轮询正常时不刷盘。
pub async fn request(State(app): State<Arc<App>>, request: Request, next: Next) -> Response {
    let Ok(log) = app.config.logs() else {
        return next.run(request).await;
    };
    let id = trace_id(
        request
            .headers()
            .get("x-sat-operation")
            .and_then(|value| value.to_str().ok()),
    );
    let path = request.uri().path().to_owned();
    let method = request.method().to_string();
    let no_response_body = method == "HEAD";
    let quiet = method == "GET";
    let operation = log.operation(
        id.clone(),
        format!("后端·API {method} {path}"),
        quiet,
        false,
    );
    operation.stage(
        "host",
        json!({"step":"处理请求","method":method,"path":path,"pid":std::process::id()}),
        true,
    );
    let mut response = scope(operation.clone(), next.run(request)).await;
    response
        .headers_mut()
        .insert("x-sat-operation", id.parse().unwrap());
    let status = response.status().as_u16();
    let expected_cache_miss = response
        .headers()
        .get("x-sat-cache-miss")
        .is_some_and(|value| value == "1");
    let level = response
        .extensions()
        .get::<Level>()
        .copied()
        .unwrap_or(if status >= 500 {
            Level::Error
        } else if status >= 400 {
            Level::Warn
        } else {
            Level::Info
        });
    let (parts, body) = response.into_parts();
    // 空响应可能不会被 HTTP 框架轮询，必须在交还框架前记录实际完成。
    if no_response_body || status == 204 || status == 304 || body.is_end_stream() {
        finish_response(&operation, status, level, expected_cache_miss);
        return Response::from_parts(parts, body);
    }
    operation.stage("host", json!({"step":"传输响应","status":status}), true);
    Response::from_parts(
        parts,
        Body::from_stream(TrackedBody {
            stream: Box::pin(body.into_data_stream()),
            operation,
            status,
            level,
            expected_cache_miss,
            finished: false,
        }),
    )
}
/// 统一响应终态；正常成功不把 HTTP 状态码误作故障原因。
fn finish_response(operation: &Operation, status: u16, level: Level, expected_cache_miss: bool) {
    let reason = (status >= 400 && !expected_cache_miss).then(|| format!("HTTP {status}"));
    operation.finish(
        level,
        if expected_cache_miss {
            "预览缓存未就绪，正常回退"
        } else if status >= 400 {
            "请求失败"
        } else {
            "请求完成"
        },
        reason.as_deref(),
    );
}
/// 代理 body 的流状态；不缓存模型数据，不改变背压。
struct TrackedBody {
    stream: Pin<Box<dyn Stream<Item = std::result::Result<bytes::Bytes, axum::Error>> + Send>>,
    operation: Arc<Operation>,
    status: u16,
    level: Level,
    expected_cache_miss: bool,
    finished: bool,
}
impl Stream for TrackedBody {
    type Item = std::result::Result<bytes::Bytes, axum::Error>;
    /// 只在终态或传输错误写结果，所有下载字节仍原样传递。
    fn poll_next(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<Option<Self::Item>> {
        match self.stream.as_mut().poll_next(cx) {
            Poll::Ready(None) => {
                self.finished = true;
                finish_response(
                    &self.operation,
                    self.status,
                    self.level,
                    self.expected_cache_miss,
                );
                Poll::Ready(None)
            }
            Poll::Ready(Some(Err(error))) => {
                self.finished = true;
                self.operation
                    .finish(Level::Error, "响应流失败", Some(&error.to_string()));
                Poll::Ready(Some(Err(error)))
            }
            Poll::Ready(Some(Ok(value))) => {
                self.operation.progress("host");
                Poll::Ready(Some(Ok(value)))
            }
            Poll::Pending => Poll::Pending,
        }
    }
}
impl Drop for TrackedBody {
    /// 客户端断连只记录取消，不能误报完整传输成功。
    fn drop(&mut self) {
        if !self.finished {
            self.operation
                .finish(Level::Info, "请求取消/响应接收方断开", None);
        }
    }
}
