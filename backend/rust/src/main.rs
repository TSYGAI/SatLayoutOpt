//! 文件说明：独立 Rust 后端进程入口，持有数据独占锁和 Windows 进程树，发布就绪协议并响应桌面退出。
use sat_layout_api::{
    api::{self, App},
    blocking,
    config::Config,
    error::{Error, Result},
};
use std::{io::Write, path::PathBuf, sync::Arc};

/// 创建进程生存期 Job；句柄由操作系统在进程退出时关闭，从而回收所有计算后代。
#[cfg(windows)]
fn process_job() -> Result<usize> {
    use windows_sys::Win32::{
        Foundation::CloseHandle,
        System::{JobObjects::*, Threading::GetCurrentProcess},
    };
    unsafe {
        let job = CreateJobObjectW(std::ptr::null(), std::ptr::null());
        if job.is_null() {
            return Err(std::io::Error::last_os_error().into());
        }
        let mut limits: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = std::mem::zeroed();
        limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
        if SetInformationJobObject(
            job,
            JobObjectExtendedLimitInformation,
            &limits as *const _ as *const _,
            std::mem::size_of_val(&limits) as u32,
        ) == 0
            || AssignProcessToJobObject(job, GetCurrentProcess()) == 0
        {
            let error = std::io::Error::last_os_error();
            CloseHandle(job);
            return Err(error.into());
        }
        Ok(job as usize)
    }
}
/// 非 Windows 开发平台无需建立 Windows Job。
#[cfg(not(windows))]
fn process_job() -> Result<usize> {
    Ok(0)
}

/// 监听宿主 stdin 命令或 EOF；使用专用线程避免阻塞 Tokio 工作线程。
fn control(app: Arc<App>) {
    std::thread::spawn(move || {
        let mut line = String::new();
        loop {
            match std::io::stdin().read_line(&mut line) {
                Ok(0) | Err(_) => break,
                Ok(_) => {
                    if line.trim() == "shutdown" {
                        break;
                    }
                    line.clear();
                }
            }
        }
        app.engine.shutdown.cancel();
    });
}

/// 初始化日志并保留启动失败；业务退出后关闭会话，避免 Result 的默认 stderr 再次重复记录。
#[tokio::main]
async fn main() {
    let result = startup().await;
    if let Err(error) = result {
        eprintln!("{error}");
        std::process::exit(1);
    }
}

/// 加载运行配置并接管日志；仅日志建立前的失败交给桌面壳 stderr 兜底。
async fn startup() -> Result<()> {
    let root = PathBuf::from(
        std::env::var_os("SAT_LAYOUT_OPT_PROJECT_ROOT")
            .unwrap_or(std::env::current_dir()?.into_os_string()),
    );
    let config = Config::load(&root)?;
    let log = config.logs()?;
    log.install();
    let lifecycle = log.operation(
        "backend-lifecycle".into(),
        "后端·生命周期".into(),
        false,
        true,
    );
    let result =
        sat_layout_api::monitoring::scope(lifecycle.clone(), run(config, lifecycle.clone())).await;
    if let Err(error) = &result {
        sat_layout_api::logging::issue(
            sat_layout_api::runtime_logging::Level::Error,
            format_args!("服务退出错误：{error}"),
        );
    }
    lifecycle.finish(
        if result.is_ok() {
            sat_layout_api::runtime_logging::Level::Info
        } else {
            sat_layout_api::runtime_logging::Level::Error
        },
        if result.is_ok() {
            "服务已停止"
        } else {
            "服务失败"
        },
        result.as_ref().err().map(ToString::to_string).as_deref(),
    );
    let reason = match &result {
        Ok(()) => "正常退出".to_owned(),
        Err(error) => format!("异常退出：{error}"),
    };
    if let Err(error) = log.finish(&reason) {
        eprintln!("后端日志关闭失败：{error}");
    }
    if result.is_err() {
        std::process::exit(1);
    }
    Ok(())
}

