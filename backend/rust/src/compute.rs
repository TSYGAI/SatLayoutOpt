//! 文件说明：Rust 持有独立计算进程，按共享预算准入；微调复用导入，其余单次执行，统一校验协议和取消回收。
#[path = "compute_refinement.rs"]
mod refinement;
use crate::{
    compute_protocol::{validate_event, EventCodec},
    config::Config,
    error::{Error, Result},
    files,
    hardware_scheduling::{allocate_waiting, Demand, SchedulingPolicy, WaitingTask},
    logging::TaskDiagnostic,
    resource_budget::{system_resources, WorkerLimits, WorkerPlan},
};
use futures_util::StreamExt;
use serde_json::{json, Value};
use std::{
    collections::HashMap,
    fs,
    path::{Path, PathBuf},
    process::Stdio,
    sync::{Arc, Mutex},
    time::{Duration, Instant},
};
use tokio::{io::AsyncWriteExt, sync::mpsc};
use tokio_util::{codec::FramedRead, sync::CancellationToken};

/// 每次任务拥有独立输入/输出目录；释放时只删除本次随机创建的暂存目录。
pub struct Task {
    pub id: String,
    pub root: PathBuf,
    pub input: PathBuf,
    pub output: PathBuf,
    pub inputs: serde_json::Map<String, Value>,
    pub operation: String,
    pub cad_threads: usize,
    pub numeric_threads: usize,
    pub priority: u64,
    pub minimum_threads: usize,
    pub minimum_memory_bytes: u64,
    pub monitor: Arc<crate::runtime_logging::Operation>,
}
impl Task {
    /// 创建任务目录及带摘要 metadata 输入；调用方应在阻塞线程复制大文件。
    pub fn new(config: &Config, operation: &str, metadata: &Value) -> Result<Self> {
        let id = files::identifier();
        let logs = config.logs()?;
        let trace = crate::monitoring::current()
            .map(|value| value.id.clone())
            .unwrap_or_else(|| format!("op-{id}"));
        let monitor = logs.operation(trace, format!("后端·计算 {operation}"), false, true);
        if let Some(parent) = crate::monitoring::current() {
            monitor.set_parent(&parent);
        }
        monitor.context(json!({"task":id,"host_pid":std::process::id(),
            "model_id":metadata["model"]["id"],
            "model_name":metadata["model"]["settings"]["device_name"].as_str().or_else(|| metadata["model"]["filename"].as_str()),
            "face_id":metadata["model"]["settings"]["installation_face_id"]}));
        monitor.stage(
            "host",
            json!({"step":"准备任务输入","task":id,"operation":operation,"pid":std::process::id()}),
            true,
        );
        let root = config.directory("rust_backend", "staging_dir").join(&id);
        let input = root.join("input");
        fs::create_dir_all(&input)?;
        let profile = SchedulingPolicy::load(&config.values)?.profile(operation, metadata);
        let mut task = Self {
            id,
            input,
            output: root.join("output"),
            root,
            inputs: Default::default(),
            operation: operation.into(),
            cad_threads: crate::hardware_config::cad_threads(config, operation, metadata),
            numeric_threads: crate::hardware_config::numeric_threads(config, operation),
            priority: profile.priority,
            minimum_threads: profile.minimum_threads,
            minimum_memory_bytes: profile.minimum_memory_bytes,
            monitor,
        };
        // Python 和所有数值子进程继承本次宿主启动配置，避免保存新值后新旧预算混用。
        let mut snapshot = config.values.clone();
        snapshot["compute_engine"]["numeric_threads_per_worker"] = json!(task.numeric_threads);
        fs::write(
            task.root.join("runtime-config.toml"),
            toml::to_string(&snapshot).map_err(Error::bad)?,
        )?;
        files::write_json(&task.input.join("metadata.json"), metadata)?;
        task.inputs.insert(
            "metadata".into(),
            files::reference(&task.input, &task.input.join("metadata.json"))?,
        );
        Ok(task)
    }
    /// 启动前按已准入 CPU 限制数值线程并同步私有快照；未准入或快照读写失败时拒绝启动。
    pub fn apply_resource_plan(&mut self, plan: &WorkerPlan) -> Result<()> {
        if plan.workers == 0 || plan.cpu_slots == 0 {
            return Err(Error::bad("计算任务尚未获得 CPU 资源"));
        }
        let numeric_threads = self.numeric_threads.min(plan.cpu_slots);
        let path = self.root.join("runtime-config.toml");
        let mut snapshot: toml::Value =
            toml::from_str(&fs::read_to_string(&path)?).map_err(Error::bad)?;
        snapshot["compute_engine"]["numeric_threads_per_worker"] =
            toml::Value::Integer(numeric_threads as i64);
        fs::write(path, toml::to_string(&snapshot).map_err(Error::bad)?)?;
        self.numeric_threads = numeric_threads;
        Ok(())
    }
    /// 复制资源到隔离输入并记录摘要；资源名和路径不得重复。
    pub fn add(&mut self, name: &str, relative: &str, source: &Path) -> Result<()> {
        self.monitor.stage("host", json!({"step":"准备输入文件及摘要","task":self.id,"file":source,"resource":name,"pid":std::process::id()}), true);
        let target = files::within(&self.input, relative)?;
        if target.exists() || self.inputs.contains_key(name) {
            return Err(Error::bad("计算输入重复"));
        }
        files::copy(source, &target)?;
        self.inputs
            .insert(name.into(), files::reference(&self.input, &target)?);
        Ok(())
    }
    /// 在本任务间共享已经验证且不再修改的数值文件，避免准备到求解时再复制大数组。
    pub fn add_shared(&mut self, name: &str, relative: &str, source: &Path) -> Result<()> {
        self.monitor.stage("host", json!({"step":"准备输入文件及摘要","task":self.id,"file":source,"resource":name,"pid":std::process::id()}), true);
        let target = files::within(&self.input, relative)?;
        if target.exists() || self.inputs.contains_key(name) {
            return Err(Error::bad("计算输入重复"));
        }
        crate::prepared_cache::share(source, &target)?;
        self.inputs
            .insert(name.into(), files::reference(&self.input, &target)?);
        Ok(())
    }
    /// 输入准备完成后写入只读元数据并更新摘要；执行后不再允许调用。
    pub fn metadata(&mut self, value: &Value) -> Result<()> {
        let path = self.input.join("metadata.json");
        files::write_json(&path, value)?;
        self.inputs
            .insert("metadata".into(), files::reference(&self.input, &path)?);
        Ok(())
    }
}
impl Drop for Task {
    /// 清理任务私有暂存目录；日志位于独立日志目录中，不随任务清理。
    fn drop(&mut self) {
        let cleanup = fs::remove_dir_all(&self.root);
        self.monitor.remember(json!({"cleanup":"task_staging","path":self.root,"succeeded":cleanup.is_ok(),"error":cleanup.as_ref().err().map(ToString::to_string)}));
        self.monitor.context(json!({"outcome": if cleanup.is_ok() {
            "临时任务已清理"
        } else {
            "临时任务清理失败，需检查文件占用或权限"
        }}));
        if let Err(error) = cleanup {
            self.monitor.emit(
                crate::runtime_logging::Level::Error,
                "任务暂存清理失败",
                vec![
                    ("task", self.id.clone()),
                    ("path", self.root.display().to_string()),
                    ("原因", error.to_string()),
                ],
            );
        }
    }
}
/// 完成/取消结果与仍由宿主持有的暂存资源。
pub struct Outcome {
    pub task: Task,
    pub result: Value,
    pub cancelled: bool,
    pub candidates: Value,
}
/// 正式计算宿主；活动登记用于模型删除和应用关闭时回收。
pub struct Engine {
    config: Arc<Config>,
    active: Mutex<HashMap<String, ActiveRun>>,
    pub shutdown: CancellationToken,
    /// 已完成任务观察到的保守单进程内存峰值，供下一任务准入估算。
    observed_worker_bytes: Mutex<u64>,
    /// 只复用微调数值进程的导入，任务输入和正式结果仍完全独立。
    refinement: refinement::Pool,
}
/// 已登记的计算任务及其资源占用；用于并发任务之间的 CPU 槽位预算。
struct ActiveRun {
    /// 业务所有者标识，用于按模型或布局任务取消。
    owner: String,
    /// 任务级协作取消令牌。
    cancel: CancellationToken,
    /// 本次任务已保留的数值进程槽位。
    cpu_slots: usize,
    memory_bytes: u64,
    priority: u64,
    queued_at: Instant,
    demand: Option<Demand>,
}
/// 生命周期登记随独立宿主任务释放，避免调用方断开时遗留活动记录。
struct Registration {
    engine: Arc<Engine>,
    id: String,
}
impl Drop for Registration {
    /// 仅在进程回收及暂存收尾结束后撤销登记。
    fn drop(&mut self) {
        self.engine.active.lock().unwrap().remove(&self.id);
    }
}
impl Engine {
    /// 创建宿主，不提前启动 Python 或引入数据库写入方。
    pub fn new(config: Arc<Config>) -> Self {
        Self {
            config,
            active: Mutex::new(HashMap::new()),
            shutdown: CancellationToken::new(),
            observed_worker_bytes: Mutex::new(0),
            refinement: refinement::Pool::new(),
        }
    }
    /// 等待全局计算资源；排队登记始终可被模型删除、调用方中断和服务关闭取消。
    async fn acquire(&self, task: &Task, cancel: &CancellationToken) -> Result<WorkerPlan> {
        task.monitor.stage("host", json!({"step":"等待计算资源准入","task":task.id,"worker_pid":null,"reason":"CPU 槽位或可用内存不足时排队","host_pid":std::process::id()}), true);
        let mut limits = WorkerLimits::load(&self.config)?;
        let scheduling = SchedulingPolicy::load(&self.config.values)?;
        limits.numeric_threads = task.numeric_threads;
        // 非求解任务也可能调用数值库，准入同时覆盖 CAD 和数值线程上限。
        limits.cad_threads = task.cad_threads.max(limits.numeric_threads);
        if task.operation == "envelope.generate" {
            // 包络遵守已配置的全局预留；其上限不再作为固定准入申请量。
            limits.memory_reserve_bytes = limits.memory_reserve_bytes.max(
                self.config
                    .integer("backend", "model_envelope_memory_reserve_bytes"),
            );
        }
        let input_bytes = task
            .inputs
            .values()
            .map(|r| r["bytes"].as_u64().unwrap_or(0))
            .sum();
        let demand = Demand {
            limits,
            solve: task.operation == "layout.solve",
            input_bytes,
            observed_worker_bytes: *self.observed_worker_bytes.lock().unwrap(),
            envelope: (task.operation == "envelope.generate").then(|| {
                crate::resource_budget::EnvelopeLimits {
                    process_memory_bytes: self
                        .config
                        .integer("backend", "model_envelope_process_memory_limit_bytes"),
                    workspace_bytes: self
                        .config
                        .integer("backend", "model_envelope_workspace_memory_bytes"),
                }
            }),
            minimum_threads: task.minimum_threads,
            minimum_memory_bytes: task.minimum_memory_bytes,
        };
        self.active
            .lock()
            .unwrap()
            .get_mut(&task.id)
            .ok_or_else(|| Error::bad("计算资源登记丢失"))?
            .demand = Some(demand);
        loop {
            if cancel.is_cancelled() || self.shutdown.is_cancelled() {
                return Err(Error::conflict("任务已取消"));
            }
            let system = system_resources()?;
            task.monitor.remember(json!({"resource_wait":{"available_bytes":system.available,"total_bytes":system.total}}));
            {
                let mut active = self.active.lock().unwrap();
                let cpu = active.values().map(|r| r.cpu_slots).sum();
                let memory = active.values().map(|r| r.memory_bytes).sum();
                let running = active.values().filter(|run| run.cpu_slots > 0).count();
                let waiting = active
                    .iter()
                    .filter(|(_, run)| run.cpu_slots == 0 && !run.cancel.is_cancelled())
                    .filter_map(|(id, run)| {
                        run.demand.map(|demand| WaitingTask {
                            id,
                            priority: run.priority,
                            queued_at: run.queued_at,
                            demand,
                        })
                    })
                    .collect();
                let free_tasks = (self.config.integer("hardware", "max_concurrent_tasks") as usize)
                    .saturating_sub(running);
                let plans = allocate_waiting(
                    system,
                    (cpu, memory),
                    free_tasks,
                    waiting,
                    &scheduling,
                    Instant::now(),
                );
                if let Some(mut plan) = plans.get(&task.id).copied() {
                    plan.cad_threads = plan.cad_threads.min(task.cad_threads);
                    let run = active
                        .get_mut(&task.id)
                        .ok_or_else(|| Error::bad("计算资源登记丢失"))?;
                    run.cpu_slots = plan.cpu_slots;
                    run.memory_bytes = plan.budget_bytes;
                    return Ok(plan);
                }
            }
            tokio::select! {
                _ = cancel.cancelled() => return Err(Error::conflict("任务已取消")),
                _ = self.shutdown.cancelled() => return Err(Error::conflict("服务正在退出")),
                _ = tokio::time::sleep(Duration::from_secs_f64(self.config.number("compute_engine","poll_interval_seconds"))) => {}
            }
        }
    }
    /// 取消指定资源拥有的所有工作进程；等待由各运行任务执行。
    pub fn cancel_owner(&self, owner: &str) {
        for run in self.active.lock().unwrap().values() {
            if run.owner == owner {
                run.cancel.cancel();
            }
        }
    }
    /// 返回是否仍有某资源的在途进程。
    pub fn owner_active(&self, owner: &str) -> bool {
        self.active
            .lock()
            .unwrap()
            .values()
            .any(|run| run.owner == owner)
    }
    /// 请求全部任务停止，并在宽限期间等待进程完成清理。
    pub async fn stop(&self) {
        self.shutdown.cancel();
        while !self.active.lock().unwrap().is_empty() {
            tokio::time::sleep(Duration::from_secs_f64(
                self.config
                    .number("compute_engine", "poll_interval_seconds"),
            ))
            .await;
        }
        self.refinement.stop().await;
    }
    /// 启动单个已准备任务；监听器仅收到已验证的进度和候选，终态错误不发布资源。
    pub async fn run(
        self: &Arc<Self>,
        task: Task,
        owner: &str,
        cancel: CancellationToken,
        events: Option<mpsc::Sender<Value>>,
    ) -> Result<Outcome> {
        let cancel = cancel.child_token();
        if task.operation.starts_with("layout.") || task.operation.starts_with("history.") {
            task.monitor.context(json!({"job_id":owner}));
        }
        {
            let mut active = self.active.lock().unwrap();
            if self.shutdown.is_cancelled() || cancel.is_cancelled() {
                return Err(Error::conflict("任务已取消"));
            }
            active.insert(
                task.id.clone(),
                ActiveRun {
                    owner: owner.into(),
                    cancel: cancel.clone(),
                    cpu_slots: 0,
                    memory_bytes: 0,
                    priority: task.priority,
                    queued_at: Instant::now(),
                    demand: None,
                },
            );
        }
        let registration = Registration {
            engine: self.clone(),
            id: task.id.clone(),
        };
        let abandoned = cancel.clone().drop_guard();
        let engine = self.clone();
        // 调用者中断只发送取消；独立宿主继续读取、终止及 wait，随后才释放 Task。
        let monitor = task.monitor.clone();
        let result = tokio::spawn(crate::monitoring::scope(monitor.clone(), async move {
            let _registration = registration;
            let result = async {
                let plan = engine.acquire(&task, &cancel).await?;
                engine.run_inner(task, cancel, events, plan).await
            }
            .await;
            if let Err(error) = &result {
                monitor.remember(error.diagnostic());
            }
            match &result {
                Ok(outcome) => monitor.finish(
                    crate::runtime_logging::Level::Info,
                    if outcome.cancelled {
                        "计算已取消"
                    } else {
                        "计算完成"
                    },
                    None,
                ),
                Err(error) => monitor.finish(
                    if error.message.contains("取消") {
                        crate::runtime_logging::Level::Info
                    } else {
                        crate::runtime_logging::Level::Error
                    },
                    "计算未完成",
                    Some(&error.to_string()),
                ),
            }
            result
        }))
        .await
        .map_err(Error::bad)?;
        abandoned.disarm();
        result
    }
    /// 执行有界事件读取与独立取消截止时间；退出码和唯一终态必须一致。
    async fn run_inner(
        &self,
        mut task: Task,
        cancel: CancellationToken,
        events: Option<mpsc::Sender<Value>>,
        plan: WorkerPlan,
    ) -> Result<Outcome> {
        task.apply_resource_plan(&plan)?;
        let config = &self.config;
        if task.operation == "layout.refine"
            && config.values["compute_engine"]["refinement_worker_enabled"] == true
        {
            return self
                .refinement
                .run(config, task, cancel, &self.shutdown)
                .await;
        }
        let request = json!({"protocol_version":1,"task_id":task.id,"operation":task.operation,
            "input_root":task.input,"output_root":task.output,"inputs":task.inputs,
            "payload":if task.operation == "layout.solve" { json!({"resource_plan":plan}) } else { json!({}) },
            "workers":plan.workers});
        let request_path = task.root.join("request.json");
        files::write_json(&request_path, &request)?;
        let logs = config.logs()?;
        let diagnostic = TaskDiagnostic::new(logs.clone(), &task.id, &task.root, &task.operation);
        let mut command = config.compute_command();
        command
            .arg(&request_path)
            .current_dir(&config.root)
            .env("PYTHONUTF8", "1")
            .env("PYTHONIOENCODING", "utf-8")
            .env(
                "SAT_LAYOUT_OPT_CONFIG_SNAPSHOT",
                task.root.join("runtime-config.toml"),
            )
            .env("SAT_LAYOUT_CAD_THREADS", plan.cad_threads.to_string())
            .env(
                "SAT_LAYOUT_ENVELOPE_MEMORY_BUDGET",
                plan.budget_bytes.to_string(),
            )
            .env(
                "SAT_LAYOUT_ENVELOPE_MEMORY_RESERVE",
                plan.memory_reserve_bytes.to_string(),
            )
            .env(
                "SAT_LAYOUT_ENVELOPE_SCRATCH_ROOT",
                task.root.join("envelope-workspace"),
            )
            .env("SAT_LAYOUT_ENVELOPE_DIAGNOSTIC_PATH", &diagnostic.path)
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
        task.monitor.stage("host",json!({"step":"启动计算进程","task":task.id,"operation":task.operation,"resource_plan":plan}),true);
        let mut child = command.spawn()?;
        task.monitor.context(json!({"worker_pid":child.id()}));
        task.monitor.stage("host",json!({"step":"等待计算协议","task":task.id,"worker_pid":child.id(),"host_pid":std::process::id()}),true);
        let stderr_monitor = task.monitor.clone();
        let stderr = child.stderr.take().unwrap();
        let stderr_capture = tokio::spawn(async move {
            use tokio::io::AsyncReadExt;
            let mut stderr = stderr;
            let mut buffer = vec![0u8; 4096];
            loop {
                match stderr.read(&mut buffer).await {
                    Ok(0) => break,
                    Ok(size) => stderr_monitor
                        .remember(json!({"stderr":String::from_utf8_lossy(&buffer[..size])})),
                    Err(error) => {
                        stderr_monitor.remember(json!({"stderr_read_error":error.to_string()}));
                        break;
                    }
                }
            }
        });
        let mut control = child.stdin.take().unwrap();
        let mut frames = FramedRead::new(
            child.stdout.take().unwrap(),
            EventCodec::new(config.integer("compute_engine", "event_max_bytes") as usize),
        );
        let grace =
            Duration::from_secs_f64(config.number("compute_engine", "cancel_grace_seconds"));
        let mut cancel_sent = false;
        let mut deadline = None;
        let mut sequence = 0u64;
        let mut terminal = None;
        let mut result = Value::Null;
        let mut candidates = json!([]);
        let mut forced = false;
        let protocol_result: Result<()> = async { loop {
            tokio::select! {
                _ = async { if let Some(at) = deadline { tokio::time::sleep_until(at).await; } else { std::future::pending::<()>().await; } } => {
                    child.kill().await?; forced = true; break;
                }
                _ = async { tokio::select! { _ = cancel.cancelled() => {}, _ = self.shutdown.cancelled() => {} } }, if !cancel_sent => {
                    cancel_sent = true;
                    deadline = Some(tokio::time::Instant::now() + grace);
                    let message = format!("{}\n", json!({"protocol_version":1,"task_id":task.id,"type":"cancel"}));
                    let _ = control.write_all(message.as_bytes()).await;
                }
                line = frames.next() => {
                    let Some(line) = line else { break; };
                    let event: Value = serde_json::from_str(&line.map_err(Error::bad)?)?;
                    sequence += 1;
                    validate_event(&event, &task.id, &task.operation, sequence, terminal.is_some())?;
                    let kind = event["type"].as_str().unwrap_or("");
                    let data = &event["data"];
                    if kind == "progress" && data.get("monitor").is_some() {
                        let state = &data["monitor"];
                        let lane = state["lane"].as_str().unwrap_or("compute");
                        if state["finished"] == true { task.monitor.end_lane(lane); }
                        else { task.monitor.stage(lane, state.clone(), state["progress"] == true); }
                        continue;
                    }
                    if kind == "started" { task.monitor.stage("host",json!({"step":"计算运行","task":task.id,"worker_pid":data["pid"]}),true); }
                    if kind == "progress" || kind == "candidates" { task.monitor.remember(json!({"progress":data})); task.monitor.progress("host"); }
                    if kind == "failed" { task.monitor.remember(json!({"failure":data})); }
                    for key in ["artifact", "result", "checkpoint"] {
                        if !data[key].is_null() {
                            let root = task.output.clone(); let reference = data[key].clone();
                            let verified = crate::blocking(move || { let path = files::verify(&root, &reference)?; let v = files::read_json(&path)?; if key == "result" { for resource in v["resources"].as_array().ok_or_else(|| Error::bad("缺少结果资源清单"))? { files::verify(&root, resource)?; } } Ok::<_, Error>(v) }).await?;
                            if key == "result" { result = verified; }
                            else { candidates = verified["candidates"].clone(); if !candidates.is_array() { return Err(Error::bad("候选检查点无效")); } }
                        }
                    }
                    if kind == "candidates" && (data["artifact"].is_null() || data["count"].as_u64() != Some(candidates.as_array().unwrap().len() as u64)) { return Err(Error::bad("候选计数与检查点不符")); }
                    if kind == "completed" && result.is_null() { return Err(Error::bad("完成事件缺少结果")); }
                    if ["completed", "cancelled", "failed"].contains(&kind) { terminal = Some(event.clone()); deadline = Some(tokio::time::Instant::now() + grace); }
                    if let Some(sender) = &events {
                        if kind == "progress" || kind == "candidates" {
                            let is_candidate = kind == "candidates";
                            let mut value = event;
                            if is_candidate { value["verified_candidates"] = candidates.clone(); }
                            // 事件落盘可能暂时阻塞；通道背压不能阻止宿主处理取消截止时间。
                            tokio::select! {
                                result = sender.send(value) => { if result.is_err() { cancel.cancel(); } },
                                _ = cancel.cancelled() => {},
                                _ = self.shutdown.cancelled() => {},
                            }
                        }
                    }
                }
            }
        } Ok(()) }.await;
        if let Err(error) = protocol_result {
            // kill().await 同时等待退出，确保任何协议错误都不会提前删除进程正在使用的输入。
            child.kill().await?;
            let _ = stderr_capture.await;
            task.monitor
                .remember(json!({"forced":true,"reaped":true,"reason":"协议错误"}));
            return Err(error);
        }
        let status = match tokio::time::timeout(grace, child.wait()).await {
            Ok(value) => value?,
            Err(_) => {
                child.kill().await?;
                let _ = stderr_capture.await;
                task.monitor
                    .remember(json!({"forced":true,"reaped":true,"reason":"终态后未退出"}));
                return Err(Error::bad("计算进程终态后未退出"));
            }
        };
        let _ = stderr_capture.await;
        task.monitor.remember(json!({"process_exit":status.to_string(),"cancel_requested":cancel_sent,"forced":forced,"reaped":true}));
        let kind = terminal
            .as_ref()
            .and_then(|x| x["type"].as_str())
            .unwrap_or("failed");
        if task.operation == "envelope.generate"
            && !status.success()
            && !cancel_sent
            && terminal.is_none()
        {
            // 原生崩溃前的阶段快照先补充宿主证据，再由诊断守卫合入唯一会话日志。
            let path = &diagnostic.path;
            let mut report = files::read_json(path).unwrap_or_else(|_| json!({"operation":"envelope.generate","stage":"process_startup","software":{"compute_command":"configured"}}));
            report["status"] = json!("failed");
            report["process_exit"] = json!(status.to_string());
            report["host_resources"] = json!({"memory_budget_bytes":plan.budget_bytes,"cpu_slots":plan.cpu_slots,"memory_reserve_bytes":plan.memory_reserve_bytes});
            if let Err(error) = files::write_json(path, &report) {
                crate::logging::issue(
                    crate::runtime_logging::Level::Error,
                    format_args!("包络宿主诊断写入失败：{error}"),
                );
            }
        }
        if forced && cancel_sent {
            return Ok(Outcome {
                task,
                result,
                cancelled: true,
                candidates,
            });
        }
        let expected = match kind {
            "completed" => 0,
            "cancelled" => 2,
            _ => 1,
        };
        if kind == "failed" && status.code() == Some(1) {
            if let Some(event) = &terminal {
                return Err(
                    Error::bad(event["data"]["message"].as_str().unwrap_or("计算失败"))
                        .computation(
                            event["data"]["code"]
                                .as_str()
                                .unwrap_or("computation_failed"),
                        ),
                );
            }
        }
        if status.code() != Some(expected) || kind == "failed" {
            return Err(Error::bad(format!(
                "计算进程异常退出（{}）：{}",
                status,
                terminal
                    .as_ref()
                    .and_then(|x| x["data"]["message"].as_str())
                    .unwrap_or("未返回有效完成结果")
            )));
        }
        if let Some(peak) = result["resources_observed"]["worker_peak_bytes"].as_u64() {
            let mut observed = self.observed_worker_bytes.lock().unwrap();
            *observed = (*observed).max(peak);
        }
        Ok(Outcome {
            task,
            result,
            cancelled: kind == "cancelled" || cancel_sent,
            candidates,
        })
    }
}
