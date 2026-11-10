//! 文件说明：前后端共用的日志基础设施，仅依赖通用序列化与时间库，不包含业务逻辑。
//! 有界单写队列、独立宿主监测线程和阶段状态保留排障证据，失败摘要仅显示具体业务步骤。

use chrono::{Local, SecondsFormat};
use serde::Deserialize;
use serde_json::{json, Value};
use std::{
    collections::{HashMap, VecDeque},
    fs::File,
    io::{self, Write},
    sync::{
        atomic::{AtomicUsize, Ordering},
        mpsc, Arc, Mutex, Weak,
    },
    thread,
    time::{Duration, Instant},
};

/// 由唯一 TOML 提供的日志策略；两端使用同一阈值和内存界限。
#[derive(Clone, Deserialize)]
pub struct Policy {
    pub queue_capacity: usize,
    pub recent_capacity: usize,
    pub field_max_chars: usize,
    pub stack_frame_limit: usize,
    pub watchdog_interval_ms: u64,
    pub slow_request_ms: u64,
    pub slow_step_ms: u64,
    pub slow_compute_ms: u64,
    pub stalled_ms: u64,
    pub repeat_ms: u64,
    pub telemetry_max_bytes: usize,
    pub telemetry_batch_size: usize,
    pub frontend_flush_ms: u64,
}

impl Policy {
    /// 校验内存和计时边界；错误配置不能产生无界队列或忙循环。
    pub fn validate(&self) -> io::Result<()> {
        if self.queue_capacity == 0
            || self.queue_capacity > 65536
            || self.recent_capacity == 0
            || self.recent_capacity > 1024
            || self.field_max_chars < 256
            || self.field_max_chars > 65536
            || self.stack_frame_limit == 0
            || self.stack_frame_limit > 32
            || self.watchdog_interval_ms == 0
            || self.slow_request_ms == 0
            || self.slow_step_ms == 0
            || self.slow_compute_ms == 0
            || self.stalled_ms == 0
            || self.repeat_ms == 0
            || self.telemetry_batch_size == 0
            || self.telemetry_batch_size > 256
            || self.telemetry_max_bytes < 1024
            || self.telemetry_max_bytes > 1048576
            || self.frontend_flush_ms == 0
        {
            return Err(io::Error::other("logging 配置超出安全边界"));
        }
        Ok(())
    }
}

/// 日志只有三个默认级别；详细内部过程保存在操作状态中。
#[derive(Clone, Copy)]
pub enum Level {
    Info,
    Warn,
    Error,
}
impl Level {
    /// 返回稳定英文级别，供文本检索。
    fn name(self) -> &'static str {
        match self {
            Self::Info => "INFO",
            Self::Warn => "WARN",
            Self::Error => "ERROR",
        }
    }
}

/// 单文件异步写入器；业务只做 try_send，退出显式排空并报告写入故障。
pub struct Writer {
    sender: Mutex<Option<mpsc::SyncSender<String>>>,
    worker: Mutex<Option<thread::JoinHandle<()>>>,
    dropped: Arc<AtomicUsize>,
    failure: Arc<Mutex<Option<String>>>,
    max_chars: usize,
    stack_frame_limit: usize,
}
impl Writer {
    /// 为已原子占号的文件启动唯一写线程。
    pub fn new(mut file: File, policy: &Policy) -> io::Result<Arc<Self>> {
        policy.validate()?;
        let (sender, receiver) = mpsc::sync_channel::<String>(policy.queue_capacity);
        let dropped = Arc::new(AtomicUsize::new(0));
        let failure = Arc::new(Mutex::new(None));
        let lost = dropped.clone();
        let failed = failure.clone();
        let worker = thread::Builder::new()
            .name("session-log-writer".into())
            .spawn(move || {
                for line in receiver {
                    let count = lost.swap(0, Ordering::Relaxed);
                    let result = (|| -> io::Result<()> {
                        if count > 0 {
                            writeln!(
                                file,
                                "{} WARN [日志·写入] 队列已满，丢弃 {count} 条记录",
                                timestamp()
                            )?;
                        }
                        file.write_all(line.as_bytes())?;
                        file.flush()
                    })();
                    if let Err(error) = result {
                        let mut stored = failed.lock().unwrap_or_else(|e| e.into_inner());
                        if stored.is_none() {
                            eprintln!("日志写入失败：{error}");
                            *stored = Some(error.to_string());
                        }
                    }
                }
                let count = lost.swap(0, Ordering::Relaxed);
                if count > 0 {
                    let _ = writeln!(
                        file,
                        "{} WARN [日志·关闭] 队列已满，丢弃 {count} 条记录",
                        timestamp()
                    );
                }
                if let Err(error) = file.flush() {
                    *failed.lock().unwrap_or_else(|e| e.into_inner()) = Some(error.to_string());
                }
            })?;
        Ok(Arc::new(Self {
            sender: Mutex::new(Some(sender)),
            worker: Mutex::new(Some(worker)),
            dropped,
            failure,
            max_chars: policy.field_max_chars,
            stack_frame_limit: policy.stack_frame_limit,
        }))
    }
    /// 成功记录保持一行，异常仅展开允许的中文字段；续行缩进避免伪造独立日志。
    pub fn event(
        &self,
        level: Level,
        module: &str,
        message: &str,
        fields: &[(&str, String)],
    ) -> io::Result<()> {
        let mut line = format!(
            "{} {} [{}] {}",
            timestamp(),
            level.name(),
            clean(&module_label(module), self.max_chars),
            clean(message, self.max_chars)
        );
        let fields: Vec<_> = display_fields(fields)
            .into_iter()
            .filter_map(|(key, value)| {
                if key != "异常堆栈" {
                    return Some((key, value));
                }
                let frames = stack_frames(&value);
                let excerpt =
                    frames[frames.len().saturating_sub(self.stack_frame_limit)..].join("\n");
                (!excerpt.is_empty()).then_some((key, excerpt))
            })
            .collect();
        if matches!(level, Level::Info)
            || fields
                .iter()
                .all(|(key, _)| matches!(*key, "耗时" | "客户端耗时"))
        {
            if let Some((key, value)) = fields
                .iter()
                .find(|(key, _)| matches!(*key, "耗时" | "客户端耗时"))
            {
                line.push_str(&format!("，{key} {}", clean(value, self.max_chars)));
            }
        } else {
            for (key, value) in fields {
                line.push_str(&format!("\n  {key}："));
                if key == "异常堆栈" {
                    let value: String = value.chars().take(self.max_chars).collect();
                    line.push_str(&value.replace('\r', "").replace('\n', "\n    "));
                } else {
                    line.push_str(&clean(&value, self.max_chars));
                }
            }
        }
        line.push('\n');
        if let Some(error) = self
            .failure
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .as_ref()
        {
            return Err(io::Error::other(error.clone()));
        }
        let guard = self.sender.lock().unwrap_or_else(|e| e.into_inner());
        let sender = guard
            .as_ref()
            .ok_or_else(|| io::Error::other("日志会话已经关闭"))?;
        match sender.try_send(line) {
            Ok(()) => Ok(()),
            Err(mpsc::TrySendError::Full(_)) => {
                self.dropped.fetch_add(1, Ordering::Relaxed);
                Ok(())
            }
            Err(mpsc::TrySendError::Disconnected(_)) => Err(io::Error::other("日志写线程已退出")),
        }
    }
    /// 关闭发送端并排空所有已接受的记录；仅供进程退出路径使用。
    pub fn finish(&self) -> io::Result<()> {
        self.sender.lock().unwrap_or_else(|e| e.into_inner()).take();
        if let Some(worker) = self.worker.lock().unwrap_or_else(|e| e.into_inner()).take() {
            worker
                .join()
                .map_err(|_| io::Error::other("日志写线程异常退出"))?;
        }
        match self
            .failure
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .as_ref()
        {
            Some(error) => Err(io::Error::other(error.clone())),
            None => Ok(()),
        }
    }
}
impl Drop for Writer {
    /// 非显式退出也排空日志；异常仅向 stderr 报告，不触发二次 panic。
    fn drop(&mut self) {
        if let Err(error) = self.finish() {
            eprintln!("日志关闭失败：{error}");
        }
    }
}

