//! 文件说明：管理独立 Rust 业务后端、健康检查和本机代理生命周期，复用既有 stdin 退出协议。
//! Rust 后端拥有业务数据库与 Python 计算子进程；Tauri 在集中配置的桌面状态目录管理运行元数据。

use sat_layout_desktop::{gateway::Gateway, session_logging::SessionLog, settings::Settings};
use std::{
    path::{Path, PathBuf},
    process::Stdio,
    sync::{atomic::Ordering, Arc},
    time::{Duration, Instant},
};
use tokio::{
    io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader},
    process::{Child, Command},
    sync::{mpsc, oneshot, Mutex},
    task::JoinHandle,
};

/// 单实例服务资源；拥有子进程和停止信号，避免窗口关闭后遗留后台服务。
pub struct Services {
    pub child: Mutex<Child>,
    pub origin: String,
    stop: Mutex<Option<oneshot::Sender<()>>>,
    shutdown_timeout: Duration,
    captures: Mutex<Vec<JoinHandle<()>>>,
    gateway: Mutex<Option<JoinHandle<()>>>,
    pub log: Arc<SessionLog>,
    metadata_path: PathBuf,
}

/// 消费标准输出就绪协议；后端自行持久化日志，桌面不再重复转存协议帧。
async fn capture_ready<R: tokio::io::AsyncRead + Unpin>(stream: R, ready: mpsc::Sender<u16>) {
    let mut lines = BufReader::new(stream).lines();
    while let Ok(Some(line)) = lines.next_line().await {
        if let Some(json) = line.strip_prefix("SAT_LAYOUT_READY=") {
            if let Ok(frame) = serde_json::from_str::<serde_json::Value>(json) {
                if let Some(port) = frame["port"]
                    .as_u64()
                    .and_then(|p| u16::try_from(p).ok())
                    .filter(|p| *p > 0)
                {
                    let _ = ready.send(port).await;
                }
            }
        }
    }
}

/// 有界捕获后端接管前或无法写盘的异常，作为进程监督错误记录到前端宿主日志。
async fn capture_stderr<R: tokio::io::AsyncRead + Unpin>(stream: R, log: Arc<SessionLog>) {
    let mut stream = BufReader::new(stream);
    let mut buffer = vec![0u8; 4096];
    loop {
        match stream.read(&mut buffer).await {
            Ok(0) => return,
            Ok(size) => {
                let result = log.writer.event(
                    sat_layout_desktop::runtime_logging::Level::Error,
                    "前端·后端进程",
                    "后端未捕获诊断",
                    &[(
                        "原因",
                        String::from_utf8_lossy(&buffer[..size]).into_owned(),
                    )],
                );
                if let Err(error) = result {
                    let _ = log.issue(&format!("后端异常输出保存失败：{error}"));
                    return;
                }
            }
            Err(error) => {
                let _ = log.issue(&format!("后端异常输出读取失败：{error}"));
                return;
            }
        }
    }
}

/// 在后端退出后等候管道排空；超时取消读取任务，确保旧会话不再写入。
async fn finish_captures(captures: Vec<JoinHandle<()>>, timeout: Duration) {
    for mut task in captures {
        if tokio::time::timeout(timeout, &mut task).await.is_err() {
            task.abort();
            let _ = task.await;
        }
    }
}

impl Services {
    /// 绑定本机代理、启动独立 Rust 后端并等待真正健康；失败回收已创建的子进程。
    pub async fn start(
        config: &Settings,
        data: &Path,
        log: Arc<SessionLog>,
    ) -> Result<Arc<Self>, Box<dyn std::error::Error>> {
        let operation = log.operation(
            "desktop-startup".into(),
            "前端·服务启动".into(),
            false,
            true,
        );
        let result = Self::start_inner(config, data, log, operation.clone()).await;
        operation.finish(
            if result.is_ok() {
                sat_layout_desktop::runtime_logging::Level::Info
            } else {
                sat_layout_desktop::runtime_logging::Level::Error
            },
            if result.is_ok() {
                "服务就绪"
            } else {
                "服务启动失败"
            },
            result.as_ref().err().map(ToString::to_string).as_deref(),
        );
        result
    }

