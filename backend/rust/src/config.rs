//! 文件说明：读取并校验集中 TOML，定位开发/桌面数据和微调进程生命周期；不维护重复运行默认值。
use crate::error::{Error, Result};
use serde_json::Value;
use std::{
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
};

/// 启动时读取的不可变配置与根目录。
#[derive(Clone)]
pub struct Config {
    pub values: Value,
    pub root: PathBuf,
    pub data: PathBuf,
    logs: Arc<Mutex<Option<Arc<crate::logging::SessionLog>>>>,
}
impl Config {
    /// 解析集中配置并采用显式环境覆盖的隔离数据根；文件损坏立即停止启动。
    pub fn load(root: &Path) -> Result<Self> {
        let root = std::fs::canonicalize(root)?;
        let text = std::fs::read_to_string(root.join("config/sat_layout_opt.toml"))?;
        let values: toml::Value = toml::from_str(&text).map_err(Error::bad)?;
        let values = serde_json::to_value(values)?;
        let data = std::env::var_os("SAT_LAYOUT_OPT_DATA_ROOT")
            .map(PathBuf::from)
            .unwrap_or_else(|| root.clone());
        std::fs::create_dir_all(&data)?;
        let config = Self {
            values,
            root,
            data: std::fs::canonicalize(data)?,
            logs: Arc::new(Mutex::new(None)),
        };
        crate::resource_budget::WorkerLimits::load(&config)?;
        crate::hardware_config::validate(&config.values)?;
        for name in ["refinement_session_idle_seconds", "refinement_session_limit"] {
            if config.values["layout_optimization"][name]
                .as_u64()
                .is_none_or(|value| value == 0 || usize::try_from(value).is_err())
            {
                return Err(Error::bad(format!("{name} 必须为有效正整数")));
            }
        }
        if !config.values["compute_engine"]["refinement_worker_enabled"].is_boolean() {
            return Err(Error::bad("refinement_worker_enabled 必须为布尔值"));
        }
        for name in [
            "refinement_worker_idle_seconds",
            "refinement_worker_poll_seconds",
        ] {
            if config.values["compute_engine"][name]
                .as_f64()
                .is_none_or(|value| !value.is_finite() || value <= 0.0 || value > 3600.0)
            {
                return Err(Error::bad(format!("{name} 必须在 (0, 3600] 内")));
            }
        }
        if config.values["envelope_progress"]["event_capacity"]
            .as_u64()
            .is_none_or(|v| v == 0 || usize::try_from(v).is_err())
        {
            return Err(Error::bad(
                "envelope_progress.event_capacity 必须为有效的正整数",
            ));
        }
        let mesh_limit = config.values["rust_backend"]["mesh_max_bytes"]
            .as_u64()
            .filter(|v| *v >= 32 && *v <= u32::MAX as u64)
            .ok_or_else(|| Error::bad("mesh_max_bytes 必须介于 32 与 Uint32 上限之间"))?;
        let fixed_display_limit = config.values["rust_backend"]["fixed_display_max_bytes"]
            .as_u64()
            .filter(|v| *v >= 32 && *v <= u32::MAX as u64)
            .ok_or_else(|| Error::bad("fixed_display_max_bytes 必须介于 32 与 Uint32 上限之间"))?;
        if config.values["rust_backend"]["mesh_cache_max_bytes"]
            .as_u64()
            .is_none_or(|v| v < mesh_limit + 4096 || v < fixed_display_limit + 4096)
        {
            return Err(Error::bad(
                "mesh_cache_max_bytes 必须至少容纳单型号资源及索引",
            ));
        }
        Ok(config)
    }
    /// 读取必需字符串；缺失配置拒绝启动/操作，不使用隐式回退。
    pub fn string(&self, section: &str, name: &str) -> &str {
        self.values[section][name]
            .as_str()
            .expect("集中配置缺少字符串")
    }
    /// 读取必需非负整数。
    pub fn integer(&self, section: &str, name: &str) -> u64 {
        self.values[section][name]
            .as_u64()
            .expect("集中配置缺少整数")
    }
    /// 读取必需浮点数。
    pub fn number(&self, section: &str, name: &str) -> f64 {
        self.values[section][name]
            .as_f64()
            .expect("集中配置缺少数值")
    }
    /// 将受控配置中的数据相对目录解析到数据根。
    pub fn directory(&self, section: &str, name: &str) -> PathBuf {
        self.data.join(self.string(section, name))
    }
    /// 返回本配置共享的会话日志；独立库测试仅在首次计算时创建，不影响配置解析。
    pub fn logs(&self) -> Result<Arc<crate::logging::SessionLog>> {
        let mut current = self.logs.lock().unwrap_or_else(|error| error.into_inner());
        if let Some(log) = current.as_ref() {
            return Ok(log.clone());
        }
        let log = crate::logging::SessionLog::from_config(self)?;
        *current = Some(log.clone());
        Ok(log)
    }
    /// 返回唯一项目环境的解释器路径。
    pub fn python(&self) -> PathBuf {
        PathBuf::from(self.string("packaging", "python_environment")).join("python.exe")
    }

    /// 安装版由同目录桌面程序识别；缺失计算程序时不得回退开发环境，避免隐藏发布缺件。
    pub fn packaged(&self) -> bool {
        self.root.join("SatLayoutOpt.exe").is_file()
    }

    /// 构造计算命令；开发态使用指定 Conda，发布态只执行包内 standalone 程序。
    pub fn compute_command(&self) -> tokio::process::Command {
        if self.packaged() {
            tokio::process::Command::new(self.root.join("backend/SatLayoutOptCompute.exe"))
        } else {
            let mut command = tokio::process::Command::new(self.python());
            command.args(["-m", "app.compute"]);
            command.env("PYTHONPATH", self.root.join("backend"));
            command
        }
    }
}