/// 单个执行者状态；心跳与有意义的进度分开，不把进程存活当作业务前进。
struct StepState {
    details: Value,
    started: Instant,
    progress: Instant,
    last_warning: Option<Instant>,
}
/// 仅保留一份最慢业务步骤摘要，避免收尾阶段或有限历史淘汰真正的耗时位置。
#[derive(Clone)]
struct SlowStep {
    details: Value,
    elapsed_ms: u64,
    specificity: u8,
}
impl SlowStep {
    /// 具体计算、排队和初始化步骤优先于包装边界，避免外层总耗时覆盖真实等待。
    fn capture(lane: &str, step: &StepState) -> Self {
        let mut details = step.details.clone();
        if let Some(fields) = details.as_object_mut() {
            fields.insert("lane".into(), json!(lane));
        }
        Self {
            details,
            elapsed_ms: step.started.elapsed().as_millis() as u64,
            specificity: if lane == "host"
                && matches!(
                    step.details["step"].as_str(),
                    Some("接收操作" | "处理请求" | "传输响应" | "计算运行")
                ) {
                0
            } else if lane.starts_with("rust-") {
                1
            } else {
                2
            },
        }
    }
    /// 同类步骤比较真实耗时，保留更具体的计算步骤而非包含它的外层总时间。
    fn retain(self, slot: &mut Option<Self>) {
        if slot.as_ref().is_none_or(|old| {
            (self.specificity, self.elapsed_ms) > (old.specificity, old.elapsed_ms)
        }) {
            *slot = Some(self);
        }
    }
}
/// 同一子错误的原因与步骤摘要，供父操作精简记录时保留真正出错的步骤。
struct ChildFailure {
    reason: String,
    summary: String,
}
/// 一个操作的所有并行阶段及有限历史，互斥期间不执行文件 I/O。
struct State {
    steps: HashMap<String, StepState>,
    recent: VecDeque<Value>,
    closed: bool,
    diagnosed: bool,
    identity: Value,
    child_failure: Option<ChildFailure>,
    slowest: Option<SlowStep>,
}
/// 贯穿异步任务的操作对象，worker 以独立键保存，互不覆盖。
pub struct Operation {
    pub id: String,
    pub name: String,
    writer: Arc<Writer>,
    policy: Policy,
    started: Instant,
    state: Mutex<State>,
    quiet: bool,
    slow_ms: u64,
    parent: Mutex<Option<Weak<Operation>>>,
    active_children: AtomicUsize,
}
impl Operation {
    /// 仅在实际收到数据或完成工作时更新时间；心跳不得调用。
    pub fn progress(&self, lane: &str) {
        let mut state = self.state.lock().unwrap_or_else(|e| e.into_inner());
        let now = Instant::now();
        for (key, step) in &mut state.steps {
            if key == lane || key == "host" || key.starts_with("rust-") {
                step.progress = now;
            }
        }
        drop(state);
        if let Some(parent) = self
            .parent
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .as_ref()
            .and_then(Weak::upgrade)
        {
            parent.progress("host");
        }
    }
    /// 创建操作并由独立 OS 线程观察；不依赖 Tokio 或 Python 的事件循环。
    pub fn new(
        writer: Arc<Writer>,
        policy: Policy,
        id: String,
        name: String,
        quiet: bool,
        long: bool,
    ) -> Arc<Self> {
        let now = Instant::now();
        let operation = Arc::new(Self {
            id,
            name,
            writer,
            slow_ms: if long {
                policy.slow_compute_ms
            } else {
                policy.slow_request_ms
            },
            policy,
            started: now,
            state: Mutex::new(State {
                steps: HashMap::new(),
                recent: VecDeque::new(),
                closed: false,
                diagnosed: false,
                identity: json!({}),
                child_failure: None,
                slowest: None,
            }),
            quiet,
            parent: Mutex::new(None),
            active_children: AtomicUsize::new(0),
        });
        operation.stage(
            "host",
            json!({"step":"接收操作", "pid":std::process::id()}),
            true,
        );
        operation
    }
    /// 更新某个执行者的阶段；同一状态的心跳不会重置无进展时间。
    pub fn stage(&self, lane: &str, details: Value, progress: bool) {
        if progress {
            self.progress(lane);
        }
        let details = bounded(details, self.policy.field_max_chars);
        let mut state = self.state.lock().unwrap_or_else(|e| e.into_inner());
        if state.closed {
            return;
        }
        if !state.steps.contains_key(lane) && state.steps.len() >= self.policy.queue_capacity {
            if !state.diagnosed {
                state.diagnosed = true;
                self.emit(
                    Level::Warn,
                    "活动步骤超过监测容量",
                    vec![("执行者", lane.to_owned())],
                );
            }
            return;
        }
        let now = Instant::now();
        if let Some(step) = state.steps.get_mut(lane) {
            if step.details == details {
                if progress {
                    step.progress = now;
                }
                return;
            }
        }
        if let Some(previous) = state.steps.remove(lane) {
            self.completed_step(lane, &previous);
            SlowStep::capture(lane, &previous).retain(&mut state.slowest);
            state.recent.push_back(json!({"lane":lane,"state":previous.details,"elapsed_ms":previous.started.elapsed().as_millis()}));
            while state.recent.len() > self.policy.recent_capacity {
                state.recent.pop_front();
            }
        }
        state.steps.insert(
            lane.to_owned(),
            StepState {
                details,
                started: now,
                progress: now,
                last_warning: None,
            },
        );
    }
    /// 已结束 worker 从活动表移除，最后状态保留在有限历史中。
    pub fn end_lane(&self, lane: &str) {
        self.progress(lane);
        let mut state = self.state.lock().unwrap_or_else(|e| e.into_inner());
        if let Some(step) = state.steps.remove(lane) {
            self.completed_step(lane, &step);
            SlowStep::capture(lane, &step).retain(&mut state.slowest);
            state.recent.push_back(json!({"lane":lane,"state":step.details,"elapsed_ms":step.started.elapsed().as_millis()}));
            while state.recent.len() > self.policy.recent_capacity {
                state.recent.pop_front();
            }
        }
    }
    /// 添加异常前上下文，不直接落盘；容量受集中配置限制。
    pub fn remember(&self, value: Value) {
        let mut state = self.state.lock().unwrap_or_else(|e| e.into_inner());
        state
            .recent
            .push_back(bounded(value, self.policy.field_max_chars));
        while state.recent.len() > self.policy.recent_capacity {
            state.recent.pop_front();
        }
    }
    /// 保留操作固定身份，子步骤变化后任务/模型仍可从终态和警告中定位。
    pub fn context(&self, value: Value) {
        let mut state = self.state.lock().unwrap_or_else(|e| e.into_inner());
        if let (Some(current), Some(fields)) = (state.identity.as_object_mut(), value.as_object()) {
            for (key, value) in fields {
                current.insert(
                    key.clone(),
                    bounded(value.clone(), self.policy.field_max_chars),
                );
            }
        }
    }
    /// 在错误产生时冻结最深业务步骤和耗时，避免栈展开或响应传输覆盖出错位置。
    pub fn failure_context(&self) -> Value {
        let state = self.state.lock().unwrap_or_else(|e| e.into_inner());
        state.steps.iter().max_by_key(|(lane, step)| (
            (!lane.starts_with("rust-") && *lane != "host") as u8,
            step.started,
        )).map(|(_, step)| json!({"state":step.details, "elapsed_ms":step.started.elapsed().as_millis() as u64}))
            .unwrap_or(Value::Null)
    }
    /// 子任务向父操作报告真实进展，不延长父对象生命，也不影响其他并行 worker。
    pub fn set_parent(&self, parent: &Arc<Operation>) {
        let mut current = self.parent.lock().unwrap_or_else(|e| e.into_inner());
        if current.is_none() {
            parent.active_children.fetch_add(1, Ordering::Relaxed);
        }
        *current = Some(Arc::downgrade(parent));
    }
    /// 独立监测慢步骤与停滞；只展开当前业务阶段，内部嵌套步骤继续留在内存中。
    pub fn check(&self) {
        if self.active_children.load(Ordering::Relaxed) > 0 {
            return;
        }
        let mut state = self.state.lock().unwrap_or_else(|e| e.into_inner());
        if state.closed {
            return;
        }
        let now = Instant::now();
        let has_workers = state
            .steps
            .keys()
            .any(|lane| lane != "host" && !lane.starts_with("rust-"));
        let latest_internal = state
            .steps
            .iter()
            .filter(|(lane, _)| lane.starts_with("rust-"))
            .max_by_key(|(_, step)| step.started)
            .map(|(lane, _)| lane.clone());
        let identity = state.identity.clone();
        let recent = state.recent.clone();
        for (lane, step) in &mut state.steps {
            if (has_workers && (lane == "host" || lane.starts_with("rust-")))
                || (!has_workers
                    && latest_internal.is_some()
                    && latest_internal.as_ref() != Some(lane))
            {
                continue;
            }
            let elapsed = step.started.elapsed().as_millis() as u64;
            let idle = step.progress.elapsed().as_millis() as u64;
            let slow = if lane == "host" {
                self.slow_ms
            } else {
                self.policy.slow_step_ms
            };
            if (elapsed >= slow || idle >= self.policy.stalled_ms)
                && step
                    .last_warning
                    .is_none_or(|last| last.elapsed().as_millis() >= self.policy.repeat_ms as u128)
            {
                step.last_warning = Some(now);
                let reason = if idle >= self.policy.stalled_ms {
                    "当前阶段持续未报告进展，尚未确认死锁"
                } else {
                    "当前阶段耗时超过预警阈值"
                };
                let mut fields = diagnostic_fields(
                    &identity,
                    &recent,
                    Some((&step.details, elapsed)),
                    Some(reason),
                    false,
                );
                if idle >= self.policy.stalled_ms {
                    fields.push(("无进展时长", format!("{idle} ms")));
                }
                self.emit(
                    Level::Warn,
                    if idle >= self.policy.stalled_ms {
                        "疑似停滞"
                    } else {
                        "执行变慢"
                    },
                    fields,
                );
            }
        }
    }
    /// 记录宿主终态；成功只保留一行结果和耗时，失败选取业务上下文而不输出内部轨迹。
    pub fn finish(&self, level: Level, result: &str, reason: Option<&str>) {
        self.finish_inner(
            level,
            result,
            reason,
            self.started.elapsed().as_millis() as u64,
            "耗时",
        );
    }
    /// 使用前端实测耗时记录终态，宿主接收延迟不得替代用户实际等待时间。
    pub fn finish_client(&self, level: Level, result: &str, reason: Option<&str>, elapsed_ms: u64) {
        self.finish_inner(level, result, reason, elapsed_ms, "客户端耗时");
    }
    /// 汇总一次终态；异常位置和堆栈仅在失败展开，慢完成不重复倾倒所有步骤。
    fn finish_inner(
        &self,
        level: Level,
        result: &str,
        reason: Option<&str>,
        elapsed_ms: u64,
        duration_label: &'static str,
    ) {
        let mut state = self.state.lock().unwrap_or_else(|e| e.into_inner());
        if state.closed {
            return;
        }
        state.closed = true;
        let mut slowest = state.slowest.clone();
        for (lane, step) in &state.steps {
            SlowStep::capture(lane, step).retain(&mut slowest);
        }
        if let Some(parent) = self
            .parent
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .as_ref()
            .and_then(Weak::upgrade)
        {
            if let Some(mut summary) = slowest.clone() {
                if let (Some(details), Some(identity)) =
                    (summary.details.as_object_mut(), state.identity.as_object())
                {
                    for (key, value) in identity {
                        details.entry(key.clone()).or_insert_with(|| value.clone());
                    }
                }
                summary.retain(
                    &mut parent
                        .state
                        .lock()
                        .unwrap_or_else(|e| e.into_inner())
                        .slowest,
                );
            }
            parent.active_children.fetch_sub(1, Ordering::Relaxed);
        }
        let failed =
            matches!(level, Level::Error) || result.contains("失败") || result.contains("未完成");
        let slow =
            elapsed_ms >= self.slow_ms && !result.contains("取消") && !result.contains("中断");
        let level = if (matches!(level, Level::Info) && slow)
            || (failed
                && matches!(level, Level::Error)
                && business_failure(&state.identity, &state.recent))
        {
            Level::Warn
        } else {
            level
        };
        let child_failure = state
            .child_failure
            .as_ref()
            .filter(|failure| failed && reason.is_some_and(|reason| reason == failure.reason));
        let child_diagnosed = child_failure.is_some();
        let failure = failed
            .then(|| {
                state.recent.iter().rev().find_map(|value| {
                    let context = value.get("context")?;
                    Some((context.get("state")?, context["elapsed_ms"].as_u64()?))
                })
            })
            .flatten();
        let current = if failure.is_some() {
            failure
        } else if slow && !failed {
            slowest
                .as_ref()
                .map(|step| (&step.details, step.elapsed_ms))
        } else {
            state
                .steps
                .iter()
                .max_by_key(|(lane, step)| {
                    (
                        (!lane.starts_with("rust-") && *lane != "host") as u8,
                        step.started,
                    )
                })
                .map(|(_, step)| (&step.details, step.started.elapsed().as_millis() as u64))
        };
        let summary = if failed {
            failure_summary(
                &self.name,
                result,
                current.map(|(details, _)| details),
                child_failure.map(|failure| failure.summary.as_str()),
            )
        } else {
            result.to_owned()
        };
        let mut fields = if matches!(level, Level::Warn | Level::Error) && !child_diagnosed {
            let reason = if slow && !failed {
                Some("操作已完成，但耗时超过预警阈值")
            } else {
                reason
            };
            let mut details =
                diagnostic_fields(&state.identity, &state.recent, current, reason, failed);
            if slow && !failed {
                for (label, _) in &mut details {
                    if *label == "当前步骤耗时" {
                        *label = "最慢步骤耗时";
                    }
                }
            }
            details
        } else {
            vec![]
        };
        fields.push((duration_label, format!("{elapsed_ms} ms")));
        if !self.quiet || !matches!(level, Level::Info) || slow {
            if child_diagnosed {
                let _ = self.writer.event(level, &self.name, &summary, &fields);
            } else {
                self.emit(level, &summary, fields);
            }
        }
        // 仅同一失败原因允许上层去重；慢告警或已恢复的子错误不能掩盖之后的新错误。
        if failed {
            if let Some(reason) = reason {
                let mut parent = self
                    .parent
                    .lock()
                    .unwrap_or_else(|e| e.into_inner())
                    .as_ref()
                    .and_then(Weak::upgrade);
                while let Some(operation) = parent {
                    operation
                        .state
                        .lock()
                        .unwrap_or_else(|e| e.into_inner())
                        .child_failure = Some(ChildFailure {
                        reason: clean(reason, self.policy.field_max_chars),
                        summary: summary.clone(),
                    });
                    parent = operation
                        .parent
                        .lock()
                        .unwrap_or_else(|e| e.into_inner())
                        .as_ref()
                        .and_then(Weak::upgrade);
                }
            }
        }
    }
    /// 捕捉监测间隔之间结束的慢计算步骤；Rust 内部函数退出不单独生成告警。
    fn completed_step(&self, lane: &str, step: &StepState) {
        if lane == "host" || lane.starts_with("rust-") {
            return;
        }
        let elapsed = step.started.elapsed().as_millis() as u64;
        if step.last_warning.is_none() && elapsed >= self.policy.slow_step_ms {
            let fields = diagnostic_fields(
                &json!({}),
                &VecDeque::new(),
                Some((&step.details, elapsed)),
                Some("当前阶段已完成，但耗时超过预警阈值"),
                false,
            );
            self.emit(Level::Warn, "慢步骤完成", fields);
        }
    }
    /// 输出稳定的跨进程操作编号；编号仅用于异常关联，成功记录保持一行。
    pub fn emit(&self, level: Level, message: &str, mut fields: Vec<(&str, String)>) {
        fields.insert(0, ("操作", self.id.clone()));
        if let Err(error) = self.writer.event(level, &self.name, message, &fields) {
            eprintln!("日志写入失败：{error}");
        }
    }
}
impl Drop for Operation {
    /// 未到终态便释放时记录中断，不能误报成功。
    fn drop(&mut self) {
        self.finish(Level::Info, "操作中断/调用方已取消", None);
    }
}

