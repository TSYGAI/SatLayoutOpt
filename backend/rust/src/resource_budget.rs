//! 文件说明：读取系统资源并计算统一计算准入预算；低内存时返回零并行度，由宿主排队且允许取消。
use crate::{
    config::Config,
    error::{Error, Result},
};
use serde::Serialize;
use serde_json::Value;

/// 汇总软件界面、常驻缓存和显示工作空间的保守预算；磁盘缓存不当作物理内存重复计算。
pub fn application_memory_reserve(values: &Value) -> Result<u64> {
    [
        ("hardware", "application_memory_overhead_bytes"),
        ("frontend", "preview_cache_max_bytes"),
        ("frontend", "data_management_cache_max_bytes"),
        ("frontend", "layout_mesh_geometry_max_bytes"),
        ("frontend", "layout_mesh_worker_max_bytes"),
    ]
    .into_iter()
    .try_fold(0u64, |sum, (section, key)| {
        let bytes = values[section][key]
            .as_u64()
            .filter(|v| *v > 0)
            .ok_or_else(|| Error::invalid(format!("{section}.{key} 内存预算无效")))?;
        sum.checked_add(bytes)
            .ok_or_else(|| Error::invalid("软件界面与缓存内存预算溢出"))
    })
}

/// 操作系统提供的物理内存与可用逻辑处理器快照。
#[derive(Clone, Copy, Debug)]
pub struct SystemResources {
    pub cpus: usize,
    pub total: u64,
    pub available: u64,
}

/// 集中配置中的资源政策；估算包含宿主、数组及工作进程私有内存。
#[derive(Clone, Copy, Debug)]
pub struct WorkerLimits {
    pub worker_cap: usize,
    pub cpu_reserve: usize,
    pub numeric_threads: usize,
    pub cad_threads: usize,
    pub memory_reserve_bytes: u64,
    pub memory_fraction: f64,
    pub worker_memory_bytes: u64,
    pub host_memory_bytes: u64,
    pub input_memory_factor: u64,
    pub application_memory_bytes: u64,
}
impl WorkerLimits {
    /// 严格读取资源配置；非法预算拒绝启动，避免隐式除零或退回无限制。
    pub fn load(config: &Config) -> Result<Self> {
        let section = &config.values["rust_backend"];
        let positive = |name: &str| -> Result<u64> {
            section[name]
                .as_u64()
                .filter(|v| *v > 0)
                .ok_or_else(|| Error::bad(format!("rust_backend.{name} 必须为正整数")))
        };
        let cpu_reserve = section["compute_cpu_reserve"]
            .as_u64()
            .ok_or_else(|| Error::bad("compute_cpu_reserve 必须为非负整数"))?;
        let fraction = section["compute_memory_fraction"]
            .as_f64()
            .filter(|v| *v > 0.0 && *v <= 1.0)
            .ok_or_else(|| Error::bad("compute_memory_fraction 必须在 (0, 1] 内"))?;
        let numeric_threads = config.values["compute_engine"]["numeric_threads_per_worker"]
            .as_u64()
            .filter(|v| *v > 0)
            .ok_or_else(|| Error::bad("数值线程数必须为正整数"))?;
        Ok(Self {
            worker_cap: positive("compute_worker_cap")?
                .min(config.integer("compute_engine", "max_workers"))
                as usize,
            cpu_reserve: cpu_reserve as usize,
            numeric_threads: numeric_threads as usize,
            cad_threads: positive("compute_cad_threads")? as usize,
            memory_reserve_bytes: positive("compute_memory_reserve_bytes")?,
            memory_fraction: fraction,
            worker_memory_bytes: positive("compute_worker_memory_bytes")?,
            host_memory_bytes: positive("compute_host_memory_bytes")?,
            input_memory_factor: positive("compute_input_memory_factor")?,
            application_memory_bytes: application_memory_reserve(&config.values)?,
        })
    }
}

/// 与 Python 共享的资源合同；zero workers 表示当前不能启动，不能传递给计算引擎。
#[derive(Clone, Copy, Debug, Serialize)]
pub struct WorkerPlan {
    pub workers: usize,
    pub cpu_slots: usize,
    pub cad_threads: usize,
    pub cpu_count: usize,
    pub available_memory_bytes: u64,
    pub memory_reserve_bytes: u64,
    pub budget_bytes: u64,
    pub worker_memory_bytes: u64,
    pub host_memory_bytes: u64,
}

