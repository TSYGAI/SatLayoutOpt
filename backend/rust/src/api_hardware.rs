//! 文件说明：硬件配置的 HTTP 契约适配；磁盘读写和校验委托 HardwareConfig，响应禁止缓存。
use crate::{
    api::{json, App, Payload},
    blocking,
    error::Result,
};
use axum::{extract::State, response::Response};
use std::sync::Arc;

/// 返回不可缓存的 JSON，确保用户重新读取时得到真实磁盘版本。
fn response(value: serde_json::Value) -> Response {
    let mut response = json(value);
    response
        .headers_mut()
        .insert("Cache-Control", "no-store".parse().unwrap());
    response
}

/// 读取配置目录、保存值、运行值及服务机器资源；文件错误保持可见。
pub async fn get(State(app): State<Arc<App>>) -> Result<Response> {
    Ok(response(blocking(move || app.hardware.read()).await?))
}

/// 根据当前计算服务硬件生成未保存建议；接口只读配置和系统资源，不写入文件。
pub async fn recommendation(State(app): State<Arc<App>>) -> Result<Response> {
    Ok(response(blocking(move || app.hardware.recommend()).await?))
}

/// 按版本保存允许的字段；422 表示配置非法，409 表示文件已变化或正在写入。
pub async fn save(State(app): State<Arc<App>>, Payload(request): Payload) -> Result<Response> {
    Ok(response(
        blocking(move || app.hardware.save(&request)).await?,
    ))
}

/// 提供当前服务会话已经生效的前端预算，用于生产与桌面构建读取运行配置。
pub async fn runtime(State(app): State<Arc<App>>) -> Response {
    response(app.hardware.runtime())
}
