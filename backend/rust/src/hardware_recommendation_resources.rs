//! 文件说明：按统一 TOML 策略推导缓存、显示空间与包络分批预算，供硬件推荐使用。
//! 先核算软件常驻预算，再按剩余计算容量估算包络工作集；不修改显示质量或模型精度。
use crate::{
    error::{Error, Result},
    hardware_config,
};
use serde::Deserialize;
use serde_json::{json, Map, Value};

const MIB: u64 = 1_048_576;

/// 单项内存预算规则；比例相对于所属资源池，边界和粒度统一以 MiB 配置。
#[derive(Clone, Copy, Deserialize)]
struct MemoryRule {
    fraction: f64,
    min_mib: u64,
    max_mib: u64,
    step_mib: u64,
}
impl MemoryRule {
    /// 检查比例、边界及对齐粒度，避免无效策略造成溢出或隐式截断。
    fn valid(self) -> bool {
        self.fraction.is_finite()
            && self.fraction > 0.0
            && self.fraction <= 1.0
            && self.step_mib > 0
            && self.min_mib > 0
            && self.min_mib <= self.max_mib
            && self.max_mib <= u64::MAX / MIB
            && self.min_mib.is_multiple_of(self.step_mib)
            && self.max_mib.is_multiple_of(self.step_mib)
    }

    /// 在所属容量内按比例估计并向下对齐；调用者负责核验各项合计预算。
    fn bytes(self, capacity: u64) -> u64 {
        let mib = ((capacity as f64 * self.fraction / MIB as f64) as u64)
            .clamp(self.min_mib, self.max_mib);
        mib / self.step_mib * self.step_mib * MIB
    }
}

/// 包络批次规则；单位内存估计与算法工作集对应，限制单批而不改变总几何单元数。
#[derive(Clone, Copy, Deserialize)]
struct BatchRule {
    fraction: f64,
    bytes_per_item: u64,
    minimum: u64,
    maximum: u64,
    step: u64,
}
impl BatchRule {
    /// 检查分批策略的计量单位和边界；非法值拒绝生成推荐。
    fn valid(self) -> bool {
        self.fraction.is_finite()
            && self.fraction > 0.0
            && self.fraction <= 1.0
            && self.bytes_per_item > 0
            && self.minimum > 0
            && self.minimum <= self.maximum
            && self.step > 0
            && self.minimum.is_multiple_of(self.step)
            && self.maximum.is_multiple_of(self.step)
            && self.maximum.checked_mul(self.bytes_per_item).is_some()
    }

    /// 根据工作空间推导批次数量；最低批次也容纳不下时返回资源不足。
    fn count(self, workspace: u64) -> Result<u64> {
        let count = ((workspace as f64 * self.fraction / self.bytes_per_item as f64) as u64)
            .clamp(self.minimum, self.maximum)
            / self.step
            * self.step;
        if count * self.bytes_per_item > workspace {
            return Err(Error::invalid("包络工作空间不足以容纳策略要求的最小批次"));
        }
        Ok(count)
    }
}

/// 所有资源推荐参数集中读取；磁盘缓存上限按处理规模估算，不声称探测了磁盘剩余容量。
#[derive(Deserialize)]
pub(super) struct ResourcePolicy {
    preview_cache: MemoryRule,
    data_cache: MemoryRule,
    display_geometry: MemoryRule,
    display_worker: MemoryRule,
    preview_disk: MemoryRule,
    fixed_preview_disk: MemoryRule,
    display_disk: MemoryRule,
    prepared_disk: MemoryRule,
    preview_model_bytes: u64,
    preview_model_cap: u64,
    envelope_workspace: MemoryRule,
    voxel_batch: BatchRule,
    surface_batch: BatchRule,
    raster_batch: BatchRule,
    triangle_batch: BatchRule,
}
impl ResourcePolicy {
    /// 严格读取资源策略并校验；缺失时报告统一配置错误，不使用隐含默认值。
    pub(super) fn load(values: &Value) -> Result<Self> {
        let policy: Self =
            serde_json::from_value(values["hardware"]["recommendation"]["resources"].clone())
                .map_err(|_| Error::invalid("硬件缓存与批次推荐策略缺失或类型错误"))?;
        if ![
            policy.preview_cache,
            policy.data_cache,
            policy.display_geometry,
            policy.display_worker,
            policy.preview_disk,
            policy.fixed_preview_disk,
            policy.display_disk,
            policy.prepared_disk,
            policy.envelope_workspace,
        ]
        .into_iter()
        .all(MemoryRule::valid)
            || ![
                policy.voxel_batch,
                policy.surface_batch,
                policy.raster_batch,
                policy.triangle_batch,
            ]
            .into_iter()
            .all(BatchRule::valid)
            || policy.preview_model_bytes == 0
            || !(1..=1000).contains(&policy.preview_model_cap)
        {
            return Err(Error::invalid(
                "硬件缓存与批次推荐策略的比例、边界或粒度无效",
            ));
        }
        Ok(policy)
    }

