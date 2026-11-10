//! 文件说明：Rust 单个与全部模型固化存储；复用逐模型校验和原子快照，汇总批量结果，兼容既有 SQLite 与资产格式。
use crate::{
    blocking,
    config::Config,
    database,
    error::{Error, Result},
    files,
    models::Models,
};
use rusqlite::{params, OptionalExtension};
use serde_json::{json, Value};
use std::{
    fs,
    path::PathBuf,
    sync::{Arc, Mutex},
};

/// 固化表格式保持版本 1，源上传和固化记录互相独立。
const SCHEMA: &str = r#"
CREATE TABLE IF NOT EXISTS store_models (
 record_id TEXT PRIMARY KEY, source_model_id TEXT NOT NULL, device_name TEXT NOT NULL,
 source_filename TEXT NOT NULL, source_format TEXT NOT NULL, source_size INTEGER NOT NULL,
 source_asset_name TEXT NOT NULL, source_sha256 TEXT NOT NULL, settings_json TEXT NOT NULL,
 envelope_state TEXT NOT NULL, envelope_algorithm TEXT, envelope_generated_at TEXT,
 envelope_variant_count INTEGER NOT NULL DEFAULT 0, envelope_mesh_sha256 TEXT,
 envelope_preview_asset_name TEXT, envelope_preview_sha256 TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS store_envelope_variants (
 variant_id INTEGER PRIMARY KEY AUTOINCREMENT, record_id TEXT NOT NULL REFERENCES store_models(record_id) ON DELETE CASCADE,
 rot_z INTEGER NOT NULL,file_name TEXT NOT NULL,asset_name TEXT NOT NULL,size INTEGER NOT NULL,sha256 TEXT NOT NULL,
 vertex_count INTEGER NOT NULL,face_count INTEGER NOT NULL,watertight INTEGER NOT NULL,bounds_json TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS idx_store_models_created_at ON store_models(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_store_models_source_model ON store_models(source_model_id);
CREATE INDEX IF NOT EXISTS idx_store_variants_record ON store_envelope_variants(record_id,rot_z);
PRAGMA user_version=1;
"#;

/// 汇总固化必需设置与包络缺项；零坐标和现行设置契约允许的零质量均为已填写，失败不创建任务或数据库记录。
pub fn validate_snapshot_requirements(settings: &Value, envelope_available: bool) -> Result<()> {
    let _logging_step = crate::monitoring::Step::new(
        "store::validate_snapshot_requirements",
        serde_json::json!({}),
    );
    let mut issues = Vec::new();
    if !envelope_available {
        issues.push("包络：尚未生成或已失效，请先生成包络".to_string());
    }
    if settings["installation_face_id"]
        .as_str()
        .is_none_or(|id| id.trim().is_empty())
    {
        issues.push("安装面：未选择，请选择安装面".to_string());
    }
    let missing_axes = ["x", "y", "z"]
        .into_iter()
        .filter(|axis| {
            settings["center_of_mass"][*axis]
                .as_f64()
                .is_none_or(|value| !value.is_finite())
        })
        .map(str::to_uppercase)
        .collect::<Vec<_>>();
    if !missing_axes.is_empty() {
        issues.push(format!(
            "质心：{} 坐标未填写或无效",
            missing_axes.join("、")
        ));
    }
    if settings["mass"]
        .as_f64()
        .is_none_or(|mass| !mass.is_finite())
    {
        issues.push("质量：未填写或无效".to_string());
    }
    if issues.is_empty() {
        Ok(())
    } else {
        Err(Error::conflict(format!(
            "请补充以下设置：{}",
            issues.join("；")
        )))
    }
}

/// 业务存储持有资产发布锁，调用者复制不可变输入时可共享该锁防止删除竞争。
pub struct Store {
    pub config: Arc<Config>,
    pub database: PathBuf,
    pub assets: PathBuf,
    pub lock: Mutex<()>,
}
impl Store {
    /// 打开现有数据库或初始化相同表；不改写历史记录格式。
    pub fn open(config: Arc<Config>) -> Result<Self> {
        let _logging_step = crate::monitoring::Step::new("store::open", serde_json::json!({}));
        let directory = config.directory("backend", "model_store_dir");
        fs::create_dir_all(&directory)?;
        let database = directory.join(config.string("backend", "model_store_database_name"));
        let assets = directory.join("assets");
        fs::create_dir_all(&assets)?;
        database::connect(&database, &config)?.execute_batch(SCHEMA)?;
        Ok(Self {
            config,
            database,
            assets,
            lock: Mutex::new(()),
        })
    }
    /// 将数据库行转换为前端契约，列表省略变体明细以保持旧行为。
    fn public(row: Value, variants: Vec<Value>) -> Result<Value> {
        let _logging_step = crate::monitoring::Step::new("store::public", serde_json::json!({}));
        let id = row["record_id"]
            .as_str()
            .ok_or_else(|| Error::bad("固化记录缺少标识"))?;
        files::safe_id(id)?;
        let mut entries = vec![];
        for variant in variants {
            entries.push(json!({"rot_z":variant["rot_z"],"file_name":variant["file_name"],"asset_name":variant["asset_name"],"size":variant["size"],"sha256":variant["sha256"],"vertex_count":variant["vertex_count"],"face_count":variant["face_count"],"watertight":variant["watertight"]==1,"bounds":serde_json::from_str::<Value>(variant["bounds_json"].as_str().unwrap_or("null"))?,"download_url":format!("/api/store/models/{id}/variants/{}",variant["rot_z"])}));
        }
        Ok(
            json!({"record_id":id,"source_model_id":row["source_model_id"],"device_name":row["device_name"],"created_at":row["created_at"],"updated_at":row["updated_at"],"settings":serde_json::from_str::<Value>(row["settings_json"].as_str().unwrap_or("null"))?,
            "source":{"filename":row["source_filename"],"format":row["source_format"],"size":row["source_size"],"asset_name":row["source_asset_name"],"sha256":row["source_sha256"],"download_url":format!("/api/store/models/{id}/source")},
            "envelope":{"state":row["envelope_state"],"algorithm":row["envelope_algorithm"],"generated_at":row["envelope_generated_at"],"variant_count":row["envelope_variant_count"],"mesh_sha256":row["envelope_mesh_sha256"],"preview_asset_name":row["envelope_preview_asset_name"],"preview_sha256":row["envelope_preview_sha256"],"preview_url":row["envelope_preview_asset_name"].as_str().map(|_|format!("/api/store/models/{id}/envelope/preview.glb")),"variants":entries}}),
        )
    }
    /// 读取完整固化记录；不存在返回 404。
    pub fn get(&self, id: &str) -> Result<Value> {
        let _logging_step =
            crate::monitoring::Step::new("store::get", serde_json::json!({"id":id}));
        let connection = database::connect(&self.database, &self.config)?;
        let row = connection
            .query_row(
                "SELECT * FROM store_models WHERE record_id=?",
                [id],
                database::row,
            )
            .optional()?
            .ok_or_else(|| Error::missing("找不到指定的固化记录"))?;
        let mut statement = connection
            .prepare("SELECT * FROM store_envelope_variants WHERE record_id=? ORDER BY rot_z")?;
        let variants = statement
            .query_map([id], database::row)?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        Self::public(row, variants)
    }
    /// 按时间与标识倒序分页，关键词沿用 SQLite LIKE 语义。
    pub fn list(&self, limit: i64, offset: i64, keyword: &str) -> Result<Value> {
        let _logging_step = crate::monitoring::Step::new("store::list", serde_json::json!({}));
        let connection = database::connect(&self.database, &self.config)?;
        let pattern = format!("%{}%", keyword.trim());
        let total:i64=connection.query_row("SELECT COUNT(*) FROM store_models WHERE device_name LIKE ?1 OR source_filename LIKE ?1",[&pattern],|r|r.get(0))?;
        let mut statement=connection.prepare("SELECT * FROM store_models WHERE device_name LIKE ?1 OR source_filename LIKE ?1 ORDER BY created_at DESC,record_id DESC LIMIT ?2 OFFSET ?3")?;
        let rows = statement
            .query_map(params![pattern, limit, offset], database::row)?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        let records = rows
            .into_iter()
            .map(|r| Self::public(r, vec![]))
            .collect::<Result<Vec<_>>>()?;
        Ok(json!({"records":records,"total":total,"limit":limit,"offset":offset}))
    }
    /// 获取全部记录摘要，供前置配置和配置锁定复用稳定排序。
    pub fn all(&self) -> Result<Vec<Value>> {
        let _logging_step = crate::monitoring::Step::new("store::all", serde_json::json!({}));
        let connection = database::connect(&self.database, &self.config)?;
        let mut statement = connection
            .prepare("SELECT * FROM store_models ORDER BY created_at DESC,record_id DESC")?;
        let rows = statement
            .query_map([], database::row)?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        rows.into_iter().map(|r| Self::public(r, vec![])).collect()
    }
    /// 返回总体文件体积与版本统计。
    pub fn summary(&self) -> Result<Value> {
        let _logging_step = crate::monitoring::Step::new("store::summary", serde_json::json!({}));
        let connection = database::connect(&self.database, &self.config)?;
        let mut data=connection.query_row("SELECT COUNT(*) AS total,COALESCE(SUM(envelope_state='ready'),0) AS envelope_ready,COALESCE(SUM(source_size),0) AS source_bytes FROM store_models",[],database::row)?;
        data["envelope_bytes"] = json!(connection.query_row(
            "SELECT COALESCE(SUM(size),0) FROM store_envelope_variants",
            [],
            |r| r.get::<_, i64>(0)
        )?);
        data["database_name"] = json!(self.database.file_name().unwrap().to_string_lossy());
        data["schema_version"] = json!(1);
        Ok(data)
    }
    /// 获取来源模型固化状态；即使来源上传已删除仍保留独立快照。
    pub fn source_state(&self, id: &str) -> Result<Value> {
        let _logging_step =
            crate::monitoring::Step::new("store::source_state", serde_json::json!({"id":id}));
        let connection = database::connect(&self.database, &self.config)?;
        let count: i64 = connection.query_row(
            "SELECT COUNT(*) FROM store_models WHERE source_model_id=?",
            [id],
            |r| r.get(0),
        )?;
        let latest=connection.query_row("SELECT * FROM store_models WHERE source_model_id=? ORDER BY created_at DESC LIMIT 1",[id],database::row).optional()?.map(|v|Self::public(v,vec![])).transpose()?;
        Ok(json!({"stored":count>0,"record_count":count,"latest":latest}))
    }
    /// 只允许访问数据库声明的文件，拒绝路径越界和已丢失资源。
    pub fn asset(&self, record: &Value, name: &str) -> Result<PathBuf> {
        let _logging_step = crate::monitoring::Step::new("store::asset", serde_json::json!({}));
        let id = record["record_id"]
            .as_str()
            .ok_or_else(|| Error::bad("固化标识缺失"))?;
        files::safe_id(id)?;
        if record["source"]["asset_name"] != name
            && record["envelope"]["preview_asset_name"] != name
            && !record["envelope"]["variants"]
                .as_array()
                .is_some_and(|a| a.iter().any(|v| v["asset_name"] == name))
        {
            return Err(Error::missing("固化记录中不存在该资源"));
        }
        let root = files::within(&self.assets, id)?;
        if !root.is_dir() {
            return Err(Error::missing("固化资源目录已丢失"));
        }
        let path = files::within(&root, name)?;
        if !path.is_file() {
            return Err(Error::missing("固化资源文件已丢失"));
        }
        Ok(path)
    }
    /// 原子删除元数据后清理对应资产；只删除本次查询命中的记录目录。
    pub fn delete(&self, ids: &[String], required: bool) -> Result<usize> {
        let _logging_step = crate::monitoring::Step::new("store::delete", serde_json::json!({}));
        let _guard = self.lock.lock().unwrap();
        let mut connection = database::connect(&self.database, &self.config)?;
        let tx = connection.transaction()?;
        let mut deleted = vec![];
        for id in ids {
            files::safe_id(id)?;
            let count = tx.execute("DELETE FROM store_models WHERE record_id=?", [id])?;
            if count > 0 {
                deleted.push(id.clone());
            } else if required {
                return Err(Error::missing("找不到指定的固化记录"));
            }
        }
        tx.commit()?;
        for id in &deleted {
            let path = files::within(&self.assets, id)?;
            if path.is_dir() {
                fs::remove_dir_all(path)?;
            }
        }
        Ok(deleted.len())
    }
    /// 固定全部上传模型的标识后依次固化；返回成功记录和逐项失败，失败不撤销其他模型的完整快照。
    /// 参数为来源模型服务；每项沿用其已保存设置，不将当前页面参数复制给其他模型，空列表返回 409。
    pub async fn save_all(self: &Arc<Self>, models: Arc<Models>) -> Result<Value> {
        let source = models.clone();
        let listed = blocking(move || source.list()).await?;
        let entries = listed["models"]
            .as_array()
            .ok_or_else(|| Error::bad("模型列表格式无效"))?;
        if entries.is_empty() {
            return Err(Error::conflict("没有可存储的已上传模型"));
        }
        let mut results = Vec::with_capacity(entries.len());
        for model in entries {
            let id = model["id"].as_str().unwrap_or("");
            let result = self.save(models.clone(), id.to_string(), None).await;
            results.push(match result {
                Ok(record) => json!({"id":id,"filename":model["filename"],"status":"stored","record":record}),
                Err(error) => {
                    if let Some(operation) = crate::monitoring::current() {
                        operation.remember(error.diagnostic());
                    }
                    json!({"id":id,"filename":model["filename"],"status":"failed","error":error.message})
                }
            });
        }
        let stored = results.iter().filter(|item| item["status"] == "stored").count();
        Ok(json!({"total":results.len(),"stored":stored,"failed":results.len()-stored,"results":results}))
    }
    /// 保存当前模型、设置和正式包络快照；安装基准与显示二进制由独立后台队列生成，不阻塞提交。
    pub async fn save(
        self: &Arc<Self>,
        models: Arc<Models>,
        id: String,
        name: Option<String>,
    ) -> Result<Value> {
        let _logging_step =
            crate::monitoring::Step::new("store::save", serde_json::json!({"id":id}));
        let current = models.get(&id)?;
        validate_snapshot_requirements(
            &current["settings"],
            models.current_envelope(&current).is_some(),
        )?;
        models.envelope_preview(&id).await?;
        let _gate = models.gate(&id, "envelope").await;
        let latest = models.get(&id)?;
        validate_snapshot_requirements(
            &latest["settings"],
            models.current_envelope(&latest).is_some(),
        )?;
        let this = self.clone();
        blocking(move || {
            let _guard=this.lock.lock().unwrap();let state=models.state.lock().unwrap();let model=models.find(&state,&id)?;
            if model["settings"] != latest["settings"] || model["source"] != latest["source"] {
                return Err(Error::conflict("固化准备期间模型设置发生变化，请重新固化"));
            }
            let envelope=models.current_envelope(&model).ok_or_else(||Error::conflict("包络已失效，请重新生成"))?;
            let variant=envelope["variants"].as_array().unwrap().iter().find(|v|v["rot_z"]==0).ok_or_else(||Error::conflict("缺少基础包络"))?;
            let root=models.root(&id).join("envelope");let counts=files::read_json(&root.join("preview-counts.json"))?;
            let record_id=files::identifier();let stage=this.assets.join(format!(".staging-{record_id}"));fs::create_dir(&stage)?;
            let final_dir=this.assets.join(&record_id);
            let result=(||{
                files::copy(&models.source_path(&model)?,&stage.join("source.step"))?;
                files::copy(&files::within(&root,variant["file_name"].as_str().unwrap_or(""))?,&stage.join("envelope-000.npz"))?;
                files::copy(&root.join("preview.glb"),&stage.join("envelope-preview.glb"))?;
                let source=files::reference(&stage,&stage.join("source.step"))?;let mesh=files::reference(&stage,&stage.join("envelope-000.npz"))?;let preview=files::reference(&stage,&stage.join("envelope-preview.glb"))?;
                let name=name.as_deref().unwrap_or("").trim();let name=if name.is_empty(){model["settings"]["device_name"].as_str().unwrap()}else{name};let timestamp=files::now();
                let mut connection=database::connect(&this.database,&this.config)?;let tx=connection.transaction()?;
                tx.execute("INSERT INTO store_models VALUES (?1,?2,?3,?4,'STEP',?5,'source.step',?6,?7,'ready',?8,?9,1,?10,'envelope-preview.glb',?11,?12,?12)",params![record_id,id,name,model["filename"].as_str(),source["bytes"].as_i64(),source["sha256"].as_str(),model["settings"].to_string(),envelope["algorithm"].as_str(),envelope["generated_at"].as_str(),mesh["sha256"].as_str(),preview["sha256"].as_str(),timestamp])?;
                tx.execute("INSERT INTO store_envelope_variants(record_id,rot_z,file_name,asset_name,size,sha256,vertex_count,face_count,watertight,bounds_json) VALUES(?1,0,?2,'envelope-000.npz',?3,?4,?5,?6,?7,?8)",params![record_id,variant["file_name"].as_str(),mesh["bytes"].as_i64(),mesh["sha256"].as_str(),counts["vertex_count"].as_i64(),counts["face_count"].as_i64(),variant["watertight"].as_bool(),variant["bounds"].to_string()])?;
                files::publish(&stage,&final_dir)?;tx.commit()?;
                let mut record=this.get(&record_id)?;record["envelope"]["preview_size"]=preview["bytes"].clone();Ok(record)
            })();
            if result.is_err(){let _=fs::remove_dir_all(&stage);let connection=database::connect(&this.database,&this.config)?;let exists:bool=connection.query_row("SELECT EXISTS(SELECT 1 FROM store_models WHERE record_id=?)",[&record_id],|r|r.get(0))?;if !exists{let _=fs::remove_dir_all(&final_dir);}}
            result
        }).await
    }
}
