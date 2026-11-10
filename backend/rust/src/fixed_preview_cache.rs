//! 文件说明：固定预览的单槽正式结果与数值准备缓存；只缓存服务端验收结果，容量由 TOML 限制，持久化缓存带摘要且可丢弃。
use crate::{compute::Outcome, config::Config, error::Result, files};
use serde_json::{json, Value};
use std::{fs, sync::Arc};

/// 最多保留一个准备快照与一个正式结果，页面往返和保存不再复制 STEP 或启动计算进程。
#[derive(Default)]
pub struct FixedCache {
    pub prepared: Option<(String, Arc<Outcome>)>,
    pub preview: Option<Value>,
}

/// 只接受完全相同指纹和输入组；规范化后的组也可复用，动作与严格空间请求由调用者另行校验。
pub fn matches(entry: &Value, fingerprint: &Value, groups: &Value) -> bool {
    let _logging_step =
        crate::monitoring::Step::new("fixed_preview_cache::matches", serde_json::json!({}));
    entry["fingerprint"] == *fingerprint
        && (entry["input_groups"] == *groups || entry["result"]["groups"] == *groups)
}

/// 读取最近一次经过摘要校验的正式结果；缺失、损坏或容量超限均当作未命中。
pub fn read(config: &Config) -> Option<Value> {
    let _logging_step =
        crate::monitoring::Step::new("fixed_preview_cache::read", serde_json::json!({}));
    let root = config.directory("rust_backend", "fixed_preview_cache_dir");
    let index = files::read_json(&root.join("index.json")).ok()?;
    if index["bytes"].as_u64()? > config.integer("rust_backend", "fixed_preview_cache_max_bytes") {
        return None;
    }
    let path = files::verify(&root, &index).ok()?;
    let entry = files::read_json(&path).ok()?;
    (entry["algorithm"] == algorithm(config)).then_some(entry)
}

/// 原子写入单槽缓存与摘要；缓存失败只影响下一次恢复，不能改变已完成保存的结果。
pub fn write(config: &Config, entry: &Value) -> Result<()> {
    let _logging_step =
        crate::monitoring::Step::new("fixed_preview_cache::write", serde_json::json!({}));
    let bytes = serde_json::to_vec_pretty(entry)?;
    if bytes.len() as u64 > config.integer("rust_backend", "fixed_preview_cache_max_bytes") {
        return Ok(());
    }
    let root = config.directory("rust_backend", "fixed_preview_cache_dir");
    fs::create_dir_all(&root)?;
    let path = root.join("preview.json");
    files::write_json(&path, entry)?;
    files::write_json(&root.join("index.json"), &files::reference(&root, &path)?)
}

/// 构造只含当前配置的缓存条目；指纹涵盖模型设置、源与包络摘要、数量、空间尺寸和已保存约束。
pub fn entry(config: &Config, fingerprint: &Value, groups: &Value, result: &Value) -> Value {
    let _logging_step =
        crate::monitoring::Step::new("fixed_preview_cache::entry", serde_json::json!({}));
    json!({"fingerprint":fingerprint,"input_groups":groups,"result":result,"algorithm":algorithm(config)})
}

/// 运行算法配置变更时禁止复用磁盘验收结论。
fn algorithm(config: &Config) -> Value {
    let _logging_step =
        crate::monitoring::Step::new("fixed_preview_cache::algorithm", serde_json::json!({}));
    json!(files::fingerprint(
        &json!({"format":"fixed-installation-region-v6","geometry":config.values["backend"],
        "solver":config.values["layout_optimization"],"version":config.values["rust_backend"]["prepared_cache_version"]})
    ))
}
