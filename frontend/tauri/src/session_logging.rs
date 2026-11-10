//! 文件说明：为一次桌面启动原子预留前后端日志文件并管理前端写入和关闭。
//! 本模块保持 UTF-8 普通文本，不改写后端内容；跨午夜仍使用启动日目录。

use std::{
    fs::{self, OpenOptions},
    io::{self},
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    },
};

/// 单次桌面运行的日志资源；后端文件仅预留，由独立 Rust 后端持有并写入。
pub struct SessionLog {
    pub root: PathBuf,
    pub session_id: String,
    pub frontend_path: PathBuf,
    pub backend_path: PathBuf,
    pub writer: Arc<crate::runtime_logging::Writer>,
    pub policy: crate::runtime_logging::Policy,
    pub registry: Arc<crate::runtime_logging::Registry>,
    closed: AtomicBool,
}

impl SessionLog {
    /// 按本地启动日期创建一对新日志；目录不可写或无法占用编号时返回 I/O 错误。
    pub fn start(root: &Path) -> io::Result<Self> {
        Self::start_on_date(root, &chrono::Local::now().format("%Y-%m-%d").to_string())
    }

    /// 在给定日期原子占用同号文件；显式日期用于边界测试，不覆盖任何既有日志。
    pub fn start_on_date(root: &Path, date: &str) -> io::Result<Self> {
        let values: toml::Value =
            toml::from_str(include_str!("../../../config/sat_layout_opt.toml"))
                .map_err(io::Error::other)?;
        let policy = values["logging"]
            .clone()
            .try_into()
            .map_err(io::Error::other)?;
        Self::start_with_policy(root, date, policy)
    }

    /// 使用唯一 TOML 策略创建桌面会话，测试可独立指定日期。
    pub fn start_with_policy(
        root: &Path,
        date: &str,
        policy: crate::runtime_logging::Policy,
    ) -> io::Result<Self> {
        policy.validate()?;
        let parsed = chrono::NaiveDate::parse_from_str(date, "%Y-%m-%d")
            .map_err(|error| io::Error::new(io::ErrorKind::InvalidInput, error))?;
        if parsed.format("%Y-%m-%d").to_string() != date {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                "日志日期格式无效",
            ));
        }
        let root = std::path::absolute(root)?;
        let day = root.join(date);
        let frontend_dir = day.join("frontend");
        let backend_dir = day.join("backend");
        fs::create_dir_all(&frontend_dir)?;
        fs::create_dir_all(&backend_dir)?;
        for number in 1_u64.. {
            let name = format!("session-{number:03}");
            let frontend_path = frontend_dir.join(format!("frontend-{name}.log"));
            let backend_path = backend_dir.join(format!("backend-{name}.log"));
            if backend_path.exists() {
                continue;
            }
            let frontend = match OpenOptions::new()
                .write(true)
                .create_new(true)
                .open(&frontend_path)
            {
                Ok(file) => file,
                Err(error) if error.kind() == io::ErrorKind::AlreadyExists => continue,
                Err(error) => return Err(error),
            };
            match OpenOptions::new()
                .write(true)
                .create_new(true)
                .open(&backend_path)
            {
                Ok(_) => {
                    let session = Self {
                        root,
                        session_id: format!("{date}/{name}"),
                        frontend_path,
                        backend_path,
                        registry: crate::runtime_logging::Registry::new(&policy)?,
                        writer: crate::runtime_logging::Writer::new(frontend, &policy)?,
                        policy,
                        closed: AtomicBool::new(false),
                    };
                    session.write(&format!("桌面启动：{}", session.session_id))?;
                    return Ok(session);
                }
                Err(error) => {
                    drop(frontend);
                    fs::remove_file(&frontend_path)?;
                    if error.kind() != io::ErrorKind::AlreadyExists {
                        return Err(error);
                    }
                }
            }
        }
        Err(io::Error::other("无法分配日志会话编号"))
    }

    /// 将普通生命周期事件交给唯一写线程；关闭后返回错误。
    pub fn write(&self, message: &str) -> io::Result<()> {
        self.writer.event(
            crate::runtime_logging::Level::Info,
            "前端·桌面",
            message,
            &[],
        )
    }
    /// 记录桌面宿主故障；前端日志保存代理、窗口和后端进程监督的实际错误。
    #[track_caller]
    pub fn issue(&self, message: &str) -> io::Result<()> {
        self.writer.event(
            crate::runtime_logging::Level::Error,
            "前端·桌面",
            message,
            &[("位置", std::panic::Location::caller().to_string())],
        )
    }

    /// 建立前端操作，由桌面宿主独立监测，WebView 卡住时也能记录当前步骤。
    pub fn operation(
        &self,
        id: String,
        name: String,
        quiet: bool,
        long: bool,
    ) -> Arc<crate::runtime_logging::Operation> {
        let operation = crate::runtime_logging::Operation::new(
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

    /// 排空单写队列并关闭文件；重复关闭无副作用。
    pub fn finish(&self, message: &str) -> io::Result<()> {
        if !self.closed.swap(true, Ordering::AcqRel) {
            self.registry.finish_all();
            let written = self.write(message);
            let closed = self.writer.finish();
            written.and(closed)?;
        }
        Ok(())
    }
}
