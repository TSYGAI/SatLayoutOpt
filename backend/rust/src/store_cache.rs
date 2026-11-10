//! 文件说明：固化安装基准和显示二进制后台队列；单消费者顺序生成，读取独立快照，重启补齐未完成资源。
use crate::{
    blocking,
    compute::{Engine, Task},
    error::{Error, Result},
    files, fixed_display,
    store::Store,
};
use serde_json::{json, Value};
use std::{
    collections::{HashMap, HashSet, VecDeque},
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
};
use tokio::sync::Notify;
use tokio_util::sync::CancellationToken;

/// 队列只保存标识和终态，不保留几何；去重覆盖排队和正在执行的记录。
#[derive(Default)]
struct Queue {
    pending: VecDeque<(String, Option<String>)>,
    scheduled: HashSet<String>,
    failures: HashMap<String, Error>,
}

/// 前台等待与后台预制共用单一消费者，不因页面请求启动重复 CAD 进程。
pub struct StoreCache {
    store: Arc<Store>,
    engine: Arc<Engine>,
    queue: Mutex<Queue>,
    wake: Notify,
    changed: Notify,
}

impl StoreCache {
    /// 创建队列；启动消费者与同步服务构造分离。
    pub fn new(store: Arc<Store>, engine: Arc<Engine>) -> Self {
        let _logging_step = crate::monitoring::Step::new("store_cache::new", serde_json::json!({}));
        Self {
            store,
            engine,
            queue: Mutex::new(Queue::default()),
            wake: Notify::new(),
            changed: Notify::new(),
        }
    }

    /// 按入队顺序调度一次，失败保留错误，服务重启后可以重试。
    pub fn enqueue(&self, id: &str) {
        let _logging_step =
            crate::monitoring::Step::new("store_cache::enqueue", serde_json::json!({"id":id}));
        let mut queue = self.queue.lock().unwrap();
        if queue.failures.contains_key(id) || !queue.scheduled.insert(id.into()) {
            return;
        }
        queue.pending.push_back((
            id.into(),
            crate::monitoring::current().map(|operation| operation.id.clone()),
        ));
        self.wake.notify_one();
    }

    /// 启动唯一消费者，恢复旧记录后处理新增记录；关闭由计算宿主取消，磁盘快照保留。
    pub fn start(self: &Arc<Self>) -> tokio::task::JoinHandle<()> {
        let _logging_step =
            crate::monitoring::Step::new("store_cache::start", serde_json::json!({}));
        let this = self.clone();
        tokio::spawn(async move {
            let store = this.store.clone();
            match blocking(move || store.all()).await {
                Ok(records) => {
                    for record in records.into_iter().rev() {
                        this.enqueue(record["record_id"].as_str().unwrap());
                    }
                }
                Err(error) => crate::logging::issue(
                    crate::runtime_logging::Level::Error,
                    format_args!("恢复固化缓存队列失败：{error}"),
                ),
            }
            loop {
                if this.engine.shutdown.is_cancelled() {
                    break;
                }
                let next = this.queue.lock().unwrap().pending.pop_front();
                let Some((id, trace)) = next else {
                    tokio::select! {
                        _ = this.engine.shutdown.cancelled() => break,
                        _ = this.wake.notified() => continue,
                    }
                };
                let logs = match this.store.config.logs() {
                    Ok(logs) => logs,
                    Err(error) => {
                        crate::logging::issue(
                            crate::runtime_logging::Level::Error,
                            format_args!("缓存日志初始化失败：{error}"),
                        );
                        break;
                    }
                };
                let operation = logs.operation(
                    trace.unwrap_or_else(|| crate::monitoring::trace_id(None)),
                    "后端·固化缓存".into(),
                    true,
                    false,
                );
                operation.stage(
                    "host",
                    json!({"step":"校验及生成固化资源","record_id":id}),
                    true,
                );
                let result = crate::monitoring::scope(operation.clone(), this.build(&id)).await;
                operation.finish(
                    if result.is_err() && !this.engine.shutdown.is_cancelled() {
                        crate::runtime_logging::Level::Error
                    } else {
                        crate::runtime_logging::Level::Info
                    },
                    if result.is_ok() {
                        "缓存完成"
                    } else {
                        "缓存未完成"
                    },
                    result.as_ref().err().map(ToString::to_string).as_deref(),
                );
                if let Err(error) = &result {
                    if !this.engine.shutdown.is_cancelled() && error.status.as_u16() != 404 {
                        crate::logging::issue(
                            crate::runtime_logging::Level::Error,
                            format_args!("固化缓存 {id} 生成失败：{error}"),
                        );
                    }
                }
                {
                    let mut queue = this.queue.lock().unwrap();
                    queue.scheduled.remove(&id);
                    if let Err(error) = result {
                        queue.failures.insert(id, error);
                    }
                }
                this.changed.notify_waiters();
            }
            this.changed.notify_waiters();
        })
    }

