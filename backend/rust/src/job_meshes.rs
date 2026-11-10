//! 文件说明：历史显示网格的按需转换、摘要缓存与容量淘汰；精确 NPZ 与业务数据库保持原契约。
use crate::{
    blocking,
    compute::Task,
    error::{Error, Result},
    files,
    jobs::Jobs,
};
use serde_json::{json, Value};
use std::{
    fs,
    path::{Path, PathBuf},
    sync::Arc,
};
use tokio_util::sync::CancellationToken;

impl Jobs {
    /// 返回轻量型号清单；读取当前候选实际引用的型号，不解压或内联几何。
    pub fn mesh_manifest(&self, id: &str) -> Result<Value> {
        let _logging_step =
            crate::monitoring::Step::new("job_meshes::mesh_manifest", serde_json::json!({"id":id}));
        let _state = self.state.lock().unwrap();
        let job = self.read(id)?;
        files::safe_id(id)?;
        let candidates = job["candidates"]
            .as_array()
            .ok_or_else(|| Error::bad("候选无效"))?;
        if candidates.is_empty() {
            return Err(Error::missing("任务尚无有效布局"));
        }
        let mut meshes = serde_json::Map::new();
        for candidate in candidates {
            for placement in candidate["placements"]
                .as_array()
                .ok_or_else(|| Error::bad("候选缺少位姿"))?
            {
                let record = placement["record_id"]
                    .as_str()
                    .ok_or_else(|| Error::bad("缺少型号"))?;
                files::safe_id(record)?;
                meshes.insert(record.into(), json!({"url":format!("/api/layout-optimization/jobs/{id}/meshes/{record}/binary")}));
            }
        }
        Ok(json!({"format":"sat-layout-mesh", "version":1, "job_id":id, "meshes":meshes}))
    }

    /// 校验当前历史仍引用请求型号；调用方持状态锁，以免与删除交错。
    fn mesh_source(&self, id: &str, record: &str) -> Result<PathBuf> {
        let _logging_step =
            crate::monitoring::Step::new("job_meshes::mesh_source", serde_json::json!({"id":id}));
        files::safe_id(id)?;
        files::safe_id(record)?;
        let job = self.read(id)?;
        let found = job["candidates"].as_array().is_some_and(|items| {
            items.iter().any(|candidate| {
                candidate["placements"]
                    .as_array()
                    .is_some_and(|p| p.iter().any(|p| p["record_id"] == record))
            })
        });
        if !found {
            return Err(Error::missing("历史方案未引用指定型号"));
        }
        let source = files::within(
            &files::within(&self.directory, id)?,
            &format!("{record}.npz"),
        )?;
        if !source.is_file() {
            return Err(Error::conflict("历史网格快照已丢失"));
        }
        Ok(source)
    }

    /// 在缓存锁内获取单型号文件；独立进程转换，命中时流式校验，返回路径由 HTTP 流式打开。
    pub async fn mesh_binary(self: &Arc<Self>, id: &str, record: &str) -> Result<PathBuf> {
        let _logging_step =
            crate::monitoring::Step::new("job_meshes::mesh_binary", serde_json::json!({"id":id}));
        let this = self.clone();
        let (key, model) = (id.to_string(), record.to_string());
        let (entry, task) = blocking(move || {
            let _state = this.state.lock().unwrap();
            let source = this.mesh_source(&key, &model)?;
            let root = files::within(
                &this.config.data,
                this.config.string("rust_backend", "mesh_cache_dir"),
            )?;
            fs::create_dir_all(&root)?;
            let digest = files::fingerprint(&json!({"source":files::hash(&source)?,"format":1}));
            let entry = files::within(&root, &digest)?;
            let limit = this.config.integer("rust_backend", "mesh_max_bytes");
            if entry.exists() {
                let cached = files::read_json(&entry.join("index.json")).and_then(|index| {
                    if index["path"] != "mesh.bin" {
                        return Err(Error::bad("网格缓存索引无效"));
                    }
                    files::verify(&entry, &index)
                });
                if let Ok(path) = cached {
                    if fs::metadata(path)?.len() <= limit {
                        fs::File::options()
                            .write(true)
                            .open(entry.join("index.json"))?
                            .set_times(
                                fs::FileTimes::new().set_modified(std::time::SystemTime::now()),
                            )?;
                        evict(
                            &root,
                            this.config.integer("rust_backend", "mesh_cache_max_bytes"),
                            0,
                        )?;
                        return Ok((entry, None));
                    }
                }
                fs::remove_dir_all(&entry)?;
            }
            let mut task = Task::new(
                &this.config,
                "history.mesh-binary",
                &json!({"max_bytes":limit}),
            )?;
            task.add("mesh", "mesh.npz", &source)?;
            Ok((entry, Some(task)))
        })
        .await?;
        if let Some(task) = task {
            let outcome = self
                .engine
                .run(task, id, CancellationToken::new(), None)
                .await
                .map_err(|e| Error::conflict(e.message))?;
            if outcome.cancelled {
                return Err(Error::conflict("网格转换已取消"));
            }
            let this = self.clone();
            let (key, model, target) = (id.to_string(), record.to_string(), entry.clone());
            blocking(move || {
                let _state = this.state.lock().unwrap();
                this.mesh_source(&key, &model)?;
                let artifacts = outcome.task.output.join("artifacts");
                let reference = files::reference(&artifacts, &artifacts.join("mesh.bin"))?;
                files::write_json(&artifacts.join("index.json"), &reference)?;
                let required = fs::metadata(artifacts.join("mesh.bin"))?.len()
                    + fs::metadata(artifacts.join("index.json"))?.len();
                evict(
                    target.parent().unwrap(),
                    this.config.integer("rust_backend", "mesh_cache_max_bytes"),
                    required,
                )?;
                files::publish(&artifacts, &target)?;
                Ok(())
            })
            .await?;
        }
        Ok(entry.join("mesh.bin"))
    }
}

/// 发布前按访问时间淘汰摘要条目，容量包括索引；只删除受控缓存根内生成的普通目录。
pub(crate) fn evict(root: &Path, limit: u64, required: u64) -> Result<()> {
    let _logging_step = crate::monitoring::Step::new("job_meshes::evict", serde_json::json!({}));
    if required > limit {
        return Err(Error::conflict("网格文件超过磁盘缓存预算"));
    }
    let mut entries = vec![];
    for item in fs::read_dir(root)? {
        let item = item?;
        let name = item.file_name().to_string_lossy().into_owned();
        if name.len() != 64
            || !name.bytes().all(|b| b.is_ascii_hexdigit())
            || !item.file_type()?.is_dir()
        {
            continue;
        }
        let path = files::within(root, &name)?;
        let mut bytes = 0;
        for file in fs::read_dir(&path)? {
            bytes += file?.metadata()?.len();
        }
        let modified = fs::metadata(path.join("index.json"))
            .or_else(|_| fs::metadata(&path))?
            .modified()?;
        entries.push((modified, path, bytes));
    }
    entries.sort_by_key(|item| item.0);
    let mut total = required + entries.iter().map(|item| item.2).sum::<u64>();
    for (_, path, bytes) in entries {
        if total <= limit {
            break;
        }
        fs::remove_dir_all(path)?;
        total -= bytes;
    }
    Ok(())
}
