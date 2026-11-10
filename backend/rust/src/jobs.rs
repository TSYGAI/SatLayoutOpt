//! 文件说明：Rust 布局任务状态与历史持久化；启动前核对锁定尺寸范围，宿主管理单活动项目和取消。
//! 资源采样更新最新进度，有限运行记录只保存带非空文字的事件，防止高频采样挤掉业务记录。
//! 相同更新标识的消息只保留最新一条，让压紧进度复用一条动态记录。
//! 新项目从全部现存默认名称的最大编号续号；重命名释放编号，中间空号不补。
use crate::{
    blocking,
    compute::Engine,
    config::Config,
    database,
    error::{Error, Result},
    files, layout_config,
    pre_config::PreConfig,
};
use rusqlite::{params, OptionalExtension};
use serde_json::{json, Value};
use std::{
    fs,
    path::PathBuf,
    sync::{Arc, Mutex},
    time::{Duration, Instant},
};
use tokio_util::sync::CancellationToken;

/// 活动项目与其协作取消标志，互斥锁同时保护历史状态写入。
pub struct JobState {
    pub active: Option<(String, CancellationToken)>,
    /// 当前活动任务的最新快照；普通进度合并于此，候选/状态立即落盘。
    pub live: Option<Value>,
    pub flushed: Instant,
}
/// 持久化任务宿主，不持有 Python 对象或几何数组。
pub struct Jobs {
    pub config: Arc<Config>,
    pub engine: Arc<Engine>,
    pub pre: Arc<PreConfig>,
    pub directory: PathBuf,
    pub database: PathBuf,
    pub state: Mutex<JobState>,
    /// 串行生成显示缓存并保护文件打开与容量淘汰，不阻塞布局求解。
    pub mesh_cache_lock: tokio::sync::Mutex<()>,
    /// 实时校验按编辑会话替换旧版本，不干扰另存或其他浏览器的编辑。
    pub refinement_validations: Arc<crate::refinement_validation::Validations>,
}
impl Jobs {
    /// 加载历史数据库并将残留活动状态改为 interrupted，保留已落盘候选。
    pub fn open(config: Arc<Config>, engine: Arc<Engine>, pre: Arc<PreConfig>) -> Result<Self> {
        let _logging_step = crate::monitoring::Step::new("jobs::open", serde_json::json!({}));
        let directory = config.directory("layout_optimization", "storage_dir");
        fs::create_dir_all(&directory)?;
        let database = directory.join("jobs.sqlite3");
        let mut connection = database::connect(&database, &config)?;
        connection.execute_batch("CREATE TABLE IF NOT EXISTS jobs(id TEXT PRIMARY KEY,created_at TEXT NOT NULL,payload TEXT NOT NULL)")?;
        let tx = connection.transaction()?;
        let mut statement = tx.prepare("SELECT id,payload FROM jobs")?;
        let rows = statement
            .query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        drop(statement);
        for (id, text) in rows {
            let mut job: Value = serde_json::from_str(&text)?;
            if is_active(&job) {
                job["status"] = json!("interrupted");
                job["finished_at"] = json!(files::now());
                job["error"] = json!("服务重新启动，之前的计算已中断；可按原参数重新运行");
                tx.execute(
                    "UPDATE jobs SET payload=?1 WHERE id=?2",
                    params![job.to_string(), id],
                )?;
            }
        }
        tx.commit()?;
        Ok(Self {
            refinement_validations: Arc::new(crate::refinement_validation::Validations::new(
                Duration::from_secs(
                    config.integer("layout_optimization", "refinement_session_idle_seconds"),
                ),
                config.integer("layout_optimization", "refinement_session_limit") as usize,
            )),
            config,
            engine,
            pre,
            directory,
            database,
            mesh_cache_lock: tokio::sync::Mutex::new(()),
            state: Mutex::new(JobState {
                active: None,
                live: None,
                flushed: Instant::now(),
            }),
        })
    }
    /// 在调用方持有任务锁时读取独立历史快照。
    pub fn read(&self, id: &str) -> Result<Value> {
        let _logging_step =
            crate::monitoring::Step::new("jobs::read", serde_json::json!({"id":id}));
        let connection = database::connect(&self.database, &self.config)?;
        let encoded: Option<String> = connection
            .query_row("SELECT payload FROM jobs WHERE id=?", [id], |r| r.get(0))
            .optional()?;
        let mut job: Value =
            serde_json::from_str(&encoded.ok_or_else(|| Error::missing("找不到指定布局任务"))?)?;
        if job.get("name").is_none() {
            job["name"] = json!("");
        }
        Ok(job)
    }
    /// 读取任务，避免与进度/重命名事务交错。
    pub fn get(&self, id: &str) -> Result<Value> {
        let _logging_step = crate::monitoring::Step::new("jobs::get", serde_json::json!({"id":id}));
        let state = self.state.lock().unwrap();
        self.read_live(&state, id)
    }
    /// 优先读取活动任务的内存快照；调用者持锁，终态与旧历史仍从 SQLite 读取。
    fn read_live(&self, state: &JobState, id: &str) -> Result<Value> {
        let _logging_step =
            crate::monitoring::Step::new("jobs::read_live", serde_json::json!({"id":id}));
        if let Some(job) = &state.live {
            if job["job_id"] == id {
                return Ok(job.clone());
            }
        }
        self.read(id)
    }
    /// 先持久化再同步内存视图；数据库失败不把状态伪装成已经保存。
    fn save_live(&self, state: &mut JobState, job: &Value) -> Result<()> {
        let _logging_step = crate::monitoring::Step::new("jobs::save_live", serde_json::json!({}));
        self.save(job)?;
        if state
            .active
            .as_ref()
            .is_some_and(|(id, _)| job["job_id"] == *id)
        {
            state.live = Some(job.clone());
            state.flushed = Instant::now();
        }
        Ok(())
    }
    /// 写入完整任务快照，调用者必须持有任务锁。
    pub fn save(&self, job: &Value) -> Result<()> {
        let _logging_step = crate::monitoring::Step::new("jobs::save", serde_json::json!({}));
        database::connect(&self.database, &self.config)?.execute(
            "INSERT OR REPLACE INTO jobs VALUES(?1,?2,?3)",
            params![
                job["job_id"].as_str(),
                job["created_at"].as_str(),
                job.to_string()
            ],
        )?;
        Ok(())
    }
    /// 返回分页历史摘要，不把大候选几何展开到列表。
    pub fn history(&self, limit: i64, offset: i64) -> Result<Value> {
        let _logging_step = crate::monitoring::Step::new("jobs::history", serde_json::json!({}));
        let _guard = self.state.lock().unwrap();
        let connection = database::connect(&self.database, &self.config)?;
        let total: i64 = connection.query_row("SELECT COUNT(*) FROM jobs", [], |r| r.get(0))?;
        let mut statement = connection
            .prepare("SELECT payload FROM jobs ORDER BY created_at DESC LIMIT ?1 OFFSET ?2")?;
        let rows = statement
            .query_map(params![limit, offset], |r| r.get::<_, String>(0))?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        let mut jobs = vec![];
        for text in rows {
            let job: Value = serde_json::from_str(&text)?;
            jobs.push(json!({"job_id":job["job_id"],"name":job.get("name").cloned().unwrap_or(json!("")),"status":job["status"],"created_at":job["created_at"],"notes":job["notes"],"error":job["error"],"candidate_count":job["candidates"].as_array().map(|x|x.len()).unwrap_or(0)}));
        }
        Ok(json!({"jobs":jobs,"total":total}))
    }
    /// 修改展示名称，不覆盖并发进度更新或输入备注。
    pub fn rename(&self, id: &str, name: &str) -> Result<Value> {
        let _logging_step =
            crate::monitoring::Step::new("jobs::rename", serde_json::json!({"id":id}));
        let mut state = self.state.lock().unwrap();
        let mut job = self.read_live(&state, id)?;
        job["name"] = json!(name);
        self.save_live(&mut state, &job)?;
        Ok(job)
    }
    /// 调用方持有任务锁时扫描全部已保存名称，返回最大默认编号加一；数据库错误向上传递。
    pub fn next_default_name(&self) -> Result<String> {
        let prefix = self
            .config
            .string("layout_optimization", "history_default_name_prefix");
        let width =
            self.config
                .integer("layout_optimization", "history_default_name_digits") as usize;
        let connection = database::connect(&self.database, &self.config)?;
        let mut statement = connection.prepare(
            "SELECT json_extract(payload, '$.name') FROM jobs WHERE json_type(payload, '$.name') = 'text'",
        )?;
        let names = statement.query_map([], |row| row.get::<_, String>(0))?;
        let mut maximum = 0_u64;
        for name in names {
            if let Some(suffix) = name?.strip_prefix(prefix) {
                if suffix.len() >= width && suffix.bytes().all(|byte| byte.is_ascii_digit()) {
                    if let Ok(number) = suffix.parse::<u64>() {
                        maximum = maximum.max(number);
                    }
                }
            }
        }
        let next = maximum
            .checked_add(1)
            .ok_or_else(|| Error::conflict("默认项目编号已达上限，请重命名最大编号项目后重试"))?;
        Ok(format!("{prefix}{next:0width$}"))
    }
    /// 仅删除终态项目，文件清理失败时保留历史记录。
    pub fn delete(&self, id: &str) -> Result<()> {
        let _logging_step =
            crate::monitoring::Step::new("jobs::delete", serde_json::json!({"id":id}));
        let state = self.state.lock().unwrap();
        let job = self.read(id)?;
        if is_active(&job) || state.active.as_ref().is_some_and(|(x, _)| x == id) {
            return Err(Error::conflict(
                "任务仍在运行或收尾，请取消并等待结束后再删除",
            ));
        }
        files::safe_id(id)?;
        let root = files::within(&self.directory, id)?;
        if root.exists() {
            fs::remove_dir_all(root)
                .map_err(|e| Error::conflict(format!("项目快照清理失败，历史记录已保留：{e}")))?;
        }
        database::connect(&self.database, &self.config)?
            .execute("DELETE FROM jobs WHERE id=?", [id])?;
        Ok(())
    }
    /// 验证当前锁定配置并登记排队项目，随后启动独立计算任务。
    pub fn start(self: &Arc<Self>, input: Value) -> Result<Value> {
        let _logging_step = crate::monitoring::Step::new("jobs::start", serde_json::json!({}));
        let options = layout_config::options(&self.config, &input)?;
        let mut state = self.state.lock().unwrap();
        if state.active.is_some() {
            return Err(Error::conflict("已有布局任务运行中，请先取消或等待完成"));
        }
        if self.engine.shutdown.is_cancelled() {
            return Err(Error::conflict("服务正在退出"));
        }
        let configuration = layout_config::configuration(&self.pre)?;
        self.pre
            .validate_installation_bounds(&configuration["geometry"])?;
        let parameters = layout_config::resolve(&configuration, &options)?;
        let id = files::identifier();
        let name = self.next_default_name()?;
        let job = json!({"job_id":id,"name":name,"status":"queued","created_at":files::now(),"finished_at":null,"parameters":parameters,"notes":parameters["notes"],"options":options,"locked_config":configuration,"progress":{},"events":[],"candidates":[],"error":""});
        self.save(&job)?;
        let cancel = CancellationToken::new();
        state.active = Some((id.clone(), cancel.clone()));
        state.live = Some(job.clone());
        state.flushed = Instant::now();
        let this = self.clone();
        crate::monitoring::spawn(async move {
            this.run(id, cancel).await;
        });
        Ok(job)
    }
    /// 将活动任务标为 cancelling，终态任务幂等返回。
    pub fn cancel(&self, id: &str) -> Result<Value> {
        let _logging_step =
            crate::monitoring::Step::new("jobs::cancel", serde_json::json!({"id":id}));
        let mut state = self.state.lock().unwrap();
        let mut job = self.read_live(&state, id)?;
        if let Some((active, token)) = &state.active {
            if active == id && is_active(&job) {
                token.cancel();
                job["status"] = json!("cancelling");
                self.save_live(&mut state, &job)?;
            }
        }
        Ok(job)
    }
    /// 合并标量状态或结果，在锁内读取最新任务避免覆盖重命名与取消。
    pub fn change(&self, id: &str, fields: Value) -> Result<Value> {
        let _logging_step =
            crate::monitoring::Step::new("jobs::change", serde_json::json!({"id":id}));
        let mut state = self.state.lock().unwrap();
        let mut job = self.read_live(&state, id)?;
        for (key, value) in fields.as_object().unwrap() {
            if key == "status" && job["status"] == "cancelling" && value == "running" {
                continue;
            }
            if key == "progress" && value.is_object() {
                for (name, field) in value.as_object().unwrap() {
                    job["progress"][name] = field.clone();
                }
            } else {
                job[key] = value.clone();
            }
        }
        self.save_live(&mut state, &job)?;
        Ok(job)
    }
    /// 合并已校验事件；相同标识的文字替换旧记录，候选先落盘，资源采样只更新进度。
    pub fn event(&self, id: &str, event: Value) -> Result<()> {
        let _logging_step =
            crate::monitoring::Step::new("jobs::event", serde_json::json!({"id":id}));
        let mut state = self.state.lock().unwrap();
        let mut job = self.read_live(&state, id)?;
        let important = event["type"] == "candidates"
            || ["phase", "round_index", "termination_reason"]
                .iter()
                .any(|key| {
                    !event["data"][key].is_null() && event["data"][key] != job["progress"][key]
                });
        if event["type"] == "candidates" {
            job["candidates"] = event["verified_candidates"].clone();
        } else {
            for (key, value) in event["data"]
                .as_object()
                .ok_or_else(|| Error::bad("进度必须为对象"))?
            {
                job["progress"][key] = value.clone();
            }
            if event["data"]["message"]
                .as_str()
                .is_some_and(|message| !message.trim().is_empty())
            {
                let mut entry = event["data"].clone();
                entry["time"] = json!(files::now());
                let events = job["events"].as_array_mut().unwrap();
                if let Some(key) = event["data"]["message_key"]
                    .as_str()
                    .filter(|key| !key.trim().is_empty())
                {
                    events.retain(|previous| previous["message_key"].as_str() != Some(key));
                }
                events.push(entry);
                let max = self
                    .config
                    .integer("layout_optimization", "progress_history_size")
                    as usize;
                if events.len() > max {
                    events.drain(..events.len() - max);
                }
            }
        }
        let interval =
            Duration::from_secs_f64(self.config.number("rust_backend", "progress_flush_seconds"));
        if important || state.flushed.elapsed() >= interval {
            self.save_live(&mut state, &job)?;
        } else {
            state.live = Some(job);
        }
        Ok(())
    }
    /// 结束取消并保留已经持久化的合法候选；收尾更新不会抹去并发重命名。
    pub fn finish_cancelled(&self, id: &str) -> Result<()> {
        let _logging_step =
            crate::monitoring::Step::new("jobs::finish_cancelled", serde_json::json!({"id":id}));
        let mut state = self.state.lock().unwrap();
        let mut job = self.read_live(&state, id)?;
        let count = job["candidates"].as_array().unwrap().len();
        let message = format!("任务已取消，保留取消前已验收的 {count} 组布局");
        job["status"] = json!("cancelled");
        job["finished_at"] = json!(files::now());
        job["error"] = json!("用户取消了优化");
        for(key,value)in json!({"valid_count":count,"returned_count":count,"termination_reason":"cancelled","message":message}).as_object().unwrap(){job["progress"][key]=value.clone();}
        self.save_live(&mut state, &job)
    }
    /// 执行任务并统一落实失败/取消终态；只有收尾完毕才释放单活动项目约束。
    async fn run(self: Arc<Self>, id: String, cancel: CancellationToken) {
        let logs = match self.config.logs() {
            Ok(logs) => logs,
            Err(error) => {
                crate::logging::issue(
                    crate::runtime_logging::Level::Error,
                    format_args!("布局日志初始化失败：{error}"),
                );
                return;
            }
        };
        let operation = crate::monitoring::background(&logs, "后端·布局优化");
        operation.context(json!({"job_id":id}));
        let operation_scope = operation.clone();
        crate::monitoring::scope(operation_scope, self.run_monitored(id, cancel, operation)).await;
    }
    /// 在完整后台生命周期内监测准备、计算、发布和终态持久化。
    async fn run_monitored(
        self: Arc<Self>,
        id: String,
        cancel: CancellationToken,
        operation: Arc<crate::runtime_logging::Operation>,
    ) {
        let _logging_step = crate::monitoring::Step::new("jobs::run", serde_json::json!({"id":id}));
        let outcome = self.execute(&id, cancel.clone()).await;
        if let Err(error) = &outcome {
            operation.remember(error.diagnostic());
        }
        let failure = outcome.as_ref().err().map(|error| error.to_string());
        let this = self.clone();
        let key = id.clone();
        let cancelled = cancel.is_cancelled() || self.engine.shutdown.is_cancelled();
        let finish = blocking(move || {
            if cancelled {
                this.finish_cancelled(&key)?;
            } else if let Err(error) = outcome {
                let status = if error.computation_code.as_deref() == Some("infeasible") {
                    "infeasible"
                } else {
                    "failed"
                };
                this.change(
                    &key,
                    json!({"status":status,"finished_at":files::now(),"error":error.message}),
                )?;
            }
            Ok(())
        })
        .await;
        if let Err(error) = finish {
            operation.context(json!({"outcome":"任务终态保存失败，下次启动将检查未完成状态"}));
            operation.finish(
                crate::runtime_logging::Level::Error,
                "终态持久化失败",
                Some(&error.to_string()),
            );
        } else {
            operation.context(json!({"outcome":if cancelled {
                "优化已取消，已保存取消状态"
            } else if failure.is_some() {
                "优化已终止，已保存失败状态"
            } else {
                "优化结果已保存"
            }}));
        }
        operation.finish(
            if failure.is_some() && !cancelled {
                crate::runtime_logging::Level::Error
            } else {
                crate::runtime_logging::Level::Info
            },
            if cancelled {
                "布局已取消"
            } else if failure.is_some() {
                "布局失败"
            } else {
                "布局处理完成"
            },
            failure.as_deref(),
        );
        // 磁盘故障也必须允许退出；未写入的活动状态会在下次启动明确标记 interrupted。
        let mut state = self.state.lock().unwrap();
        if state.active.as_ref().is_some_and(|(x, _)| x == &id) {
            state.active = None;
            state.live = None;
        }
    }
}
/// 判断历史状态是否仍然活动，启动时用于中断恢复，删除时用于保护在途项目。
pub fn is_active(job: &Value) -> bool {
    matches!(
        job["status"].as_str(),
        Some("queued" | "running" | "cancelling")
    )
}
