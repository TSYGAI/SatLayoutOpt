//! 文件说明：布局计算与历史导出编排；保留独立数值安装快照供微调，Rust 管理持久化，Python 只计算。
use crate::{
    blocking,
    compute::{Outcome, Task},
    error::{Error, Result},
    files,
    jobs::Jobs,
    layout_config, prepared_cache,
};
use serde_json::{json, Value};
use std::sync::Arc;
use tokio_util::sync::CancellationToken;

impl Jobs {
    /// 将当前锁定记录及资源复制成不可变协议输入；持固化锁防止删除/复制交错。
    pub(crate) fn prepare_task(&self, job: &Value) -> Result<Task> {
        let _logging_step =
            crate::monitoring::Step::new("job_compute::prepare_task", serde_json::json!({}));
        self.prepare_task_mode(job, false)
    }
    /// 固定预览只准备包络和安装基准；优化任务继续保存本体与历史数据。
    pub(crate) fn prepare_task_mode(&self, job: &Value, envelope_only: bool) -> Result<Task> {
        let _logging_step =
            crate::monitoring::Step::new("job_compute::prepare_task_mode", serde_json::json!({}));
        let _guard = self.pre.store.lock.lock().unwrap();
        let mut records = vec![];
        let mut assets = json!({});
        let mut task = Task::new(&self.config, "layout.prepare", &json!({}))?;
        for selection in job["parameters"]["satellites"].as_array().unwrap() {
            if selection["count"] == 0 {
                continue;
            }
            let id = selection["record_id"].as_str().unwrap();
            let record = self.pre.store.get(id)?;
            task.monitor.context(
                json!({"model_id":id,"model_name":record["device_name"],"job":job["job_id"]}),
            );
            assets[id] = json!({});
            let variant = record["envelope"]["variants"]
                .as_array()
                .unwrap()
                .iter()
                .find(|v| v["rot_z"] == 0)
                .ok_or_else(|| Error::conflict("固化记录缺少基础包络"))?;
            let mut resources = vec![];
            if envelope_only {
                let root = files::within(&self.pre.store.assets, id)?;
                let path = root.join("envelope-installation.json");
                if !path.is_file() {
                    return Err(Error::conflict(
                        "旧包络缺少安装基准缓存，请补齐缓存或重新固化",
                    ));
                }
                // 配套资源只在内部声明，不改变固化库公开资产契约。
                let name = format!("reference_{id}");
                task.add(&name, &format!("{id}/envelope-installation.json"), &path)?;
                assets[id]["envelope-installation.json"] = json!(name);
            } else {
                resources.push(record["source"].clone());
            }
            resources.push(variant.clone());
            for item in &resources {
                let key = format!("resource_{:04}", task.inputs.len());
                let name = item["asset_name"]
                    .as_str()
                    .ok_or_else(|| Error::bad("固化资源名称缺失"))?;
                let path = self.pre.store.asset(&record, name)?;
                task.add(&key, &format!("{id}/{name}"), &path)?;
                assets[id][name] = json!(key);
            }
            records.push(record);
        }
        let mut metadata =
            json!({"parameters":job["parameters"],"records":records,"assets":assets});
        if envelope_only {
            metadata["envelope_only"] = json!(true);
        }
        task.metadata(&metadata)?;
        Ok(task)
    }
    /// 执行一个计算步骤并消费经过摘要校验的进度/候选；管道故障不会丢弃已落盘候选。
    async fn compute_step(
        self: &Arc<Self>,
        id: &str,
        task: Task,
        cancel: CancellationToken,
    ) -> Result<Outcome> {
        let _logging_step =
            crate::monitoring::Step::new("job_compute::compute_step", serde_json::json!({"id":id}));
        let (sender, mut receiver) = tokio::sync::mpsc::channel(
            self.config
                .integer("layout_optimization", "progress_history_size") as usize,
        );
        let step_cancel = cancel.child_token();
        let future = self.engine.run(task, id, step_cancel.clone(), Some(sender));
        tokio::pin!(future);
        let mut storage_error = None;
        let result = loop {
            tokio::select! {
                result=&mut future=>break result,
                Some(event)=receiver.recv()=>{
                    if storage_error.is_none() {
                        let this=self.clone();let key=id.to_string();
                        if let Err(error)=blocking(move||this.event(&key,event)).await {
                            storage_error=Some(error);step_cancel.cancel();
                        }
                    }
                }
            }
        };
        while let Ok(event) = receiver.try_recv() {
            if storage_error.is_some() {
                break;
            }
            let this = self.clone();
            let key = id.to_string();
            blocking(move || this.event(&key, event)).await?;
        }
        if let Some(error) = storage_error {
            return Err(error);
        }
        result
    }
    /// 执行准备、配置再校验、兼容 NPZ 发布和受资源预算约束的多进程求解。
    pub async fn execute(self: &Arc<Self>, id: &str, cancel: CancellationToken) -> Result<()> {
        let _logging_step =
            crate::monitoring::Step::new("job_compute::execute", serde_json::json!({"id":id}));
        let this = self.clone();
        let key = id.to_string();
        let task=blocking(move||{let job=this.change(&key,json!({"status":"running","progress":{"phase":"prepare","message":"正在校验锁定模型、正式包络与指定安装面","attempts":0,"valid_count":0}}))?;this.prepare_task(&job)}).await?;
        if cancel.is_cancelled() {
            return Ok(());
        }
        let config = self.config.clone();
        let (task, cached) = blocking(move || {
            let cached = prepared_cache::restore(&task, &config)?;
            Ok((task, cached))
        })
        .await?;
        let cache_hit = cached.is_some();
        let prepared = if let Some(result) = cached {
            Outcome {
                task,
                result,
                cancelled: false,
                candidates: json!([]),
            }
        } else {
            self.compute_step(id, task, cancel.clone()).await?
        };
        if prepared.cancelled {
            return Ok(());
        }
        let this = self.clone();
        let key = id.to_string();
        let solve = blocking(move || {
            if !cache_hit {
                // 缓存仅影响下一任务性能；磁盘缓存故障不能替代本次已经验证的计算结果。
                if let Err(error) = prepared_cache::store(&prepared, &this.config) {
                    crate::logging::issue(
                        crate::runtime_logging::Level::Warn,
                        format_args!("布局准备缓存写入失败：{error}"),
                    );
                }
            }
            let job = this.get(&key)?;
            if layout_config::configuration(&this.pre)?["config_fingerprint"]
                != job["options"]["config_fingerprint"]
            {
                return Err(Error::conflict(
                    "加载期间前置配置或模型库已改变，请刷新锁定参数后重新开始",
                ));
            }
            files::safe_id(&key)?;
            let history = files::within(&this.directory, &key)?;
            if history.exists() {
                return Err(Error::conflict("任务快照已存在，禁止覆盖"));
            }
            files::publish(&prepared.task.output.join("history"), &history)?;
            files::publish(
                &prepared.task.output.join("prepared"),
                &history.join("refinement-input"),
            )?;
            let snapshot = history.join("refinement-input/snapshot.json");
            let manifest = files::read_json(&snapshot)?;
            let mut solve = Task::new(&this.config, "layout.solve", &json!({}))?;
            solve.add_shared("snapshot", "prepared/snapshot.json", &snapshot)?;
            for (key, reference) in manifest["arrays"]
                .as_object()
                .ok_or_else(|| Error::bad("数值快照缺少数组"))?
            {
                let path = files::verify(snapshot.parent().unwrap(), reference)?;
                solve.add_shared(
                    key,
                    &format!("prepared/{}", reference["path"].as_str().unwrap()),
                    &path,
                )?;
            }
            this.change(&key, json!({"progress":{"prepared_cache_hit":cache_hit}}))?;
            Ok(solve)
        })
        .await?;
        if cancel.is_cancelled() {
            return Ok(());
        }
        let result = self.compute_step(id, solve, cancel.clone()).await?;
        let this = self.clone();
        let key = id.to_string();
        blocking(move||{
            if result.cancelled||cancel.is_cancelled(){return this.finish_cancelled(&key);}
            let candidates=result.result["candidates"].clone();let valid=candidates.as_array().ok_or_else(||Error::bad("计算结果缺少候选列表"))?;
            if !valid.is_empty(){this.change(&key,json!({"status":"completed","candidates":candidates,"progress":result.result["progress"],"finished_at":files::now()}))?;}
            else{let mut progress=result.result["progress"].clone();let reason=progress["termination_reason"].as_str().unwrap_or("exhausted");let message=if reason=="attempt_limit"{"本次搜索达到每轮尝试上限，尚未找到通过完整验收的布局；搜索提前结束，不代表已证明无解"}else{"半径扫描及回退搜索均未找到通过完整验收的布局，请检查高度、安装姿态、悬高和包络边界"};progress["message"]=json!(message);progress["valid_count"]=json!(0);this.change(&key,json!({"status":"infeasible","candidates":[],"progress":progress,"error":message,"finished_at":files::now()}))?;}Ok(())
        }).await
    }
    /// 为历史预览或导出复制 NPZ 及旧记录回退源；删除历史与复制共用任务锁。
    fn history_task(&self, id: &str, candidate: Option<&str>) -> Result<Task> {
        let _logging_step = crate::monitoring::Step::new(
            "job_compute::history_task",
            serde_json::json!({"id":id,"candidate":candidate}),
        );
        let _guard = self.state.lock().unwrap();
        let _store = self.pre.store.lock.lock().unwrap();
        let mut job = self.read(id)?;
        files::safe_id(id)?;
        if job["candidates"].as_array().is_none_or(|x| x.is_empty()) {
            return Err(Error::missing("任务尚无有效布局"));
        }
        if let Some(candidate) = candidate {
            let selected = crate::job_refinement::candidate(&job, candidate)?;
            if selected.get("refinement").is_some() {
                job["candidates"].as_array_mut().unwrap().push(selected);
            }
        }
        let mut task = Task::new(
            &self.config,
            if candidate.is_some() {
                "history.export"
            } else {
                "history.meshes"
            },
            &json!({}),
        )?;
        let mut snapshots = json!({});
        let mut records = vec![];
        let mut assets = json!({});
        for item in job["parameters"]["satellites"].as_array().unwrap() {
            if item["count"] == 0 {
                continue;
            }
            let record_id = item["record_id"].as_str().unwrap();
            files::safe_id(record_id)?;
            let path = files::within(
                &files::within(&self.directory, id)?,
                &format!("{record_id}.npz"),
            )?;
            if path.is_file() {
                let name = format!("history_{record_id}");
                task.add(&name, &format!("history/{record_id}.npz"), &path)?;
                snapshots[record_id] = json!(name);
            } else if candidate.is_none() {
                return Err(Error::conflict("历史网格快照已丢失"));
            }
            if candidate.is_some() {
                if let Ok(record) = self.pre.store.get(record_id) {
                    let name = record["source"]["asset_name"].as_str().unwrap();
                    if let Ok(path) = self.pre.store.asset(&record, name) {
                        let key = format!("source_{record_id}");
                        task.add(&key, &format!("sources/{record_id}.step"), &path)?;
                        assets[record_id] = json!({name:key});
                        records.push(record);
                    }
                }
            }
        }
        task.metadata(&json!({"job":job,"candidate_id":candidate,"snapshots":snapshots,"records":records,"assets":assets}))?;
        Ok(task)
    }
    /// 导出/解码在独立进程执行，结果字节读取完才释放暂存目录。
    pub async fn history_bytes(
        self: &Arc<Self>,
        id: &str,
        candidate: Option<String>,
    ) -> Result<Vec<u8>> {
        let _logging_step = crate::monitoring::Step::new(
            "job_compute::history_bytes",
            serde_json::json!({"id":id,"candidate":candidate}),
        );
        let this = self.clone();
        let key = id.to_string();
        let export = candidate.is_some();
        let task = blocking(move || this.history_task(&key, candidate.as_deref())).await?;
        let result = self
            .engine
            .run(task, id, CancellationToken::new(), None)
            .await
            .map_err(|e| Error::conflict(e.message))?;
        if result.cancelled {
            return Err(Error::conflict("历史读取已取消"));
        }
        Ok(tokio::fs::read(result.task.output.join(if export {
            "artifacts/installation.xlsx"
        } else {
            "artifacts/meshes.json"
        }))
        .await?)
    }
}