/// 每个宿主只建立一个监测线程；登记弱引用，不延长操作生命周期。
pub struct Registry {
    operations: Mutex<Vec<Weak<Operation>>>,
    capacity: usize,
}
impl Registry {
    /// 启动一个独立监测线程，宿主释放登记表后自动退出。
    pub fn new(policy: &Policy) -> io::Result<Arc<Self>> {
        let registry = Arc::new(Self {
            operations: Mutex::new(Vec::new()),
            capacity: policy.queue_capacity,
        });
        let weak = Arc::downgrade(&registry);
        let interval = Duration::from_millis(policy.watchdog_interval_ms);
        thread::Builder::new()
            .name("operation-watchdog".into())
            .spawn(move || loop {
                thread::sleep(interval);
                let Some(registry) = weak.upgrade() else {
                    return;
                };
                let operations = {
                    let mut values = registry
                        .operations
                        .lock()
                        .unwrap_or_else(|e| e.into_inner());
                    values.retain(|value| value.strong_count() > 0);
                    values.iter().filter_map(Weak::upgrade).collect::<Vec<_>>()
                };
                for operation in operations {
                    operation.check();
                }
            })?;
        Ok(registry)
    }
    /// 登记一个独立操作，包括异步请求、计算进程或 WebView 操作。
    pub fn register(&self, operation: &Arc<Operation>) {
        let mut values = self.operations.lock().unwrap_or_else(|e| e.into_inner());
        values.retain(|value| value.strong_count() > 0);
        if values.len() < self.capacity {
            values.push(Arc::downgrade(operation));
        } else {
            operation.emit(
                Level::Warn,
                "监测容量已满，本操作仅保留终态与内存轨迹",
                vec![],
            );
        }
    }
    /// 会话关闭前终止剩余监测，防止 watchdog 在文件关闭后继续追加。
    pub fn finish_all(&self) {
        let operations =
            std::mem::take(&mut *self.operations.lock().unwrap_or_else(|e| e.into_inner()));
        for operation in operations
            .into_iter()
            .filter_map(|operation| operation.upgrade())
        {
            operation.finish(Level::Info, "会话关闭，未返回终态的操作已中断", None);
        }
    }
}

