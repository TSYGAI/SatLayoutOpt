//! 文件说明：硬件配置读取、关联校验、保留注释的原子保存与运行快照比较。
//! 仅修改白名单字段；版本摘要和跨进程文件锁防止覆盖其他页面或外部编辑，不热替换运行中任务预算。
use crate::{
    config::Config,
    error::{Error, Result},
    files, hardware_catalog, resource_budget,
};
use serde_json::{json, Map, Value};
use sha2::{Digest, Sha256};
use std::{
    fs::{self, File},
    io::Write,
    sync::Arc,
};
use toml_edit::Document;

/// 每个服务共享启动配置；磁盘值可以更新，当前会话始终使用同一资源合同。
pub struct HardwareConfig {
    config: Arc<Config>,
}

/// 计算原始 UTF-8 文件摘要，包括注释和无关字段，避免保存时覆盖外部编辑。
fn revision(text: &str) -> String {
    format!("{:x}", Sha256::digest(text.as_bytes()))
}

/// 按受控 section.key 读取值，不允许客户端提供任意文件或嵌套路径。
pub fn value<'a>(values: &'a Value, key: &str) -> &'a Value {
    let (section, name) = key.split_once('.').expect("目录中的字段路径合法");
    &values[section][name]
}

/// 只返回允许公开的字段值，完整配置及路径不会通过 API 暴露。
pub fn selected(values: &Value) -> Value {
    Value::Object(
        hardware_catalog::fields()
            .iter()
            .map(|field| (field.key.into(), value(values, field.key).clone()))
            .collect(),
    )
}

/// 按真实计算操作选择所属模块线程预算；布局数值池仍使用独立的进程和数值线程设置。
pub fn cad_threads(config: &Config, operation: &str, metadata: &Value) -> usize {
    let field = match operation {
        "preview.generate" if metadata["quality"] == "interaction" => {
            Some("upload_interaction_threads")
        }
        "preview.generate" => Some("upload_detail_threads"),
        "envelope.generate" => Some("envelope_threads"),
        "fairing.generate" | "fixed.preview" | "fixed.reference" | "fixed.display" => {
            Some("pre_config_threads")
        }
        "envelope.preview" | "envelope.export-stl" => Some("data_management_threads"),
        _ => None,
    };
    field
        .map(|name| config.integer("hardware", name))
        .unwrap_or_else(|| config.integer("rust_backend", "compute_cad_threads")) as usize
}

/// 对数组密集的固定显示与数据资源操作分配实际数值库线程，其他任务沿用全局数值线程。
pub fn numeric_threads(config: &Config, operation: &str) -> usize {
    let threads = match operation {
        "fixed.preview" | "fixed.display" => config.integer("hardware", "pre_config_threads"),
        "envelope.preview" | "envelope.export-stl" => {
            config.integer("hardware", "data_management_threads")
        }
        _ => config.integer("compute_engine", "numeric_threads_per_worker"),
    };
    threads as usize
}

