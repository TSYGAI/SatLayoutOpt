//! 文件说明：Rust 模型上传、设置及包络服务；汇总可恢复的包络工作进度，CAD 只在独立引擎执行。
use crate::{
    blocking,
    compute::{Engine, Task},
    config::Config,
    error::{Error, Result},
    files, model_manifests as manifests, model_settings,
};
use serde_json::{json, Value};
use std::{
    collections::{HashMap, HashSet},
    fs,
    io::Read,
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
};
use tokio::sync::{mpsc, Mutex as AsyncMutex, OwnedMutexGuard};
use tokio_util::sync::CancellationToken;

/// 上传索引及删除屏障；短时元数据操作与发布共用此锁。
pub struct ModelState {
    pub entries: Vec<Value>,
    deleting: HashSet<String>,
}
/// 模型业务资源，不拥有 SQLite 固化记录，删除上传模型不会级联删除固化快照。
pub struct Models {
    pub config: Arc<Config>,
    pub engine: Arc<Engine>,
    pub storage: PathBuf,
    pub artifacts: PathBuf,
    pub state: Mutex<ModelState>,
    pub(crate) preview_sources: crate::preview_reuse::SourceDigests,
    gates: Mutex<HashMap<String, Arc<AsyncMutex<()>>>>,
    latest: Mutex<Value>,
}
impl Models {
    /// 打开兼容 JSON 索引并迁移缺失默认名称；损坏索引报错，避免覆盖已有数据。
    pub fn open(config: Arc<Config>, engine: Arc<Engine>) -> Result<Self> {
        let _logging_step = crate::monitoring::Step::new("models::open", serde_json::json!({}));
        let storage = config.directory("backend", "model_storage_dir");
        let artifacts = config.directory("backend", "model_artifact_dir");
        fs::create_dir_all(&storage)?;
        fs::create_dir_all(&artifacts)?;
        let index = storage.join("index.json");
        let mut entries = if index.exists() {
            files::read_json(&index)?
                .as_array()
                .cloned()
                .ok_or_else(|| Error::bad("上传索引损坏"))?
        } else {
            vec![]
        };
        let original = entries.clone();
        for model in &mut entries {
            files::safe_id(
                model["id"]
                    .as_str()
                    .ok_or_else(|| Error::bad("上传索引缺少标识"))?,
            )?;
            files::within(
                &storage,
                model["stored_name"]
                    .as_str()
                    .ok_or_else(|| Error::bad("上传索引缺少文件名"))?,
            )?;
            let name = model["settings"]["device_name"]
                .as_str()
                .unwrap_or("")
                .trim();
            if name.is_empty()
                || name == config.string("backend", "model_settings_default_device_name")
            {
                let stem = Path::new(model["filename"].as_str().unwrap_or(""))
                    .file_stem()
                    .and_then(|x| x.to_str())
                    .unwrap_or("")
                    .to_string();
                if !stem.is_empty() && stem.chars().count() <= 200 {
                    if !model["settings"].is_object() {
                        model["settings"] = json!({});
                    }
                    model["settings"]["device_name"] = json!(stem);
                }
            }
            model["settings"] =
                model_settings::normalize(&config, &model["settings"], None, false)?;
        }
        if entries != original {
            files::write_json(&index, &json!(entries))?;
        }
        Ok(Self {
            config,
            engine,
            storage,
            artifacts,
            state: Mutex::new(ModelState {
                entries,
                deleting: HashSet::new(),
            }),
            gates: Mutex::new(HashMap::new()),
            preview_sources: Default::default(),
            latest: Mutex::new(json!({"state":"idle"})),
        })
    }
    /// 获取资源锁句柄，供异步等待和上传后的非阻塞预热共同使用。
    pub(crate) fn resource_gate(&self, id: &str, kind: &str) -> Arc<AsyncMutex<()>> {
        let _logging_step =
            crate::monitoring::Step::new("models::gate", serde_json::json!({"id":id}));
        self.gates
            .lock()
            .unwrap()
            .entry(format!("{id}:{kind}"))
            .or_insert_with(|| Arc::new(AsyncMutex::new(())))
            .clone()
    }
    /// 取得指定业务资源锁，预览两档及包络互不阻塞已发布资源读取。
    pub async fn gate(&self, id: &str, kind: &str) -> OwnedMutexGuard<()> {
        self.resource_gate(id, kind).lock_owned().await
    }
    /// 在调用方持有索引锁时查找有效模型，删除屏障阻止迟到计算发布。
    pub fn find(&self, state: &ModelState, id: &str) -> Result<Value> {
        let _logging_step =
            crate::monitoring::Step::new("models::find", serde_json::json!({"id":id}));
        if state.deleting.contains(id) {
            return Err(Error::missing("模型正在删除，已取消转换"));
        }
        state
            .entries
            .iter()
            .find(|m| m["id"] == id && self.source_path(m).is_ok_and(|p| p.is_file()))
            .cloned()
            .ok_or_else(|| Error::missing("找不到指定模型"))
    }
    /// 返回独立模型快照，不在异步计算期间持有索引锁。
    pub fn get(&self, id: &str) -> Result<Value> {
        let _logging_step =
            crate::monitoring::Step::new("models::get", serde_json::json!({"id":id}));
        self.find(&self.state.lock().unwrap(), id)
    }
    /// 将受验证存储名解析为源文件路径。
    pub fn source_path(&self, model: &Value) -> Result<PathBuf> {
        let _logging_step =
            crate::monitoring::Step::new("models::source_path", serde_json::json!({}));
        files::within(
            &self.storage,
            model["stored_name"]
                .as_str()
                .ok_or_else(|| Error::bad("缺少模型文件名"))?,
        )
    }
    /// 返回模型派生目录，调用方模型标识已通过索引或 safe_id 验证。
    pub fn root(&self, id: &str) -> PathBuf {
        let _logging_step =
            crate::monitoring::Step::new("models::root", serde_json::json!({"id":id}));
        self.artifacts.join(id)
    }
    /// 从当前模型读取仍有效的预览清单。
    pub fn current_preview(&self, model: &Value, quality: &str) -> Option<Value> {
        let _logging_step = crate::monitoring::Step::new(
            "models::current_preview",
            serde_json::json!({"quality":quality}),
        );
        manifests::preview(
            &self.config,
            &self.root(model["id"].as_str()?),
            &manifests::source(&self.source_path(model).ok()?).ok()?,
            quality,
        )
    }
    /// 从当前设置读取仍有效的包络清单。
    pub fn current_envelope(&self, model: &Value) -> Option<Value> {
        let _logging_step =
            crate::monitoring::Step::new("models::current_envelope", serde_json::json!({}));
        manifests::envelope(
            &self.config,
            &self.root(model["id"].as_str()?),
            &manifests::source(&self.source_path(model).ok()?).ok()?,
            &model["settings"],
        )
    }
    /// 构造与原 API 一致的模型公开状态。
    pub fn public(&self, model: &Value) -> Value {
        let _logging_step = crate::monitoring::Step::new("models::public", serde_json::json!({}));
        let detail = self.current_preview(model, "detail");
        let interaction = self.current_preview(model, "interaction");
        json!({"id":model["id"],"filename":model["filename"],"size":model["size"],"uploaded_at":model["uploaded_at"],"source_format":"STEP",
            "download_url":format!("/api/models/{}/file", model["id"].as_str().unwrap()),"settings":model["settings"],
            "derivatives":{"state":if detail.is_some(){"ready"}else{"pending"},"interaction_state":if interaction.is_some(){"ready"}else{"pending"},
                "stats":detail.as_ref().or(interaction.as_ref()).map(|m|&m["stats"]),"envelope":manifests::envelope_status(self.current_envelope(model).as_ref())}})
    }
    /// 读取模型列表并剔除缺失源文件，原子保存清理后的索引。
    pub fn list(&self) -> Result<Value> {
        let _logging_step = crate::monitoring::Step::new("models::list", serde_json::json!({}));
        let mut state = self.state.lock().unwrap();
        let mut entries: Vec<_> = state
            .entries
            .iter()
            .filter(|m| self.source_path(m).is_ok_and(|p| p.is_file()))
            .cloned()
            .collect();
        if entries != state.entries {
            files::write_json(&self.storage.join("index.json"), &json!(entries))?;
            state.entries = entries.clone();
        }
        entries.sort_by(|a, b| b["uploaded_at"].as_str().cmp(&a["uploaded_at"].as_str()));
        Ok(
            json!({"models":entries.iter().filter(|m|!state.deleting.contains(m["id"].as_str().unwrap())).map(|m|self.public(m)).collect::<Vec<_>>()}),
        )
    }
    /// 校验已流式落盘的上传、原子登记索引；失败时清理仅本次创建的目标。
    pub fn upload(&self, filename: &str, temporary: &Path) -> Result<Value> {
        let _logging_step = crate::monitoring::Step::new(
            "models::upload",
            serde_json::json!({"filename":filename}),
        );
        let name = filename.rsplit(['/', '\\']).next().unwrap_or("").trim();
        let suffix = Path::new(name)
            .extension()
            .and_then(|x| x.to_str())
            .unwrap_or("")
            .to_lowercase();
        if name.is_empty() || !["stp", "step"].contains(&suffix.as_str()) {
            return Err(Error::bad("仅支持上传 .stp 或 .step 模型文件"));
        }
        let size = fs::metadata(temporary)?.len();
        let mut head = vec![0u8; 4096];
        let n = fs::File::open(temporary)?.read(&mut head)?;
        if size == 0
            || !String::from_utf8_lossy(&head[..n])
                .to_uppercase()
                .contains("ISO-10303-21")
        {
            return Err(Error::bad("文件内容不是有效的 STEP 交换格式"));
        }
        let settings = model_settings::normalize(
            &self.config,
            &json!({"device_name":Path::new(name).file_stem().and_then(|x|x.to_str())}),
            None,
            false,
        )
        .map_err(|e| Error::bad(e.message))?;
        let id = files::identifier();
        let stored = format!("{id}.{suffix}");
        let target = self.storage.join(&stored);
        files::replace(temporary, &target)?;
        let model = json!({"id":id,"filename":name,"stored_name":stored,"size":size,"uploaded_at":files::now(),"settings":settings});
        let mut state = self.state.lock().unwrap();
        let mut entries = state.entries.clone();
        entries.push(model.clone());
        if let Err(e) = files::write_json(&self.storage.join("index.json"), &json!(entries)) {
            let _ = fs::remove_file(target);
            return Err(e);
        }
        state.entries = entries;
        drop(state);
        self.warm_uploaded_preview(&id);
        Ok(json!({"model":self.public(&model)}))
    }
    /// 从有效内部清单补全下载 URL 与另一档统计。
    pub fn public_manifest(&self, id: &str, quality: &str, mut manifest: Value) -> Result<Value> {
        let _logging_step = crate::monitoring::Step::new(
            "models::public_manifest",
            serde_json::json!({"id":id,"quality":quality}),
        );
        let model = self.get(id)?;
        manifest["model"] = self.public(&model);
        let route = if quality == "interaction" {
            "preview-interaction.glb"
        } else {
            "preview.glb"
        };
        manifest["browser_asset"]["url"] = json!(format!(
            "/api/models/{id}/{route}?v={}",
            manifest["generated_at"].as_str().unwrap_or("")
        ));
        if manifest["face_mapping"].is_object() {
            let route = if quality == "interaction" {
                "interaction-face-map"
            } else {
                "face-map"
            };
            manifest["face_mapping"]["url"] = json!(format!(
                "/api/models/{id}/{route}?v={}",
                manifest["generated_at"].as_str().unwrap_or("")
            ));
        }
        let counterpart = if quality == "interaction" {
            "detail"
        } else {
            "interaction"
        };
        if let Some(other) = self.current_preview(&model, counterpart) {
            manifest["stats"][format!("{counterpart}_triangle_count")] =
                other["stats"]["triangle_count"].clone();
        }
        Ok(manifest)
    }
    /// 优先立即返回有效清单，缺失时只生成所需质量档并在源指纹匹配时发布。
    pub async fn preview(self: &Arc<Self>, id: &str, quality: &str) -> Result<Value> {
        let _logging_step = crate::monitoring::Step::new(
            "models::preview",
            serde_json::json!({"id":id,"quality":quality}),
        );
        if self.engine.shutdown.is_cancelled() {
            return Err(Error::conflict("服务正在退出"));
        }
        let this = self.clone();
        let key = id.to_string();
        let tier = quality.to_string();
        let found = blocking(move || Ok(this.current_preview(&this.get(&key)?, &tier))).await?;
        if let Some(manifest) = found {
            return self.public_manifest(id, quality, manifest);
        }
        let _gate = self.gate(id, quality).await;
        let this = self.clone();
        let key = id.to_string();
        let (hashed_source, digest) = blocking(move || {
            let model = this.get(&key)?;
            this.preview_sources.get(&this.source_path(&model)?)
        })
        .await?;
        // 相同内容与参数共用生成锁；等待者会在取得锁后复用首个成功结果。
        let content_key = files::fingerprint(&json!({"sha256":digest,"quality":quality,
            "parameters":manifests::preview_parameters(&self.config,quality)}));
        let _content_gate = self.wait_preview_content(id, &content_key, quality).await;
        let this = self.clone();
        let key = id.to_string();
        let tier = quality.to_string();
        let content_digest = digest.clone();
        if let Some(manifest) =
            blocking(move || this.reuse_preview(&key, &tier, &content_digest)).await?
        {
            return self.public_manifest(id, quality, manifest);
        }
        let this = self.clone();
        let key = id.to_string();
        let tier = quality.to_string();
        let prepared = blocking(move || {
            let state = this.state.lock().unwrap(); let model = this.find(&state, &key)?;
            if let Some(found) = this.current_preview(&model, &tier) { return Ok((None, found)); }
            let source = manifests::source(&this.source_path(&model)?)?;
            if source != hashed_source { return Err(Error::conflict("模型源文件在等待预览期间发生变化，请重试")); }
            let mut task = Task::new(&this.config, "preview.generate", &json!({"model":this.public(&model),"quality":tier,"parameters":manifests::preview_parameters(&this.config,&tier)}))?;
            task.add("source", "source.step", &this.source_path(&model)?)?;
            Ok((Some(task), source))
        }).await?;
        let (Some(task), expected) = prepared else {
            return self.public_manifest(id, quality, prepared.1);
        };
        let outcome = self
            .engine
            .run(task, id, CancellationToken::new(), None)
            .await?;
        if outcome.cancelled {
            return Err(Error::bad("模型预览已取消"));
        }
        let this = self.clone();
        let key = id.to_string();
        let tier = quality.to_string();
        let manifest = blocking(move || {
            let produced = outcome.task.output.join("artifacts");
            let manifest = manifests::preview_files(
                &this.config,
                &produced,
                &produced.join("shell-map.json"),
                &expected,
                &tier,
            )
            .ok_or_else(|| Error::bad("生成预览清单未通过完整校验"))?;
            // 摘要凭据只用于以后复用；写入失败不阻止本次已经成功的预览发布。
            if let Err(error) = crate::preview_reuse::record(&produced, &manifest, &digest) {
                crate::logging::issue(
                    crate::runtime_logging::Level::Warn,
                    format_args!("预览复用摘要保存失败：{error}"),
                );
            }
            let state = this.state.lock().unwrap();
            let model = this.find(&state, &key)?;
            if manifests::source(&this.source_path(&model)?)? != expected {
                return Err(Error::bad("模型源文件已变化"));
            }
            let root = this.root(&key);
            let shell = files::read_json(&produced.join("shell-map.json"))?;
            files::publish_with(&produced, &root.join(&tier), || {
                if manifest["parameters"]["shell_policy"] != "all_faces_interaction" {
                    files::write_json(&root.join("common/shell-map.json"), &shell)?;
                }
                Ok(())
            })?;
            let _ = fs::remove_file(root.join("runtime-preview.bin"));
            Ok(manifest)
        })
        .await?;
        self.public_manifest(id, quality, manifest)
    }
    /// 校验设置和精确安装面投影，保存前比较旧设置与源指纹以拒绝迟到写入。
    pub async fn update(self: &Arc<Self>, id: &str, mut value: Value) -> Result<Value> {
        let _logging_step =
            crate::monitoring::Step::new("models::update", serde_json::json!({"id":id}));
        let _gate = self.gate(id, "settings").await;
        let previous = self.get(id)?;
        if let Some(expected) = value
            .as_object_mut()
            .and_then(|v| v.remove("expected_settings"))
            .filter(|v| !v.is_null())
        {
            if !model_settings::matches_baseline(&self.config, &expected, &previous["settings"])? {
                return Err(Error::conflict(
                    "模型设置已被其他操作修改，请重新进入坐标系编辑",
                ));
            }
        }
        let mut settings =
            model_settings::normalize(&self.config, &value, Some(&previous["settings"]), true)?;
        let source = manifests::source(&self.source_path(&previous)?)?;
        if !settings["installation_face_id"].is_null() {
            let tier = if self
                .current_preview(&previous, "interaction")
                .is_some_and(|m| m["face_mapping"].is_object())
            {
                "interaction"
            } else {
                "detail"
            };
            let manifest = self.preview(id, tier).await?;
            let this = self.clone();
            let model = previous.clone();
            let saved = settings.clone();
            let key = id.to_string();
            let task = blocking(move || {
                let mut task = Task::new(&this.config,"installation.project",&json!({"face_id":saved["installation_face_id"],"point":saved["installation_point"],
                    "linear_ratio":if tier=="interaction"{manifest["parameters"]["actual_linear_ratio"].clone()}else{Value::Null},
                    "tolerance":if tier=="interaction"{manifest["parameters"]["actual_linear_tolerance"].as_f64().map(|x|x*2.0)}else{None}}))?;
                task.monitor.context(json!({"model_id":key,"model_name":saved["device_name"].as_str().or_else(|| model["filename"].as_str()),"face_id":saved["installation_face_id"]}));
                task.add("source","source.step",&this.source_path(&model)?)?;
                task.add("mapping","face-map.json",&files::within(&this.root(&key).join(tier),manifest["face_mapping"]["file_name"].as_str().ok_or_else(|| Error::bad("安装面映射缺失"))?)?)?;
                let faces=this.root(&key).join(tier).join("faces.brep"); if tier=="interaction" && faces.is_file(){task.add("faces","faces.brep",&faces)?;} Ok(task)
            }).await?;
            let result = self
                .engine
                .run(task, id, CancellationToken::new(), None)
                .await?;
            if result.cancelled {
                return Err(Error::bad("安装面校验已取消"));
            }
            settings["installation_point"] = result.result["installation_point"].clone();
        }
        let this = self.clone();
        let key = id.to_string();
        blocking(move || {
            let mut state = this.state.lock().unwrap(); let current=this.find(&state,&key)?;
            if current["settings"]!=previous["settings"] || manifests::source(&this.source_path(&current)?)? !=source {return Err(Error::bad("校验期间模型已变化，请重新保存"));}
            let mut entries=state.entries.clone(); for model in &mut entries{if model["id"]==key{model["settings"]=settings.clone();}}
            files::write_json(&this.storage.join("index.json"),&json!(entries))?; state.entries=entries;
            let model=this.find(&state,&key)?;
            Ok(json!({"settings":settings,"envelope":manifests::envelope_status(this.current_envelope(&model).as_ref())}))
        }).await
    }
    /// 生成正式包络；只在源、几何设置及增量均未变化时发布。
    pub async fn generate_envelope(self: &Arc<Self>, id: &str) -> Result<Value> {
        self.generate_envelope_with_events(id, None).await
    }
    /// 在正式包络计算期间转发独立引擎事件；只有校验和原子发布成功后返回结果。
    async fn generate_envelope_with_events(
        self: &Arc<Self>,
        id: &str,
        events: Option<mpsc::Sender<Value>>,
    ) -> Result<Value> {
        let _logging_step =
            crate::monitoring::Step::new("models::generate_envelope", serde_json::json!({"id":id}));
        self.preview(id, "interaction").await?;
        let _gate = self.gate(id, "envelope").await;
        let this = self.clone();
        let key = id.to_string();
        let (task, expected)=blocking(move || {
            let state=this.state.lock().unwrap(); let model=this.find(&state,&key)?;
            let expected=json!({"source":manifests::source(&this.source_path(&model)?)?,"geometry":model_settings::geometry(&model["settings"]),"parameters":manifests::envelope_parameters(&this.config,&model["settings"])});
            let mut task=Task::new(&this.config,"envelope.generate",&json!({"model":{"id":key,"filename":model["filename"],"settings":model["settings"]},"source":expected["source"],"parameters":expected["parameters"]}))?;
            task.add("source","source.step",&this.source_path(&model)?)?;
            // 缓存可以在增量变化后失效；由 Python 校验源、姿态和参数后决定复用。
            let previous = this.root(&key).join("envelope");
            if previous.join("manifest.json").is_file() {
                task.add("envelope_manifest", "previous/manifest.json", &previous.join("manifest.json"))?;
                for name in ["source_mesh.npz", "rot_z_0_envelope.npz"] {
                    let path = previous.join(name);
                    if path.is_file() { task.add_shared(name, &format!("previous/{name}"), &path)?; }
                }
            }
            Ok((task,expected))
        }).await?;
        let outcome = self
            .engine
            .run(task, id, CancellationToken::new(), events)
            .await?;
        if outcome.cancelled {
            return Err(Error::bad("包络生成已取消"));
        }
        let this = self.clone();
        let key = id.to_string();
        blocking(move || {
            let state=this.state.lock().unwrap(); let model=this.find(&state,&key)?;
            if expected!=json!({"source":manifests::source(&this.source_path(&model)?)?,"geometry":model_settings::geometry(&model["settings"]),"parameters":manifests::envelope_parameters(&this.config,&model["settings"])}) {return Err(Error::bad("包络生成期间模型设置发生变化，请重新生成"));}
            let produced=outcome.task.output.join("artifacts"); let mut manifest=files::read_json(&produced.join("manifest.json"))?;
            if manifest["source"]!=expected["source"] || manifest["geometry_settings"]!=expected["geometry"] || manifest["parameters"]!=expected["parameters"] || manifest["algorithm"]!=this.config.string("rust_backend","envelope_algorithm") || manifest["model_id"]!=key || manifest["variants"].as_array().is_none_or(|v|v.len()!=1 || v[0]["rot_z"]!=0 || !v[0]["watertight"].is_boolean()) {return Err(Error::bad("包络产物与任务不一致"));}
            files::publish(&produced,&this.root(&key).join("envelope"))?;
            manifest["state"]=json!("ready"); for variant in manifest["variants"].as_array_mut().unwrap(){variant.as_object_mut().unwrap().remove("file_name");}
            Ok(json!({"state":"ready","generated_at":manifest["generated_at"],"algorithm":manifest["algorithm"],"normalization":manifest["normalization"],"source_mesh":manifest["source_mesh"],"variants":manifest["variants"]}))
        }).await
    }
    /// 与模型计算并行消费有界进度事件；计算结束或准备失败时自然关闭接收，不遗留轮询任务。
    async fn generate_tracked_envelope(
        self: &Arc<Self>,
        id: &str,
        task_id: &str,
        index: usize,
        total: usize,
    ) -> Result<Value> {
        use crate::envelope_task_progress::update;
        update(
            &mut self.latest.lock().unwrap(),
            task_id,
            id,
            index,
            total,
            &json!({"phase":"preparing","message":"正在准备模型包络","percent":0}),
        );
        let (sender, mut receiver) = mpsc::channel::<Value>(
            self.config.integer("envelope_progress", "event_capacity") as usize,
        );
        let receive = async {
            while let Some(event) = receiver.recv().await {
                if event["type"] == "progress" {
                    update(
                        &mut self.latest.lock().unwrap(),
                        task_id,
                        id,
                        index,
                        total,
                        &event["data"]["envelope_progress"],
                    );
                }
            }
        };
        let (result, ()) = tokio::join!(
            self.generate_envelope_with_events(id, Some(sender)),
            receive
        );
        result
    }
    /// 读取最新包络任务；页面刷新不会取消后台工作。
    pub fn latest(&self) -> Value {
        let _logging_step = crate::monitoring::Step::new("models::latest", serde_json::json!({}));
        json!({"task":self.latest.lock().unwrap().clone()})
    }
    /// 启动唯一后台包络任务，重复请求幂等返回当前活动任务。
    pub fn start_envelopes(self: &Arc<Self>, id: Option<String>) -> Result<Value> {
        let _logging_step =
            crate::monitoring::Step::new("models::start_envelopes", serde_json::json!({"id":id}));
        if self.engine.shutdown.is_cancelled() {
            return Err(Error::conflict("服务正在退出"));
        }
        if let Some(id) = &id {
            self.get(id)?;
        }
        let mut latest = self.latest.lock().unwrap();
        if latest["state"] == "running" {
            return Ok(json!({"task":latest.clone()}));
        }
        let mut task = json!({"id":files::identifier(),"kind":if id.is_some(){"single"}else{"all"},"state":"running","started_at":files::now(),
            "progress":crate::envelope_task_progress::initial(if id.is_some(){1}else{0})});
        if let Some(id) = &id {
            task["model_id"] = json!(id);
        }
        *latest = task.clone();
        let task_id = task["id"].as_str().unwrap().to_string();
        let this = self.clone();
        let operation =
            crate::monitoring::background(self.config.logs()?.as_ref(), "后端·包络生成");
        crate::monitoring::spawn(crate::monitoring::scope(operation.clone(), async move {
            let result = if let Some(id) = id {
                this.generate_tracked_envelope(&id, &task_id, 0, 1).await
            } else {
                let models = this.list();
                match models {
                    Err(e) => Err(e),
                    Ok(models) => {
                        let mut results = vec![];
                        let models = models["models"].as_array().unwrap();
                        let total = models.len();
                        this.latest.lock().unwrap()["progress"]["total_models"] = json!(total);
                        for (index, model) in models.iter().enumerate() {
                            let id = model["id"].as_str().unwrap();
                            operation.stage("host",json!({"step":"处理模型包络","model_id":id,"model_name":model["filename"]}),true);
                            let result = this
                                .generate_tracked_envelope(id, &task_id, index, total)
                                .await;
                            results.push(match result{Ok(e)=>json!({"id":id,"filename":model["filename"],"status":"generated","envelope":e}),Err(e)=>json!({"id":id,"filename":model["filename"],"status":"failed","error":e.message})});
                            crate::envelope_task_progress::complete_model(
                                &mut this.latest.lock().unwrap(),
                                results.len(),
                                total,
                            );
                        }
                        let failed = results.iter().filter(|r| r["status"] == "failed").count();
                        Ok(
                            json!({"total":results.len(),"generated":results.len()-failed,"failed":failed,"results":results}),
                        )
                    }
                }
            };
            let mut latest = this.latest.lock().unwrap();
            latest["finished_at"] = json!(files::now());
            match result {
                Ok(value) => {
                    operation.finish(
                        if value["failed"].as_u64().unwrap_or(0) > 0 {
                            crate::runtime_logging::Level::Warn
                        } else {
                            crate::runtime_logging::Level::Info
                        },
                        "包络任务完成",
                        Some(&format!("失败数={}", value["failed"].as_u64().unwrap_or(0))),
                    );
                    latest["state"] = json!("succeeded");
                    latest["progress"]["percent"] = json!(100);
                    latest["progress"]["model_percent"] = json!(100);
                    latest["progress"]["completed_models"] =
                        latest["progress"]["total_models"].clone();
                    latest["progress"]["phase"] = json!("completed");
                    latest["progress"]["message"] =
                        json!(if value["failed"].as_u64().unwrap_or(0) > 0 {
                            "包络生成结束，部分模型失败"
                        } else {
                            "包络生成完成"
                        });
                    latest["result"] = value;
                }
                Err(e) => {
                    operation.remember(e.diagnostic());
                    operation.finish(
                        crate::runtime_logging::Level::Error,
                        "包络任务失败",
                        Some(&e.to_string()),
                    );
                    latest["state"] = json!("failed");
                    latest["progress"]["phase"] = json!("failed");
                    latest["progress"]["message"] = json!("包络生成失败");
                    latest["error"] = json!(e.message);
                }
            }
        }));
        Ok(json!({"task":task}))
    }
    /// 删除先建立屏障、取消在途计算，再清理上传资源和索引；不影响固化记录。
    pub async fn delete(self: &Arc<Self>, id: &str) -> Result<()> {
        let _logging_step =
            crate::monitoring::Step::new("models::delete", serde_json::json!({"id":id}));
        {
            let mut state = self.state.lock().unwrap();
            self.find(&state, id)?;
            state.deleting.insert(id.into());
        }
        self.engine.cancel_owner(id);
        let pending = async {
            (
                self.gate(id, "settings").await,
                self.gate(id, "detail").await,
                self.gate(id, "interaction").await,
                self.gate(id, "envelope").await,
            )
        };
        tokio::pin!(pending);
        let _guards = loop {
            tokio::select! {
                guards = &mut pending => break guards,
                _ = tokio::time::sleep(std::time::Duration::from_secs_f64(self.config.number("compute_engine","poll_interval_seconds"))) => self.engine.cancel_owner(id),
            }
        };
        while self.engine.owner_active(id) {
            tokio::time::sleep(std::time::Duration::from_secs_f64(
                self.config
                    .number("compute_engine", "poll_interval_seconds"),
            ))
            .await;
        }
        let this = self.clone();
        let key = id.to_string();
        blocking(move || {
            let mut state = this.state.lock().unwrap();
            let result = (|| {
                let model = state
                    .entries
                    .iter()
                    .find(|m| m["id"] == key)
                    .cloned()
                    .ok_or_else(|| Error::missing("找不到指定模型"))?;
                let entries: Vec<_> = state
                    .entries
                    .iter()
                    .filter(|m| m["id"] != key)
                    .cloned()
                    .collect();
                let source = this.source_path(&model)?;
                if source.exists() {
                    fs::remove_file(source)?;
                }
                this.preview_sources.forget(&this.source_path(&model)?);
                let root = this.root(&key);
                if root.exists() {
                    fs::remove_dir_all(root)?;
                }
                files::write_json(&this.storage.join("index.json"), &json!(entries))?;
                state.entries = entries;
                Ok(())
            })();
            state.deleting.remove(&key);
            result
        })
        .await
    }
}