/// 将业务上下文收敛到人工排障所需字段，内部步骤列表、资源计划和完整路径不进入正文。
fn diagnostic_fields(
    identity: &Value,
    recent: &VecDeque<Value>,
    current: Option<(&Value, u64)>,
    reason: Option<&str>,
    failed: bool,
) -> Vec<(&'static str, String)> {
    let mut fields = Vec::new();
    let mut sources = vec![identity];
    if let Some((details, _)) = current {
        sources.insert(0, details);
    }
    sources.extend(recent.iter().rev());
    for (label, keys) in [
        ("优化任务", &["job_id", "job", "优化任务"][..]),
        (
            "安装面",
            &["installation_face_id", "face_id", "face", "安装面"][..],
        ),
    ] {
        if let Some(value) = find_sources(&sources, keys) {
            fields.push((label, value));
        }
    }
    let same_model = current.is_some_and(|(value, _)| {
        !value["model_id"].is_null() && value["model_id"] == identity["model_id"]
    });
    let model = if same_model {
        model_identity(identity, 0)
    } else {
        None
    }
    .or_else(|| sources.iter().find_map(|source| model_identity(source, 0)));
    if let Some(model) = model {
        fields.push(("模型", model));
    }
    let compute_pid = current
        .and_then(|(value, _)| {
            value["lane"]
                .as_str()
                .filter(|lane| lane.starts_with("compute-") || lane.starts_with("worker-"))
                .and_then(|_| find_value(value, &["pid"], 0))
        })
        .or_else(|| find_value(identity, &["worker_pid"], 0))
        .or_else(|| find_sources(&sources, &["worker_pid"]));
    if let Some(pid) = compute_pid {
        fields.push(("计算进程", format!("PID={pid}")));
    } else if let Some(pid) = find_sources(&sources, &["host_pid", "pid", "PID"]) {
        fields.push(("宿主进程", format!("PID={pid}")));
    }
    for (label, keys) in [
        ("文件", &["file", "文件"][..]),
        ("用户操作", &["action", "用户操作"][..]),
        ("页面", &["page", "页面"][..]),
    ] {
        if let Some(value) = find_sources(&sources, keys).filter(|value| !value.ends_with(".rs")) {
            fields.push((label, value));
        }
    }
    if let Some(value) = find_sources(&sources, &["step", "stage", "阶段"]) {
        let step = stage_label(&value);
        let phase = find_sources(&sources, &["phase"]);
        let stage = match phase {
            Some(phase) if phase.split(" → ").any(|part| part == step) => phase,
            Some(phase) => format!("{phase} → {step}"),
            None => step,
        };
        fields.push(("阶段", stage));
    }
    let failure_reason = if failed {
        find_sources(&sources, &["error", "message", "原因"]).or_else(|| reason.map(str::to_owned))
    } else {
        reason.map(str::to_owned)
    };
    if let Some(reason) = failure_reason.filter(|value| !value.is_empty()) {
        fields.push(("原因", reason));
    }
    if let Some((_, elapsed)) = current {
        fields.push(("当前步骤耗时", format!("{elapsed} ms")));
    }
    let mut outcomes = Vec::new();
    if let Some(value) = find_sources(&sources, &["处理结果", "outcome"]) {
        outcomes.push(value);
    }
    if recent.iter().any(|value| value["reaped"] == true)
        && !outcomes.iter().any(|value| value.contains("进程已回收"))
    {
        outcomes.push(
            if recent.iter().any(|value| value["forced"] == true) {
                "计算进程已强制回收"
            } else {
                "计算进程已回收"
            }
            .into(),
        );
    }
    if !outcomes.is_empty() {
        fields.push(("处理结果", outcomes.join("；")));
    }
    if failed && !business_failure(identity, recent) {
        let mut stack_location = None;
        if let Some(value) = find_sources(&sources, &["traceback", "stack", "调用栈", "异常堆栈"])
        {
            stack_location = stack_frames(&value)
                .last()
                .map(|frame| frame.split('（').next().unwrap_or(frame).to_owned());
            fields.push(("异常堆栈", value));
        } else if let Some(value) = recent
            .iter()
            .rev()
            .filter_map(|value| value["stderr"].as_str())
            .find(|value| value.contains("Traceback") || value.contains("panicked"))
        {
            stack_location = stack_frames(value)
                .last()
                .map(|frame| frame.split('（').next().unwrap_or(frame).to_owned());
            fields.push(("异常堆栈", value.to_owned()));
        }
        if let Some(value) =
            stack_location.or_else(|| find_sources(&sources, &["location", "origin", "异常位置"]))
        {
            fields.push(("异常位置", source_location(&value)));
        }
    }
    fields
}

