//! 文件说明：按整机容量生成三档共享资源建议，扣除界面与缓存余量后按功能需求推导参数；只读配置，不写文件。
use crate::{
    error::{Error, Result},
    hardware_catalog, hardware_config,
    hardware_scheduling::SchedulingPolicy,
    resource_budget::{application_memory_reserve, SystemResources},
};
use serde::Deserialize;
use serde_json::{json, Map, Value};

#[path = "hardware_recommendation_resources.rs"]
mod resources;

/// 可维护的推荐策略；容量为字节，比例为零到一的小数，限制来自统一配置。
#[derive(Deserialize)]
struct Policy {
    resource_fractions: [f64; 3],
    default_tier_index: usize,
    application_cpu_slots: usize,
    memory_reserve_fraction: f64,
    memory_reserve_min_bytes: u64,
    memory_reserve_max_bytes: u64,
    numeric_threads: usize,
    worker_cap: usize,
    concurrent_tasks_cap: usize,
    task_headroom_bytes: u64,
    envelope_memory_fraction: f64,
    envelope_memory_max_bytes: u64,
}
impl Policy {
    /// 严格读取并校验策略，缺失或错误时返回可展示异常，避免隐藏硬编码默认值。
    fn load(values: &Value) -> Result<Self> {
        let policy: Self = serde_json::from_value(values["hardware"]["recommendation"].clone())
            .map_err(|_| {
                Error::invalid(
                    "硬件推荐策略缺失或类型错误，请检查统一 TOML 的 hardware.recommendation",
                )
            })?;
        if [
            policy.memory_reserve_fraction,
            policy.envelope_memory_fraction,
        ]
        .iter()
        .any(|v| !v.is_finite() || *v <= 0.0 || *v >= 1.0)
            || [
                policy.numeric_threads,
                policy.worker_cap,
                policy.concurrent_tasks_cap,
            ]
            .iter()
            .any(|v| *v == 0 || *v > 256)
            || policy.memory_reserve_min_bytes == 0
            || policy.memory_reserve_min_bytes > policy.memory_reserve_max_bytes
            || policy.task_headroom_bytes == 0
            || policy.envelope_memory_max_bytes == 0
            || policy.default_tier_index >= policy.resource_fractions.len()
            || policy.application_cpu_slots > 256
            || policy
                .resource_fractions
                .iter()
                .any(|v| !v.is_finite() || *v <= 0.0 || *v >= 1.0)
            || policy.resource_fractions.windows(2).any(|v| v[0] >= v[1])
        {
            return Err(Error::invalid("硬件推荐策略的比例或资源上限无效"));
        }
        Ok(policy)
    }
}

