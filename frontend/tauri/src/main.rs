//! 文件说明：Tauri 原生窗口与服务生命周期入口，React 通过同源 HTTP 调用独立 Rust 后端。
//! 安装版使用随包固定 WebView2；Python 仅作为独立计算程序由 Rust 管理，验收实例按隔离数据目录区分。
//! 窗口与 WebView 共用集中配置的背景，在首次绘制及尺寸变化期间提供不透明底色。
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod services;

use sat_layout_desktop::{session_logging::SessionLog, settings::Settings};
use services::Services;
use std::hash::{Hash, Hasher};
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc, Mutex,
};
use tauri::{Manager, WebviewUrl, WebviewWindowBuilder};

/// 弹出可诊断的原生错误提示；日志位置由调用者提供，不输出敏感环境信息。
fn show_error(message: &str) {
    rfd::MessageDialog::new()
        .set_title("卫星配载工作台")
        .set_description(message)
        .set_level(rfd::MessageLevel::Error)
        .show();
}

/// 按实际数据基准派生单实例标识；不同安装位置互不接管窗口，同一数据目录仍只启动一次。
fn scope_isolated_instance(identifier: &mut String, config: &Settings) -> std::io::Result<()> {
    let data = config.data_root();
    std::fs::create_dir_all(&data)?;
    let canonical = data.canonicalize()?;
    // 规范化路径并忽略 Windows 大小写，确保同一测试目录的重复启动仍恢复原窗口。
    let mut hash = std::collections::hash_map::DefaultHasher::new();
    canonical.to_string_lossy().to_lowercase().hash(&mut hash);
    identifier.push_str(&format!(".data-{:016x}", hash.finish()));
    Ok(())
}