/// 将笼统失败替换为最深业务步骤；同一子错误沿用已确定摘要，不把整条阶段链或原因放进标题。
fn failure_summary(
    name: &str,
    result: &str,
    current: Option<&Value>,
    child: Option<&str>,
) -> String {
    if !matches!(
        result,
        "失败"
            | "请求失败"
            | "计算失败"
            | "计算未完成"
            | "布局失败"
            | "包络任务失败"
            | "缓存未完成"
            | "校验失败"
            | "服务启动失败"
    ) {
        return result.to_owned();
    }
    if let Some(summary) = child {
        return summary.to_owned();
    }
    let step = current
        .and_then(|details| find_value(details, &["step", "stage", "阶段", "phase"], 0))
        .map(|value| stage_label(value.rsplit('→').next().unwrap_or(&value).trim()))
        .filter(|step| {
            !step.is_empty()
                && !matches!(
                    step.as_str(),
                    "接收操作"
                        | "处理请求"
                        | "传输响应"
                        | "计算运行"
                        | "处理业务步骤"
                        | "处理业务请求"
                )
        });
    let step = step.unwrap_or_else(|| {
        let name = module_label(name);
        name.split_once('·')
            .map_or(name.clone(), |(_, step)| step.to_owned())
    });
    if step.ends_with("失败") {
        step
    } else {
        let separator = if step.ends_with(|c: char| c.is_ascii_alphanumeric()) {
            " "
        } else {
            ""
        };
        format!("{step}{separator}失败")
    }
}

