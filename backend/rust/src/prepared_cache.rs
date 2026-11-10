//! 文件说明：保存和复用带摘要的布局准备结果，磁盘容量受限；缓存可删除且不替代历史快照。
use crate::{
    compute::{Outcome, Task},
    config::Config,
    error::{Error, Result},
    files,
};
use serde_json::{json, Value};
use std::{
    fs,
    path::{Path, PathBuf},
};

/// 将已验证的不可变资源链接到新的任务目录；不同卷或文件系统不支持时复制。
pub fn share(source: &Path, target: &Path) -> Result<()> {
    let _logging_step = crate::monitoring::Step::new(
        "prepared_cache::share",
        serde_json::json!({"source":source,"target":target}),
    );
    fs::create_dir_all(
        target
            .parent()
            .ok_or_else(|| Error::bad("资源缺少父目录"))?,
    )?;
    if fs::hard_link(source, target).is_err() {
        files::copy(source, target)?;
    }
    Ok(())
}

/// 源摘要、完整参数和几何/求解配置共同确定缓存身份，算法版本变化自动失效。
pub fn key(task: &Task, config: &Config) -> String {
    let _logging_step = crate::monitoring::Step::new("prepared_cache::key", serde_json::json!({}));
    files::fingerprint(
        &json!({"inputs":task.inputs, "version":config.values["rust_backend"]["prepared_cache_version"],
        "geometry":config.values["backend"], "solver":config.values["layout_optimization"]}),
    )
}

/// 限制缓存目录在当前数据根内；该目录只容纳本模块生成的条目。
fn directory(config: &Config) -> Result<PathBuf> {
    let _logging_step =
        crate::monitoring::Step::new("prepared_cache::directory", serde_json::json!({}));
    let path = files::within(
        &config.data,
        config.string("rust_backend", "prepared_cache_dir"),
    )?;
    fs::create_dir_all(&path)?;
    Ok(path)
}

/// 校验缓存结果和所有资源；任何缺失/摘要错误向调用者传播，不能命中损坏缓存。
fn validate(entry: &Path) -> Result<(Value, Vec<PathBuf>, u64)> {
    let _logging_step =
        crate::monitoring::Step::new("prepared_cache::validate", serde_json::json!({}));
    let index = files::read_json(&entry.join("index.json"))?;
    let result_path = files::verify(entry, &index["result"])?;
    let result = files::read_json(&result_path)?;
    let mut resources = vec![result_path];
    let mut bytes = index["result"]["bytes"].as_u64().unwrap_or(0);
    for reference in result["resources"]
        .as_array()
        .ok_or_else(|| Error::bad("缓存资源清单无效"))?
    {
        resources.push(files::verify(entry, reference)?);
        bytes = bytes.saturating_add(reference["bytes"].as_u64().unwrap_or(0));
    }
    Ok((result, resources, bytes))
}

/// 恢复已校验资源到新的独立输出；损坏只使本条缓存失效，原始计算输入保持完整。
pub fn restore(task: &Task, config: &Config) -> Result<Option<Value>> {
    let _logging_step =
        crate::monitoring::Step::new("prepared_cache::restore", serde_json::json!({}));
    let root = directory(config)?;
    let entry = files::within(&root, &key(task, config))?;
    if !entry.exists() {
        return Ok(None);
    }
    let (result, resources, _) = match validate(&entry) {
        Ok(value) => value,
        Err(error) => {
            crate::logging::issue(
                crate::runtime_logging::Level::Warn,
                format_args!("布局准备缓存失效，将重新计算：{error}"),
            );
            fs::remove_dir_all(&entry)?;
            return Ok(None);
        }
    };
    fs::create_dir_all(&task.output)?;
    for source in resources {
        let target = task
            .output
            .join(source.strip_prefix(&entry).map_err(Error::bad)?);
        if source.extension().is_some_and(|e| e == "npy") {
            share(&source, &target)?;
        } else {
            files::copy(&source, &target)?;
        }
    }
    files::write_json(&entry.join("used.json"), &json!({"time":files::now()}))?;
    Ok(Some(result))
}

/// 持久化经过宿主验证的准备产物；仅缓存成功结果，完整目录原子发布后才可命中。
pub fn store(outcome: &Outcome, config: &Config) -> Result<()> {
    let _logging_step =
        crate::monitoring::Step::new("prepared_cache::store", serde_json::json!({}));
    if outcome.cancelled {
        return Ok(());
    }
    let limit = config.integer("rust_backend", "prepared_cache_max_bytes");
    let references = outcome.result["resources"]
        .as_array()
        .ok_or_else(|| Error::bad("缺少准备资源"))?;
    let bytes: u64 = references
        .iter()
        .map(|v| v["bytes"].as_u64().unwrap_or(0))
        .sum();
    if bytes > limit {
        return Ok(());
    }
    let root = directory(config)?;
    let entry = files::within(&root, &key(&outcome.task, config))?;
    let temporary = files::within(&root, &format!("pending-{}", files::identifier()))?;
    fs::create_dir_all(&temporary)?;
    let result = (|| {
        for reference in references {
            let source = files::verify(&outcome.task.output, reference)?;
            let target = files::within(&temporary, reference["path"].as_str().unwrap())?;
            if source.extension().is_some_and(|e| e == "npy") {
                share(&source, &target)?;
            } else {
                files::copy(&source, &target)?;
            }
        }
        files::write_json(&temporary.join("result.json"), &outcome.result)?;
        let reference = files::reference(&temporary, &temporary.join("result.json"))?;
        files::write_json(
            &temporary.join("index.json"),
            &json!({"result":reference,"bytes":bytes}),
        )?;
        files::write_json(&temporary.join("used.json"), &json!({"time":files::now()}))?;
        files::publish(&temporary, &entry)?;
        evict(&root, limit)?;
        Ok(())
    })();
    if temporary.exists() {
        let _ = fs::remove_dir_all(temporary);
    }
    result
}

/// 按最近访问时间淘汰；只删除经过边界检查的 SHA-256 条目，已有任务/历史的硬链接继续有效。
fn evict(root: &Path, limit: u64) -> Result<()> {
    let _logging_step =
        crate::monitoring::Step::new("prepared_cache::evict", serde_json::json!({}));
    let mut entries = vec![];
    for item in fs::read_dir(root)? {
        let item = item?;
        let name = item.file_name().to_string_lossy().into_owned();
        if name.len() != 64 || !name.bytes().all(|b| b.is_ascii_hexdigit()) {
            continue;
        }
        let path = files::within(root, &name)?;
        let size = files::read_json(&path.join("index.json"))?["bytes"]
            .as_u64()
            .unwrap_or(0);
        let used = fs::metadata(path.join("used.json"))?.modified()?;
        entries.push((used, path, size));
    }
    entries.sort_by_key(|e| e.0);
    let mut total: u64 = entries.iter().map(|e| e.2).sum();
    for (_, path, size) in entries {
        if total <= limit {
            break;
        }
        fs::remove_dir_all(path)?;
        total = total.saturating_sub(size);
    }
    Ok(())
}