/// 初始化服务、健康协议与优雅退出；桌面模式使用动态端口，浏览器开发采用集中端口。
async fn run(
    config: Config,
    lifecycle: Arc<sat_layout_api::runtime_logging::Operation>,
) -> Result<()> {
    lifecycle.stage("host", serde_json::json!({"step":"解析启动参数"}), true);
    let mut port = config.integer("backend", "port") as u16;
    let mut frontend = None;
    let mut managed = false;
    let mut args = std::env::args().skip(1);
    while let Some(arg) = args.next() {
        match arg.as_str() {
            "--frontend-port" => {
                frontend = Some(
                    args.next()
                        .ok_or_else(|| Error::bad("缺少前端端口"))?
                        .parse::<u16>()
                        .map_err(Error::bad)?,
                );
                port = 0;
                managed = true;
            }
            "--port" => {
                port = args
                    .next()
                    .ok_or_else(|| Error::bad("缺少监听端口"))?
                    .parse()
                    .map_err(Error::bad)?
            }
            "--managed" => managed = true,
            _ => return Err(Error::bad("未知后端启动参数")),
        }
    }
    let _job = process_job()?;
    lifecycle.stage(
        "host",
        serde_json::json!({"step":"锁定业务目录并初始化数据库"}),
        true,
    );
    let lock_path = config.directory("rust_backend", "lock_file");
    std::fs::create_dir_all(lock_path.parent().unwrap())?;
    let _lock = std::fs::OpenOptions::new()
        .create(true)
        .truncate(false)
        .read(true)
        .write(true)
        .open(&lock_path)?;
    _lock
        .try_lock()
        .map_err(|_| Error::conflict("此数据目录已有 Rust 后端运行"))?;
    let host = config.string("backend", "host").to_string();
    let app = blocking(move || App::open(config)).await?;
    let cache_worker = app.store_cache.start();
    let listener = tokio::net::TcpListener::bind((host.as_str(), port)).await?;
    let port = listener.local_addr()?.port();
    lifecycle.finish(
        sat_layout_api::runtime_logging::Level::Info,
        "后端就绪",
        None,
    );
    let ready = format!(
        "SAT_LAYOUT_READY={}",
        serde_json::json!({"port":port,"pid":std::process::id(),"runtime":"rust"})
    );
    println!("{ready}");
    std::io::stdout().flush()?;
    if managed {
        control(app.clone());
    }
    let stop = app.engine.shutdown.clone();
    let signal = stop.clone();
    tokio::spawn(async move {
        let _ = tokio::signal::ctrl_c().await;
        signal.cancel();
    });
    let router = api::router(app.clone(), frontend);
    let serve = axum::serve(listener, router).with_graceful_shutdown(stop.cancelled_owned());
    let engine = app.engine.clone();
    tokio::spawn(async move {
        engine.shutdown.cancelled().await;
        engine.stop().await;
    });
    serve.await?;
    let shutdown =
        app.config
            .logs()?
            .operation("backend-shutdown".into(), "后端·关闭".into(), false, true);
    shutdown.stage(
        "host",
        serde_json::json!({"step":"取消并回收所有计算进程"}),
        true,
    );
    app.engine.stop().await;
    shutdown.stage(
        "host",
        serde_json::json!({"step":"等待缓存队列与业务终态持久化"}),
        true,
    );
    cache_worker.await.map_err(Error::bad)?;
    // 任务终态写入由业务宿主完成；退出前等待活动项目释放，保证取消结果落盘。
    loop {
        let active = app.jobs.state.lock().unwrap().active.is_some()
            || app.models.latest()["task"]["state"] == "running";
        if !active {
            break;
        }
        tokio::time::sleep(std::time::Duration::from_secs_f64(
            app.config.number("compute_engine", "poll_interval_seconds"),
        ))
        .await;
    }
    shutdown.finish(
        sat_layout_api::runtime_logging::Level::Info,
        "关闭清理完成",
        None,
    );
    Ok(())
}
