//! 文件说明：管理后端会话归档，复用共享异步写入器与监测注册表；不包含业务规则。
use crate::{
    config::Config,
    error::{Error, Result},
    runtime_logging::{Level, Operation, Policy, Registry, Writer},
};
use chrono::{Local, NaiveDate};
use std::{
    fmt,
    fs::{self, OpenOptions},
    io::Write,
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex, OnceLock, Weak,
    },
};

/// 当前进程日志弱引用，供兼容诊断和 panic 使用。
static CURRENT: OnceLock<Mutex<Weak<SessionLog>>> = OnceLock::new();
/// 单次启动的日志；日期和编号固定，关闭后排空队列并拒绝追加。
pub struct SessionLog {
    pub path: PathBuf,
    pub session: String,
    pub writer: Arc<Writer>,
    pub policy: Policy,
    pub registry: Arc<Registry>,
    closed: AtomicBool,
}
impl SessionLog {
    /// 从统一配置和宿主覆盖值创建隔离会话。
    pub fn from_config(config: &Config) -> Result<Arc<Self>> {
        let root = std::env::var_os("SAT_LAYOUT_OPT_LOG_ROOT")
            .map(PathBuf::from)
            .or_else(|| {
                std::env::var_os("SAT_LAYOUT_TEST_OUTPUT")
                    .map(|path| PathBuf::from(path).join("logs"))
            })
            .unwrap_or_else(|| config.root.join(config.string("logging", "root_dir")));
        Self::create_with_policy(
            &root,
            std::env::var("SAT_LAYOUT_OPT_LOG_SESSION_ID")
                .ok()
                .as_deref(),
            serde_json::from_value(config.values["logging"].clone())?,
        )
    }
    /// 独立库测试从集中配置读取默认策略，不维护重复默认值。
    pub fn create(root: &Path, inherited: Option<&str>) -> Result<Arc<Self>> {
        let values: toml::Value =
            toml::from_str(include_str!("../../../config/sat_layout_opt.toml"))
                .map_err(Error::bad)?;
        Self::create_with_policy(
            root,
            inherited,
            values["logging"].clone().try_into().map_err(Error::bad)?,
        )
    }
    /// 原子创建会话文件或接管桌面预留空文件；不覆盖已有内容。
    pub fn create_with_policy(
        root: &Path,
        inherited: Option<&str>,
        policy: Policy,
    ) -> Result<Arc<Self>> {
        policy.validate()?;
        let (session, path, mut file) = if let Some(session) = inherited {
            let (date, name) = parse_session(session)?;
            let directory = root.join(date).join("backend");
            fs::create_dir_all(&directory)?;
            let path = directory.join(format!("backend-{name}.log"));
            let file = OpenOptions::new().create(true).append(true).open(&path)?;
            if file.metadata()?.len() != 0 {
                return Err(Error::bad("后端会话日志已包含内容，拒绝复用"));
            }
            (session.to_owned(), path, file)
        } else {
            let date = Local::now().format("%Y-%m-%d").to_string();
            let day = root.join(&date);
            fs::create_dir_all(day.join("backend"))?;
            let mut index = 1u64;
            loop {
                let name = format!("session-{index:03}");
                let path = day.join("backend").join(format!("backend-{name}.log"));
                if !day
                    .join("frontend")
                    .join(format!("frontend-{name}.log"))
                    .exists()
                {
                    match OpenOptions::new().create_new(true).append(true).open(&path) {
                        Ok(file) => break (format!("{date}/{name}"), path, file),
                        Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {}
                        Err(error) => return Err(error.into()),
                    }
                }
                index = index
                    .checked_add(1)
                    .ok_or_else(|| Error::bad("日志会话编号已耗尽"))?;
            }
        };
        // 同步首行标记占用，避免异步队列尚未落盘时再次接管空文件。
        writeln!(
            file,
            "{} INFO [后端·生命周期] Rust 后端启动（会话 {}，PID {}）",
            crate::runtime_logging::timestamp(),
            session,
            std::process::id()
        )?;
        file.flush()?;
        let registry = Registry::new(&policy)?;
        let writer = Writer::new(file, &policy)?;
        Ok(Arc::new(Self {
            path,
            session,
            writer,
            policy,
            registry,
            closed: AtomicBool::new(false),
        }))
    }
    /// 写入兼容诊断；新增业务代码使用显式级别和操作对象。
    pub fn write(&self, message: fmt::Arguments<'_>) -> std::io::Result<()> {
        self.writer
            .event(Level::Info, "后端·运行", message.to_string().trim(), &[])
    }
    /// 创建操作并登记宿主独立监测；编号与前端请求一致。
    pub fn operation(&self, id: String, name: String, quiet: bool, long: bool) -> Arc<Operation> {
        let operation = Operation::new(
            self.writer.clone(),
            self.policy.clone(),
            id,
            name,
            quiet,
            long,
        );
        self.registry.register(&operation);
        operation
    }
    /// 安装当前进程日志与 panic 接收器；panic 保留调用栈。
    pub fn install(self: &Arc<Self>) {
        *CURRENT
            .get_or_init(|| Mutex::new(Weak::new()))
            .lock()
            .unwrap_or_else(|e| e.into_inner()) = Arc::downgrade(self);
        let weak = Arc::downgrade(self);
        std::panic::set_hook(Box::new(move |panic| {
            if let Some(log) = weak.upgrade() {
                let _ = log.writer.event(
                    Level::Error,
                    "后端·运行",
                    "未捕获异常",
                    &[
                        ("原因", panic.to_string()),
                        (
                            "调用栈",
                            std::backtrace::Backtrace::force_capture().to_string(),
                        ),
                    ],
                );
            } else {
                eprintln!("{panic}");
            }
        }));
    }
    /// 正常退出路径排空日志；重复关闭无副作用。
    pub fn finish(&self, reason: &str) -> std::io::Result<()> {
        if !self.closed.swap(true, Ordering::AcqRel) {
            self.registry.finish_all();
            let result = self.writer.event(
                Level::Info,
                "后端·生命周期",
                &format!("Rust 后端关闭：{reason}"),
                &[],
            );
            let closed = self.writer.finish();
            result.and(closed)?;
        }
        Ok(())
    }
}
/// 普通兼容诊断；初始化或磁盘故障时由 stderr 明确兜底。
pub fn diagnostic(message: fmt::Arguments<'_>) {
    let log = CURRENT
        .get()
        .and_then(|current| current.lock().unwrap_or_else(|e| e.into_inner()).upgrade());
    if let Some(log) = log {
        if log.write(message).is_ok() {
            return;
        }
    }
    eprintln!("{message}");
}
/// 可恢复问题与失败使用显式级别；失败展开源位置，普通警告不输出内部文件行号。
#[track_caller]
pub fn issue(level: Level, message: fmt::Arguments<'_>) {
    let location = std::panic::Location::caller();
    let fields = if matches!(level, Level::Error) {
        vec![("异常位置", location.to_string())]
    } else {
        vec![]
    };
    if let Some(operation) = crate::monitoring::current() {
        operation.emit(level, &message.to_string(), fields);
        return;
    }
    let log = CURRENT
        .get()
        .and_then(|current| current.lock().unwrap_or_else(|e| e.into_inner()).upgrade());
    if let Some(log) = log {
        if log
            .writer
            .event(level, "后端·运行", &message.to_string(), &fields)
            .is_ok()
        {
            return;
        }
    }
    eprintln!("{message}");
}
/// 计算临时诊断在收尾时归并，成功快照不刷盘，暂存随任务清理。
pub struct TaskDiagnostic {
    log: Arc<SessionLog>,
    pub path: PathBuf,
    task: String,
}
impl TaskDiagnostic {
    /// 创建包络原生崩溃快照位置，不重复记录操作开始。
    pub fn new(log: Arc<SessionLog>, task: &str, root: &Path, _operation: &str) -> Self {
        Self {
            log,
            path: root.join("envelope-diagnostic.json"),
            task: task.to_owned(),
        }
    }
}
impl Drop for TaskDiagnostic {
    /// 只归并明确失败的原生快照；删除失败可见，不替代业务结果。
    fn drop(&mut self) {
        let result = (|| -> std::io::Result<()> {
            if self.path.is_file() {
                let report = fs::read_to_string(&self.path)?;
                let value: serde_json::Value = serde_json::from_str(&report).unwrap_or_default();
                if value["status"] == "failed" && !value["process_exit"].is_null() {
                    if let Some(operation) = crate::monitoring::current() {
                        operation.remember(value);
                    } else {
                        let mut fields = vec![("操作", self.task.clone())];
                        for (label, key) in [
                            ("模型", "model_id"),
                            ("阶段", "stage"),
                            ("原因", "error"),
                            ("异常堆栈", "traceback"),
                        ] {
                            if let Some(value) = value[key].as_str() {
                                fields.push((label, value.to_owned()));
                            }
                        }
                        self.log.writer.event(
                            Level::Error,
                            "后端·包络",
                            "原生计算失败",
                            &fields,
                        )?;
                    }
                }
                fs::remove_file(&self.path)?;
            }
            Ok(())
        })();
        if let Err(error) = result {
            let _ = self.log.writer.event(
                Level::Error,
                "后端·收尾",
                "临时诊断清理失败",
                &[("任务", self.task.clone()), ("原因", error.to_string())],
            );
        }
    }
}
/// 校验日期与会话编号，拒绝目录穿越和非标准编号。
fn parse_session(value: &str) -> Result<(&str, &str)> {
    let (date, name) = value
        .split_once('/')
        .ok_or_else(|| Error::bad("日志会话标识格式无效"))?;
    let parsed = NaiveDate::parse_from_str(date, "%Y-%m-%d").map_err(Error::bad)?;
    let number = name
        .strip_prefix("session-")
        .ok_or_else(|| Error::bad("日志会话编号无效"))?;
    if parsed.format("%Y-%m-%d").to_string() != date
        || number.len() < 3
        || !number.bytes().all(|byte| byte.is_ascii_digit())
        || number.parse::<u64>().ok().is_none_or(|number| number == 0)
    {
        return Err(Error::bad("日志会话标识格式无效"));
    }
    Ok((date, name))
}