    /// 按软件总预算推导缓存和显示空间；关联下载、资源与磁盘缓存限额同步调整。
    pub(super) fn memory_values(&self, values: &Value, budget: u64) -> Result<Map<String, Value>> {
        let preview = self.preview_cache.bytes(budget);
        let geometry = self.display_geometry.bytes(budget);
        let worker = self.display_worker.bytes(budget).max(geometry);
        let mesh = hardware_config::value(values, "rust_backend.mesh_max_bytes")
            .as_u64()
            .ok_or_else(|| Error::invalid("缺少网格资源上限"))?;
        // 显示二进制资源需要额外的索引头；该 4096 字节是现有资源格式契约。
        let disk_minimum = geometry
            .max(mesh)
            .checked_add(4096)
            .and_then(|bytes| bytes.div_ceil(MIB).checked_mul(MIB))
            .ok_or_else(|| Error::invalid("显示资源磁盘预算溢出"))?;
        Ok(Map::from_iter([
            ("frontend.preview_cache_max_bytes".into(), json!(preview)),
            (
                "frontend.preview_cache_model_limit".into(),
                json!((preview / self.preview_model_bytes).clamp(1, self.preview_model_cap)),
            ),
            (
                "frontend.data_management_cache_max_bytes".into(),
                json!(self.data_cache.bytes(budget)),
            ),
            (
                "frontend.layout_mesh_geometry_max_bytes".into(),
                json!(geometry),
            ),
            (
                "frontend.layout_mesh_worker_max_bytes".into(),
                json!(worker),
            ),
            (
                "frontend.fixed_display_download_max_bytes".into(),
                json!(geometry),
            ),
            (
                "rust_backend.fixed_display_max_bytes".into(),
                json!(geometry),
            ),
            (
                "backend.model_preview_runtime_cache_max_bytes".into(),
                json!(self.preview_disk.bytes(budget)),
            ),
            (
                "rust_backend.fixed_preview_cache_max_bytes".into(),
                json!(self.fixed_preview_disk.bytes(budget)),
            ),
            (
                "rust_backend.mesh_cache_max_bytes".into(),
                json!(self.display_disk.bytes(budget).max(disk_minimum)),
            ),
            (
                "rust_backend.prepared_cache_max_bytes".into(),
                json!(self.prepared_disk.bytes(budget)),
            ),
        ]))
    }

    /// 从剩余计算容量推导包络单批空间及各阶段批次，检查同时存在的数组不会挤满工作空间。
    pub(super) fn envelope_values(&self, capacity: u64) -> Result<Map<String, Value>> {
        let workspace = self.envelope_workspace.bytes(capacity);
        let voxel = self.voxel_batch.count(workspace)?;
        let raster = self.raster_batch.count(workspace)?;
        let triangle = self.triangle_batch.count(workspace)?;
        let surface = self.surface_batch.count(workspace)?;
        let combined = voxel
            .checked_mul(self.voxel_batch.bytes_per_item)
            .and_then(|v| v.checked_add(raster * self.raster_batch.bytes_per_item))
            .and_then(|v| v.checked_add(triangle * self.triangle_batch.bytes_per_item));
        if combined.is_none_or(|bytes| bytes >= workspace) {
            return Err(Error::invalid(
                "包络体素、栅格与源三角面批次合计超过单批工作空间",
            ));
        }
        Ok(Map::from_iter([
            (
                "backend.model_envelope_workspace_memory_bytes".into(),
                json!(workspace),
            ),
            (
                "backend.model_envelope_voxel_max_cells".into(),
                json!(voxel),
            ),
            (
                "backend.model_envelope_surface_batch_cells".into(),
                json!(surface),
            ),
            (
                "backend.model_envelope_raster_batch_cells".into(),
                json!(raster),
            ),
            (
                "backend.model_envelope_raster_triangle_batch".into(),
                json!(triangle),
            ),
        ]))
    }
}

/// 将推荐字段合并到独立配置副本，供后续预算核算与正式校验；不修改磁盘配置。
pub(super) fn apply(values: &mut Value, targets: &Map<String, Value>) {
    for (key, value) in targets {
        let (section, name) = key.split_once('.').expect("推荐字段使用已知配置键");
        values[section][name] = value.clone();
    }
}