    /// 执行启动步骤，先发送宿主阶段，再进入可能阻塞的文件与进程操作。
    async fn start_inner(
        config: &Settings,
        data: &Path,
        log: Arc<SessionLog>,
        operation: Arc<sat_layout_desktop::runtime_logging::Operation>,
    ) -> Result<Arc<Self>, Box<dyn std::error::Error>> {
        operation.stage(
            "host",
            serde_json::json!({"step":"准备运行目录与代理","path":data}),
            true,
        );
        let state = config.state_root();
        tokio::fs::create_dir_all(&state).await?;
        let metadata_path = state.join("tauri-runtime.json");
        if metadata_path.is_file() {
            tokio::fs::remove_file(&metadata_path).await?;
        }
        let listener = tokio::net::TcpListener::bind(("127.0.0.1", 0)).await?;
        let frontend_port = listener.local_addr()?.port();
        let mut gateway = Gateway::new(
            frontend_port,
            config.root.join("frontend/dist"),
            config.desktop.entry_path.clone(),
            config.desktop.tauri.csp.clone(),
            Duration::from_millis(config.desktop.tauri.connect_timeout_ms),
        )?;
        gateway.telemetry = Some(Arc::new(sat_layout_desktop::telemetry::Telemetry::new(
            log.clone(),
        )));
        let backend = config.backend_executable();
        if !backend.is_file() {
            return Err("未找到 Rust 业务后端，请先通过统一入口构建".into());
        }
        let mut command = Command::new(backend);
        if config.packaged {
            for (key, _) in std::env::vars_os() {
                let name = key.to_string_lossy().to_uppercase();
                if name.starts_with("PYTHON") || name.starts_with("CONDA") {
                    command.env_remove(key);
                }
            }
            let windows = std::env::var_os("SystemRoot").ok_or("未设置 Windows 系统目录")?;
            let windows = std::path::PathBuf::from(windows);
            command.env(
                "PATH",
                std::env::join_paths([
                    config.root.join("backend"),
                    windows.join("System32"),
                    windows,
                ])?,
            );
        }
        command
            .arg("--frontend-port")
            .arg(frontend_port.to_string())
            .current_dir(&config.root)
            .env("SAT_LAYOUT_OPT_PROJECT_ROOT", &config.root)
            .env("SAT_LAYOUT_OPT_DATA_ROOT", data)
            .env("SAT_LAYOUT_OPT_LOG_ROOT", &log.root)
            .env("SAT_LAYOUT_OPT_LOG_SESSION_ID", &log.session_id)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true);
        #[cfg(windows)]
        command.creation_flags(0x08000000); // CREATE_NO_WINDOW：计算进程不弹出控制台。
        let mut child = command.spawn()?;
        operation.stage(
            "host",
            serde_json::json!({"step":"等待后端就绪与健康检查","backend_pid":child.id()}),
            true,
        );
        if let Some(pid) = child.id() {
            operation.context(serde_json::json!({"pid":pid}));
        }
        let (sender, mut receiver) = mpsc::channel(1);
        let captures = vec![
            tokio::spawn(capture_ready(child.stdout.take().unwrap(), sender)),
            tokio::spawn(capture_stderr(child.stderr.take().unwrap(), log.clone())),
        ];
        let deadline = Instant::now() + Duration::from_millis(config.desktop.startup_timeout_ms);
        let ready = async {
            loop {
                if let Some(exit) = child.try_wait().map_err(|error| error.to_string())? {
                    break Err(format!("Rust 后端启动失败：{exit}"));
                }
                if Instant::now() >= deadline {
                    break Err(format!(
                        "Rust 后端启动超时，请查看 {}",
                        log.backend_path.display()
                    ));
                }
                if let Ok(port) = receiver.try_recv() {
                    gateway.backend_port.store(port, Ordering::Release);
                }
                let port = gateway.backend_port.load(Ordering::Acquire);
                if port != 0 {
                    let health = gateway
                        .client
                        .get(format!("http://127.0.0.1:{port}/api/health"))
                        .timeout(Duration::from_millis(
                            config.desktop.tauri.connect_timeout_ms,
                        ))
                        .send()
                        .await;
                    if let Ok(response) = health {
                        if response.status().is_success() {
                            if let Ok(body) = response.json::<serde_json::Value>().await {
                                if body["status"] == "ok" && body["service"] == "sat-layout-api" {
                                    break Ok(port);
                                }
                            }
                        }
                    }
                }
                tokio::time::sleep(config.poll_interval()).await;
            }
        }
        .await;
        let port = match ready {
            Ok(port) => port,
            Err(error) => {
                let killed = child.kill().await;
                let waited = child.wait().await;
                operation.remember(serde_json::json!({
                    "outcome":format!("终止后端：{}；等待退出：{}",
                        killed.map(|_| "已发送终止请求".to_owned()).unwrap_or_else(|error| error.to_string()),
                        waited.map(|status| status.to_string()).unwrap_or_else(|error| error.to_string()))
                }));
                finish_captures(
                    captures,
                    Duration::from_millis(config.desktop.shutdown_timeout_ms),
                )
                .await;
                return Err(error.into());
            }
        };
        let (stop, stopped) = oneshot::channel();
        operation.stage(
            "host",
            serde_json::json!({"step":"启动本机代理并写入运行状态","backend_port":port}),
            true,
        );
        let origin = gateway.origin.clone();
        let gateway_log = log.clone();
        let gateway_task = tokio::spawn(async move {
            if let Err(error) = axum::serve(listener, gateway.router())
                .with_graceful_shutdown(async {
                    let _ = stopped.await;
                })
                .await
            {
                let _ = gateway_log.issue(&format!("本机代理异常：{error}"));
            }
        });
        let metadata = serde_json::json!({"origin": origin, "api_base_url": origin, "backend_port": port,
            "pid": std::process::id(), "backend_pid": child.id(), "backend_runtime": "rust", "data_root": data,
            "log_session_id": log.session_id, "frontend_log": log.frontend_path, "backend_log": log.backend_path});
        let services = Arc::new(Self {
            child: Mutex::new(child),
            origin,
            stop: Mutex::new(Some(stop)),
            shutdown_timeout: Duration::from_millis(config.desktop.shutdown_timeout_ms),
            captures: Mutex::new(captures),
            gateway: Mutex::new(Some(gateway_task)),
            log,
            metadata_path,
        });
        if let Err(error) = tokio::fs::write(
            &services.metadata_path,
            serde_json::to_vec_pretty(&metadata)?,
        )
        .await
        {
            services.stop().await;
            return Err(error.into());
        }
        Ok(services)
    }

    /// 通知 Rust 取消任务并退出；超时则终止后端，由 Rust Job 回收全部计算进程树。
    pub async fn stop(&self) {
        let operation = self.log.operation(
            "desktop-shutdown".into(),
            "前端·服务关闭".into(),
            false,
            true,
        );
        operation.stage(
            "host",
            serde_json::json!({"step":"请求后端停止并回收计算树"}),
            true,
        );
        if let Some(stop) = self.stop.lock().await.take() {
            let _ = stop.send(());
        }
        let mut child = self.child.lock().await;
        if let Some(mut stdin) = child.stdin.take() {
            let _ = stdin.write_all(b"shutdown\n").await;
        }
        let mut shutdown_issue = None;
        match tokio::time::timeout(self.shutdown_timeout, child.wait()).await {
            Ok(Ok(status)) if status.success() => {}
            Ok(Ok(status)) => {
                shutdown_issue = Some(format!("后端异常退出：{status}"));
                operation.remember(serde_json::json!({"outcome":format!("后端已退出：{status}")}));
            }
            result => {
                let reason = match result {
                    Ok(Err(error)) => error.to_string(),
                    Err(_) => "等待超时".to_owned(),
                    Ok(Ok(_)) => unreachable!("成功退出已在前面分支处理"),
                };
                shutdown_issue = Some(format!("后端退出等待失败，已执行强制回收：{reason}"));
                operation.stage(
                    "host",
                    serde_json::json!({"step":"强制回收后端进程","原因":reason}),
                    true,
                );
                let killed = child.kill().await;
                let waited = child.wait().await;
                operation.remember(serde_json::json!({
                    "outcome":format!("终止后端：{}；等待退出：{}",
                        killed.map(|_| "已发送终止请求".to_owned()).unwrap_or_else(|error| error.to_string()),
                        waited.map(|status| status.to_string()).unwrap_or_else(|error| error.to_string()))
                }));
            }
        }
        finish_captures(
            std::mem::take(&mut *self.captures.lock().await),
            self.shutdown_timeout,
        )
        .await;
        operation.stage(
            "host",
            serde_json::json!({"step":"排空代理与清理运行状态"}),
            true,
        );
        if let Some(task) = self.gateway.lock().await.take() {
            finish_captures(vec![task], self.shutdown_timeout).await;
        }
        if let Err(error) = tokio::fs::remove_file(&self.metadata_path).await {
            if error.kind() != std::io::ErrorKind::NotFound {
                let _ = self.log.issue(&format!("运行状态清理失败：{error}"));
            }
        }
        operation.finish(
            if shutdown_issue.is_some() {
                sat_layout_desktop::runtime_logging::Level::Warn
            } else {
                sat_layout_desktop::runtime_logging::Level::Info
            },
            "关闭流程结束",
            shutdown_issue.as_deref(),
        );
    }
}