/// 返回全部推荐字段；按总内存计算稳定建议，瞬时可用内存由实时调度再次限制。
pub fn recommended_values(
    values: &Value,
    system: SystemResources,
    fraction: f64,
) -> Result<Map<String, Value>> {
    let policy = Policy::load(values)?;
    let scheduling = SchedulingPolicy::load(values)?;
    let resource_policy = resources::ResourcePolicy::load(values)?;
    if !policy.resource_fractions.contains(&fraction) {
        return Err(Error::invalid("推荐档位不在统一策略允许的范围内"));
    }
    if system.cpus == 0 || system.total == 0 {
        return Err(Error::invalid(
            "未读取到有效的 CPU 或物理内存，无法生成推荐",
        ));
    }
    let application_cpu = ((system.cpus as f64 * fraction).floor() as usize).max(1);
    let usable_cpu = application_cpu
        .saturating_sub(policy.application_cpu_slots)
        .max(1);
    let reserve_cpu = system.cpus - usable_cpu;
    let numeric_threads = policy
        .numeric_threads
        .max(scheduling.layout.minimum_threads)
        .min(usable_cpu);
    let reserve = ((system.total as f64 * policy.memory_reserve_fraction) as u64)
        .clamp(
            policy.memory_reserve_min_bytes,
            policy.memory_reserve_max_bytes,
        )
        .div_ceil(1_048_576)
        * 1_048_576;
    let mut targets =
        resource_policy.memory_values(values, (system.total as f64 * fraction) as u64)?;
    let mut candidate = values.clone();
    resources::apply(&mut candidate, &targets);
    let capacity = system.total.saturating_sub(reserve).min(
        ((system.total as f64 * fraction) as u64)
            .saturating_sub(application_memory_reserve(&candidate)?),
    );
    targets.extend(resource_policy.envelope_values(capacity)?);
    resources::apply(&mut candidate, &targets);
    let host = values["rust_backend"]["compute_host_memory_bytes"]
        .as_u64()
        .ok_or_else(|| Error::invalid("缺少计算宿主内存预算"))?;
    let worker = values["rust_backend"]["compute_worker_memory_bytes"]
        .as_u64()
        .filter(|v| *v > 0)
        .ok_or_else(|| Error::invalid("缺少数值进程内存预算"))?;
    let workspace = candidate["backend"]["model_envelope_workspace_memory_bytes"]
        .as_u64()
        .ok_or_else(|| Error::invalid("缺少包络工作空间预算"))?;
    let coordinator = usize::from(usable_cpu > numeric_threads);
    let cpu_workers = (usable_cpu - coordinator) / numeric_threads;
    let memory_workers = capacity
        .saturating_sub(host)
        .saturating_sub(policy.task_headroom_bytes)
        / worker;
    let engine_cap = values["compute_engine"]["max_workers"]
        .as_u64()
        .ok_or_else(|| Error::invalid("缺少引擎进程硬上限"))? as usize;
    let worker_cap = cpu_workers
        .min(memory_workers as usize)
        .min(engine_cap)
        .min(policy.worker_cap);
    let minimum_envelope = host
        .saturating_add(workspace)
        .saturating_add(policy.task_headroom_bytes);
    if worker_cap == 0
        || capacity < minimum_envelope
        || policy.envelope_memory_max_bytes < minimum_envelope
        || [
            scheduling.interaction,
            scheduling.pre_config,
            scheduling.layout,
            scheduling.envelope,
            scheduling.detail,
            scheduling.data,
            scheduling.other,
        ]
        .iter()
        .any(|p| capacity < p.minimum_memory_bytes || usable_cpu < p.minimum_threads)
    {
        return Err(Error::invalid(
            "该档位扣除推荐缓存与显示空间后，不足以容纳宿主、包络工作空间和输入余量；请选择更高档位或检查高级资源预算",
        ));
    }
    let concurrent_tasks = usable_cpu
        .min(policy.concurrent_tasks_cap)
        .min((capacity / host.saturating_add(policy.task_headroom_bytes)) as usize)
        .max(1);
    let envelope_limit = (((capacity as f64 * policy.envelope_memory_fraction) as u64)
        .min(policy.envelope_memory_max_bytes)
        / 1_048_576
        * 1_048_576)
        .max(minimum_envelope)
        .max(scheduling.envelope.minimum_memory_bytes);
    if envelope_limit > policy.envelope_memory_max_bytes || envelope_limit > capacity {
        return Err(Error::invalid("包络最低工作集超过该档总预算或进程上限"));
    }
    targets.extend(Map::from_iter([
        (
            "rust_backend.compute_cpu_reserve".into(),
            json!(reserve_cpu),
        ),
        (
            "rust_backend.compute_memory_reserve_bytes".into(),
            json!(reserve),
        ),
        (
            "rust_backend.compute_memory_fraction".into(),
            json!(fraction),
        ),
        ("rust_backend.compute_worker_cap".into(), json!(worker_cap)),
        (
            "compute_engine.numeric_threads_per_worker".into(),
            json!(numeric_threads),
        ),
        (
            "hardware.max_concurrent_tasks".into(),
            json!(concurrent_tasks),
        ),
        (
            "backend.model_envelope_memory_reserve_bytes".into(),
            json!(reserve),
        ),
        (
            "backend.model_envelope_process_memory_limit_bytes".into(),
            json!(envelope_limit),
        ),
    ]));
    for (key, profile) in [
        ("rust_backend.compute_cad_threads", scheduling.layout),
        (
            "hardware.upload_interaction_threads",
            scheduling.interaction,
        ),
        ("hardware.upload_detail_threads", scheduling.detail),
        ("hardware.envelope_threads", scheduling.envelope),
        ("hardware.pre_config_threads", scheduling.pre_config),
        ("hardware.data_management_threads", scheduling.data),
    ] {
        targets.insert(key.into(), json!(profile.threads(usable_cpu)));
    }
    resources::apply(&mut candidate, &targets);
    hardware_config::validate(&candidate)?;
    Ok(targets)
}

