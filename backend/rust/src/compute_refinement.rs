//! 文件说明：管理单个可复用微调进程；每次仍校验完整文件协议，正常中断确认后复用进程，故障、超时、空闲或关闭时等待回收。
use super::{Outcome, Task};
use crate::{
    compute_protocol::{validate_event, EventCodec},
    config::Config,
    error::{Error, Result},
    files,
};
use futures_util::StreamExt;
use serde_json::{json, Value};
use std::{
    fs,
    path::{Path, PathBuf},
    process::Stdio,
    sync::{Arc, Mutex},
    time::Duration,
};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    process::{Child, ChildStdin, ChildStdout},
    sync::Mutex as AsyncMutex,
    task::JoinHandle,
};
use tokio_util::{codec::FramedRead, sync::CancellationToken};

/// 整个后端最多保留一个微调进程；锁覆盖一个完整请求，防止来源或协议交叉。
pub(super) struct Pool {
    slot: Arc<AsyncMutex<Option<Worker>>>,
}

impl Pool {
    /// 仅建立空槽位，首次正式校核通过资源准入后才启动进程。
    pub(super) fn new() -> Self {
        Self {
            slot: Arc::new(AsyncMutex::new(None)),
        }
    }

    /// 对已准入请求执行完整校核；完成、正常中断或合法输入错误保留进程，故障时回收并按需重建。
    pub(super) async fn run(
        &self,
        config: &Config,
        task: Task,
        cancel: CancellationToken,
        shutdown: &CancellationToken,
    ) -> Result<Outcome> {
        let mut slot = tokio::select! {
            guard = self.slot.lock() => guard,
            _ = cancel.cancelled() => return Err(Error::conflict("微调校核已取消")),
            _ = shutdown.cancelled() => return Err(Error::conflict("服务正在退出")),
        };
        if cancel.is_cancelled() || shutdown.is_cancelled() {
            return Err(Error::conflict("微调校核已取消"));
        }
        if let Some(worker) = slot.as_mut() {
            worker.idle.cancel();
            if worker.numeric_threads != task.numeric_threads || worker.child.try_wait()?.is_some()
            {
                slot.take().unwrap().stop().await;
            }
        }
        let mut worker = match slot.take() {
            Some(worker) => worker,
            None => Worker::start(config, &task)?,
        };
        *worker.monitor.lock().unwrap() = Some(task.monitor.clone());
        task.monitor
            .context(json!({"worker_pid":worker.child.id(),"reused_process":worker.used}));
        let execution = worker.execute(&task, &cancel, shutdown).await;
        let reusable = !shutdown.is_cancelled()
            && (execution.is_ok()
                || execution.as_ref().err().is_some_and(|error| {
                    error.computation_code.as_deref() == Some("invalid_input")
                }));
        *worker.monitor.lock().unwrap() = None;
        if reusable {
            worker.used = true;
            worker.idle = CancellationToken::new();
            let idle = worker.idle.clone();
            *slot = Some(worker);
            let pool = self.slot.clone();
            let duration = Duration::from_secs_f64(
                config.number("compute_engine", "refinement_worker_idle_seconds"),
            );
            // 新请求取消旧计时器，故不会在刚完成下一次任务时错误回收。
            tokio::spawn(async move {
                tokio::select! {
                    _ = idle.cancelled() => return,
                    _ = tokio::time::sleep(duration) => {},
                }
                let mut slot = pool.lock().await;
                if !idle.is_cancelled() {
                    if let Some(worker) = slot.take() {
                        worker.stop().await;
                    }
                }
            });
        } else {
            worker.stop().await;
        }
        execution.map(|result| Outcome {
            task,
            cancelled: result.is_none(),
            result: result.unwrap_or(Value::Null),
            candidates: json!([]),
        })
    }

    /// 后端关闭先等待活动任务结束，再回收空闲进程及其私有配置目录。
    pub(super) async fn stop(&self) {
        if let Some(worker) = self.slot.lock().await.take() {
            worker.stop().await;
        }
    }
}

