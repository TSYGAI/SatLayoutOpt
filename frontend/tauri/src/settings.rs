//! 文件说明：读取窗口尺寸与背景，按程序目录隔离安装版业务数据和桌面状态；旧配置补项由独立模块负责。

use serde::Deserialize;
use std::{path::PathBuf, time::Duration};

/// 集中配置中仅与桌面启动有关的部分；其余业务节由独立后端读取。
#[derive(Deserialize)]
pub struct Settings {
    pub desktop: Desktop,
    pub packaging: Packaging,
    pub rust_backend: RustBackend,
    pub logging: Logging,
    #[serde(skip)]
    pub root: PathBuf,
    #[serde(skip)]
    pub packaged: bool,
}

/// 窗口、生命周期与桌面状态目录；业务数据路径由后端统一配置解析。
#[derive(Deserialize)]
pub struct Desktop {
    pub state_dir: PathBuf,
    pub title: String,
    pub entry_path: String,
    pub width: f64,
    pub height: f64,
    pub min_width: f64,
    pub min_height: f64,
    pub background_color: [u8; 4],
    pub startup_timeout_ms: u64,
    pub shutdown_timeout_ms: u64,
    pub control_poll_interval_ms: u64,
    pub tauri: Native,
}

/// Tauri 独有的传输及开发数据目录，安装版以可执行文件所在目录为业务路径基准。
#[derive(Deserialize)]
pub struct Native {
    pub data_dir: PathBuf,
    pub connect_timeout_ms: u64,
    pub csp: String,
}

/// 复用既有环境位置，确保 Python 计算始终在项目 Conda 中运行。
#[derive(Deserialize)]
pub struct Packaging {
    pub python_environment: PathBuf,
    pub webview2_dir: PathBuf,
}

/// 独立后端构建目录；程序名属于构建契约，运行路径由集中配置派生。
#[derive(Deserialize)]
pub struct RustBackend {
    pub build_dir: PathBuf,
}

/// 前后端共享的日志目录配置；日期和会话命名属于固定归档契约。
#[derive(Deserialize)]
pub struct Logging {
    pub root_dir: PathBuf,
    #[serde(flatten)]
    pub policy: crate::runtime_logging::Policy,
}

impl Settings {
    /// 从显式项目根目录读取配置；无目录、非法参数或缺失依赖时返回错误。
    pub fn load() -> Result<Self, Box<dyn std::error::Error>> {
        let executable = std::env::current_exe()?;
        let directory = executable.parent().ok_or("程序目录无效")?;
        let packaged = directory.join("config/sat_layout_opt.toml").is_file();
        let root = if packaged {
            directory.to_path_buf()
        } else {
            PathBuf::from(std::env::var("SAT_LAYOUT_OPT_PROJECT_ROOT")?).canonicalize()?
        };
        let path = root.join("config/sat_layout_opt.toml");
        let original = std::fs::read_to_string(&path)?;
        let text = if packaged {
            crate::config_upgrade::merge(&original)?
        } else {
            original.clone()
        };
        let mut config: Self = toml::from_str(&text)?;
        config.root = root.clone();
        config.packaged = packaged;
        if !config.desktop.entry_path.starts_with("/frontend/")
            || config.desktop.startup_timeout_ms == 0
            || config.desktop.shutdown_timeout_ms == 0
            || config.desktop.control_poll_interval_ms == 0
            || !root.join("frontend/dist/frontend/index.html").is_file()
            || (!packaged
                && !config
                    .packaging
                    .python_environment
                    .join("python.exe")
                    .is_file())
        {
            return Err("桌面配置或构建产物无效，请通过统一入口构建".into());
        }
        if packaged {
            if !config.backend_executable().is_file()
                || !root.join("backend/SatLayoutOptCompute.exe").is_file()
                || !root
                    .join(&config.packaging.webview2_dir)
                    .join("msedgewebview2.exe")
                    .is_file()
            {
                return Err("安装文件缺失，请重新安装完整离线包".into());
            }
            crate::config_upgrade::save(&path, &original, &text, &config.state_root())?;
        }
        Ok(config)
    }

    /// 返回后端相对路径的基准目录；安装版使用程序根目录，使既有 data/ 路径落在本次安装内。
    pub fn data_root(&self) -> PathBuf {
        std::env::var_os("SAT_LAYOUT_OPT_DESKTOP_DATA_ROOT")
            .map(PathBuf::from)
            .unwrap_or_else(|| {
                if self.packaged {
                    self.root.clone()
                } else {
                    self.root.join(&self.desktop.tauri.data_dir)
                }
            })
    }

    /// 返回当前数据基准下的桌面状态目录，集中容纳 WebView 资料、配置备份和运行状态。
    pub fn state_root(&self) -> PathBuf {
        self.data_root().join(&self.desktop.state_dir)
    }

    /// 返回共享日志根目录；隔离验收可显式覆盖，普通运行始终相对程序根目录解析。
    pub fn log_root(&self) -> PathBuf {
        std::env::var_os("SAT_LAYOUT_OPT_LOG_ROOT")
            .map(PathBuf::from)
            .unwrap_or_else(|| self.root.join(&self.logging.root_dir))
    }

    /// 返回生命周期轮询间隔，避免启动和关闭过程中忙等。
    pub fn poll_interval(&self) -> Duration {
        Duration::from_millis(self.desktop.control_poll_interval_ms)
    }

    /// 返回与桌面构建模式一致的独立业务程序，开发启动也可使用统一构建器传入的明确路径。
    pub fn backend_executable(&self) -> PathBuf {
        if self.packaged {
            return self.root.join("backend/sat-layout-api.exe");
        }
        std::env::var_os("SAT_LAYOUT_RUST_BACKEND")
            .map(PathBuf::from)
            .unwrap_or_else(|| {
                self.root
                    .join(&self.rust_backend.build_dir)
                    .join("target")
                    .join(if cfg!(debug_assertions) {
                        "debug"
                    } else {
                        "release"
                    })
                    .join("sat-layout-api.exe")
            })
    }
}