/// 一次生成三档方案；资源不足的档位单独禁用，保留另外两档及原因，绝不自动改选或保存。
pub fn plans(values: &Value, system: SystemResources) -> Result<Value> {
    let policy = Policy::load(values)?;
    let scheduling = SchedulingPolicy::load(values)?;
    resources::ResourcePolicy::load(values)?;
    if system.cpus == 0 || system.total == 0 {
        return Err(Error::invalid(
            "未读取到有效的 CPU 或物理内存，无法生成推荐",
        ));
    }
    let mut tiers = Vec::new();
    for (index, (id, label, description)) in [
        ("low", "低档", "轻量共用 · 为其他软件留出更多空间"),
        ("balanced", "中档", "日常平衡 · 兼顾响应与计算效率"),
        ("high", "高档", "集中计算 · 适合较少同时使用其他软件"),
    ]
    .into_iter()
    .enumerate()
    {
        let fraction = policy.resource_fractions[index];
        let mut tier = json!({"id":id,"label":label,"description":description,"fraction":fraction,
            "application_cpu_slots":((system.cpus as f64 * fraction).floor() as usize).max(1),
            "memory_budget_bytes":(system.total as f64 * fraction) as u64});
        match recommended_values(values, system, fraction) {
            Ok(targets) => {
                let mut candidate = values.clone();
                resources::apply(&mut candidate, &targets);
                tier["application_memory_bytes"] = json!(application_memory_reserve(&candidate)?);
                let mut items = Vec::new();
                for field in hardware_catalog::fields() {
                    if let Some(target) = targets.get(field.key) {
                        items.push(
                            json!({"key":field.key,"from":hardware_config::value(values,field.key),
                            "to":target,"reason":reason(field.key)}),
                        );
                    }
                }
                tier["available"] = json!(true);
                tier["cpu_slots"] = json!(
                    system.cpus
                        - targets["rust_backend.compute_cpu_reserve"]
                            .as_u64()
                            .unwrap() as usize
                );
                tier["concurrent_tasks"] = targets["hardware.max_concurrent_tasks"].clone();
                tier["workers"] = targets["rust_backend.compute_worker_cap"].clone();
                let reserve = targets["rust_backend.compute_memory_reserve_bytes"]
                    .as_u64()
                    .unwrap();
                tier["memory_reserve_bytes"] = json!(reserve);
                tier["notes"] = json!(if system.available
                    < reserve
                        + values["rust_backend"]["compute_host_memory_bytes"]
                            .as_u64()
                            .unwrap()
                {
                    vec!["当前空闲内存偏低；运行时会等待资源或减少并发。"]
                } else {
                    vec![]
                });
                tier["items"] = json!(items);
                tier["allocation"] = json!([
                    ("模型上传 · 第一阶段", "hardware.upload_interaction_threads", scheduling.interaction),
                    ("前置配置", "hardware.pre_config_threads", scheduling.pre_config),
                    ("布局求解", "rust_backend.compute_cad_threads", scheduling.layout),
                    ("包络生成", "hardware.envelope_threads", scheduling.envelope),
                    ("模型上传 · 第二阶段", "hardware.upload_detail_threads", scheduling.detail),
                    ("数据管理", "hardware.data_management_threads", scheduling.data),
                ].into_iter().map(|(label, key, p)| json!({"label":label,"priority":p.priority,
                    "minimum_threads":p.minimum_threads,"minimum_memory_bytes":p.minimum_memory_bytes,
                    "threads":targets[key]})).collect::<Vec<_>>());
            }
            Err(error) => {
                tier["available"] = json!(false);
                tier["unavailable_reason"] = json!(error.message);
                tier["items"] = json!([]);
            }
        }
        tiers.push(tier);
    }
    Ok(
        json!({"default_tier_id":tiers[policy.default_tier_index]["id"],"tiers":tiers,
        "notes":[
            "所有模块共享所选总预算：先留出界面与缓存空间，再按任务需求申请剩余资源，不平均分配。",
            "先满足多个任务的最低工作集，再按功能重要程度分配剩余资源；资源充足时上传与包络可并行，资源不足才排队，久候任务逐步提高优先级。已运行任务不被抢占。",
            "最低工作集是配置与输入估算的下限，大模型会追加申请；不是任意模型都能在固定内存内稳定运行的保证。",
            "这是资源预算估算，不是任务管理器占用率的硬限制；小型 CPU 至少使用一个计算槽位。缓存、显示工作空间和包络批次随档位推荐，渲染方式、像素比与等待时间沿用原值。",
            "确认仅应用到编辑草稿；保存后写入配置，重启应用生效。"
        ]}),
    )
}