    /// 校验安装基准身份，拒绝旧设置和旧坐标空间的结果。
    fn reference_ready(root: &Path, record: &Value) -> bool {
        let _logging_step =
            crate::monitoring::Step::new("store_cache::reference_ready", serde_json::json!({}));
        let Ok(reference) = files::read_json(&root.join("envelope-installation.json")) else {
            return false;
        };
        let variant = record["envelope"]["variants"]
            .as_array()
            .and_then(|v| v.iter().find(|v| v["rot_z"] == 0));
        reference["version"] == 3
            && reference["region_rule"] == "all_geometric_planes_v1"
            && reference["installation_plane_vertices"]
                .as_array()
                .is_some_and(|v| v.len() >= 3)
            && reference["model_coordinate_space"] == "current_model_v1"
            && reference["settings"] == record["settings"]
            && reference["source_sha256"] == record["source"]["sha256"]
            && variant.is_some_and(|v| reference["envelope_sha256"] == v["sha256"])
    }

    /// 查询完整资源；按输入和容量记住超限结果，避免连续重算。
    fn ready(&self, id: &str, display: bool) -> Result<Option<PathBuf>> {
        let _logging_step =
            crate::monitoring::Step::new("store_cache::ready", serde_json::json!({"id":id}));
        let _guard = self.store.lock.lock().unwrap();
        let record = self.store.get(id)?;
        let root = files::within(&self.store.assets, id)?;
        if !display {
            return Ok(Self::reference_ready(&root, &record)
                .then(|| root.join("envelope-installation.json")));
        }
        let limit = self
            .store
            .config
            .integer("rust_backend", "fixed_display_max_bytes");
        if let Some(path) = fixed_display::read_display(&root, &record, limit) {
            return Ok(Some(path));
        }
        let status = files::read_json(&root.join("cache-state.json")).unwrap_or(Value::Null);
        if status["state"] == "unavailable" && status["key"] == self.key(&record) {
            return Err(Error::conflict(
                status["message"]
                    .as_str()
                    .unwrap_or("固定显示资源超过网格容量预算"),
            ));
        }
        Ok(None)
    }

    /// 容量设置参与身份，调整上限后可重新生成此前超限资源。
    fn key(&self, record: &Value) -> Value {
        let _logging_step = crate::monitoring::Step::new("store_cache::key", serde_json::json!({}));
        json!(files::fingerprint(&json!({"record":record,
            "limit":self.store.config.integer("rust_backend", "fixed_display_max_bytes")})))
    }

    /// 等待同一队列；基准发布后即可正式预览，无须等待显示文件完成。
    pub async fn ensure(self: &Arc<Self>, id: &str, display: bool) -> Result<PathBuf> {
        let _logging_step =
            crate::monitoring::Step::new("store_cache::ensure", serde_json::json!({"id":id}));
        loop {
            let changed = self.changed.notified();
            tokio::pin!(changed);
            changed.as_mut().enable();
            let this = self.clone();
            let key = id.to_string();
            if let Some(path) = blocking(move || this.ready(&key, display)).await? {
                return Ok(path);
            }
            if let Some(error) = self.queue.lock().unwrap().failures.get(id).cloned() {
                return Err(error);
            }
            self.enqueue(id);
            tokio::select! {
                _ = self.engine.shutdown.cancelled() => return Err(Error::conflict("服务正在退出，缓存将在下次启动后继续生成")),
                _ = changed => {}
            }
        }
    }