/// 初始化单实例桌面、启动服务并安装退出回收；错误以原生提示和非零退出码报告。
fn main() {
    let config = match Settings::load() {
        Ok(config) => Arc::new(config),
        Err(error) => {
            show_error(&format!("桌面启动配置错误：{error}"));
            std::process::exit(1);
        }
    };
    // 安装验收可只验证配置迁移；本入口不启动后台、不打开数据库，也不创建窗口。
    if std::env::args()
        .skip(1)
        .any(|value| value == "--upgrade-config")
    {
        return;
    }
    let mut context = tauri::tauri_build_context!();
    if let Err(error) = scope_isolated_instance(&mut context.config_mut().identifier, &config) {
        show_error(&format!("桌面隔离目录初始化失败：{error}"));
        std::process::exit(1);
    }
    if config.packaged {
        // 必须在 WebView2 初始化前指定固定运行时；安装版不依赖系统 Evergreen 或联网安装。
        std::env::set_var(
            "WEBVIEW2_BROWSER_EXECUTABLE_FOLDER",
            config.root.join(&config.packaging.webview2_dir),
        );
    }
    let stopping = Arc::new(AtomicBool::new(false));
    let exit_guard = stopping.clone();
    let setup_config = config.clone();
    let session_state = Arc::new(Mutex::new(None::<Arc<SessionLog>>));
    let setup_session = session_state.clone();
    let service_state = Arc::new(Mutex::new(None::<Arc<Services>>));
    let setup_service = service_state.clone();
    let app = tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _, _| {
            if let Some(log) = app.try_state::<Arc<SessionLog>>() {
                let _ = log.write("重复启动：恢复现有桌面窗口");
            }
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.unminimize();
                let _ = window.set_focus();
            }
        }))
        .setup(move |app| {
            let config = &setup_config;
            let data = config.data_root();
            let log = Arc::new(SessionLog::start_with_policy(&config.log_root(), &chrono::Local::now().format("%Y-%m-%d").to_string(), config.logging.policy.clone())?);
            *setup_session.lock().expect("桌面启动状态锁损坏") = Some(log.clone());
            app.manage(log.clone());
            let panic_log = Arc::downgrade(&log);
            let previous_panic_hook = std::panic::take_hook();
            std::panic::set_hook(Box::new(move |info| {
                if let Some(log) = panic_log.upgrade() {
                    if log.writer.event(
                        sat_layout_desktop::runtime_logging::Level::Error,
                        "前端·桌面", "未捕获异常",
                        &[("原因", info.to_string()), ("异常堆栈", std::backtrace::Backtrace::force_capture().to_string())],
                    ).is_ok() {
                        return;
                    }
                }
                previous_panic_hook(info);
            }));
            let services =
                tauri::async_runtime::block_on(Services::start(config, &data, log.clone()))?;
            *setup_service.lock().expect("桌面服务状态锁损坏") = Some(services.clone());
            app.manage(services.clone());
            let origin = services.origin.clone();
            let allowed_origin = origin.clone();
            let mut builder = WebviewWindowBuilder::new(
                app,
                "main",
                WebviewUrl::External((origin + &config.desktop.entry_path).parse()?),
            )
            .initialization_script(format!("window.__SAT_DESKTOP_LOGGING__ = {};", serde_json::json!({
                "endpoint":"/__desktop/telemetry", "flushMs":config.logging.policy.frontend_flush_ms,
                "batchSize":config.logging.policy.telemetry_batch_size, "capacity":config.logging.policy.queue_capacity,
                "fieldLimit":config.logging.policy.field_max_chars, "slowMs":config.logging.policy.slow_request_ms,
                "maxBytes":config.logging.policy.telemetry_max_bytes
            })))
            .title(&config.desktop.title)
            .background_color(config.desktop.background_color.into())
            .inner_size(config.desktop.width, config.desktop.height)
            .min_inner_size(config.desktop.min_width, config.desktop.min_height)
            .data_directory(config.state_root().join("webview2"))
            .disable_drag_drop_handler()
            .on_navigation(move |url| url.origin().ascii_serialization() == allowed_origin)
            .on_new_window(|_, _| tauri::webview::NewWindowResponse::Deny);
            if let Some(monitor) = app.primary_monitor()? {
                let area = monitor.work_area();
                let scale = monitor.scale_factor();
                builder = builder
                    .inner_size(
                        config.desktop.width.min(area.size.width as f64 / scale),
                        config.desktop.height.min(area.size.height as f64 / scale),
                    )
                    .min_inner_size(
                        config.desktop.min_width.min(area.size.width as f64 / scale),
                        config
                            .desktop
                            .min_height
                            .min(area.size.height as f64 / scale),
                    );
            }
            builder.build()?;
            log.write(&format!("桌面窗口已就绪：{}", services.origin))?;
            let handle = app.handle().clone();
            let interval = config.poll_interval();
            let error_guard = exit_guard.clone();
            tauri::async_runtime::spawn(async move {
                loop {
                    tokio::time::sleep(interval).await;
                    if error_guard.load(Ordering::Acquire) {
                        break;
                    }
                    if matches!(services.child.lock().await.try_wait(), Ok(Some(_)) | Err(_)) {
                        let _ = services.log.issue("Rust 后端意外退出，正在关闭桌面");
                        show_error(&format!(
                            "后台服务意外退出。请查看 {}",
                            services.log.backend_path.display()
                        ));
                        handle.exit(1);
                        break;
                    }
                }
            });
            Ok(())
        })
        .build(context);
    match app {
        Ok(app) => app.run(move |handle, event| {
            if let tauri::RunEvent::ExitRequested { api, code, .. } = event {
                if !stopping.swap(true, Ordering::AcqRel) {
                    api.prevent_exit();
                    let services = handle.state::<Arc<Services>>().inner().clone();
                    let handle = handle.clone();
                    tauri::async_runtime::spawn(async move {
                        services.stop().await;
                        if let Err(error) = services
                            .log
                            .finish(&format!("桌面已关闭：退出码={}", code.unwrap_or(0)))
                        {
                            show_error(&format!("桌面日志关闭失败：{error}"));
                        }
                        handle.exit(code.unwrap_or(0));
                    });
                }
            }
        }),
        Err(error) => {
            if let Some(services) = service_state.lock().expect("桌面服务状态锁损坏").take()
            {
                tauri::async_runtime::block_on(services.stop());
            }
            if let Some(log) = session_state.lock().expect("桌面启动状态锁损坏").take() {
                let _ = log.issue(&format!("桌面启动失败：{error}"));
                let _ = log.finish("启动失败，资源已回收");
            }
            show_error(&format!("桌面启动失败：{error}"));
            std::process::exit(1);
        }
    }
}