/// 采用已有错误分类识别业务拒绝；最新的程序故障标记优先，不能被旧校验错误掩盖。
fn business_failure(identity: &Value, recent: &VecDeque<Value>) -> bool {
    let sources: Vec<_> = recent
        .iter()
        .rev()
        .chain(std::iter::once(identity))
        .collect();
    if let Some(kind) = find_sources(&sources, &["failure_kind"]) {
        return kind == "business";
    }
    matches!(
        find_sources(&sources, &["code"]).as_deref(),
        Some("infeasible" | "invalid_input")
    )
}

/// 提取 Python、浏览器及 Rust 的有效调用位置，移除路径、源代码正文和重复包装调用。
fn stack_frames(value: &str) -> Vec<String> {
    let mut frames = Vec::new();
    for line in value.lines().map(str::trim) {
        let parsed = if let Some(frame) = line.strip_prefix("File \"") {
            frame.split_once("\", line ").and_then(|(path, rest)| {
                let (number, function) = rest.split_once(", in ").unwrap_or((rest, ""));
                number.parse::<u64>().ok().map(|_| {
                    (
                        format!("{}:{number}", source_location(path)),
                        function.to_owned(),
                    )
                })
            })
        } else {
            let frame = line.strip_prefix("at ").unwrap_or(line);
            let (location, function) = if let Some((function, location)) = frame.rsplit_once(" (") {
                (location.trim_end_matches(')'), function)
            } else {
                (frame, "")
            };
            location
                .rsplit_once(':')
                .filter(|(_, line)| line.parse::<u64>().is_ok())
                .map(|_| (source_location(location), function.to_owned()))
        };
        let Some((location, function)) = parsed else {
            continue;
        };
        if (location.starts_with("monitoring.py:") && function == "run")
            || (location.starts_with("__main__.py:") && function == "main")
        {
            continue;
        }
        let frame = if function.is_empty() {
            location
        } else {
            format!("{location}（{function}）")
        };
        if !frames.contains(&frame) {
            frames.push(frame);
        }
    }
    // Python 按调用先后输出，浏览器/Rust 通常把异常最近的帧放在前面；统一后再截取最近位置。
    if !value
        .lines()
        .any(|line| line.trim_start().starts_with("File \""))
    {
        frames.reverse();
    }
    frames
}

