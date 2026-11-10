//! 文件说明：独立 Rust 业务后端模块入口；HTTP、持久化、正式包络导出与计算宿主分层，不依赖 Tauri。
pub mod api;
pub mod api_business;
pub mod api_hardware;
pub mod api_models;
pub mod compute;
pub mod compute_protocol;
pub mod config;
pub mod database;
pub mod error;
pub mod envelope_task_progress;
pub mod files;
pub mod fixed_constraints;
pub mod fixed_display;
pub mod fixed_preview_cache;
pub mod fixed_stream;
pub mod hardware_catalog;
pub mod hardware_config;
pub mod hardware_recommendation;
pub mod hardware_scheduling;
pub mod job_compute;
pub mod job_meshes;
pub mod job_refinement;
pub mod jobs;
pub mod layout_config;
pub mod logging;
pub mod model_cache;
pub mod model_manifests;
pub mod model_settings;
pub mod models;
pub mod monitoring;
pub mod pre_config;
pub mod prepared_cache;
pub mod preview_reuse;
pub mod preview_runtime_reuse;
pub mod resource_budget;
pub mod refinement_validation;
#[path = "../../../shared/runtime_logging.rs"]
pub mod runtime_logging;
pub mod store;
pub mod store_cache;
pub mod store_export;

/// 将同步数据库和重型文件工作隔离到 Tokio 阻塞线程，传播业务错误。
pub async fn blocking<T: Send + 'static>(
    action: impl FnOnce() -> error::Result<T> + Send + 'static,
) -> error::Result<T> {
    let operation = monitoring::current();
    tokio::task::spawn_blocking(move || monitoring::in_sync(operation, action))
        .await
        .map_err(error::Error::bad)?
}