/// 校验类型、范围和相互依赖；不改变既有几何精度或已保存模型设置。
pub fn validate(values: &Value) -> Result<()> {
    for field in hardware_catalog::fields() {
        let current = value(values, field.key);
        let valid = if field.kind == "select" {
            current
                .as_str()
                .is_some_and(|v| field.options.iter().any(|option| option.0 == v))
        } else {
            (field.kind != "integer" || current.as_u64().is_some())
                && current.as_f64().is_some_and(|v| {
                    v.is_finite() && v >= field.min * field.scale && v <= field.max * field.scale
                })
        };
        if !valid {
            return Err(Error::invalid(format!(
                "{}（{}）的类型或范围无效",
                field.label, field.key
            )));
        }
    }
    let n = |key: &str| value(values, key).as_f64().unwrap();
    for (lower, upper, message) in [
        (
            "rust_backend.compute_worker_cap",
            "compute_engine.max_workers",
            "布局进程上限不能大于引擎进程硬上限",
        ),
        (
            "frontend.preview_interaction_min_pixel_ratio",
            "frontend.preview_interaction_pixel_ratio",
            "最低交互像素比不能大于交互像素比",
        ),
        (
            "frontend.preview_interaction_pixel_ratio",
            "frontend.preview_idle_pixel_ratio_cap",
            "交互像素比不能大于静止像素比上限",
        ),
        (
            "frontend.layout_mesh_geometry_max_bytes",
            "frontend.layout_mesh_worker_max_bytes",
            "Worker 工作空间不能小于共享显示几何预算",
        ),
        (
            "frontend.fixed_display_download_max_bytes",
            "rust_backend.fixed_display_max_bytes",
            "固定显示下载上限不能大于后端资源上限",
        ),
    ] {
        if n(lower) > n(upper) {
            return Err(Error::invalid(message));
        }
    }
    let resource_limit = n("rust_backend.fixed_display_max_bytes");
    let mesh_limit = values["rust_backend"]["mesh_max_bytes"]
        .as_f64()
        .ok_or_else(|| Error::invalid("缺少网格资源上限"))?;
    if resource_limit > u32::MAX as f64 {
        return Err(Error::invalid("固定显示资源上限不能超过 4095 MiB"));
    }
    if n("rust_backend.mesh_cache_max_bytes") < resource_limit.max(mesh_limit) + 4096.0 {
        return Err(Error::invalid(
            "显示网格磁盘缓存必须至少容纳一个资源及 4096 字节索引",
        ));
    }
    if n("backend.model_envelope_workspace_memory_bytes")
        + n("rust_backend.compute_host_memory_bytes")
        >= n("backend.model_envelope_process_memory_limit_bytes")
    {
        return Err(Error::invalid(
            "包络进程上限必须大于单批工作空间与宿主基础内存之和，并为模型输入留出空间",
        ));
    }
    let scheduling = crate::hardware_scheduling::SchedulingPolicy::load(values)?;
    for (key, minimum) in [
        (
            "hardware.upload_interaction_threads",
            scheduling.interaction.minimum_threads,
        ),
        (
            "hardware.upload_detail_threads",
            scheduling.detail.minimum_threads,
        ),
        (
            "hardware.envelope_threads",
            scheduling.envelope.minimum_threads,
        ),
        (
            "hardware.pre_config_threads",
            scheduling.pre_config.minimum_threads,
        ),
        (
            "hardware.data_management_threads",
            scheduling.data.minimum_threads,
        ),
        (
            "rust_backend.compute_cad_threads",
            scheduling
                .layout
                .minimum_threads
                .max(scheduling.other.minimum_threads),
        ),
        (
            "compute_engine.numeric_threads_per_worker",
            scheduling.layout.minimum_threads,
        ),
    ] {
        if n(key) < minimum as f64 {
            return Err(Error::invalid(format!(
                "{key} 不能低于该功能的最低线程配置 {minimum}"
            )));
        }
    }
    if n("backend.model_envelope_process_memory_limit_bytes")
        < scheduling.envelope.minimum_memory_bytes as f64
    {
        return Err(Error::invalid("包络进程上限不能低于包络功能的最低内存配置"));
    }
    Ok(())
}