/// 按信息源优先级查找已知标量；仅进入诊断包装对象，不遍历任意业务数组。
fn find_sources(sources: &[&Value], keys: &[&str]) -> Option<String> {
    sources.iter().find_map(|value| find_value(value, keys, 0))
}

/// 模型名称与编号只从同一对象组合，避免把前一个模型名称拼到当前模型编号上。
fn model_identity(value: &Value, depth: usize) -> Option<String> {
    let name = ["model_name", "model", "模型"].iter().find_map(|key| {
        value[*key]
            .as_str()
            .filter(|value| !value.is_empty() && *value != "尚未读取")
    });
    let id = ["model_id", "record_id", "record"]
        .iter()
        .find_map(|key| value[*key].as_str().filter(|value| !value.is_empty()));
    if let Some(name) = name {
        return Some(
            id.map(|id| format!("{name}（{}）", short_identifier("模型", id)))
                .unwrap_or_else(|| name.into()),
        );
    }
    if let Some(id) = id {
        return Some(short_identifier("模型", id));
    }
    if depth < 3 {
        for key in ["failure", "details", "state", "object", "context"] {
            if let Some(found) = model_identity(&value[key], depth + 1) {
                return Some(found);
            }
        }
    }
    None
}

/// 从有限层级上下文中提取字符串或数值，避免把整份 JSON 序列化到日志。
fn find_value(value: &Value, keys: &[&str], depth: usize) -> Option<String> {
    for key in keys {
        match &value[*key] {
            Value::String(text) if !text.is_empty() && text != "尚未读取" => {
                return Some(text.clone())
            }
            Value::Number(number) => return Some(number.to_string()),
            _ => {}
        }
    }
    if depth < 3 {
        for key in ["failure", "details", "state", "object", "context"] {
            if let Some(found) = find_value(&value[key], keys, depth + 1) {
                return Some(found);
            }
        }
    }
    None
}

/// 同一原始标识在所有进程中映射为同一短标签，不创建各进程独立递增编号。
pub fn short_identifier(prefix: &str, value: &str) -> String {
    let hash = value.bytes().fold(0xcbf29ce484222325u64, |hash, byte| {
        (hash ^ u64::from(byte)).wrapping_mul(0x100000001b3)
    });
    format!("{prefix}-{:08x}", (hash ^ (hash >> 32)) as u32)
}

/// 保留源文件名和行号供定位，去掉机器私有目录前缀。
fn source_location(value: &str) -> String {
    value.rsplit(['/', '\\']).next().unwrap_or(value).to_owned()
}

/// 将已知 Rust 内部边界翻译为业务阶段；源代码函数名仅留在内存监测状态。
fn stage_label(value: &str) -> String {
    if !value.contains("::") {
        return value.to_owned();
    }
    let exact = match value {
        "files::copy" => "复制模型文件",
        "files::hash" => "核对文件摘要",
        "files::verify" | "files::reference" => "校验文件资源",
        "files::within" => "校验资源路径",
        "files::write_json" | "files::replace" => "保存数据文件",
        "files::publish" => "发布计算产物",
        "models::find" | "models::get" | "models::list" => "读取模型记录",
        "models::preview" => "加载模型预览",
        "models::generate_envelope" => "生成模型包络",
        "jobs::run" | "job_compute::execute" => "执行布局优化",
        "job_compute::prepare_task" | "job_compute::prepare_task_mode" => "准备模型校验输入",
        "jobs::save" | "jobs::save_live" => "保存任务状态",
        "store::get" | "store::public" => "读取固化模型",
        "store::asset" => "读取固化模型文件",
        "prepared_cache::restore" => "读取布局准备缓存",
        "database::connect" => "连接数据库",
        _ => "",
    };
    if !exact.is_empty() {
        return exact.into();
    }
    let module = value.split("::").next().unwrap_or(value);
    match module {
        "models" | "model_manifests" | "model_settings" => "处理模型数据",
        "model_cache" => "读取预览缓存",
        "files" => "处理模型文件",
        "database" => "读写业务数据",
        "jobs" | "job_compute" => "处理布局优化",
        "job_meshes" | "fixed_display" => "生成显示网格",
        "fixed_constraints" | "fixed_stream" | "fixed_preview_cache" => "校验固定约束",
        "pre_config" | "layout_config" => "校验前置配置",
        "prepared_cache" | "store_cache" => "准备计算缓存",
        "store" | "store_export" => "处理模型库",
        "resource_budget" => "等待计算资源",
        "api" | "api_models" | "api_business" => "处理业务请求",
        _ => "处理业务步骤",
    }
    .into()
}