/// 解释推荐的资源关系；描述与实际调度职责一致，不承诺未经基准测试的加速倍数。
pub fn reason(key: &str) -> &'static str {
    match key {
        "rust_backend.compute_cpu_reserve" => {
            "按所选档位控制所有任务共享的 CPU 槽位，并为软件界面预留；小型电脑至少一个计算槽位。"
        }
        "rust_backend.compute_memory_reserve_bytes"
        | "backend.model_envelope_memory_reserve_bytes" => {
            "在实时可用内存中留出安全余量；已占用内存仍由全局调度检查。"
        }
        "rust_backend.compute_memory_fraction" => {
            "全软件共享总预算，扣除界面、缓存与显示工作空间后才供计算任务使用。"
        }
        "rust_backend.compute_worker_cap" => "同时考虑 CPU 协调槽位、进程内存估计和引擎硬上限。",
        "compute_engine.numeric_threads_per_worker" => {
            "布局以多进程并行，限制单进程数值线程以避免嵌套争用。"
        }
        "hardware.max_concurrent_tasks" => "结合 CPU 和宿主内存预算控制同时运行的任务数。",
        "backend.model_envelope_process_memory_limit_bytes" => {
            "给包络分配整机预算的一部分，并容纳工作空间与输入余量。"
        }
        "hardware.upload_interaction_threads" => "快速预览优先响应操作，按网格生成需求申请线程。",
        "hardware.upload_detail_threads" => {
            "细节处理包含串行步骤，采用较低线程需求并让位于交互任务。"
        }
        "hardware.envelope_threads" => "包络是核心重计算，可申请较多剩余线程；内存另外按批次控制。",
        "hardware.pre_config_threads" => "前置设置优先保障响应，按 CAD 与数值操作需要申请线程。",
        "hardware.data_management_threads" => {
            "数据生成与导出采用较少线程，不为未运行模块预占资源。"
        }
        "frontend.preview_cache_model_limit" => {
            "按推荐数组缓存与单模型估计容量推导；实际同时受模型数量和缓存字节预算限制。"
        }
        "frontend.preview_cache_max_bytes" | "frontend.data_management_cache_max_bytes" => {
            "按所选档位的内存预算设置缓存，并先从计算可用容量中扣除。"
        }
        "frontend.layout_mesh_geometry_max_bytes" | "frontend.layout_mesh_worker_max_bytes" => {
            "按内存容量推荐共享显示与网格工作空间，两项合计纳入软件总预算。"
        }
        "frontend.fixed_display_download_max_bytes" | "rust_backend.fixed_display_max_bytes" => {
            "与推荐显示几何预算同步，保证前端下载和后端单资源上限一致。"
        }
        "backend.model_preview_runtime_cache_max_bytes"
        | "rust_backend.fixed_preview_cache_max_bytes"
        | "rust_backend.mesh_cache_max_bytes"
        | "rust_backend.prepared_cache_max_bytes" => {
            "随档位处理规模推荐磁盘缓存容量，不计入常驻内存；显示缓存同时容纳资源及索引。"
        }
        "backend.model_envelope_workspace_memory_bytes" => {
            "按扣除界面与缓存后的计算容量推荐单批空间，并为宿主和输入保留余量。"
        }
        "backend.model_envelope_voxel_max_cells"
        | "backend.model_envelope_surface_batch_cells"
        | "backend.model_envelope_raster_triangle_batch"
        | "backend.model_envelope_raster_batch_cells" => {
            "按推荐工作空间与各阶段数组开销计算批次上限，保持模型分辨率和总处理范围。"
        }
        _ => "按功能并行需求申请资源，最终使用量受全局剩余预算限制。",
    }
}