/// 进程及其唯一控制/事件流；不缓存任务、模型、来源或结果。
struct Worker {
    root: PathBuf,
    child: Child,
    control: Option<ChildStdin>,
    frames: FramedRead<ChildStdout, EventCodec>,
    stderr: Option<JoinHandle<()>>,
    monitor: Arc<Mutex<Option<Arc<crate::runtime_logging::Operation>>>>,
    numeric_threads: usize,
    idle: CancellationToken,
    grace: Duration,
    used: bool,
}

impl Worker {
    /// 复制本次已准入配置到进程专属根，开发和安装版均复用现有计算入口与指定解释器。
    fn start(config: &Config, task: &Task) -> Result<Self> {
        let logs = config.logs()?;
        let root = config
            .directory("rust_backend", "staging_dir")
            .join(format!("refinement-worker-{}", files::identifier()));
        fs::create_dir_all(&root)?;
        let startup = (|| {
            fs::copy(
                task.root.join("runtime-config.toml"),
                root.join("runtime-config.toml"),
            )?;
            let mut command = config.compute_command();
            command
                .arg("--refinement-worker")
                .current_dir(&config.root)
                .env("PYTHONUTF8", "1")
                .env("PYTHONIOENCODING", "utf-8")
                .env(
                    "SAT_LAYOUT_OPT_CONFIG_SNAPSHOT",
                    root.join("runtime-config.toml"),
                )
                .stdin(Stdio::piped())
                .stdout(Stdio::piped())
                .stderr(Stdio::piped())
                .kill_on_drop(true);
            for key in [
                "OPENBLAS_NUM_THREADS",
                "OMP_NUM_THREADS",
                "MKL_NUM_THREADS",
                "NUMEXPR_NUM_THREADS",
                "VECLIB_MAXIMUM_THREADS",
            ] {
                command.env(key, task.numeric_threads.to_string());
            }
            #[cfg(windows)]
            command.creation_flags(0x08000000);
            task.monitor.stage(
                "host",
                json!({"step":"启动微调复用进程","task":task.id}),
                true,
            );
            let mut child = command.spawn()?;
            let monitor: Arc<Mutex<Option<Arc<crate::runtime_logging::Operation>>>> =
                Arc::new(Mutex::new(None));
            let stderr_monitor = monitor.clone();
            let mut stderr = child.stderr.take().unwrap();
            let stderr = tokio::spawn(async move {
                let mut buffer = vec![0u8; 4096];
                loop {
                    match stderr.read(&mut buffer).await {
                        Ok(0) => break,
                        Ok(size) => {
                            let current = stderr_monitor.lock().unwrap().clone();
                            let text = String::from_utf8_lossy(&buffer[..size]);
                            if let Some(current) = current {
                                current.remember(json!({"stderr":text}));
                            } else {
                                let _ = logs.write(format_args!("微调计算进程：{text}"));
                            }
                        }
                        Err(error) => {
                            let _ = logs.write(format_args!("微调 stderr 读取失败：{error}"));
                            break;
                        }
                    }
                }
            });
            Ok(Self {
                root: root.clone(),
                control: child.stdin.take(),
                frames: FramedRead::new(
                    child.stdout.take().unwrap(),
                    EventCodec::new(config.integer("compute_engine", "event_max_bytes") as usize),
                ),
                child,
                stderr: Some(stderr),
                monitor,
                numeric_threads: task.numeric_threads,
                idle: CancellationToken::new(),
                grace: Duration::from_secs_f64(
                    config.number("compute_engine", "cancel_grace_seconds"),
                ),
                used: false,
            })
        })();
        if startup.is_err() {
            let _ = fs::remove_dir_all(&root);
        }
        startup
    }