/// 去除标题中的路由、UUID 和计算协议操作名，使用稳定的中文模块与步骤。
fn module_label(value: &str) -> String {
    if value.contains("/api/") {
        let side = if value.starts_with("前端") {
            "前端"
        } else {
            "后端"
        };
        return format!("{side}·{}", request_label(value));
    }
    if let Some(operation) = value.strip_prefix("后端·计算 ") {
        let name = match operation {
            "preview.generate" => "生成模型预览",
            "envelope.generate" => "生成模型包络",
            "fairing.generate" => "生成整流罩",
            "layout.prepare" => "准备布局计算",
            "layout.solve" => "执行布局优化",
            "layout.validate" => "校验布局",
            "fixed.prepare" | "fixed.preview" => "准备固定预览",
            "envelope.export-stl" => "导出包络",
            "installation.project" => "安装面精确投影",
            "envelope.preview" => "生成包络显示资源",
            "history.meshes" => "读取历史网格",
            "history.export" => "导出布局Excel",
            "fixed.reference" => "生成安装基准",
            "fixed.display" => "生成固定显示网格",
            _ => "执行计算",
        };
        return format!("后端·{name}");
    }
    if value.starts_with("后端·布局优化 ") {
        return "后端·布局优化".into();
    }
    if value.contains('·') {
        value.to_owned()
    } else {
        format!("业务·{value}")
    }
}

/// 按既有路由的业务域显示中文操作，路径中的随机标识不进入标题。
fn request_label(value: &str) -> &'static str {
    let write = ["POST ", "PUT ", "PATCH ", "DELETE "]
        .iter()
        .any(|verb| value.contains(verb));
    if value.contains("preview-runtime-cache") {
        return if write {
            "保存预览缓存"
        } else {
            "读取预览缓存"
        };
    }
    if value.contains("/settings") {
        return if write {
            "保存模型设置"
        } else {
            "读取模型设置"
        };
    }
    if value.contains("/cancel") {
        return "取消优化任务";
    }
    if value.contains("/export") {
        return "导出模型或布局";
    }
    if value.contains("/meshes") {
        return "读取布局网格";
    }
    if value.contains("/envelope") {
        return if write {
            "生成模型包络"
        } else {
            "读取模型包络"
        };
    }
    if value.contains("/layout-optimization/jobs") {
        return if write {
            "管理优化任务"
        } else {
            "读取优化任务"
        };
    }
    if value.contains("/pre-config") {
        return if write {
            "保存前置配置"
        } else {
            "读取前置配置"
        };
    }
    if value.contains("/models") {
        return if value.contains("DELETE ") {
            "删除模型"
        } else if value.contains("POST ") {
            "上传模型"
        } else {
            "读取模型"
        };
    }
    if value.contains("/model-store") {
        return "管理固化模型";
    }
    "接口请求"
}

/// 统一字段别名和展示顺序，未知内部字段一律留在内存，不在最终文本展开。
fn display_fields(fields: &[(&str, String)]) -> Vec<(&'static str, String)> {
    let mut values = HashMap::new();
    for (key, value) in fields {
        if value.is_empty() || value == "null" {
            continue;
        }
        let label = match *key {
            "操作" | "操作编号" => "操作",
            "优化任务" | "job" | "job_id" => "优化任务",
            "模型" | "model" | "model_id" | "model_name" => "模型",
            "安装面" | "face" | "face_id" | "installation_face_id" => "安装面",
            "阶段" | "step" | "stage" => "阶段",
            "原因" | "reason" | "error" => "原因",
            "PID" | "pid" | "worker_pid" => "PID",
            "计算进程" => "计算进程",
            "宿主进程" => "宿主进程",
            "当前步骤耗时" | "步骤耗时ms" => "当前步骤耗时",
            "最慢步骤耗时" => "最慢步骤耗时",
            "无进展时长" => "无进展时长",
            "处理结果" | "outcome" => "处理结果",
            "异常堆栈" | "调用栈" | "stack" | "traceback" => "异常堆栈",
            "异常位置" | "位置" | "location" => "异常位置",
            "耗时" | "耗时ms" => "耗时",
            "客户端耗时" | "客户端耗时ms" => "客户端耗时",
            "文件" | "file" => "文件",
            "用户操作" | "action" => "用户操作",
            "页面" | "page" => "页面",
            _ => continue,
        };
        let text = match label {
            "操作" => short_identifier("操作", value),
            "优化任务" => short_identifier("任务", value),
            "异常位置" | "文件" => source_location(value),
            _ => value.clone(),
        };
        values.insert(label, text);
    }
    [
        "操作",
        "优化任务",
        "模型",
        "安装面",
        "文件",
        "用户操作",
        "页面",
        "阶段",
        "原因",
        "计算进程",
        "宿主进程",
        "PID",
        "当前步骤耗时",
        "最慢步骤耗时",
        "无进展时长",
        "耗时",
        "客户端耗时",
        "处理结果",
        "异常位置",
        "异常堆栈",
    ]
    .into_iter()
    .filter_map(|key| values.remove(key).map(|value| (key, value)))
    .collect()
}

/// 限制每份内存轨迹的总大小；截断可见且不会保留原始大型模型对象。
fn bounded(value: Value, limit: usize) -> Value {
    let text = value.to_string();
    if text.chars().count() <= limit {
        value
    } else {
        json!({"truncated":true,"summary":clean(&text,limit)})
    }
}

/// 返回毫秒精度本地时区时间。
pub fn timestamp() -> String {
    Local::now()
        .to_rfc3339_opts(SecondsFormat::Millis, false)
        .replace('T', " ")
}
/// 防止换行注入，并显式标出有界截断。
fn clean(value: &str, limit: usize) -> String {
    let mut chars = value.chars();
    let text: String = chars.by_ref().take(limit).collect();
    let suffix = if chars.next().is_some() {
        "…[截断]"
    } else {
        ""
    };
    format!("{}{suffix}", text.replace(['\r', '\n'], "\\n"))
}
