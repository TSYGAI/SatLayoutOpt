//! 文件说明：读取经完整性校验的固化二进制；未生成时等待后台串行队列，HTTP 不另开计算任务。
use crate::{
    api::{self, App},
    error::Result,
    files,
};
use axum::{
    extract::{Path, State},
    http::HeaderMap,
    response::Response,
};
use serde_json::Value;
use std::{
    path::{Path as FilePath, PathBuf},
    sync::Arc,
};

/// 校验显示资源与固化记录一致，损坏或旧版本视为缺失，不使用过期网格。
pub(crate) fn read_display(root: &FilePath, record: &Value, limit: u64) -> Option<PathBuf> {
    let _logging_step =
        crate::monitoring::Step::new("fixed_display::read_display", serde_json::json!({}));
    let manifest = files::read_json(&root.join("fixed-display.json")).ok()?;
    let variant = record["envelope"]["variants"]
        .as_array()?
        .iter()
        .find(|v| v["rot_z"] == 0)?;
    if manifest["version"] != 1
        || manifest["settings"] != record["settings"]
        || manifest["source_sha256"] != record["source"]["sha256"]
        || manifest["envelope_sha256"] != variant["sha256"]
        || manifest["mesh"]["path"] != "fixed-display.bin"
        || manifest["mesh"]["bytes"].as_u64()? > limit
    {
        return None;
    }
    files::verify(root, &manifest["mesh"]).ok()
}

/// 现成资源立即流式返回；缺失等待后台任务，超限保留既有错误与前端旧网格兜底。
pub async fn mesh(
    State(app): State<Arc<App>>,
    Path(id): Path<String>,
    headers: HeaderMap,
) -> Result<Response> {
    let _logging_step = crate::monitoring::Step::new("fixed_display::mesh", serde_json::json!({}));
    let path = app.store_cache.ensure(&id, true).await?;
    api::file(
        &path,
        "application/octet-stream",
        "private, max-age=3600",
        false,
        headers,
    )
    .await
}
