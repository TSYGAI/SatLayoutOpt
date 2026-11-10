//! 文件说明：集中读取功能需求与优先级，供推荐和真实计算队列共用；不固定瓜分资源，不抢占已运行进程。
use crate::{
    error::{Error, Result},
    resource_budget::{
        choose_envelope_workers, choose_workers, EnvelopeLimits, SystemResources, WorkerLimits,
        WorkerPlan,
    },
};
use serde::Deserialize;
use serde_json::Value;
use std::{collections::HashMap, time::Instant};

/// 单类功能的相对重要程度及 CPU 需求上限，所有参数来自统一 TOML。
#[derive(Clone, Copy, Deserialize)]
pub struct Profile {
    pub priority: u64,
    pub cpu_fraction: f64,
    pub thread_cap: usize,
    pub minimum_threads: usize,
    pub minimum_memory_bytes: u64,
}
impl Profile {
    /// 按工作特征估算线程需求；这是可复用的申请上限，不为闲置模块占用槽位。
    pub fn threads(&self, cpu_slots: usize) -> usize {
        ((cpu_slots as f64 * self.cpu_fraction).floor() as usize)
            .max(self.minimum_threads)
            .min(self.thread_cap)
            .min(cpu_slots.max(1))
    }
}

/// 统一功能优先级以及排队老化策略；缺失配置时拒绝隐式使用未知默认值。
#[derive(Deserialize)]
pub struct SchedulingPolicy {
    pub aging_interval_seconds: u64,
    pub aging_priority_step: u64,
    pub interaction: Profile,
    pub pre_config: Profile,
    pub layout: Profile,
    pub envelope: Profile,
    pub detail: Profile,
    pub data: Profile,
    pub other: Profile,
}
impl SchedulingPolicy {
    /// 读取并检查集中策略，非法参数返回可展示的配置错误。
    pub fn load(values: &Value) -> Result<Self> {
        let policy: Self = serde_json::from_value(values["hardware"]["scheduling"].clone())
            .map_err(|_| Error::invalid("硬件功能调度策略缺失或类型错误"))?;
        if policy.aging_interval_seconds == 0
            || policy.aging_priority_step == 0
            || [
                policy.interaction,
                policy.pre_config,
                policy.layout,
                policy.envelope,
                policy.detail,
                policy.data,
                policy.other,
            ]
            .iter()
            .any(|p| {
                p.priority > 1000
                    || p.thread_cap == 0
                    || p.thread_cap > 256
                    || p.minimum_threads == 0
                    || p.minimum_threads > p.thread_cap
                    || p.minimum_memory_bytes == 0
                    || !p.cpu_fraction.is_finite()
                    || p.cpu_fraction <= 0.0
                    || p.cpu_fraction > 1.0
            })
        {
            return Err(Error::invalid(
                "硬件功能调度优先级、线程需求或等待老化参数无效",
            ));
        }
        Ok(policy)
    }

    /// 将实际计算操作映射到功能；模型上传两阶段根据真实质量参数区分。
    pub fn profile(&self, operation: &str, metadata: &Value) -> Profile {
        match operation {
            "preview.generate" if metadata["quality"] == "interaction" => self.interaction,
            "preview.generate" => self.detail,
            "envelope.generate" => self.envelope,
            "fairing.generate" | "fixed.preview" | "fixed.reference" | "fixed.display" => {
                self.pre_config
            }
            "envelope.preview" | "envelope.export-stl" => self.data,
            value if value.starts_with("layout.") => self.layout,
            _ => self.other,
        }
    }

    /// 判断等待者是否应先运行；高优先级先行，长时间等待逐步提高优先级，同分按入队时间。
    pub fn precedes(&self, other: (u64, Instant), current: (u64, Instant), now: Instant) -> bool {
        let score = |(priority, at): (u64, Instant)| {
            priority.saturating_add(
                (now.saturating_duration_since(at).as_secs() / self.aging_interval_seconds)
                    .saturating_mul(self.aging_priority_step),
            )
        };
        score(other) > score(current) || (score(other) == score(current) && other.1 < current.1)
    }
}