/// 统一核算 CPU、总内存比例、系统保留内存和已登记资源；大输入按字节数提高估计。
pub fn choose_workers(
    system: SystemResources,
    reserved_cpu: usize,
    reserved_memory: u64,
    limits: WorkerLimits,
    solve: bool,
    input_bytes: u64,
    observed_worker_bytes: u64,
) -> WorkerPlan {
    let cpu = system
        .cpus
        .saturating_sub(limits.cpu_reserve)
        .max(1)
        .saturating_sub(reserved_cpu);
    let memory = system
        .available
        .saturating_sub(limits.memory_reserve_bytes)
        .saturating_sub(reserved_memory)
        .min(
            ((system.total as f64 * limits.memory_fraction) as u64)
                .saturating_sub(limits.application_memory_bytes)
                .saturating_sub(reserved_memory),
        );
    let host = limits
        .host_memory_bytes
        .saturating_add(input_bytes.saturating_mul(limits.input_memory_factor));
    let worker = limits
        .worker_memory_bytes
        .max(observed_worker_bytes)
        .saturating_add(input_bytes.saturating_mul(limits.input_memory_factor));
    let usable_cpu = system.cpus.saturating_sub(limits.cpu_reserve).max(1);
    let coordinator = usize::from(solve && usable_cpu > limits.numeric_threads);
    let per_worker_cpu = if solve {
        limits.numeric_threads
    } else {
        limits.cad_threads.min(cpu).max(1)
    };
    let cpu_workers = cpu.saturating_sub(coordinator) / per_worker_cpu;
    let workers = if solve {
        limits
            .worker_cap
            .min(cpu_workers)
            .min(memory.saturating_sub(host).checked_div(worker).unwrap_or(0) as usize)
    } else {
        usize::from(cpu >= per_worker_cpu && memory >= host)
    };
    WorkerPlan {
        workers,
        cpu_slots: if workers == 0 {
            0
        } else {
            workers * per_worker_cpu + coordinator
        },
        cad_threads: if solve { 1 } else { per_worker_cpu },
        cpu_count: system.cpus,
        available_memory_bytes: system.available,
        memory_reserve_bytes: limits.memory_reserve_bytes,
        budget_bytes: if workers == 0 {
            0
        } else {
            host + if solve { workers as u64 * worker } else { 0 }
        },
        worker_memory_bytes: worker,
        host_memory_bytes: host,
    }
}

/// 包络仅取得现有任务之后的剩余资源；最小 CAD 工作集不足时排队，单批网格随后自适应。
pub fn choose_envelope_workers(
    system: SystemResources,
    reserved_cpu: usize,
    reserved_memory: u64,
    mut limits: WorkerLimits,
    input_bytes: u64,
    envelope: EnvelopeLimits,
) -> WorkerPlan {
    let available = system
        .available
        .saturating_sub(limits.memory_reserve_bytes)
        .saturating_sub(reserved_memory)
        .min(
            ((system.total as f64 * limits.memory_fraction) as u64)
                .saturating_sub(limits.application_memory_bytes)
                .saturating_sub(reserved_memory),
        )
        .min(envelope.process_memory_bytes);
    limits.host_memory_bytes = limits
        .host_memory_bytes
        .saturating_add(envelope.workspace_bytes);
    let mut plan = choose_workers(
        system,
        reserved_cpu,
        reserved_memory,
        limits,
        false,
        input_bytes,
        0,
    );
    if plan.workers > 0 && available >= plan.budget_bytes {
        plan.budget_bytes = available;
    } else {
        plan.workers = 0;
        plan.cpu_slots = 0;
        plan.budget_bytes = 0;
    }
    plan
}

/// 包络专属的进程上限与单批工作空间，不改变其他计算任务的资源政策。
#[derive(Clone, Copy, Debug)]
pub struct EnvelopeLimits {
    pub process_memory_bytes: u64,
    pub workspace_bytes: u64,
}

/// 读取 Windows 物理内存及进程可见 CPU；采样失败拒绝启动任务，不猜测可用内存。
pub fn system_resources() -> Result<SystemResources> {
    let cpus = std::thread::available_parallelism()?.get();
    #[cfg(windows)]
    {
        use windows_sys::Win32::System::SystemInformation::{GlobalMemoryStatusEx, MEMORYSTATUSEX};
        let mut status = MEMORYSTATUSEX {
            dwLength: std::mem::size_of::<MEMORYSTATUSEX>() as u32,
            ..Default::default()
        };
        // SAFETY: 长度正确的结构体由本线程独占，系统调用不会保存其指针。
        if unsafe { GlobalMemoryStatusEx(&mut status) } == 0 {
            return Err(std::io::Error::last_os_error().into());
        }
        Ok(SystemResources {
            cpus,
            total: status.ullTotalPhys,
            available: status.ullAvailPhys,
        })
    }
    #[cfg(not(windows))]
    {
        let content = std::fs::read_to_string("/proc/meminfo")?;
        let bytes = |key: &str| -> Result<u64> {
            content
                .lines()
                .find_map(|line| {
                    let mut fields = line.split_whitespace();
                    if fields.next()? != key {
                        return None;
                    }
                    fields
                        .next()?
                        .parse::<u64>()
                        .ok()
                        .map(|kb| kb.saturating_mul(1024))
                })
                .ok_or_else(|| Error::bad("系统未提供物理内存数据"))
        };
        Ok(SystemResources {
            cpus,
            total: bytes("MemTotal:")?,
            available: bytes("MemAvailable:")?,
        })
    }
}