    /// 从固化快照复制带摘要输入，持锁防止删除竞争，不依赖上传目录和页面生命周期。
    fn task(&self, id: &str, display: bool) -> Result<Task> {
        let _logging_step =
            crate::monitoring::Step::new("store_cache::task", serde_json::json!({"id":id}));
        let _guard = self.store.lock.lock().unwrap();
        let record = self.store.get(id)?;
        let root = files::within(&self.store.assets, id)?;
        let variant = record["envelope"]["variants"]
            .as_array()
            .and_then(|v| v.iter().find(|v| v["rot_z"] == 0))
            .ok_or_else(|| Error::conflict("缺少正式零度包络"))?;
        let mut task = Task::new(
            &self.store.config,
            if display {
                "fixed.display"
            } else {
                "fixed.reference"
            },
            &json!({"settings":record["settings"], "source_sha256":record["source"]["sha256"],
                "envelope_sha256":variant["sha256"], "build_display":false,
                "max_bytes":self.store.config.integer("rust_backend", "fixed_display_max_bytes")}),
        )?;
        task.monitor.context(json!({"model_id":id,"model_name":record["settings"]["device_name"],"face_id":record["settings"]["installation_face_id"]}));
        task.add(
            "envelope",
            "envelope.npz",
            &self
                .store
                .asset(&record, variant["asset_name"].as_str().unwrap())?,
        )?;
        if task.inputs["envelope"]["sha256"] != variant["sha256"] {
            return Err(Error::conflict("固化包络摘要不一致"));
        }
        if display {
            task.add(
                "reference",
                "reference.json",
                &root.join("envelope-installation.json"),
            )?;
        } else {
            task.add(
                "source",
                "source.step",
                &self
                    .store
                    .asset(&record, record["source"]["asset_name"].as_str().unwrap())?,
            )?;
            if task.inputs["source"]["sha256"] != record["source"]["sha256"] {
                return Err(Error::conflict("固化源文件摘要不一致"));
            }
        }
        files::write_json(
            &root.join("cache-state.json"),
            &json!({"state":"running", "key":self.key(&record),
            "phase":if display {"display"} else {"reference"}, "updated_at":files::now()}),
        )?;
        Ok(task)
    }

    /// 依次计算并原子发布基准与显示文件；失败不撤销已经保存的数据库记录。
    async fn build(self: &Arc<Self>, id: &str) -> Result<()> {
        let _logging_step =
            crate::monitoring::Step::new("store_cache::build", serde_json::json!({"id":id}));
        for display in [false, true] {
            let this = self.clone();
            let key = id.to_string();
            if blocking(move || this.ready(&key, display)).await?.is_some() {
                continue;
            }
            let this = self.clone();
            let key = id.to_string();
            let task = blocking(move || this.task(&key, display)).await?;
            let result = self
                .engine
                .run(
                    task,
                    &format!("store-cache-{id}"),
                    CancellationToken::new(),
                    None,
                )
                .await;
            let this = self.clone();
            let key = id.to_string();
            blocking(move || {
                let _guard = this.store.lock.lock().unwrap();
                let record = this.store.get(&key)?;
                let root = files::within(&this.store.assets, &key)?;
                match result {
                    Ok(outcome) if !outcome.cancelled => {
                        let artifacts = outcome.task.output.join("artifacts");
                        if display {
                            if fixed_display::read_display(&artifacts, &record, this.store.config.integer("rust_backend", "fixed_display_max_bytes")).is_none() {
                                return Err(Error::conflict("生成的固定显示资源与当前模型不一致"));
                            }
                            for name in ["fixed-display.bin", "fixed-display.json"] { files::publish(&artifacts.join(name), &root.join(name))?; }
                            files::write_json(&root.join("cache-state.json"), &json!({"state":"ready", "key":this.key(&record), "updated_at":files::now()}))?;
                        } else {
                            if !Self::reference_ready(&artifacts, &record) { return Err(Error::conflict("安装基准生成失败")); }
                            files::publish(&artifacts.join("envelope-installation.json"), &root.join("envelope-installation.json"))?;
                        }
                        Ok(())
                    }
                    result => {
                        let error = result.err().unwrap_or_else(|| Error::conflict("缓存生成已取消"));
                        if !this.engine.shutdown.is_cancelled() {
                            let state = if error.message.contains("容量预算") {"unavailable"} else {"failed"};
                            files::write_json(&root.join("cache-state.json"), &json!({"state":state, "key":this.key(&record),
                                "message":error.message, "updated_at":files::now()}))?;
                        }
                        Err(error)
                    }
                }
            }).await?;
            self.changed.notify_waiters();
        }
        Ok(())
    }
}