/// 根据当前服务器资源提供调参提示；不把瞬时可用内存伪装成硬件额定容量。
fn warnings(values: &Value, system: resource_budget::SystemResources) -> Vec<String> {
    let mut messages = vec![];
    let n = |key: &str| value(values, key).as_f64().unwrap_or(0.0);
    let cpu = (system.cpus as f64 - n("rust_backend.compute_cpu_reserve")).max(1.0);
    if n("rust_backend.compute_worker_cap") * n("compute_engine.numeric_threads_per_worker") > cpu {
        messages
            .push("数值进程数 × 每进程线程数超过可用 CPU 槽位，调度器会降低实际进程数。".into());
    }
    if n("compute_engine.numeric_threads_per_worker") > cpu {
        messages.push(
            "每数值进程线程数超过当前可用 CPU 槽位，布局任务将无法准入；请减少线程或系统保留核数。"
                .into(),
        );
    }
    if n("rust_backend.compute_memory_reserve_bytes") + n("rust_backend.compute_host_memory_bytes")
        >= system.available as f64
    {
        messages.push(
            "当前可用内存不足以覆盖系统预留与计算宿主，任务可能持续等待；请降低预留或释放内存。"
                .into(),
        );
    }
    let memory = n("rust_backend.compute_memory_fraction") * system.total as f64
        - resource_budget::application_memory_reserve(values).unwrap_or(0) as f64;
    if n("backend.model_envelope_workspace_memory_bytes")
        + n("rust_backend.compute_host_memory_bytes")
        >= memory
    {
        messages.push(
            "全软件内存预算扣除界面、缓存后不足以容纳包络工作空间与宿主，包络任务可能持续等待。"
                .into(),
        );
    }
    messages
}

impl HardwareConfig {
    /// 绑定当前服务的不可变启动配置，不重复创建数据库或计算引擎。
    pub fn new(config: Arc<Config>) -> Self {
        Self { config }
    }

    /// 读取磁盘值、当前运行值与真实资源信息，任何配置解析错误都明确返回。
    pub fn read(&self) -> Result<Value> {
        let text = fs::read_to_string(self.config.root.join("config/sat_layout_opt.toml"))?;
        self.describe(&text)
    }

    /// 点击后生成三档全软件建议；仅读取硬件和文件，版本用于后续显式保存时检查。
    pub fn recommend(&self) -> Result<Value> {
        let text = fs::read_to_string(self.config.root.join("config/sat_layout_opt.toml"))?;
        let saved: toml::Value = toml::from_str(&text)
            .map_err(|_| Error::conflict("配置文件不是有效 TOML，请先修复文件再生成推荐"))?;
        let saved = serde_json::to_value(saved)?;
        validate(&saved)?;
        let system = resource_budget::system_resources()?;
        let mut recommendation = crate::hardware_recommendation::plans(&saved, system)?;
        recommendation["revision"] = json!(revision(&text));
        recommendation["hardware"] = json!({"logical_cpus":system.cpus,"total_memory_bytes":system.total,"available_memory_bytes":system.available});
        recommendation["summary"] = json!(format!(
            "计算服务所在电脑：{} 个逻辑处理器，{:.1} GiB 内存；当前可用 {:.1} GiB。",
            system.cpus,
            system.total as f64 / 1_073_741_824.0,
            system.available as f64 / 1_073_741_824.0
        ));
        Ok(recommendation)
    }

    /// 生成前端视图模型；只有白名单字段参与保存和重启待生效比较。
    fn describe(&self, text: &str) -> Result<Value> {
        let saved: toml::Value = toml::from_str(text)
            .map_err(|_| Error::conflict("配置文件不是有效 TOML，请先修复文件再重新读取"))?;
        let saved = serde_json::to_value(saved)?;
        validate(&saved)?;
        let values = selected(&saved);
        let active = selected(&self.config.values);
        let pending: Vec<_> = hardware_catalog::fields()
            .iter()
            .filter(|f| values[f.key] != active[f.key])
            .map(|f| f.key)
            .collect();
        let system = resource_budget::system_resources()?;
        Ok(
            json!({"revision":revision(text),"values":values,"active_values":active,"pending_keys":pending,
            "restart_required":!pending.is_empty(),"apply_mode":"restart",
            "modules":hardware_catalog::modules(),"fields":hardware_catalog::fields(),
            "hardware":{"logical_cpus":system.cpus,"total_memory_bytes":system.total,"available_memory_bytes":system.available},
            "warnings":warnings(&saved,system),"config_file":"config/sat_layout_opt.toml"}),
        )
    }