/// 一个任务的可伸缩申请；最低工作集按真实输入和配置底线共同决定，而非平均分配。
#[derive(Clone, Copy)]
pub struct Demand {
    pub limits: WorkerLimits,
    pub solve: bool,
    pub input_bytes: u64,
    pub observed_worker_bytes: u64,
    pub envelope: Option<EnvelopeLimits>,
    pub minimum_threads: usize,
    pub minimum_memory_bytes: u64,
}
impl Demand {
    /// 在剩余预算内取得最低配置或扩展配置；低于配置底线和模型估算时返回零进程。
    pub fn plan(
        &self,
        system: SystemResources,
        cpu: usize,
        memory: u64,
        minimum: bool,
    ) -> WorkerPlan {
        let mut limits = self.limits;
        let extra = self.input_bytes.saturating_mul(limits.input_memory_factor);
        let worker = if self.solve {
            limits
                .worker_memory_bytes
                .max(self.observed_worker_bytes)
                .saturating_add(extra)
        } else {
            0
        };
        let workspace = self.envelope.map_or(0, |e| e.workspace_bytes);
        limits.host_memory_bytes = limits.host_memory_bytes.max(
            self.minimum_memory_bytes
                .saturating_sub(worker)
                .saturating_sub(extra)
                .saturating_sub(workspace),
        );
        if minimum {
            limits.worker_cap = 1;
            limits.cad_threads = self.minimum_threads;
        }
        let mut plan = if let Some(envelope) = self.envelope {
            if minimum {
                limits.host_memory_bytes = limits.host_memory_bytes.saturating_add(workspace);
                choose_workers(system, cpu, memory, limits, false, self.input_bytes, 0)
            } else {
                choose_envelope_workers(system, cpu, memory, limits, self.input_bytes, envelope)
            }
        } else {
            choose_workers(
                system,
                cpu,
                memory,
                limits,
                self.solve,
                self.input_bytes,
                self.observed_worker_bytes,
            )
        };
        if plan.cpu_slots < self.minimum_threads
            || plan.budget_bytes < self.minimum_memory_bytes
            || self
                .envelope
                .is_some_and(|e| plan.budget_bytes > e.process_memory_bytes)
        {
            plan.workers = 0;
            plan.cpu_slots = 0;
            plan.budget_bytes = 0;
        }
        plan
    }
}

/// 已准备好输入、等待准入的任务，优先级只影响不足时的选择与额外资源，不串行阻断其他功能。
pub struct WaitingTask<'a> {
    pub id: &'a str,
    pub priority: u64,
    pub queued_at: Instant,
    pub demand: Demand,
}

/// 先尽量满足多个任务的最低工作集，再按重要程度分配剩余资源；始终合计所有运行和待准入任务。
pub fn allocate_waiting(
    system: SystemResources,
    running: (usize, u64),
    free_tasks: usize,
    mut waiting: Vec<WaitingTask<'_>>,
    policy: &SchedulingPolicy,
    now: Instant,
) -> HashMap<String, WorkerPlan> {
    waiting.sort_by(|a, b| {
        let a_rank = (a.priority, a.queued_at);
        let b_rank = (b.priority, b.queued_at);
        if policy.precedes(a_rank, b_rank, now) {
            std::cmp::Ordering::Less
        } else if policy.precedes(b_rank, a_rank, now) {
            std::cmp::Ordering::Greater
        } else {
            a.id.cmp(b.id)
        }
    });
    let mut plans = HashMap::new();
    let (mut cpu, mut memory) = running;
    for task in &waiting {
        if plans.len() >= free_tasks {
            break;
        }
        let plan = task.demand.plan(system, cpu, memory, true);
        if plan.workers > 0 {
            cpu += plan.cpu_slots;
            memory += plan.budget_bytes;
            plans.insert(task.id.to_string(), plan);
        }
    }
    for task in &waiting {
        if let Some(minimum) = plans.get(task.id).copied() {
            let expanded = task.demand.plan(
                system,
                cpu - minimum.cpu_slots,
                memory - minimum.budget_bytes,
                false,
            );
            if expanded.workers > 0
                && expanded.cpu_slots >= minimum.cpu_slots
                && expanded.budget_bytes >= minimum.budget_bytes
            {
                cpu = cpu - minimum.cpu_slots + expanded.cpu_slots;
                memory = memory - minimum.budget_bytes + expanded.budget_bytes;
                plans.insert(task.id.to_string(), expanded);
            }
        }
    }
    plans
}
