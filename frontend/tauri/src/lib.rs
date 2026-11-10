//! 文件说明：导出不依赖窗口的桌面传输模块，供原生壳和隔离集成测试共用。
pub mod config_upgrade;
pub mod gateway;
#[path = "../../../shared/runtime_logging.rs"]
pub mod runtime_logging;
pub mod session_logging;
pub mod settings;
pub mod telemetry;