    /// 校验并原子保存增量，保留注释、无关键和原文件换行；冲突或失败时不发布半份配置。
    pub fn save(&self, request: &Value) -> Result<Value> {
        crate::api::fields(request, &["revision", "changes"])?;
        let expected = request["revision"]
            .as_str()
            .ok_or_else(|| Error::invalid("缺少配置版本"))?;
        let changes = request["changes"]
            .as_object()
            .filter(|v| !v.is_empty())
            .ok_or_else(|| Error::invalid("changes 必须是非空对象"))?;
        let catalog = hardware_catalog::fields();
        if changes
            .keys()
            .any(|key| !catalog.iter().any(|field| field.key == key))
        {
            return Err(Error::invalid("请求包含不可编辑的配置项"));
        }
        // 锁放在统一项目数据目录，使浏览器开发与桌面数据根不同的服务也能互斥写同一配置。
        let lock_path = self.config.root.join("data/processed/hardware-config.lock");
        fs::create_dir_all(lock_path.parent().unwrap())?;
        let lock = File::options()
            .read(true)
            .write(true)
            .create(true)
            .truncate(false)
            .open(lock_path)?;
        lock.try_lock()
            .map_err(|_| Error::conflict("其他服务正在保存配置，请稍后重新读取"))?;
        let path = self.config.root.join("config/sat_layout_opt.toml");
        let before = fs::read_to_string(&path)?;
        if revision(&before) != expected {
            return Err(Error::conflict(
                "配置文件已被其他页面或程序修改，请重新读取后再保存",
            ));
        }
        let mut document: Document = before
            .parse()
            .map_err(|_| Error::conflict("配置文件解析失败"))?;
        let mut values: Value =
            serde_json::to_value(toml::from_str::<toml::Value>(&before).map_err(Error::bad)?)?;
        for (key, current) in changes {
            let (section, name) = key.split_once('.').unwrap();
            values[section][name] = current.clone();
        }
        validate(&values)?;
        for (key, current) in changes {
            let (section, name) = key.split_once('.').unwrap();
            let item = document
                .get_mut(section)
                .and_then(|v| v.get_mut(name))
                .and_then(|v| v.as_value_mut())
                .ok_or_else(|| Error::conflict(format!("配置缺少 {key}，请重启应用补齐配置")))?;
            let mut updated = if let Some(v) = current.as_str() {
                toml_edit::Value::from(v)
            } else if let Some(v) = current.as_u64() {
                toml_edit::Value::from(v as i64)
            } else {
                toml_edit::Value::from(current.as_f64().unwrap())
            };
            *updated.decor_mut() = item.decor().clone();
            *item = updated;
        }
        let after = document.to_string();
        let after = if before.contains("\r\n") {
            after.replace("\r\n", "\n").replace('\n', "\r\n")
        } else {
            after
        };
        // 响应和资源采样在落盘前准备，避免磁盘已经保存成功却因采样失败报告保存失败。
        let result = self.describe(&after)?;
        let backup = self
            .config
            .data
            .join("data/history/hardware-config")
            .join(format!("{}.toml", files::identifier()));
        fs::create_dir_all(backup.parent().unwrap())?;
        fs::write(&backup, &before)?;
        let temporary = path.with_extension(format!("{}.tmp", files::identifier()));
        let publish = (|| -> Result<()> {
            let mut file = File::create(&temporary)?;
            file.write_all(after.as_bytes())?;
            file.sync_all()?;
            if fs::read_to_string(&path)? != before {
                return Err(Error::conflict("保存过程中配置被外部修改，本次保存已取消"));
            }
            files::replace(&temporary, &path)
        })();
        let _ = fs::remove_file(temporary);
        publish?;
        Ok(result)
    }

    /// 返回启动时已生效的前端性能值；生产包无需重新构建即可读取重启后的配置。
    pub fn runtime(&self) -> Value {
        let values: Map<String, Value> = hardware_catalog::fields()
            .iter()
            .filter(|f| f.key.starts_with("frontend."))
            .map(|f| (f.key.into(), value(&self.config.values, f.key).clone()))
            .collect();
        json!({"values":values})
    }
}