    /// 核对身份、序号和全部结果资源；None 表示已确认中断并清理本次任务，超时则回收进程。
    async fn execute(
        &mut self,
        task: &Task,
        cancel: &CancellationToken,
        shutdown: &CancellationToken,
    ) -> Result<Option<Value>> {
        let path = task.root.join("request.json");
        files::write_json(
            &path,
            &json!({"protocol_version":1,"task_id":task.id,"operation":task.operation,
            "input_root":task.input,"output_root":task.output,"inputs":task.inputs,"payload":{},"workers":1}),
        )?;
        let command =
            json!({"protocol_version":1,"type":"execute","task_id":task.id,"request_path":path});
        let control = self
            .control
            .as_mut()
            .ok_or_else(|| Error::bad("微调控制管道已关闭"))?;
        control.write_all(format!("{command}\n").as_bytes()).await?;
        control.flush().await?;
        task.monitor.stage("host", json!({"step":"微调完整校核","task":task.id,"worker_pid":self.child.id(),"reused_process":self.used}), true);
        let mut sequence = 0;
        let mut cancel_sent = false;
        let mut deadline = None;
        loop {
            let line = tokio::select! {
                line = self.frames.next() => line.ok_or_else(|| Error::bad("微调计算进程提前退出"))?,
                _ = async { tokio::select! { _ = cancel.cancelled() => {}, _ = shutdown.cancelled() => {} } }, if !cancel_sent => {
                    cancel_sent = true;
                    deadline = Some(tokio::time::Instant::now() + self.grace);
                    let command = json!({"protocol_version":1,"task_id":task.id,"type":"cancel"});
                    let _ = control.write_all(format!("{command}\n").as_bytes()).await;
                    continue;
                }
                _ = async { if let Some(at) = deadline { tokio::time::sleep_until(at).await; } else { std::future::pending::<()>().await; } } => {
                    return Err(Error::conflict("微调校核取消超时"));
                }
            };
            let event: Value = serde_json::from_str(&line.map_err(Error::bad)?)?;
            sequence += 1;
            validate_event(&event, &task.id, "layout.refine", sequence, false)?;
            let kind = event["type"].as_str().unwrap();
            let data = &event["data"];
            match kind {
                "started" => task.monitor.context(json!({"worker_pid":data["pid"]})),
                "progress" => {
                    if let Some(state) = data.get("monitor") {
                        let lane = state["lane"].as_str().unwrap_or("compute");
                        if state["finished"] == true {
                            task.monitor.end_lane(lane);
                        } else {
                            task.monitor
                                .stage(lane, state.clone(), state["progress"] == true);
                        }
                    } else {
                        task.monitor.remember(json!({"progress":data}));
                    }
                    task.monitor.progress("host");
                }
                "completed" => {
                    if cancel_sent || cancel.is_cancelled() || shutdown.is_cancelled() {
                        return Ok(None);
                    }
                    let root = task.output.clone();
                    let reference = data["result"].clone();
                    return crate::blocking(move || verified_result(&root, &reference)).await.map(Some);
                }
                "failed" => {
                    task.monitor.remember(json!({"failure":data}));
                    return Err(
                        Error::bad(data["message"].as_str().unwrap_or("微调计算失败"))
                            .computation(data["code"].as_str().unwrap_or("computation_failed")),
                    );
                }
                "cancelled" if cancel_sent || cancel.is_cancelled() => return Ok(None),
                _ => return Err(Error::bad("微调进程返回不支持的检查点事件")),
            }
        }
    }

    /// 关闭宿主输入并等待退出；超过宽限强制结束，只有进程退出后才删除专属配置。
    async fn stop(mut self) {
        self.idle.cancel();
        drop(self.control.take());
        if !matches!(
            tokio::time::timeout(self.grace, self.child.wait()).await,
            Ok(Ok(_))
        ) {
            let _ = self.child.kill().await;
        }
        if let Some(stderr) = self.stderr.take() {
            let _ = stderr.await;
        }
    }
}

impl Drop for Worker {
    /// 异常展开时兜底终止进程；正常路径已等待退出，目录仅为本模块生成的私有配置根。
    fn drop(&mut self) {
        self.idle.cancel();
        let _ = self.child.start_kill();
        if let Err(error) = fs::remove_dir_all(&self.root) {
            crate::logging::issue(
                crate::runtime_logging::Level::Error,
                format_args!("微调进程目录清理失败：{error}"),
            );
        }
    }
}

/// 宿主重新校验终态结果和所有声明资源，不因使用复用进程而放松文件边界或摘要。
fn verified_result(root: &Path, reference: &Value) -> Result<Value> {
    let path = files::verify(root, reference)?;
    let result = files::read_json(&path)?;
    for resource in result["resources"]
        .as_array()
        .ok_or_else(|| Error::bad("缺少结果资源清单"))?
    {
        files::verify(root, resource)?;
    }
    Ok(result)
}
