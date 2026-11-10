//! 文件说明：统一业务错误、日志诊断分类与 HTTP 映射，保留旧接口的 detail 错误结构。
use axum::{
    http::StatusCode,
    response::{IntoResponse, Response},
    Json,
};
use serde_json::json;

/// 业务错误；status 区分输入、缺失、冲突和内部故障。
#[derive(Debug, Clone)]
pub struct Error {
    pub status: StatusCode,
    pub message: String,
    pub computation_code: Option<String>,
    pub origin: String,
    pub error_id: String,
    pub internal: bool,
    pub expected_cache_miss: bool,
    context: Option<Box<serde_json::Value>>,
}
pub type Result<T> = std::result::Result<T, Error>;
impl Error {
    /// 创建指定状态的业务错误，消息可展示给用户。
    #[track_caller]
    pub fn new(status: u16, message: impl ToString) -> Self {
        Self {
            status: StatusCode::from_u16(status).unwrap(),
            message: message.to_string(),
            computation_code: None,
            origin: std::panic::Location::caller().to_string(),
            error_id: format!("err-{}", uuid::Uuid::new_v4().simple()),
            internal: status >= 500,
            expected_cache_miss: false,
            context: crate::monitoring::current()
                .map(|operation| Box::new(operation.failure_context())),
        }
    }
    /// 请求语义不合法。
    #[track_caller]
    pub fn bad(message: impl ToString) -> Self {
        Self::new(400, message)
    }
    /// 目标模型、历史或资源不存在。
    #[track_caller]
    pub fn missing(message: impl ToString) -> Self {
        Self::new(404, message)
    }
    /// 标记模型已存在但可选预览缓存尚未生成，保持 404 契约并允许前端正常回退。
    pub fn cache_miss(message: impl ToString) -> Self {
        let mut error = Self::missing(message);
        error.expected_cache_miss = true;
        error
    }
    /// 请求与当前任务或配置状态冲突。
    #[track_caller]
    pub fn conflict(message: impl ToString) -> Self {
        Self::new(409, message)
    }
    /// 请求字段不符合 API 契约。
    #[track_caller]
    pub fn invalid(message: impl ToString) -> Self {
        Self::new(422, message)
    }
    /// 保留计算引擎的机器可读错误分类，供任务状态区分不可行与执行故障。
    pub fn computation(mut self, code: &str) -> Self {
        self.computation_code = Some(code.into());
        self.internal = !matches!(code, "infeasible" | "invalid_input");
        self
    }
    /// 统一内部诊断字段，后台任务未经过 HTTP 映射时也保留创建位置和错误编号。
    pub fn diagnostic(&self) -> serde_json::Value {
        json!({"error":self.message,"error_id":self.error_id,"location":self.origin,"code":self.computation_code,"status":self.status.as_u16(),"context":self.context,
            "failure_kind":if self.internal { "program" } else { "business" }})
    }
}
impl std::fmt::Display for Error {
    /// 向日志输出错误描述。
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.message)
    }
}
impl std::error::Error for Error {}
impl IntoResponse for Error {
    /// 保持 HTTP detail 字段，不暴露 Rust 调用栈。
    fn into_response(self) -> Response {
        if let Some(operation) = crate::monitoring::current().filter(|_| !self.expected_cache_miss)
        {
            operation.remember(self.diagnostic());
        }
        if self.status == StatusCode::UNPROCESSABLE_ENTITY {
            return (
                self.status,
                Json(json!({"detail":[{"type":"value_error","loc":["body"],"msg":self.message}]})),
            )
                .into_response();
        }
        let mut response = (self.status, Json(json!({"detail": self.message}))).into_response();
        if self.expected_cache_miss {
            response
                .headers_mut()
                .insert("x-sat-cache-miss", "1".parse().unwrap());
            response
                .extensions_mut()
                .insert(crate::runtime_logging::Level::Info);
        } else if self.internal {
            response
                .extensions_mut()
                .insert(crate::runtime_logging::Level::Error);
        }
        response
    }
}
impl From<std::io::Error> for Error {
    /// 文件错误映射为业务输入错误，沿用旧资源 API 行为。
    #[track_caller]
    fn from(value: std::io::Error) -> Self {
        let mut error = Self::bad(value);
        error.internal = true;
        error
    }
}
impl From<serde_json::Error> for Error {
    /// JSON 数据异常保留具体原因供排障。
    #[track_caller]
    fn from(value: serde_json::Error) -> Self {
        Self::bad(value)
    }
}
impl From<rusqlite::Error> for Error {
    /// 数据库错误返回内部错误，禁止假报写入成功。
    #[track_caller]
    fn from(value: rusqlite::Error) -> Self {
        Self::new(500, value)
    }
}
